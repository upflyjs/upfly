/**
 * Where the graph build's time goes, sampled, so a step's movement can be attributed.
 * It says which step moved; it is never the gated figure.
 *
 * Each step gets a median and a spread over passes in separate processes, with `unusable`
 * beside a step whose passes disagree. Those spreads are within one run and cannot see
 * the drift between runs, so every run says so. `--experiments` adds the reading that
 * survives that drift: an A/B inside one run, timing `scan` under treatments that each
 * remove one more thing (`EXPERIMENT_1`).
 *
 * Reads only; writes nothing anywhere.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Adapter } from 'upfly-core';
import {
  type Asset,
  buildGraph,
  defaultAdapters,
  discover,
  resolveReferences,
  scanSources,
} from 'upfly-core/internal';
import { MEASURED_BETWEEN_RUN_DRIFT } from './invocations.js';
import { type Summary, summarise } from './samples.js';

const exec = promisify(execFile);
const ADAPTERS: readonly Adapter[] = defaultAdapters;

/**
 * One treatment of the instrumented pass.
 *
 * `env` is applied when the child process is spawned, because libuv reads
 * `UV_THREADPOOL_SIZE` when its pool is first used and ignores later changes, which makes
 * it a property of the process. For the same reason it belongs to an entry point, never
 * to the library: nothing in `upfly-core` touches it. Every current variant leaves it empty.
 */
interface VariantSpec {
  readonly label: string;
  readonly stubParse: boolean;
  readonly withMentions: boolean;
  /** Extra environment for the child process that measures it. */
  readonly env: Readonly<Record<string, string>>;
  /** How many files `scanSources` reads at once. Absent means the shipped default of 16. */
  readonly concurrency?: number;
}

export const VARIANTS = ['baseline', 'no-parse', 'no-parse-no-mentions', 'wide'] as const;

/**
 * The concurrency the `wide` variant uses.
 *
 * 256 rather than as high as possible. On a development machine, `scan` fell by about a
 * third from 16 to 256 and 1,024 bought almost nothing more, while 1,024 concurrent reads
 * is a very different demand on libuv from anything the engine ships with. CI has not
 * confirmed that shape.
 */
export const WIDE_CONCURRENCY = 256;
export type Variant = (typeof VARIANTS)[number];

/**
 * The parse experiment's treatments, which partition `scan`'s time. Each removes one
 * more thing than the one before, so consecutive differences are what parsing costs and
 * what the mention pass costs, and the last is everything else. The mention pass is its
 * own treatment because it also runs on the main thread for every file: left in the last
 * row, it would pass for time spent waiting on the disk.
 */
export const EXPERIMENT_1: readonly Variant[] = ['baseline', 'no-parse', 'no-parse-no-mentions'];
/**
 * Experiment 2, a larger libuv threadpool, is answered and has no variant: paired
 * comparisons on both CI platforms all landed inside the spread. A settled experiment
 * left in the harness costs CI time on every push and reads as an open question.
 */
export const EXPERIMENT_2_CLOSED = true;

export const VARIANT_SPEC: Readonly<Record<Variant, VariantSpec>> = {
  baseline: { label: 'baseline', stubParse: false, withMentions: true, env: {} },
  'no-parse': { label: 'no parse', stubParse: true, withMentions: true, env: {} },
  'no-parse-no-mentions': {
    label: 'no parse, no mentions',
    stubParse: true,
    withMentions: false,
    env: {},
  },
  // What a far wider concurrency would gain, as `scan` at that width. `scanSources`
  // already takes `concurrency`, so the treatment costs no code.
  wide: {
    label: `concurrency ${WIDE_CONCURRENCY}`,
    stubParse: false,
    withMentions: true,
    env: {},
    concurrency: WIDE_CONCURRENCY,
  },
};

export const VARIANT_LABEL: Readonly<Record<Variant, string>> = Object.freeze(
  Object.fromEntries(VARIANTS.map((variant) => [variant, VARIANT_SPEC[variant].label])) as Record<
    Variant,
    string
  >,
);

/**
 * Above this a step's samples disagree too much to attribute a change to it.
 *
 * The same 20% line `invocations.ts` and `run.ts` draw, not one picked separately here.
 * It is a machine-health line, as it is there: a step that crosses it had something
 * wrong with it, not merely a small signal. Re-size it from the per-step spreads CI
 * prints, never from one development machine.
 */
export const MAX_STEP_SPREAD_PERCENT = 20;

export interface Breakdown {
  readonly variant: Variant;
  readonly discoverMs: number;
  readonly scanMs: number;
  readonly resolveMs: number;
  readonly graphMs: number;
  /** Wall-clock window with at least one read outstanding. Overlaps `parseMs`. */
  readonly readMs: number;
  /** Summed read durations. Divided by `readMs`, the effective concurrency. */
  readonly readOccupancyMs: number;
  /** Summed adapter time. Adapters run synchronously, so the sum is elapsed time. */
  readonly parseMs: number;
  /** JSON-friendly, because this crosses a process boundary. A `Map` would not. */
  readonly parseByExtension: readonly (readonly [string, number])[];
  /** Adapter calls that threw. Printed even when zero, so a zero is a count, not an omission. */
  readonly adapterThrows: number;
  readonly files: number;
  readonly references: number;
}

/**
 * One instrumented pass.
 *
 * Read against parse is measured from outside the engine. `scanSources` takes its reader
 * and its adapters as parameters, so wrapping both times each in the real run:
 * interleaved, at the real concurrency, in the real order. Reading everything and then
 * parsing everything would time a different execution and report it as this one's shape.
 *
 * An adapter that throws still spent time parsing, and timing only the success path would
 * under-count the files that are hardest to parse. So the timing is taken in `finally`,
 * and the error is rethrown untouched, `UpflyError.partial` included, which has to
 * survive every boundary it crosses.
 */
export async function measureBreakdown(root: string, variant: Variant): Promise<Breakdown> {
  const { stubParse, withMentions, concurrency } = VARIANT_SPEC[variant];

  let readMs = 0;
  let parseMs = 0;
  let adapterThrows = 0;
  const parseByExtension = new Map<string, number>();

  // Reads overlap and parses do not, so they are measured differently. `scanSources`
  // reads several files at once, and summing concurrent durations measures occupancy,
  // not time. So `readMs` is the union of the intervals with at least one read in flight,
  // and the occupancy sum is kept beside it because their ratio is the effective
  // concurrency. Parsing is synchronous, so the sum of parse durations is elapsed time.
  //
  // Read-wall and parse overlap and are never added. The window also closes in a
  // `finally` that runs on the main thread, so a read that completes while another file
  // parses stays counted as outstanding until the parse ends. The `no-parse` variant
  // measures how much of read-wall that is.
  let readOccupancyMs = 0;
  let readsInFlight = 0;
  let windowStarted = 0;

  const timedRead = async (path: string): Promise<string> => {
    const started = performance.now();
    if (readsInFlight === 0) windowStarted = started;
    readsInFlight++;
    try {
      return await readFile(path, 'utf8');
    } finally {
      const now = performance.now();
      readOccupancyMs += now - started;
      readsInFlight--;
      if (readsInFlight === 0) readMs += now - windowStarted;
    }
  };

  const timedAdapters: readonly Adapter[] = ADAPTERS.map((adapter) => ({
    ...adapter,
    findReferences(input) {
      const extension = extname(input.file).toLowerCase();
      const started = performance.now();
      try {
        // The stubbed parse: scan every file, return no references. The wrapper stays on
        // so the stub's own cost is visible rather than assumed to be zero, and
        // `extensions` and `id` are untouched so `discover` claims the same files in every
        // variant, which `breakdown.test.ts` checks.
        return stubParse ? [] : adapter.findReferences(input);
      } catch (error) {
        adapterThrows++;
        throw error;
      } finally {
        const spent = performance.now() - started;
        parseMs += spent;
        parseByExtension.set(extension, (parseByExtension.get(extension) ?? 0) + spent);
      }
    },
  }));

  const t0 = performance.now();
  const found = await discover({ root, adapters: timedAdapters });
  const discoverMs = performance.now() - t0;

  const t1 = performance.now();
  const parsed = await scanSources({
    sourceFiles: found.sourceFiles,
    adapters: timedAdapters,
    readFile: timedRead,
    // Spread rather than `: undefined`, which `exactOptionalPropertyTypes` rejects, and
    // rightly: "absent" and "present but undefined" are different states, and the
    // mention pass's absence is the treatment being measured.
    ...(withMentions ? { assetBasenames: basenamesOf(found.assets) } : {}),
    ...(concurrency === undefined ? {} : { concurrency }),
  });
  const scanMs = performance.now() - t1;

  const t2 = performance.now();
  const links = resolveReferences(parsed.references, {
    root: found.root,
    assets: found.assets,
    servingRoots: { dirs: ['public'], declared: true },
    excludedRoots: found.excludedRoots,
    exists: (path) => existsSync(path),
  });
  const resolveMs = performance.now() - t2;

  const t3 = performance.now();
  buildGraph({
    root: found.root,
    assets: found.assets,
    references: links,
    unscannedFiles: [...found.unscannedFiles, ...parsed.unscanned],
  });
  const graphMs = performance.now() - t3;

  return {
    variant,
    discoverMs,
    scanMs,
    resolveMs,
    graphMs,
    readMs,
    readOccupancyMs,
    parseMs,
    parseByExtension: [...parseByExtension.entries()],
    adapterThrows,
    files: found.sourceFiles.length,
    references: parsed.references.length,
  };
}

/** Lowercased asset basenames, for the mention pass `scan` does while reading. */
function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

/** One variant's passes, summarised per step. */
export interface BreakdownSample {
  readonly variant: Variant;
  readonly passes: number;
  readonly discover: Summary;
  readonly scan: Summary;
  readonly read: Summary;
  readonly parse: Summary;
  readonly resolve: Summary;
  readonly graph: Summary;
  readonly readOccupancy: Summary;
  /** Every pass saw the same tree, so a disagreement here invalidates the comparison. */
  readonly fileCounts: readonly number[];
  readonly references: number;
  readonly adapterThrows: number;
  /** From the pass whose `scan` was the median, so it describes a real single execution. */
  readonly parseByExtension: readonly (readonly [string, number])[];
  /** Step labels whose spread crossed `MAX_STEP_SPREAD_PERCENT`. */
  readonly unusableSteps: readonly string[];
}

export function summariseBreakdowns(passes: readonly Breakdown[]): BreakdownSample {
  const first = passes[0];
  if (first === undefined) throw new Error('summariseBreakdowns needs at least one pass');

  const of = (pick: (pass: Breakdown) => number) => summarise(passes.map(pick));
  const discover = of((pass) => pass.discoverMs);
  const scan = of((pass) => pass.scanMs);
  const read = of((pass) => pass.readMs);
  const parse = of((pass) => pass.parseMs);
  const resolve = of((pass) => pass.resolveMs);
  const graph = of((pass) => pass.graphMs);

  // The median pass by `scan`, so `parse by extension` describes one real execution
  // rather than an average of executions that never happened.
  const byScan = [...passes].sort((a, b) => a.scanMs - b.scanMs);
  const median = byScan[Math.floor((byScan.length - 1) / 2)] ?? first;

  const unusableSteps = (
    [
      ['discover', discover],
      ['scan', scan],
      ['read (wall)', read],
      ['parse', parse],
      ['resolve', resolve],
      ['graph', graph],
    ] as const
  )
    .filter(([, summary]) => summary.spreadPercent > MAX_STEP_SPREAD_PERCENT)
    .map(([label]) => label);

  return {
    variant: first.variant,
    passes: passes.length,
    discover,
    scan,
    read,
    parse,
    resolve,
    graph,
    readOccupancy: of((pass) => pass.readOccupancyMs),
    fileCounts: [...new Set(passes.map((pass) => pass.files))],
    references: median.references,
    adapterThrows: median.adapterThrows,
    parseByExtension: median.parseByExtension,
    unusableSteps,
  };
}

/**
 * Run the instrumented pass across separate processes, interleaving the variants.
 *
 * A fresh process per sample for the reason `invocations.ts` gives: the in-process
 * sampler controls the filesystem cache and nothing else. Each child discards one
 * warm-up pass before it measures anything, as `sample()` in `run.ts` does.
 */
export async function sampleBreakdowns(
  processes: number,
  variants: readonly Variant[],
): Promise<BreakdownSample[]> {
  const script = fileURLToPath(new URL('run.js', import.meta.url));
  const collected = new Map<Variant, Breakdown[]>(variants.map((variant) => [variant, []]));

  // Grouped by environment because `UV_THREADPOOL_SIZE` is a property of the process:
  // libuv reads it when the pool is first used and it cannot be changed after. Variants
  // that need the same environment share a child; variants that need a different one get
  // their own. Each group is still rotated, so no variant is always measured first.
  const groups = new Map<string, Variant[]>();
  for (const variant of variants) {
    const key = JSON.stringify(VARIANT_SPEC[variant].env);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [variant]);
    else bucket.push(variant);
  }

  for (let index = 0; index < processes; index++) {
    for (const [key, members] of groups) {
      const rotated = rotate(members, index);
      const { stdout: out } = await exec(
        process.execPath,
        [script, '--breakdown-child', `--variants=${rotated.join(',')}`],
        {
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, ...(JSON.parse(key) as Record<string, string>) },
        },
      );
      for (const pass of JSON.parse(out) as Breakdown[]) {
        collected.get(pass.variant)?.push(pass);
      }
    }
  }

  return variants.map((variant) => summariseBreakdowns(collected.get(variant) ?? []));
}

/**
 * Child `i` starts at variant `i`, so no variant is always first or always last, and
 * neither drift across the run nor JIT warm-up favours one of them.
 */
export function rotate<T>(values: readonly T[], by: number): readonly T[] {
  if (values.length === 0) return values;
  const offset = ((by % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function renderBreakdown(sample: BreakdownSample, experiment = false): string {
  const total =
    sample.discover.medianMs +
    sample.scan.medianMs +
    sample.resolve.medianMs +
    sample.graph.medianMs;
  const share = (ms: number) => `${((ms / Math.max(1, total)) * 100).toFixed(1)}%`;
  const row = (label: string, summary: Summary) =>
    `    ${label.padEnd(14)} ${String(summary.medianMs).padStart(7)} ms   ${`${summary.spreadPercent}%`.padStart(5)}${
      summary.spreadPercent > MAX_STEP_SPREAD_PERCENT ? ' unusable' : '         '
    }  ${share(summary.medianMs).padStart(6)}`;

  const top = [...sample.parseByExtension]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([extension, ms]) => `${extension} ${Math.round(ms)}ms`)
    .join(' · ');

  return [
    '',
    `  Where the time goes: ${VARIANT_LABEL[sample.variant]}, median of ${sample.passes} instrumented`,
    '  passes in separate processes. This is not the gate number.',
    '',
    '    step              median  spread             share',
    row('discover', sample.discover),
    row('scan', sample.scan),
    row('  read (wall)', sample.read),
    row('  parse', sample.parse),
    row('resolve', sample.resolve),
    row('graph', sample.graph),
    '',
    `    per pass, scan: ${sample.scan.allMs.join(', ')} ms · parse: ${sample.parse.allMs.join(', ')} ms`,
    `    read occupancy ${sample.readOccupancy.medianMs} ms over ${sample.read.medianMs} ms wall = ${(
      sample.readOccupancy.medianMs / Math.max(1, sample.read.medianMs)
    ).toFixed(1)}x concurrency`,
    '    read-wall and parse overlap and are not a partition of scan. Do not add them.',
    '',
    `    parse by extension: ${top}`,
    `    files an adapter could not parse: ${sample.adapterThrows}`,
    `    ${sample.fileCounts.join('/')} source files, ${sample.references} references`,
    ...(sample.fileCounts.length > 1
      ? ['    The passes saw different trees. Nothing below is comparable.']
      : []),
    '',
    // Printed on every run, pass or fail, for the same reason `renderInvocations` prints
    // its drift line: a tight spread here says these passes agreed inside one run, not
    // that a step holds still between runs, which this cannot see.
    `    The spreads above are within this run only. The headline drifts ${MEASURED_BETWEEN_RUN_DRIFT}`,
    '    on unchanged code and these steps drift with it, so a spread here is not the',
    '    attribution floor for a change measured against a previous run. What beats that',
    experiment
      ? '    drift is an A/B inside one run, which is what the experiment block below is.'
      : '    drift is an A/B inside one run, which `--experiments` adds to this output.',
    '',
  ].join('\n');
}

/**
 * The A/B, and the only reading in this file that survives run-to-run drift.
 *
 * Consecutive variants differ by one removed thing, so each difference names a cost.
 * These are a partition: every row is `scan` wall clock, measured the same way, under a
 * different treatment, in the same job. That is what read-wall and parse are not.
 */
export function renderExperiment(samples: readonly BreakdownSample[]): string {
  const baseline = samples.find((sample) => sample.variant === 'baseline');
  const noParse = samples.find((sample) => sample.variant === 'no-parse');
  const noMentions = samples.find((sample) => sample.variant === 'no-parse-no-mentions');
  if (baseline === undefined || noParse === undefined) return '';

  const partition = samples.filter((sample) => EXPERIMENT_1.includes(sample.variant));

  const lines: string[] = [
    '',
    '  Experiment: what `scan` costs with parsing stubbed to a no-op',
    '',
    '    variant                     scan       spread        vs baseline',
  ];

  for (const sample of partition) {
    const delta =
      sample === baseline
        ? 'n/a'
        : `${percent(sample.scan.medianMs - baseline.scan.medianMs, baseline.scan.medianMs)}`;
    lines.push(
      `    ${VARIANT_LABEL[sample.variant].padEnd(24)} ${String(sample.scan.medianMs).padStart(6)} ms  ${`${sample.scan.spreadPercent}%`.padStart(5)}${
        sample.unusableSteps.includes('scan') ? ' unusable' : '         '
      }  ${delta.padStart(10)}`,
    );
  }

  const parseCost = baseline.scan.medianMs - noParse.scan.medianMs;
  const mentionCost =
    noMentions === undefined ? null : noParse.scan.medianMs - noMentions.scan.medianMs;
  const floor = noMentions?.scan.medianMs ?? null;

  lines.push(
    '',
    `    parsing costs           ${String(parseCost).padStart(6)} ms  ${percentOf(parseCost, baseline.scan.medianMs)} of scan`,
    ...(mentionCost === null || floor === null
      ? []
      : [
          `    the mention pass costs  ${String(mentionCost).padStart(6)} ms  ${percentOf(mentionCost, baseline.scan.medianMs)} of scan`,
          `    everything else         ${String(floor).padStart(6)} ms  ${percentOf(floor, baseline.scan.medianMs)} of scan  ← reads, the walk, and scan's own overhead`,
        ]),
    '',
    `    read (wall) ${baseline.read.medianMs} → ${noParse.read.medianMs} ms with parse stubbed (${percent(noParse.read.medianMs - baseline.read.medianMs, baseline.read.medianMs)}).`,
    "    The claim under test: read-wall is inflated by parse, because `timedRead`'s",
    '    `finally` runs on the main thread. The line above tests it: a read-wall that',
    '    barely moves means the window really was waiting on a disk.',
    '',
    '    These rows are a partition: all of them are `scan` wall under three treatments,',
    '    measured in the same job. read-wall and parse are not, and still must not be added.',
    '',
    ...verdict(baseline, noParse, parseCost),
    '',
  );

  return lines.join('\n');
}

/**
 * The noise floor two samples share, or `null` when there is not one.
 *
 * One pass has a spread of 0%, and that is not a floor but the absence of one: a verdict
 * placed against it would call any difference a finding. `noise.test.ts` records the
 * same trap in the same arithmetic.
 */
function spreadFloor(a: BreakdownSample, b: BreakdownSample): number | null {
  if (a.passes < 2 || b.passes < 2) return null;
  return Math.max(a.scan.spreadPercent, b.scan.spreadPercent);
}

/**
 * The experiment's decision rule, applied out loud, and refused when the spreads cannot
 * carry it: is the main thread the bottleneck, or is the disk.
 *
 * Stated as a share of `scan` rather than in milliseconds, because milliseconds belong to
 * one tree on one runner and the rule has to survive both changing.
 */
function verdict(
  baseline: BreakdownSample,
  noParse: BreakdownSample,
  parseCost: number,
): readonly string[] {
  const floor = spreadFloor(baseline, noParse);
  const movePercent = (Math.abs(parseCost) / Math.max(1, baseline.scan.medianMs)) * 100;

  if (floor === null) {
    return [
      `    verdict: parsing is ${((parseCost / Math.max(1, baseline.scan.medianMs)) * 100).toFixed(1)}% of scan's wall clock, but this ran one pass`,
      '       per variant, so there is no spread to place it against. Stubbing the parse is',
      '       expected to cut scan by about 70%, large enough to survive one sample; nothing',
      '       smaller does. Re-run with --breakdown-passes=3.',
    ];
  }

  const floorPercent = floor;

  if (movePercent <= floorPercent) {
    return [
      `    verdict: none. The difference is ${movePercent.toFixed(1)}% and these variants' own spread is`,
      `       ${floorPercent}%. A move inside the noise is not a finding: a 26% saving from a larger`,
      '       threadpool was once read from noise like this and later measured zero. Raise the',
      '       pass count and re-run.',
    ];
  }

  const share = (parseCost / Math.max(1, baseline.scan.medianMs)) * 100;
  return share >= 50
    ? [
        `    verdict: parsing is ${share.toFixed(1)}% of scan's wall clock. The main thread is the`,
        '       bottleneck, so a faster parse is the lever. That share is also the ceiling of',
        '       moving parsing elsewhere; a parse pool tried and was slower in every configuration.',
      ]
    : [
        `    verdict: parsing is only ${share.toFixed(1)}% of scan's wall clock, so a faster parse`,
        '       can recover that much at most; the rest is spent reading, so the answer is the',
        '       threadpool or the read strategy.',
      ];
}

function percent(delta: number, of: number): string {
  const value = (delta / Math.max(1, of)) * 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function percentOf(part: number, whole: number): string {
  return `${((part / Math.max(1, whole)) * 100).toFixed(1)}%`;
}
