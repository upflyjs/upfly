/**
 * `upfly audit`: a summary of the report, with the full report kept in Upfly's own folder.
 * No project file is written. Its savings are what `optimize` would convert and save: the
 * images a plan could convert are measured, and planned as a dry run of `optimize` plans.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type PipelineOutput,
  type PlannedConversion,
  type PublicPolicy,
  type Report,
  buildReport,
  runPipeline,
  servingRootsFor,
} from 'upfly-core';
import { convertibleImages, optimizeFromPipeline } from 'upfly-core/internal';
import type { AuditOptions } from './args.js';
import { loadConfig } from './config.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { renderFile } from './layout.js';
import { policyFor } from './optimize.js';
import { type Io, emit, progressReporter, stopWith } from './output.js';
import {
  type ReportFile,
  localTime,
  printRun,
  reportPath,
  typedOptions,
  writeReport,
} from './report-file.js';
import { type NextStep, auditSummary } from './summary.js';

/**
 * Reads the project and prints what it found.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the audit ran; 2 or 3 when the configuration stopped it
 */
export async function runAudit(options: AuditOptions, io: Io): Promise<ExitCode> {
  const started = new Date();
  const root = resolve(options.dir);
  if (!isDirectory(root)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `${options.dir} is not a directory`);
  }

  const config = await loadConfig(root);
  if (config.kind === 'refused') {
    return stopWith(io, options, EXIT_CODES.ABORTED, config.message, config.reason);
  }
  if (config.kind === 'invalid') {
    return stopWith(io, options, EXIT_CODES.USAGE, `${config.file} ${config.message}`);
  }
  const settings = config.kind === 'loaded' ? config.config : {};
  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;
  const format = settings.format ?? 'webp';
  const extraIgnores = [...(settings.exclude ?? []), ...options.exclude];

  const progress = progressReporter(io, 'audit', options.json);
  const output = await runPipeline({
    root,
    servingRoots: servingRootsFor(
      publicDirs === null ? undefined : { dirs: publicDirs, declared: true },
    ),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: probeOptionsFor(options, format),
    encodeOnly: (built) => convertibleImages({ ...built, format }),
    extraIgnores,
    onProgress: (event) => progress.update(event),
  });
  const savings = options.probe
    ? await plannedSavings(output, {
        format,
        publicPolicy: policyFor({ policy: null }, settings),
        extraIgnores,
      })
    : null;
  progress.clear();

  const report = buildReport({
    graph: output.graph,
    audit: output.audit,
    discovery: output.discovery,
    sweep: output.sweep,
    servingRoots: output.servingRoots,
    aliases: output.aliases,
    ...(output.probes === undefined ? {} : { probes: output.probes }),
    includeDiscarded: options.includeDiscarded,
    includeUnusedVectors: options.includeUnusedSvg,
  });
  write(options, io, { report, savings, output, root, started });
  return EXIT_CODES.OK;
}

/** What `optimize` would convert and save with the same options, as the audit measured it. */
export interface Savings {
  /** The images the plan converts, each with what it saves, as `optimize --json` lists them. */
  readonly conversions: readonly PlannedConversion[];
  /** Their size now, in bytes. */
  readonly bytes: number;
  /** How much smaller they would be together, in bytes. */
  readonly savedBytes: number;
  /**
   * Images the plan could convert that were not measured, past `--max-encodes`. When there
   * are any, the plan converts at least these images and saves at least these bytes.
   */
  readonly unmeasured: number;
  /** Each image's size, by POSIX-relative path, for the list of what converts. */
  readonly sizes: ReadonlyMap<string, number>;
}

/**
 * The plan a dry run of `optimize` makes, from the audit's own measurements: the same
 * function on the same graph, so the images and bytes are the same, or, past the cap, a part
 * of them. Null when `optimize` would refuse to plan, as it does when it cannot tell where
 * the site is served from.
 */
async function plannedSavings(
  output: PipelineOutput,
  settings: {
    readonly format: 'webp' | 'avif';
    readonly publicPolicy: PublicPolicy;
    readonly extraIgnores: readonly string[];
  },
): Promise<Savings | null> {
  const run = await optimizeFromPipeline(output, { ...settings, apply: false });
  if (run.refusal !== null) return null;
  const sizes = new Map(output.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]));
  const { conversions } = run.plan;
  return {
    conversions,
    bytes: conversions.reduce((sum, conversion) => sum + (sizes.get(conversion.asset) ?? 0), 0),
    savedBytes: conversions.reduce((sum, conversion) => sum + conversion.savedBytes, 0),
    unmeasured: (output.probes ?? []).filter((probe) =>
      probe.skipped.some((skip) => skip.code === 'beyond-encode-cap'),
    ).length,
    sizes,
  };
}

function probeOptionsFor(options: AuditOptions, format: 'webp' | 'avif') {
  if (!options.probe) return null;
  return {
    formats: [format],
    ...(options.maxEncodes === null ? {} : { maxEncodedAssets: options.maxEncodes }),
  };
}

function write(
  options: AuditOptions,
  io: Io,
  run: {
    readonly report: Report;
    readonly savings: Savings | null;
    readonly output: PipelineOutput;
    readonly root: string;
    readonly started: Date;
  },
): void {
  const { report, savings, output, root } = run;
  if (options.json) {
    // The libraries' own wording, which varies between runs, stays out of the report.
    for (const diagnostic of output.diagnostics) {
      emit(io, { type: 'diagnostic', command: 'audit', source: 'image', ...diagnostic });
    }
    for (const diagnostic of output.scanDiagnostics) {
      emit(io, { type: 'diagnostic', command: 'audit', source: 'parser', ...diagnostic });
    }
    emit(io, {
      type: 'result',
      command: 'audit',
      exitCode: EXIT_CODES.OK,
      report,
      savings:
        savings === null
          ? null
          : {
              images: savings.conversions.length,
              bytes: savings.bytes,
              savedBytes: savings.savedBytes,
              unmeasured: savings.unmeasured,
              conversions: savings.conversions,
            },
    });
    return;
  }
  const next = nextAfterAudit(options, report, savings);
  const summary = (file: ReportFile) => auditSummary(report, savings, file, next);
  const text = renderFile(summary({ written: reportPath('audit') }), {
    when: localTime(run.started),
    folder: root,
    options: typedOptions(options),
  });
  const file = writeReport(root, 'audit', text, null);
  printRun(io, options, summary(file), text, file);
  const said = output.diagnostics.length + output.scanDiagnostics.length;
  if (said > 0) {
    io.stderr.write(
      `The imaging and parsing libraries left ${said} ${said === 1 ? 'message' : 'messages'} of their own; \`upfly audit --json\` includes their text.\n`,
    );
  }
}

/**
 * The command to run after an audit: `optimize` when an image would be smaller, `dedupe`
 * when identical copies were found, with the same folder and the options that choose files.
 */
function nextAfterAudit(
  options: AuditOptions,
  report: Report,
  savings: Savings | null,
): NextStep | null {
  const { findings } = report.summary;
  // `optimize` refuses to plan until the folder is named, so that comes first; once it is
  // named, until the references that name no file there are fixed, which `check` lists.
  if (findings['serving-root-unknown'] > 0 && report.coverage.servingRoots.declared) {
    return {
      words: ['upfly', 'check', ...scopeWords(options)],
      text: 'upfly check, with the same folder and options',
    };
  }
  if (findings['serving-root-unknown'] > 0) {
    return {
      words: null,
      text: 'name the folder the site serves: upfly audit --public <dir>',
    };
  }
  const converts = (savings?.conversions.length ?? 0) > 0;
  const command = converts ? 'optimize' : findings.duplicate > 0 ? 'dedupe' : null;
  if (command === null) return null;
  return {
    words: ['upfly', command, ...scopeWords(options)],
    text: `upfly ${command}, with the same folder and options`,
  };
}

/**
 * The folder and the options that choose which files a run reads, written as they would be
 * typed again, so a next command reads the same project.
 */
export function scopeWords(options: {
  readonly dir: string;
  readonly publicDirs: readonly string[] | null;
  readonly exclude: readonly string[];
}): string[] {
  return [
    ...(options.dir === '.' ? [] : [options.dir]),
    ...(options.publicDirs ?? []).flatMap((dir) => ['--public', dir === '' ? '.' : dir]),
    ...options.exclude.flatMap((pattern) => ['--exclude', pattern]),
  ];
}

/**
 * Whether `path` names a directory.
 *
 * @param path an absolute path
 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
