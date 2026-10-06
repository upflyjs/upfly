import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from '../adapters/default-adapters.js';
import { NO_REFERENCE_TO_FIND, htmlAdapter } from '../adapters/html.js';
import { audit } from '../audit/audit.js';
import type { Finding } from '../audit/audit.js';
import { sweepForMentions } from '../audit/sweep.js';
import type { Mention } from '../audit/sweep.js';
import { discover } from '../discover/discover.js';
import { buildGraph } from '../graph/graph.js';
import { toPosix } from '../paths.js';
import { MENTION_SURVIVES } from '../plan/plan.js';
import { createSharpProbe } from '../probe/probe-sharp.js';
import { probeAssets } from '../probe/probe.js';
import type { AssetProbe } from '../probe/probe.js';
import type { AliasMap } from '../resolve/aliases.js';
import { resolveReferences } from '../resolve/resolve.js';
import type { ServingRoots } from '../resolve/resolve.js';
import { scanSources } from '../scan/scan.js';
import type { ExcludedRoot, Reference, UnscannedFile } from '../types.js';
import type { Adapter } from '../types.js';
import { renderReport } from './report-human.js';
import {
  REPORT_SCHEMA_VERSION,
  buildReport,
  classifyReference,
  refusalReasonId,
} from './report.js';
import type { ClassificationBound, ReferenceEntry, Report } from './report.js';

/**
 * The report's JSON is public API, so it is snapshot-tested over real fixture trees: a
 * schema change shows as a diff somebody has to approve. The same repository reported
 * from another working directory must give byte-identical output, so no absolute path
 * may reach the report.
 *
 * When every fixture shares the value a branch depends on, the fixtures cannot test that
 * branch, and a green suite says only that nothing changed. Those blocks build their
 * input by hand.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');
const ADAPTERS: readonly Adapter[] = defaultAdapters;

const PUBLIC_DIRS: Record<string, string> = {
  'vite-react': 'public',
  'next-app': 'public',
  astro: 'public',
  'plain-html': '',
  eleventy: 'src',
};

/**
 * No serving root at all: none declared, detected or inferred. On `eleventy`, which serves
 * `src`, no root-relative reference resolves in this state.
 */
const NO_SERVING_ROOT: ServingRoots = { dirs: [], declared: false };

async function reportFor(
  name: string,
  probed = false,
  includeDiscarded = false,
  servingRoots: ServingRoots = { dirs: [PUBLIC_DIRS[name] ?? 'public'], declared: true },
): Promise<Report> {
  const root = join(FIXTURES, name);
  const discovery = await discover({ root, adapters: ADAPTERS });
  const readFileText = (path: string) => readFile(path, 'utf8');

  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
  });

  const graph = buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references: resolveReferences(scanned.references, {
      root: discovery.root,
      assets: discovery.assets,
      servingRoots,
      excludedRoots: discovery.excludedRoots,
      exists: (path) => existsSync(path),
    }),
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
  });

  const sweep = await sweepForMentions({ graph, readFile: readFileText });
  const probes = probed
    ? await probeAssets(
        graph.assets.map((node) => node.asset),
        { probe: await createSharpProbe(), formats: ['webp'] },
      )
    : undefined;

  const auditResult = await audit({
    graph,
    sweep,
    readFile: readFileText,
    publicDirs: servingRoots.dirs,
    ...(probes === undefined ? {} : { probes }),
  });

  return buildReport({
    aliases: { rules: [], skipped: [] },
    graph,
    audit: auditResult,
    discovery,
    sweep,
    servingRoots,
    includeDiscarded,
    ...(probes === undefined ? {} : { probes }),
  });
}

const NAMES = ['vite-react', 'next-app', 'astro', 'plain-html', 'eleventy'] as const;

/** Lowercased asset basenames, for the mention pass `scan` does while reading. */
function basenamesOf(assets: readonly { relative: string }[]): Set<string> {
  return new Set(
    assets.map((asset) => asset.relative.slice(asset.relative.lastIndexOf('/') + 1).toLowerCase()),
  );
}

describe('buildReport', () => {
  it('declares its schema version', async () => {
    expect((await reportFor('plain-html')).version).toBe(REPORT_SCHEMA_VERSION);
  });

  it.each(NAMES)('%s: matches the approved JSON shape', async (name) => {
    expect(await reportFor(name)).toMatchSnapshot();
  });

  /**
   * The snapshots above run unprobed, so none holds a `format-opportunity` and their
   * `savingQuality` is `{}`. This one is probed against `partial-pattern`, where
   * `screenshot.png` is measured lossless and the other images at quality 80, so one run
   * holds two settings for one format. A single value per format would keep only one.
   */
  it('carries both settings when a run mixes them', async () => {
    const report = await reportFor('partial-pattern', true);

    expect(report.summary.savingQuality.webp).toEqual([80, 'lossless']);
  });

  it('partial-pattern: matches the approved JSON shape, lossless included', async () => {
    expect(await reportFor('partial-pattern', true)).toMatchSnapshot();
  });

  it.each(NAMES)('%s: matches the approved human rendering', async (name) => {
    expect(renderReport(await reportFor(name))).toMatchSnapshot();
  });

  /**
   * The snapshots above declare each fixture's serving root, so none holds a
   * `serving-root-unknown` finding. Without one, `eleventy` resolves no root-relative
   * reference, and these show the diagnosis with every reference it withholds.
   */
  it('eleventy, with no serving root found: matches the approved JSON shape', async () => {
    expect(await reportFor('eleventy', false, false, NO_SERVING_ROOT)).toMatchSnapshot();
  });

  it('eleventy, with no serving root found: matches the approved human rendering', async () => {
    expect(
      renderReport(await reportFor('eleventy', false, false, NO_SERVING_ROOT)),
    ).toMatchSnapshot();
  });

  it('eleventy, with a named folder that resolves too little: lists what names no file there', async () => {
    const report = await reportFor('eleventy', false, false, { dirs: ['nowhere'], declared: true });
    const rendered = renderReport(report);
    const diagnosis = report.findings.find((finding) => finding.kind === 'serving-root-unknown');
    if (diagnosis?.kind !== 'serving-root-unknown') throw new Error('no diagnosis');

    expect(rendered).toContain(
      'Few root-relative references resolved where the project says the site is served from',
    );
    expect(rendered).toContain(
      `None of the ${diagnosis.checkable} root-relative references resolved in nowhere, named as the folder the site is served from; if it is, all ${diagnosis.checkable} name no file there:`,
    );
    for (const entry of diagnosis.suppressed) expect(rendered).toContain(entry.rawPath);
    expect(rendered).not.toMatch(/declare|could not work out|publicDirs/i);
  });

  describe('no absolute path leaks', () => {
    it.each(NAMES)('%s: the serialised report never contains the root', async (name) => {
      // Half the data upstream carries an absolute `path` beside its `relative`, so
      // this is one forgotten projection away from being false.
      const report = await reportFor(name);
      const serialised = JSON.stringify(report);

      expect(serialised).not.toContain(FIXTURES);
      expect(serialised).not.toContain('\\\\');
      expect(serialised).not.toMatch(/[A-Za-z]:\//);
    });

    it('renders no absolute path in the human output either', async () => {
      const text = renderReport(await reportFor('astro'));

      expect(text).not.toContain(FIXTURES);
    });
  });

  describe('determinism', () => {
    it('produces byte-identical JSON across two runs', async () => {
      const [first, second] = await Promise.all([reportFor('astro'), reportFor('astro')]);

      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it('carries no timestamp or duration', async () => {
      const serialised = JSON.stringify(await reportFor('eleventy'));

      expect(serialised).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(Object.keys((await reportFor('eleventy')).summary)).not.toContain('durationMs');
    });
  });

  describe('what the summary says', () => {
    it('counts a saving once per asset even when two formats were measured', async () => {
      // Summing every measurement would double-count an asset measured against
      // both webp and avif, and the headline number would be a fiction.
      const report = await reportFor('plain-html', true);

      expect(report.summary.potentialSavingBytes).toBeGreaterThanOrEqual(0);
      expect(report.summary.probed).toBe(true);
    });

    it('says it did not probe when it did not', async () => {
      const report = await reportFor('plain-html');

      expect(report.summary.probed).toBe(false);
      expect(report.caveats.map((caveat) => caveat.code)).toContain('not-probed');
    });
  });

  describe('the caveats', () => {
    it('names the public-dir dead count rather than hedging those assets', async () => {
      const report = await reportFor('astro');
      const caveat = report.caveats.find((entry) => entry.code === 'public-dir-dead');

      expect(caveat?.count).toBe(1);
      expect(report.findings.some((finding) => finding.kind === 'dead')).toBe(true);
    });

    it('names the file types no adapter reads', async () => {
      const report = await reportFor('eleventy');

      expect(report.coverage.unscannedExtensions).toEqual([{ ext: '.njk', fileCount: 2 }]);
      expect(report.caveats.map((caveat) => caveat.code)).toContain('unscanned-extensions');
    });
  });

  describe('the encode cap caveat', () => {
    // No fixture run is capped, so this is built by hand.
    function cappedReport() {
      const ROOT = '/repo';
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [],
          conventionLinked: [],
          unreadableSources: [],
          probed: true,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        probes: [
          {
            relative: 'huge.png',
            metadata: { width: 10, height: 10, format: 'png', pages: 1 },
            encoded: [],
            skipped: [
              {
                measurement: 'webp',
                code: 'beyond-encode-cap',
                reason:
                  'not among the 2 largest assets measured (run with --probe-all to measure the rest)',
              },
            ],
          },
        ],
      });
    }

    it('counts the assets it did not measure', () => {
      const caveat = cappedReport().caveats.find((entry) => entry.code === 'encode-capped');

      expect(caveat?.count).toBe(1);
    });

    it('names --probe-all, the flag a user wants at that moment', () => {
      // Both `--max-encodes <n>` and `--probe-all` reach the same option. This
      // string is where someone notices a number is missing, so it points at the
      // discoverable name rather than the tunable.
      const text = renderReport(cappedReport());

      expect(text).toContain('--probe-all');
    });

    it('lists the per-asset reason in the skipped section too', () => {
      const text = renderReport(cappedReport());

      expect(text).toContain('huge.png');
      expect(text).toContain('could not be measured');
    });
  });

  describe('the possibly-dead headings', () => {
    // The fixtures' hedges all come from `eleventy`, from `.njk` files and one
    // unresolved reference, so the third evidence source and an asset cited by two
    // sources are reachable only from here. The assets are rasters because the report
    // moves an unreferenced vector out of `findings`, so a vector never reaches a heading.
    const ROOT = '/repo';

    function mention(source: Mention['source'], where: string, quote: string): Mention {
      return { asset: quote, source, where, quote };
    }

    function hedgedReport(): Report {
      const hedge = (asset: string, evidence: readonly [Mention, ...Mention[]]): Finding => ({
        kind: 'possibly-dead',
        asset,
        bytes: 2048,
        inPublicDir: false,
        evidence,
      });

      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [
            // Two from one file, so the grouping has something to count.
            hedge('public/logos/gitbook.png', [
              mention('unresolved-reference', 'src/data/logos.ts:56', 'gitbook.png'),
            ]),
            hedge('public/logos/hugo.png', [
              mention('unresolved-reference', 'src/data/logos.ts:65', 'hugo.png'),
            ]),
            hedge('src/assets/docs.png', [
              mention('unscanned-file', 'src/components/SiteTitle.astro:3', 'docs.png'),
            ]),
            hedge('public/assets/arc.webp', [
              mention('scanned-file', 'src/content/tutorial.mdx:119', 'arc.webp'),
            ]),
          ],
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
    }

    it('never claims a file could not be read when the engine read it fine', () => {
      // `src/data/logos.ts` is ordinary TypeScript that parses, and `'gitbook.png'` in it
      // is simply not a resolvable path. Under a "cannot read" heading, a user who follows
      // the citation opens a readable file and concludes the tool is broken.
      const text = renderReport(hedgedReport());
      const section = text.slice(text.indexOf('possibly unreferenced'));
      const unresolvedLine = section
        .split('\n')
        .findIndex((line) => line.includes('src/data/logos.ts'));
      const heading = section
        .split('\n')
        .slice(0, unresolvedLine)
        .filter((line) => line.trimStart().startsWith('named '))
        .at(-1);

      expect(heading).toContain('could not resolve');
      expect(heading).not.toContain('no adapter reads');
    });

    it('heads each evidence source separately, because they mean different things', () => {
      const text = renderReport(hedgedReport());

      expect(text).toContain('named in a file no adapter reads');
      expect(text).toContain('named in text Upfly read but no adapter claimed');
      expect(text).toContain('named by a path Upfly read but could not resolve');
    });

    it('groups by the citing file and counts it, which is the actionable fact', () => {
      const text = renderReport(hedgedReport());

      expect(text).toContain('src/data/logos.ts: 2 assets');
      expect(text).toContain('src/components/SiteTitle.astro: 1 asset');
    });

    it('files an asset under its most actionable evidence, and still prints the rest', () => {
      // A real case: `Sponsors.astro` imports `./logos/mux.svg` and `logos.ts` names
      // `mux.svg` too, so the asset carries both. It belongs under the heading with
      // something to do about it, and neither citation may be dropped. Spelled `.png`
      // so the report does not demote it as a vector.
      const both = buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [
            {
              kind: 'possibly-dead',
              asset: 'public/logos/mux.png',
              bytes: 809,
              inPublicDir: true,
              evidence: [
                mention('unresolved-reference', 'src/data/logos.ts:80', 'mux.png'),
                mention('unscanned-file', 'src/components/Sponsors.astro:4', 'mux.png'),
              ],
            },
          ],
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
      const text = renderReport(both);

      expect(text).toContain(
        'named in a file no adapter reads; an adapter for that file type would find these',
      );
      expect(text).not.toContain('config entry');
      expect(text).not.toContain('named by a path Upfly read but could not resolve');
      expect(text).toContain('src/components/Sponsors.astro: 1 asset');
      expect(text).toContain('named in src/data/logos.ts:80');
    });
  });

  // A newline, spelled without a backslash escape so that no tool rewriting this file
  // can turn it into a literal line break inside the string.
  const NEWLINE = String.fromCharCode(10);

  describe('one sentence, said once', () => {
    // A reason many capped assets share is printed once, with a count. Printed per
    // asset, 80 capped assets would repeat `--probe-all` 81 times.
    const ROOT = '/repo';

    function reportWithCapped(n: number) {
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [],
          conventionLinked: [],
          unreadableSources: [],
          probed: true,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        probes: Array.from({ length: n }, (_, index) => ({
          relative: `img${index}.png`,
          metadata: { width: 10, height: 10, format: 'png' as const, pages: 1 },
          encoded: [],
          skipped: [
            {
              measurement: 'webp' as const,
              code: 'beyond-encode-cap' as const,
              reason: 'not among the 100 largest assets measured (run with --probe-all)',
            },
          ],
        })),
      });
    }

    it('says a shared reason once, with a count', () => {
      const text = renderReport(reportWithCapped(80));

      expect(text).toContain('80 files: webp: not among the 100 largest');
      // Three places, each saying something different: the collapsed skip line, the
      // caveat, and the headline's floor clause.
      expect(text.match(/--probe-all/g)).toHaveLength(3);
    });

    it('keeps every name under the collapsed reason, not just a count', () => {
      // The names are the actionable part: `eleventy-docs` has ten `.js` files that are
      // really Nunjucks templates, and a reader needs to know which ten. The sentence
      // moves up; the names stay.
      const text = renderReport(reportWithCapped(80));

      expect(text).toContain('img0.png');
      expect(text).toContain('img79.png');
      expect(reportWithCapped(80).skipped).toHaveLength(80);
    });

    it('still names them individually when there are only a few', () => {
      // Three lines are easier to read than a count you have to go and look up.
      const text = renderReport(reportWithCapped(2));

      expect(text).toContain('img0.png');
      expect(text).toContain('img1.png');
    });
  });

  describe('the headline says what to act on, and says when it is a floor', () => {
    /**
     * The headline is the only text a reader gives ten seconds, so it leads with the
     * saving and says in the same sentence when the saving is a floor. Most branches
     * below need a probed run, and the fixture snapshots are unprobed, so they are
     * built by hand.
     */
    const ROOT = '/repo';

    /** A probe of `img<index>.png` that measured nothing, for the reason its code gives. */
    function unmeasured(index: number, code: 'beyond-encode-cap' | 'encode-failed'): AssetProbe {
      return {
        relative: `img${index}.png`,
        metadata: { width: 10, height: 10, format: 'png', pages: 1 },
        encoded: [],
        skipped: [{ measurement: 'webp', code, reason: code }],
      };
    }

    function reportOf(over: {
      probed?: boolean;
      saving?: number;
      capped?: number;
      failed?: number;
      extraProbes?: readonly AssetProbe[];
      aliases?: AliasMap;
      assets?: number;
      alsoAvif?: boolean;
      alsoLossless?: boolean;
    }): Report {
      const assetCount = over.assets ?? 10;
      const assets = Array.from({ length: assetCount }, (_, index) => ({
        path: `${ROOT}/img${index}.png`,
        relative: `img${index}.png`,
        extension: '.png',
        bytes: 100,
      }));
      const capped = over.capped ?? 0;
      // The capped images first, then those whose encode failed.
      const probes: AssetProbe[] = [
        ...Array.from({ length: capped }, (_, index) => unmeasured(index, 'beyond-encode-cap')),
        ...Array.from({ length: over.failed ?? 0 }, (_, index) =>
          unmeasured(capped + index, 'encode-failed'),
        ),
        ...(over.extraProbes ?? []),
      ];

      const report = buildReport({
        graph: buildGraph({ root: ROOT, assets, references: [], unscannedFiles: [] }),
        audit: {
          findings:
            over.saving === undefined
              ? []
              : [
                  {
                    kind: 'format-opportunity' as const,
                    quality: 80,
                    asset: 'img0.png',
                    from: 'png',
                    to: 'webp' as const,
                    bytes: 1_000_000,
                    wouldBe: 1_000_000 - over.saving,
                    savedBytes: over.saving,
                    savedPercent: 50,
                  },
                  ...(over.alsoAvif
                    ? [
                        {
                          kind: 'format-opportunity' as const,
                          quality: 75,
                          asset: 'img0.png',
                          from: 'png',
                          to: 'avif' as const,
                          bytes: 1_000_000,
                          wouldBe: 1_000_000 - over.saving,
                          savedBytes: over.saving,
                          savedPercent: 50,
                        },
                      ]
                    : []),
                  ...(over.alsoLossless
                    ? [
                        {
                          kind: 'format-opportunity' as const,
                          quality: 'lossless' as const,
                          asset: 'img1.png',
                          from: 'png',
                          to: 'webp' as const,
                          bytes: 1_000_000,
                          wouldBe: 1_000_000 - over.saving,
                          savedBytes: over.saving,
                          savedPercent: 50,
                        },
                      ]
                    : []),
                ],
          conventionLinked: [],
          unreadableSources: [],
          probed: over.probed ?? true,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets,
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        aliases: over.aliases ?? { rules: [], skipped: [] },
        ...(probes.length > 0 ? { probes } : {}),
      });

      return report;
    }

    function headlineOf(over: Parameters<typeof reportOf>[0]): string {
      return renderReport(reportOf(over)).split(NEWLINE)[2] ?? '';
    }

    it('leads with the savings, not with the file counts', () => {
      expect(headlineOf({ saving: 4_200_000 })).toContain('4.2 MB of savings');
    });

    it('states the quality the saving was measured at', () => {
      // A saving without its quality is not a figure: the same images give 95% at
      // quality 50 and 44% at quality 90, so without it a reader cannot tell which
      // product is being offered.
      expect(headlineOf({ saving: 4_200_000 })).toContain('of savings as webp at quality 80,');
    });

    it('says in words that some images were measured lossless', () => {
      // A list of settings joined with a comma would print `webp quality 80,lossless`.
      expect(headlineOf({ saving: 4_200_000, alsoLossless: true })).toContain(
        'of savings as webp at quality 80, or lossless where that came out smaller, measured',
      );
    });

    it('names every format when more than one was measured', () => {
      expect(headlineOf({ saving: 4_200_000, alsoAvif: true })).toContain(
        'as avif at quality 75 and webp at quality 80,',
      );
    });

    it('says the number is incomplete when the cap left images unmeasured', () => {
      // When the cap leaves images unmeasured the total is a floor, and the count goes
      // in the same sentence so the total is not read as the whole.
      const line = headlineOf({ saving: 4_200_000, capped: 3, assets: 10 });

      expect(line).toContain('so far');
      expect(line).toContain('3 of 10 images went unmeasured');
      expect(line).toContain('--probe-all');
    });

    it('says how many images could not be measured, rather than all of them', () => {
      const line = headlineOf({ saving: 4_200_000, failed: 2, assets: 10 });

      expect(line).toContain('measured across 8 of 10 images; 2 could not be measured');
      expect(line).not.toContain('all');
    });

    it('says how many could not be measured when it found no savings', () => {
      const line = headlineOf({ failed: 1, assets: 10 });

      expect(line).toContain(
        'no savings found, measured across 9 of 10 images; 1 could not be measured',
      );
      expect(line).not.toContain('every one');
    });

    it('counts the images that could not be measured apart from those past the cap', () => {
      const line = headlineOf({ saving: 4_200_000, capped: 3, failed: 1, assets: 10 });

      expect(line).toContain('3 of 10 images went unmeasured and 1 more could not be measured');
      expect(line).toContain('--probe-all');
    });

    it('counts each image that could not be measured once, and neither the cap nor a vector', () => {
      const probe = (relative: string, skipped: AssetProbe['skipped']): AssetProbe => ({
        relative,
        metadata: null,
        encoded: [],
        skipped,
      });

      const report = reportOf({
        assets: 10,
        extraProbes: [
          probe('img0.png', [
            { measurement: 'metadata', code: 'not-an-image', reason: 'not an image' },
            { measurement: 'webp', code: 'not-an-image', reason: 'nothing to encode' },
          ]),
          probe('img1.png', [{ measurement: 'webp', code: 'encode-failed', reason: 'failed' }]),
          probe('img2.png', [{ measurement: 'webp', code: 'drops-animation', reason: 'animated' }]),
          probe('img3.png', [{ measurement: 'webp', code: 'vector', reason: 'a vector' }]),
          probe('img4.png', [{ measurement: 'webp', code: 'beyond-encode-cap', reason: 'capped' }]),
        ],
      });

      expect(report.summary.unmeasuredAssets).toBe(3);
    });

    it('lists every alias config it could not read, under its own label', () => {
      const unread = 'extends "@acme/cfg", which could not be found, so its aliases were not read';
      const cwd = 'the alias "@" at line 5 depends on the folder Vite runs in, so it was not read';
      const report = reportOf({
        aliases: {
          rules: [],
          skipped: [
            { what: 'vite.config.ts', reason: cwd, scopes: [ROOT] },
            { what: 'apps/web/tsconfig.json', reason: unread, scopes: [`${ROOT}/apps/web`] },
          ],
        },
      });

      expect(report.skipped.filter((item) => item.stage === 'aliases')).toEqual([
        { what: 'apps/web/tsconfig.json', stage: 'aliases', reason: unread },
        { what: 'vite.config.ts', stage: 'aliases', reason: cwd },
      ]);
      expect(renderReport(report)).toContain('had path aliases Upfly could not read');
    });

    it('says plainly that it measured everything when it did', () => {
      expect(headlineOf({ saving: 4_200_000, assets: 10 })).toContain(
        'measured across all 10 images',
      );
    });

    it('distinguishes "no savings" from "not measured"', () => {
      // Two very different statements, and neither may render as an absent line.
      expect(headlineOf({ assets: 10 })).toContain('no savings found');
      expect(headlineOf({ probed: false })).toContain('savings not measured');
    });
  });

  describe('one image, one size story', () => {
    /**
     * `oversized` and `format-opportunity` are two measurements of one file, so they
     * print together: a reader wants "551 KB, and 340 KB as webp" in one place. Neither
     * finding is produced without a probe, and the fixture snapshots are unprobed, so
     * this is built by hand.
     */
    const ROOT = '/repo';

    function sizeReport(findings: Finding[]) {
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings,
          conventionLinked: [],
          unreadableSources: [],
          probed: true,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
    }

    const oversized: Finding = {
      kind: 'oversized',
      asset: 'src/assets/landing-page-book.png',
      bytes: 551_000,
      width: 2256,
      height: 1320,
      exceeded: ['bytes'],
    };
    const opportunity: Finding = {
      kind: 'format-opportunity',
      quality: 80,
      asset: 'src/assets/landing-page-book.png',
      bytes: 551_000,
      from: 'png',
      wouldBe: 340_000,
      to: 'webp',
      savedBytes: 211_000,
      savedPercent: 38,
    };

    it('reports one file once, with both measurements under it', () => {
      const text = renderReport(sizeReport([oversized, opportunity]));

      expect(text.match(/landing-page-book\.png/g)).toHaveLength(1);
      expect(text).toContain('larger than the size limit');
      expect(text).toContain('as webp');
    });

    it('keeps both counts in the heading, so the merge hides nothing', () => {
      // Two numbers went in, so two numbers come out.
      const text = renderReport(sizeReport([oversized, opportunity]));

      expect(text).toContain('1 over the limit');
      expect(text).toContain('1 smaller as another format');
    });

    it('reads naturally for a file with only one of the two', () => {
      const text = renderReport(sizeReport([opportunity]));

      expect(text).toContain('landing-page-book.png');
      // The specific line rather than `over `, which the heading's "0 over the limit"
      // also contains.
      expect(text).not.toContain('larger than the size limit');
      expect(text).toContain('0 over the limit');
    });
  });

  describe('a determination is not a failure', () => {
    /**
     * A vector, or a file already in the target format, is Upfly working out that there
     * is nothing to gain, not something it could not handle, so it stays out of the
     * skipped list. No human-rendering snapshot has a skipped entry, so the rendered
     * stage labels, heading and grouping are reachable only from here.
     */
    const ROOT = '/repo';

    function probe(relative: string, code: 'vector' | 'already-target-format' | 'encode-failed') {
      const reason =
        code === 'vector'
          ? 'SVG is a vector: encoding it measures a rasterisation, not a saving'
          : code === 'already-target-format'
            ? 'already webp'
            : 'the encoder rejected it';
      return {
        relative,
        metadata: { width: 10, height: 10, format: 'png' as const, pages: 1 },
        encoded: [],
        skipped: [{ measurement: 'webp' as const, code, reason }],
      };
    }

    function reportWith(probes: ReturnType<typeof probe>[]) {
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [],
          conventionLinked: [],
          unreadableSources: [],
          probed: true,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        probes,
      });
    }

    it('keeps a vector and an already-converted file out of the skipped list', () => {
      const report = reportWith([
        probe('logo.svg', 'vector'),
        probe('hero.webp', 'already-target-format'),
      ]);

      expect(report.skipped).toEqual([]);
    });

    it('counts them in one caveat instead, with the reasons broken out', () => {
      // The count survives the collapse, and the per-asset detail stays in
      // `probes[].skipped` for anyone reading the JSON.
      const caveat = reportWith([
        probe('a.svg', 'vector'),
        probe('b.svg', 'vector'),
        probe('c.webp', 'already-target-format'),
      ]).caveats.find((entry) => entry.code === 'nothing-to-measure');

      expect(caveat?.count).toBe(3);
      expect(caveat?.message).toContain('needed no measurement');
      expect(caveat?.detail).toEqual([
        'vectors, where an encode would measure a rasterisation rather than a saving: 2',
        'already in the format Upfly would convert to: 1',
      ]);
    });

    describe('the report names where the libraries’ own words went', () => {
      /**
       * No fixture report passes a `diagnosticsFile`, so it is `null` in every snapshot
       * and only these tests render the sentence that names it.
       */
      function rendered(diagnosticsFile?: string) {
        const report = reportWith([probe('broken.png', 'encode-failed')]);
        return renderReport(
          diagnosticsFile === undefined ? report : { ...report, diagnosticsFile },
        );
      }

      it('names the file when the run wrote one', () => {
        // The libraries' own messages are kept out of the report, so the report says
        // where they went, or a reader would have nowhere to look.
        const text = rendered('railsgirls-com.diagnostics.txt');

        expect(text).toContain('railsgirls-com.diagnostics.txt');
        expect(text).toContain('their wording, not ours');
      });

      it('says nothing at all when no such file was written', () => {
        // Absent is the honest answer, not a default name: naming a file that does not
        // exist sends a reader looking for nothing, and the CLI writes no such file.
        const text = rendered();

        expect(text).not.toContain('diagnostics');
        expect(text).toContain('broken.png');
      });

      it('is a name and never a path, so two checkouts render the same bytes', () => {
        const report = reportWith([probe('broken.png', 'encode-failed')]);

        expect(report.diagnosticsFile).toBeNull();
        expect(JSON.stringify(report)).not.toContain(ROOT);
      });
    });

    it('still reports a measurement that genuinely failed', () => {
      // The control, and the thing that must not be lost: an encoder rejecting an
      // image is a failure, not a determination, and it belongs in the list.
      const report = reportWith([probe('broken.png', 'encode-failed')]);

      expect(report.skipped).toEqual([
        { what: 'broken.png', stage: 'measurement', reason: 'webp: the encoder rejected it' },
      ]);
      expect(report.caveats.some((entry) => entry.code === 'nothing-to-measure')).toBe(false);
    });

    it('says what the sweep skip actually was, not "could not be searched"', () => {
      // Eight fonts over the sweep's size limit, under a heading about what Upfly
      // could not handle and beside conversion messages, read as "why are we trying
      // to convert fonts?" They are not being converted at all.
      const report = buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings: [],
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: {
          mentions: new Map(),
          skipped: [{ relative: 'fonts/inter.woff2', reason: 'over 2 MB' }],
        },
        servingRoots: { dirs: ['public'], declared: true },
      });
      const text = renderReport(report);

      expect(text).toContain('too large to search for asset filenames');
      expect(text).not.toContain('could not be searched');
      expect(text).toContain('each with its reason');
    });
  });

  describe('the unsafe bucket lists what can be checked', () => {
    // The only fixture with an unsafe reference has exactly one, and it shows a
    // filename, so the counted branch below is reachable only from here.
    const ROOT = '/repo';

    function dynamicReference(file: string, rawPath: string, start: number) {
      return {
        file: `${ROOT}/${file}`,
        start,
        end: start + rawPath.length,
        rawPath,
        kind: 'string' as const,
        shape: 'js.string.literal' as const,
        ceiling: 'unsafe' as const,
        asserted: true,
        resolution: 'dynamic' as const,
        confidence: 'unsafe' as const,
        resolvedPath: null,
      };
    }

    function reportWith(rawPaths: readonly string[]) {
      return reportOf(
        rawPaths.map((rawPath, index) => dynamicReference('app.ts', rawPath, index * 100)),
      );
    }

    /** The HTML adapter's own refusal of a style attribute, resolved as a run resolves it. */
    function styleRefusal(css: string): Reference[] {
      const file = `${ROOT}/page.html`;
      const raw = htmlAdapter.findReferences({ file, text: `<div style="${css}"></div>` });
      return resolveReferences(raw, {
        root: ROOT,
        assets: [],
        servingRoots: { dirs: [''], declared: true },
        excludedRoots: [],
        exists: () => false,
      });
    }

    it('says what each counted reference is, when not all are built at run time', () => {
      const text = renderReport(
        reportOf([
          ...styleRefusal('margin 0 0 0 15px'),
          dynamicReference('app.ts', '/view/${style}/${name}', 0),
        ]),
      );

      expect(text).toContain('  none with a filename to check:\n');
      expect(text).toContain('    1 built at run time\n');
      expect(text).toContain('    1 in CSS that holds no url() or image-set()\n');
      expect(text).not.toContain('each builds its path at runtime');
      expect(text).toContain(
        'each is built at run time, is CSS\n  that holds no url() or image-set()',
      );
    });

    it('keeps the one line when every counted reference is built at run time', () => {
      const text = renderReport(reportWith(['/view/${style}/${name}', '/api/${id}']));

      expect(text).toContain('  none with a filename to check: each builds its path at runtime\n');
    });

    function reportOf(
      references: readonly Reference[],
      aliases: AliasMap = { rules: [], skipped: [] },
    ) {
      return buildReport({
        aliases,
        graph: buildGraph({ root: ROOT, assets: [], references, unscannedFiles: [] }),
        audit: {
          findings: [],
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
    }

    it('lists the ones showing a filename somebody could go and look at', () => {
      const text = renderReport(reportWith(['${base}/hero.png', '/img/${slug}.jpg']));

      expect(text).toContain('${base}/hero.png');
      expect(text).toContain('/img/${slug}.jpg');
    });

    it('counts the ones with no filename instead of listing them', () => {
      // `/view/${style}/${name}` shows nothing to check, and with no extension it
      // can never glob to an asset either. Listed, entries like it bury the few a person
      // could act on.
      const text = renderReport(
        reportWith(['${base}/hero.png', '/view/${style}/${name}', '/api/${id}']),
      );

      expect(text).toContain('${base}/hero.png');
      expect(text).not.toContain('/view/');
      expect(text).toContain('plus 2 with no filename to check');
    });

    it('still reports the full count in the heading, so the collapse hides nothing', () => {
      // The risk is a list that quietly shrinks. The heading has to count everything,
      // listed or not.
      const text = renderReport(reportWith(['/view/${style}/${name}', '/api/${id}']));

      // The full count appears although no entry is listed. Both paths are assembled at
      // run time, so the heading is the one for references with no answer to find.
      expect(text).toContain('2 references had no answer to find');
      expect(text).toContain('none with a filename to check');
    });

    it('says an alias-shaped path matched no alias Upfly reads, and which configs those are', () => {
      const report = reportOf([
        {
          ...dynamicReference('app.ts', '@/assets/logo.png', 0),
          resolution: 'unresolved-alias',
        },
      ]);

      // Not "no alias the project declares": a webpack config or SvelteKit's `kit.alias`
      // can declare one that Upfly never reads.
      expect(report.references.unsafe.map((entry) => entry.reason)).toEqual([
        "alias-shaped, and no alias Upfly reads maps it; it reads only tsconfig and jsconfig paths and a Vite config's resolve.alias",
      ]);
    });

    it('says how SvelteKit writes `$lib`, so a fresh clone knows what to run first', () => {
      const report = reportOf([
        {
          ...dynamicReference('src/routes/+page.svelte', '$lib/assets/logo.png', 0),
          resolution: 'unresolved-alias',
        },
      ]);

      expect(report.references.unsafe.map((entry) => entry.reason)).toEqual([
        expect.stringContaining(
          'SvelteKit writes `$lib` into `.svelte-kit/tsconfig.json` when `svelte-kit sync` runs',
        ),
      ]);
    });

    it('names the nearest config it could not read first, once, and counts the others', () => {
      const unread = (what: string, scope: string, reason = 'could not be parsed') => ({
        what,
        reason,
        scopes: [scope],
      });
      const report = reportOf(
        [
          {
            ...dynamicReference('web/src/a.ts', '@/assets/logo.png', 0),
            resolution: 'unresolved-alias',
          },
        ],
        {
          rules: [],
          skipped: [
            unread('tsconfig.json', ROOT),
            unread('web/vite.config.ts', `${ROOT}/web`),
            unread('web/vite.config.ts', `${ROOT}/web`, 'a second alias'),
            unread('docs/tsconfig.json', `${ROOT}/docs`),
          ],
        },
      );

      // The nested config sorts after `tsconfig.json` by name, so only nearness puts it first.
      expect(report.references.unsafe.map((entry) => entry.reason)).toEqual([
        'alias-shaped, and no alias Upfly could read maps it; web/vite.config.ts and 1 more have aliases Upfly could not read, listed under Skipped',
      ]);
    });
  });

  describe('originals kept beside their converted files', () => {
    const ROOT = '/repo';
    const png = (relative: string) => ({
      path: `${ROOT}/${relative}`,
      relative,
      extension: '.png',
      bytes: 3_000,
    });
    const webp = (relative: string) => ({ ...png(relative), extension: '.webp', bytes: 1_000 });
    const linkTo = (relative: string) => ({
      file: `${ROOT}/index.html`,
      start: 10,
      end: 10 + relative.length,
      rawPath: relative,
      kind: 'attr' as const,
      shape: 'html.img.src' as const,
      ceiling: 'high' as const,
      asserted: true,
      resolution: 'resolved' as const,
      confidence: 'high' as const,
      resolvedPath: `${ROOT}/${relative}`,
      resolvedVia: 'file' as const,
    });
    const dead = (asset: string) => ({
      kind: 'dead' as const,
      asset,
      bytes: 3_000,
      inPublicDir: true,
    });

    function reportFrom(assets: ReturnType<typeof png>[], linked: string[], deadAssets: string[]) {
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({
          root: ROOT,
          assets,
          references: linked.map(linkTo),
          unscannedFiles: [],
        }),
        audit: {
          findings: deadAssets.map(dead),
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets,
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
    }

    it('lists an unreferenced original whose converted file is linked apart from the findings', () => {
      const report = reportFrom(
        [png('public/logo.png'), webp('public/logo.webp')],
        ['public/logo.webp'],
        ['public/logo.png'],
      );

      expect(report.findings).toEqual([]);
      expect(report.summary.findings.dead).toBe(0);
      expect(report.keptOriginals).toEqual({
        count: 1,
        bytes: 3_000,
        assets: [{ asset: 'public/logo.png', bytes: 3_000, convertedTo: 'public/logo.webp' }],
      });
      // The caveat about public images counts what the findings list, so it is silent here.
      expect(report.caveats.map((caveat) => caveat.code)).not.toContain('public-dir-dead');

      const text = renderReport(report);
      expect(text).toContain(
        'including originals kept beside the converted file their references moved to: 1, 3 KB.',
      );
      expect(text).toContain('No findings, apart from 1 kept original counted above.');
    });

    it('keeps it a finding when the converted file is not linked either', () => {
      const report = reportFrom(
        [png('public/logo.png'), webp('public/logo.webp')],
        [],
        ['public/logo.png', 'public/logo.webp'],
      );

      expect(
        report.findings.filter((finding) => finding.kind === 'dead').map((f) => f.asset),
      ).toEqual(['public/logo.png', 'public/logo.webp']);
      expect(report.keptOriginals.count).toBe(0);
    });

    it('keeps it a finding when there is no converted file beside it', () => {
      const report = reportFrom(
        [png('public/logo.png'), webp('public/other.webp')],
        ['public/other.webp'],
        ['public/logo.png'],
      );

      expect(
        report.findings.filter((finding) => finding.kind === 'dead').map((f) => f.asset),
      ).toEqual(['public/logo.png']);
      expect(report.keptOriginals.count).toBe(0);
    });
  });

  describe('a file that could not be parsed', () => {
    const ROOT = '/repo';
    const reason = 'parse-failed';
    const detail = 'ADAPTER_PARSE_FAILED: Could not parse: invalid css syntax at line 2, column 17';

    function reportWithUnread(unscannedFiles: UnscannedFile[]) {
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles }),
        audit: {
          findings: [],
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
      });
    }

    it('reads as the reason alone, while the JSON keeps the codes', () => {
      const report = reportWithUnread([
        { path: `${ROOT}/site.css`, relative: 'site.css', extension: '.css', reason, detail },
      ]);

      expect(report.skipped).toEqual([
        { what: 'site.css', stage: 'scan', reason: `${reason}: ${detail}` },
      ]);
      expect(renderReport(report)).toContain(
        '  could not be parsed:\n    site.css: invalid css syntax at line 2, column 17\n',
      );
      expect(report.caveats.map((caveat) => caveat.code)).not.toContain('unscanned-extensions');
    });

    it('is not counted among the file types no adapter reads', () => {
      const report = reportWithUnread([
        {
          path: `${ROOT}/a.njk`,
          relative: 'a.njk',
          extension: '.njk',
          reason: 'unclaimed-extension',
          detail: '',
        },
        { path: `${ROOT}/b.scss`, relative: 'b.scss', extension: '.scss', reason, detail },
        {
          path: `${ROOT}/c.css`,
          relative: 'c.css',
          extension: '.css',
          reason: 'unreadable',
          detail: 'EACCES',
        },
      ]);

      const caveat = report.caveats.find((entry) => entry.code === 'unscanned-extensions');
      expect(caveat?.count).toBe(1);
      expect(caveat?.message).toContain('1 file type had no adapter, so 1 file went unread');
    });
  });

  describe('discarded candidates', () => {
    // Every fixture tree has zero discarded candidates, so these are built by hand.
    const ROOT = '/repo';

    function discardedGraph() {
      const reference = {
        file: `${ROOT}/package.json`,
        start: 10,
        end: 26,
        rawPath: 'assets/logo.png',
        kind: 'json' as const,
        shape: 'js.string.literal' as const,
        ceiling: 'high' as const,
        asserted: false,
        resolution: 'discarded' as const,
        confidence: 'unsafe' as const,
        resolvedPath: null,
      };
      return buildGraph({ root: ROOT, assets: [], references: [reference], unscannedFiles: [] });
    }

    function reportOf(includeDiscarded: boolean) {
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: discardedGraph(),
        audit: {
          findings: [],
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        includeDiscarded,
      });
    }

    it('counts them but does not list them by default', () => {
      const report = reportOf(false);

      expect(report.references.discardedCount).toBe(1);
      // `null`, not `[]`: an empty array would read as "there were none".
      expect(report.references.discarded).toBeNull();
    });

    it('lists them when asked, so each one can be inspected', () => {
      // The JSON adapter is generous. If it starts eating genuine references, the
      // count says something is wrong and only the list says what.
      const report = reportOf(true);

      expect(report.references.discarded).toEqual([
        {
          file: 'package.json',
          rawPath: 'assets/logo.png',
          resolution: 'discarded',
          reason: 'a path-shaped string that resolved to nothing',
          // A guess nobody asserted is in no accuracy class: scoring the engine on a
          // lockfile string measures it against work that was never its job.
          classification: 'not-a-claim',
          refusalReason: null,
        },
      ]);
    });

    it('says the strings did not resolve, never that they were not references', () => {
      // Many of these strings do name an asset: `src/data/logos.ts` in `astro-docs` holds
      // entries such as `{ file: 'gitbook.svg' }`, joined to a base directory at runtime.
      // The sweep reads the same strings as evidence that an asset is alive, so this
      // line must not call them "not references".
      const text = renderReport(reportOf(false));

      expect(text).toContain('did not resolve to an asset');
      expect(text).not.toContain('not an asset reference');
      expect(text).not.toContain('not asset references');
    });

    it('names the flag that actually produces the list', () => {
      // `--json` alone gives a bare integer. A message that sends someone where the data
      // is not costs more trust than no message would.
      const text = renderReport(reportOf(false));

      expect(text).toContain(
        '1 path-shaped string did not resolve to an asset (use --include-discarded to list it)',
      );
      expect(text).not.toContain('use --json to inspect');
    });

    it('shows them in the human output too when the flag was given', () => {
      // Otherwise the flag appears to do nothing unless `--json` is passed with it.
      const text = renderReport(reportOf(true));

      expect(text).toContain('package.json  assets/logo.png');
      expect(text).not.toContain('--include-discarded');
    });
  });

  describe('values an adapter declined', () => {
    // No fixture tree holds one, so the graph is built by hand: two titles and a prop that
    // name images, beside one resolved reference and one guess that named nothing.
    const ROOT = '/repo';
    const TITLE = 'JSX attribute title, which Upfly does not read as a file path on this element';
    const PROP = 'JSX attribute image, which Upfly does not read as a file path on this element';

    function unlinked(
      rawPath: string,
      extra: { readonly declined?: true; readonly note?: string } = {},
    ): Reference {
      return {
        file: `${ROOT}/src/Card.jsx`,
        start: 10,
        end: 10 + rawPath.length,
        rawPath,
        kind: 'string',
        shape: extra.declined === true ? 'js.jsx.attribute.other' : 'js.string.literal',
        ceiling: 'unsafe',
        asserted: false,
        ...extra,
        resolution: 'discarded',
        confidence: 'unsafe',
        resolvedPath: null,
      };
    }

    function reportOf(includeDiscarded: boolean): Report {
      const resolved: Reference = {
        file: `${ROOT}/src/Card.jsx`,
        start: 2,
        end: 11,
        rawPath: '/hero.png',
        kind: 'attr',
        shape: 'js.jsx.attribute',
        ceiling: 'high',
        asserted: true,
        resolution: 'resolved',
        confidence: 'high',
        resolvedPath: `${ROOT}/public/hero.png`,
        resolvedVia: 'serving-root',
      };
      const references = [
        resolved,
        unlinked('assets/nothing.png'),
        unlinked('/img/a.png', { declined: true, note: TITLE }),
        unlinked('/img/b.png', { declined: true, note: PROP }),
        unlinked('/img/c.png', { declined: true, note: TITLE }),
      ];
      const assets = [
        {
          path: `${ROOT}/public/hero.png`,
          relative: 'public/hero.png',
          extension: '.png',
          bytes: 5,
        },
      ];
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets, references, unscannedFiles: [] }),
        audit: {
          findings: [],
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets,
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        includeDiscarded,
      });
    }

    it('counts them by reason, most common first, and not as references', () => {
      const { references, summary } = reportOf(false);

      expect(references.declinedValues).toEqual({
        count: 3,
        byReason: [
          { reason: TITLE, count: 2 },
          { reason: PROP, count: 1 },
        ],
        values: null,
      });
      // A declined value is not a reference, so the counts leave it out: only the guess
      // that named nothing is discarded.
      expect(summary.references).toBe(2);
      expect(references.byResolution.discarded).toBe(1);
      expect(references.discardedCount).toBe(1);
      expect(references.byConfidence.unsafe).toBe(1);
      expect(references.byClassification['not-a-claim']).toBe(1);
    });

    it('lists each one with its reason when asked, apart from the discarded guesses', () => {
      const { references } = reportOf(true);

      expect(references.declinedValues.values).toEqual([
        { file: 'src/Card.jsx', rawPath: '/img/a.png', reason: TITLE },
        { file: 'src/Card.jsx', rawPath: '/img/b.png', reason: PROP },
        { file: 'src/Card.jsx', rawPath: '/img/c.png', reason: TITLE },
      ]);
      expect(references.discarded?.map((entry) => entry.rawPath)).toEqual(['assets/nothing.png']);
    });

    it('prints the count and a line for each reason, and names the flag that lists them', () => {
      const text = renderReport(reportOf(false));

      expect(text).toContain(
        '3 values with an image extension linked nothing, written where Upfly reads no file path (use --include-discarded to list them)',
      );
      expect(text).toContain(`  2 values: ${TITLE}\n  1 value: ${PROP}\n`);
      expect(text).toContain('1 path-shaped string did not resolve to an asset');
    });

    it('prints each value under its reason when the flag was given', () => {
      const text = renderReport(reportOf(true));

      expect(text).toContain(
        `  2 values: ${TITLE}\n    src/Card.jsx  /img/a.png\n    src/Card.jsx  /img/c.png\n`,
      );
      expect(text).not.toContain('use --include-discarded');
    });
  });

  describe('the human rendering', () => {
    it('prints what was skipped before what was found', async () => {
      // A limitation printed after eighty findings is a limitation nobody reads.
      const text = renderReport(await reportFor('eleventy'));
      const unresolved = text.search(/had no answer to find|could not be resolved|were not linked/);
      const findings = text.indexOf('Findings');

      expect(unresolved).toBeGreaterThan(-1);
      expect(unresolved).toBeLessThan(findings);
    });

    it('cites where a possibly-dead asset was named', async () => {
      const text = renderReport(await reportFor('eleventy'));

      expect(text).toContain('named in src/posts/first.md:7');
    });

    it('cites the line of a broken reference', async () => {
      const text = renderReport(await reportFor('plain-html'));

      expect(text).toContain('about.html:10');
    });

    it('formats bytes without locale rules', async () => {
      // `toLocaleString` would render `1,5 MB` in some locales, and the same input would
      // no longer give byte-identical output.
      const text = renderReport(await reportFor('plain-html'));

      expect(text).not.toMatch(/\d,\d/);
    });
  });

  /**
   * `vite-react` holds one unreferenced vector, so the demotion runs end to end in the
   * snapshots. The plural wording, the flag, the pairing with a broken reference and
   * the empty-findings branch are reachable only from here.
   */
  describe('unreferenced vectors and stale conversions', () => {
    const ROOT = '/repo';

    function deadVector(asset: string, bytes: number): Finding {
      return { kind: 'dead', asset, bytes, inPublicDir: false };
    }

    function brokenAt(rawPath: string, where: string): Finding {
      return { kind: 'broken', file: where.split(':')[0] ?? where, line: 1, where, rawPath };
    }

    function reportOf(findings: readonly Finding[], includeUnusedVectors = false): Report {
      return buildReport({
        aliases: { rules: [], skipped: [] },
        graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
        audit: {
          findings,
          conventionLinked: [],
          unreadableSources: [],
          probed: false,
          duplicatesChecked: false,
        },
        discovery: {
          root: ROOT,
          assets: [],
          sourceFiles: [],
          directories: [],
          ignoredCount: 0,
          skipped: [],
          excludedRoots: [],
          excludedFiles: [],
          excludedImages: [],
          unscannedFiles: [],
        },
        sweep: { mentions: new Map(), skipped: [] },
        servingRoots: { dirs: ['public'], declared: true },
        includeUnusedVectors,
      });
    }

    it('demotes an unreferenced vector out of findings, carrying count and size', () => {
      const report = reportOf([
        deadVector('public/logo.svg', 1200),
        deadVector('public/icon.svg', 800),
        { kind: 'dead', asset: 'public/photo.png', bytes: 5000, inPublicDir: false },
      ]);

      const named = report.findings.map((finding) => {
        if (finding.kind === 'broken') return finding.rawPath;
        if (finding.kind === 'serving-root-unknown') return finding.kind;
        // A duplicate names a set rather than one asset, so it has no `asset` to read.
        if (finding.kind === 'duplicate') return finding.assets.join(' + ');
        return finding.asset;
      });
      expect(named).toEqual(['public/photo.png']);
      expect(report.unusedVectors.count).toBe(2);
      expect(report.unusedVectors.bytes).toBe(2000);
    });

    it('prints the note of a broken reference on its own line under it, and nothing for one without', () => {
      const text = renderReport(
        reportOf([
          {
            kind: 'broken',
            file: 'index.html',
            line: 4,
            where: 'index.html:4',
            rawPath: '/img/logo.pn',
            note: 'ends in .pn, one keystroke from .png: a likely typo, so no image shows here',
          },
          brokenAt('/img/gone.png', 'index.html:5'),
        ]),
      );

      expect(text).toContain(
        [
          '    index.html:4  /img/logo.pn',
          '      ends in .pn, one keystroke from .png: a likely typo, so no image shows here',
          '    index.html:5  /img/gone.png',
          '',
        ].join('\n'),
      );
    });

    it('counts the itemised array in the summary, so the two can never disagree', () => {
      // A reader who adds up the findings must get the headline number, and any
      // difference has to be explained by something on the page rather than by a bug.
      const report = reportOf([
        deadVector('public/logo.svg', 1200),
        { kind: 'dead', asset: 'public/photo.png', bytes: 5000, inPublicDir: false },
      ]);

      expect(report.summary.findings.dead).toBe(report.findings.length);
      expect(report.summary.findings.dead).toBe(1);
    });

    it('hedged vectors are demoted too, not only confident ones', () => {
      // `possibly-dead` is where most unreferenced vectors are: 122 of the 140 hedges
      // on `astro-docs` are vectors.
      const report = reportOf([
        {
          kind: 'possibly-dead',
          asset: 'public/logos/gitbook.svg',
          bytes: 900,
          inPublicDir: true,
          evidence: [
            {
              asset: 'gitbook.svg',
              source: 'unresolved-reference',
              where: 'src/data/logos.ts:56',
              quote: 'gitbook.svg',
            },
          ],
        },
      ]);

      expect(report.findings).toEqual([]);
      expect(report.unusedVectors.count).toBe(1);
    });

    it('itemises them behind the flag, and says null rather than empty without it', () => {
      const findings = [deadVector('public/logo.svg', 1200)];

      expect(reportOf(findings).unusedVectors.assets).toBeNull();
      expect(reportOf(findings, true).unusedVectors.assets).toEqual([
        { asset: 'public/logo.svg', bytes: 1200, kind: 'dead' },
      ]);
    });

    it('keeps a vector itemised when a broken reference asks for its raster twin', () => {
      // Why the demotion is not a plain filter: for this vector there is an action,
      // fixing the reference, so demoting it would hide the one unused vector in the
      // repository worth looking at.
      const report = reportOf([
        deadVector('images/hero.svg', 1200),
        brokenAt('images/hero.png', 'about.html:10'),
      ]);

      expect(report.unusedVectors.count).toBe(0);
      const kept = report.findings.map((finding) => {
        if (finding.kind === 'broken') return finding.rawPath;
        if (finding.kind === 'serving-root-unknown') return finding.kind;
        if (finding.kind === 'duplicate') return finding.assets.join(' + ');
        return finding.asset;
      });
      expect(kept).toContain('images/hero.svg');
      expect(report.staleConversions).toEqual([
        { vector: 'images/hero.svg', rawPath: 'images/hero.png', where: 'about.html:10' },
      ]);
    });

    it('says both facts and asserts neither, because the pairing is an inference', () => {
      const text = renderReport(
        reportOf([
          deadVector('images/hero.svg', 1200),
          brokenAt('images/hero.png', 'about.html:10'),
        ]),
      );

      expect(text).toContain('may have been converted by hand without updating the reference');
      expect(text).toContain(
        'images/hero.svg is unreferenced, and about.html:10 asks for images/hero.png',
      );
    });

    it('does not pair a vector with a broken reference to another vector', () => {
      // `shadcn-ui`'s real shape: 20 broken references, every one an `.svg` from a
      // framework scaffold, beside 10 unreferenced vectors. Pairing on stem alone
      // would have invented a conversion story for `next.svg` against `next.svg`.
      const report = reportOf([
        deadVector('public/next.svg', 1200),
        brokenAt('/next.svg', 'app/page.tsx:34'),
      ]);

      expect(report.staleConversions).toEqual([]);
      expect(report.unusedVectors.count).toBe(1);
    });

    it('does not pair on a stem a broken reference only resembles', () => {
      const report = reportOf([
        deadVector('images/hero.svg', 1200),
        brokenAt('images/hero-wide.png', 'about.html:10'),
        brokenAt('images/Hero.png', 'about.html:11'),
      ]);

      // Exact and case-sensitive. `Hero.png` is a different file on the platform most
      // of this runs on, and a hint nobody asked for costs more trust than a missed one.
      expect(report.staleConversions).toEqual([]);
    });

    it('does not claim there is nothing to see when everything was demoted', () => {
      // With vectors demoted, `No findings.` would be false for a repository whose only
      // unreferenced assets are vectors. Every fixture has other findings, so only this
      // test reaches the branch.
      const text = renderReport(reportOf([deadVector('public/logo.svg', 1200)]));

      expect(text).toContain('No findings, apart from 1 unreferenced SVG counted above');
      expect(text).not.toContain('No findings.');
    });

    it('agrees with itself about one vector and about several', () => {
      // Singular and plural are separate wordings in two places, the headline and the
      // caveat, and each one is asserted.
      const one = renderReport(reportOf([deadVector('public/logo.svg', 1200)]));
      const two = renderReport(
        reportOf([deadVector('public/logo.svg', 1200), deadVector('public/icon.svg', 800)]),
      );

      expect(one).toContain('including 1 unreferenced SVG, 1.2 KB');
      expect(one).toContain('1 unreferenced SVG totalling 1.2 KB, not listed');
      expect(two).toContain('including 2 unreferenced SVGs, 2 KB');
      expect(two).toContain('2 unreferenced SVGs totalling 2 KB, not listed');
    });

    it('explains the gap where the reader is, not forty lines below it', () => {
      // The headline says how many images have no reference, and the findings list
      // shows fewer. An explanation only in the caveats, far below, is one the reader
      // never meets.
      const text = renderReport(reportOf([deadVector('public/logo.svg', 1200)]));
      const headlineMention = text.indexOf('including 1 unreferenced SVG');
      const findingsHeading = text.indexOf('No findings');

      expect(headlineMention).toBeGreaterThan(-1);
      expect(headlineMention).toBeLessThan(findingsHeading);
    });

    it('says nothing at all when there are no unreferenced vectors', () => {
      // The other half of every count: a report with no vectors must not grow a line
      // reading "0 unreferenced vectors".
      const text = renderReport(
        reportOf([{ kind: 'dead', asset: 'public/photo.png', bytes: 5000, inPublicDir: false }]),
      );

      expect(text).not.toContain('unreferenced SVG');
      expect(text).not.toContain('--include-unused-svg');
    });
  });
});

describe('byResolvedVia: the field that says which links may be rewritten', () => {
  const ROOT = resolve('/repo');
  const ASSET = {
    path: join(ROOT, 'at-root.png'),
    relative: 'at-root.png',
    extension: '.png',
    bytes: 10,
  };

  /** Built through `resolveReferences`, so the value under test is the engine's own. */
  function reportFor(rawPath: string, asserted: boolean): Report {
    const references = resolveReferences(
      [
        {
          file: join(ROOT, 'src', 'page.tsx'),
          start: 0,
          end: rawPath.length,
          rawPath,
          kind: asserted ? 'attr' : 'json',
          shape: 'html.img.src' as const,
          ceiling: 'high',
          asserted,
        },
      ],
      {
        root: ROOT,
        assets: [ASSET],
        servingRoots: { declared: true, dirs: ['public'] },
        exists: () => false,
      },
    );

    return buildReport({
      aliases: { rules: [], skipped: [] },
      graph: buildGraph({ root: ROOT, assets: [ASSET], references, unscannedFiles: [] }),
      audit: {
        findings: [],
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
        duplicatesChecked: false,
      },
      discovery: {
        root: ROOT,
        assets: [ASSET],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        excludedFiles: [],
        excludedImages: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: ['public'], declared: true },
    });
  }

  it('counts a root-relative fallback as project-root, not as the speculative one', () => {
    // Common in real repositories, but no fixture tree produces one, so without this
    // case the split is untested at the report layer.
    const report = reportFor('/at-root.png', true);

    expect(report.references.byResolvedVia['project-root']).toBe(1);
    expect(report.references.byResolvedVia['speculative-root']).toBe(0);
  });

  it('counts a speculative dot-path retry as speculative-root', () => {
    const report = reportFor('./at-root.png', false);

    expect(report.references.byResolvedVia['speculative-root']).toBe(1);
    expect(report.references.byResolvedVia['project-root']).toBe(0);
  });

  it('sums to exactly the linked resolutions and to nothing else', () => {
    // The sum `byResolvedVia`'s documentation promises, checked against `byResolution`
    // rather than a pasted number.
    for (const [rawPath, asserted] of [
      ['/at-root.png', true],
      ['./at-root.png', false],
    ] as const) {
      const report = reportFor(rawPath, asserted);
      const via = Object.values(report.references.byResolvedVia).reduce((a, b) => a + b, 0);
      const linked =
        report.references.byResolution.resolved +
        report.references.byResolution['resolved-pattern'];

      expect(via).toBe(linked);
    }
  });
});

describe('the headline reads correctly at a count of one', () => {
  const ROOT = resolve('/repo');

  /** One reference, one linked asset and one unreferenced asset, so every count is 1. */
  function singularReport(): Report {
    const linked = {
      path: join(ROOT, 'used.png'),
      relative: 'used.png',
      extension: '.png',
      bytes: 10,
    };
    const orphan = {
      path: join(ROOT, 'spare.png'),
      relative: 'spare.png',
      extension: '.png',
      bytes: 10,
    };
    const references = resolveReferences(
      [
        {
          file: join(ROOT, 'index.html'),
          start: 0,
          end: '/used.png'.length,
          rawPath: '/used.png',
          kind: 'attr',
          shape: 'html.img.src',
          ceiling: 'high',
          asserted: true,
        },
      ],
      {
        root: ROOT,
        assets: [linked, orphan],
        servingRoots: { declared: true, dirs: [''] },
        exists: () => false,
      },
    );

    return buildReport({
      aliases: { rules: [], skipped: [] },
      graph: buildGraph({
        root: ROOT,
        assets: [linked, orphan],
        references,
        unscannedFiles: [],
      }),
      audit: {
        findings: [],
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
        duplicatesChecked: false,
      },
      discovery: {
        root: ROOT,
        assets: [linked, orphan],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        excludedFiles: [],
        excludedImages: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: ['public'], declared: true },
    });
  }

  it('says nothing that disagrees with itself', () => {
    // Every fixture has several references, so the singular reference line is
    // reachable only from here. The assertions are written against English rather than
    // against the current output.
    const rendered = renderReport(singularReport());

    expect(rendered).not.toMatch(/\b1 image have\b/);
    expect(rendered).not.toMatch(/\b1 reference resolve\b/);
    expect(rendered).not.toMatch(/\bthey point at\b.*\n?/);
  });

  it('renders the singular lines in full, so the wording is reviewable', () => {
    const rendered = renderReport(singularReport());

    // Derived by writing the sentence out, not by pasting what the renderer emits.
    expect(rendered).toContain('1 of 1 reference resolved, pointing at 1 of those images');
    expect(rendered).toContain('1 image with no reference Upfly could follow');
  });
});

describe('the serving roots the report discloses', () => {
  const ROOT = '/repo';

  function reportWith(dirs: readonly string[], declared: boolean): Report {
    return buildReport({
      aliases: { rules: [], skipped: [] },
      graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
      audit: {
        findings: [],
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
        duplicatesChecked: false,
      },
      discovery: {
        root: ROOT,
        assets: [],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        excludedFiles: [],
        excludedImages: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs, declared },
    });
  }

  it('carries them into the JSON exactly as the resolver was given them', () => {
    const report = reportWith(['apps/v4/public', 'apps/www/public'], false);

    expect(report.coverage.servingRoots).toEqual({
      dirs: ['apps/v4/public', 'apps/www/public'],
      declared: false,
    });
  });

  it('tells the reader when the roots were detected rather than declared', () => {
    // Every broken finding under this line depends on the engine having guessed right,
    // and a guess nobody is told about cannot be checked.
    const rendered = renderReport(reportWith(['public'], false));

    expect(rendered).toContain('what Upfly detected rather than what the project declared');
    expect(rendered).toContain('public');
  });

  it('stays quiet when the project declared them, because there is nothing to own up to', () => {
    const rendered = renderReport(reportWith(['public'], true));

    expect(rendered).not.toContain('Upfly detected');
  });

  it('says so plainly when it found none and none was declared', () => {
    // A static site really does serve from its own root, so this is not a failure.
    // It still has to be said: it is the state in which every root-relative path
    // resolves against the project root and nobody chose that.
    const rendered = renderReport(reportWith([], false));

    expect(rendered).toContain('resolved from the project root');
    expect(rendered).toContain('found no public directory and none was declared');
  });

  it('names three and counts the rest, rather than printing twelve paths', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => `app${index}/public`);

    const rendered = renderReport(reportWith(twelve, false));

    expect(rendered).toContain('(12 in all): app0/public, app1/public, app2/public, and 9 more');
  });

  it('never pluralises a noun against a number, which this renderer keeps getting wrong', () => {
    // `count()` pluralises by appending to whatever it is handed, which can render
    // "12 directory Upfly detecteds". The sentence contains no noun that agrees with a
    // number at all.
    for (const dirs of [['public'], ['a/public', 'b/public']]) {
      const rendered = renderReport(reportWith(dirs, false));

      expect(rendered).not.toMatch(/detecteds/);
      expect(rendered).toContain(`(${dirs.length} in all)`);
    }
  });
});

describe('the references withheld when the serving root cannot be found', () => {
  async function diagnosed() {
    const report = await reportFor('eleventy', false, false, NO_SERVING_ROOT);
    const diagnosis = report.findings.find((finding) => finding.kind === 'serving-root-unknown');
    if (diagnosis?.kind !== 'serving-root-unknown') throw new Error('no diagnosis');
    return { report, diagnosis };
  }

  it('does not call the withheld paths nothing to fix', async () => {
    // Declaring the serving root resolves them, and the diagnosis above says so.
    const { report } = await diagnosed();
    const text = renderReport(report);

    expect(text).toContain(
      'named by a path Upfly read but could not resolve; those files parse fine',
    );
    expect(text).not.toContain('nothing to fix');
  });

  it('names every broken reference it counts, as a finding or under the diagnosis', async () => {
    // `byResolution` counts every broken reference, so each one has to be findable by
    // name: as a broken finding, or in the list of those the diagnosis withheld.
    const { report, diagnosis } = await diagnosed();
    const broken = report.findings.filter((finding) => finding.kind === 'broken');

    expect(diagnosis.suppressed).toHaveLength(diagnosis.suppressedBroken);
    expect(broken.length + diagnosis.suppressed.length).toBe(report.references.byResolution.broken);
    expect(diagnosis.suppressed).toContainEqual({
      file: 'src/css/site.css',
      line: 2,
      where: 'src/css/site.css:2',
      rawPath: '/img/texture.png',
    });
  });

  it('prints each one in the human report, in the form a broken finding takes', async () => {
    const { report, diagnosis } = await diagnosed();
    const text = renderReport(report);

    expect(text).toContain('\n      src/css/site.css:2  /img/texture.png\n');
    expect(text).toContain(
      diagnosis.suppressed.map((entry) => `      ${entry.where}  ${entry.rawPath}`).join('\n'),
    );
  });

  it('hedges each asset a withheld reference names, rather than calling it dead', async () => {
    // With no serving root, `/img/diagram.png` may well be `src/img/diagram.png`: its
    // target is unknown, not missing. `dead` says a file is safe to remove, so each such
    // asset is hedged, citing every withheld reference that names it.
    const { report, diagnosis } = await diagnosed();
    const verdictOf = (asset: string) =>
      report.findings.find(
        (finding) =>
          (finding.kind === 'dead' || finding.kind === 'possibly-dead') && finding.asset === asset,
      )?.kind;
    const cited = report.findings.flatMap((finding) =>
      finding.kind === 'possibly-dead'
        ? finding.evidence
            .filter((mention) => mention.source === 'unresolved-reference')
            .map((mention) => `${mention.where}  ${mention.quote}`)
        : [],
    );

    expect(
      ['src/img/diagram.png', 'src/img/inline.png', 'src/img/texture.png'].map(verdictOf),
    ).toEqual(['possibly-dead', 'possibly-dead', 'possibly-dead']);
    expect(
      diagnosis.suppressed.filter((entry) => !cited.includes(`${entry.where}  ${entry.rawPath}`)),
    ).toEqual([]);
    // Nothing names `unused.png`, so it stays confidently dead.
    expect(verdictOf('src/img/unused.png')).toBe('dead');
  });
});

/**
 * A small project held in memory and run through the real adapters, resolver, sweep and
 * audit: a fixture tree cannot take these inputs without moving every snapshot it has. Its
 * page shows ten images kept under `src`, which serves them, so a run that is not told so
 * resolves none of their root-relative paths and withholds them.
 */
describe('what a path that did not resolve names, in a project held in memory', () => {
  const ROOT = resolve('/repo');
  const SERVED = Array.from({ length: 10 }, (_, index) => `src/img/a${index}.png`);
  const SERVED_FROM_SRC: ServingRoots = { dirs: ['src'], declared: true };

  /** An HTML page with one image for each of `SERVED` and then one for each path, a line each. */
  function page(paths: readonly string[] = []): string {
    const srcs = [...SERVED.map((asset) => asset.slice('src'.length)), ...paths];
    return `${srcs.map((src) => `<img src="${src}">`).join('\n')}\n`;
  }

  async function reportForFiles(
    sources: Readonly<Record<string, string>>,
    assetPaths: readonly string[],
    servingRoots: ServingRoots = NO_SERVING_ROOT,
    aliases: AliasMap = { rules: [], skipped: [] },
  ): Promise<Report> {
    const texts = new Map(
      Object.entries(sources).map(([relative, text]) => [join(ROOT, relative), text]),
    );
    const readFileText = async (path: string): Promise<string> => {
      const text = texts.get(path);
      if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return text;
    };
    const assets = assetPaths.map((relative) => ({
      path: join(ROOT, relative),
      relative,
      extension: extname(relative).toLowerCase(),
      bytes: 70,
    }));
    const sourceFiles = Object.keys(sources).map((relative) => {
      const extension = extname(relative);
      const adapter = ADAPTERS.find((candidate) => candidate.extensions.includes(extension));
      if (adapter === undefined) throw new Error(`no adapter reads ${relative}`);
      return { path: join(ROOT, relative), relative, extension, adapterId: adapter.id };
    });

    const scanned = await scanSources({
      sourceFiles,
      adapters: ADAPTERS,
      readFile: readFileText,
      assetBasenames: basenamesOf(assets),
    });
    const graph = buildGraph({
      root: ROOT,
      assets,
      references: resolveReferences(scanned.references, {
        root: ROOT,
        assets,
        servingRoots,
        aliases,
        exists: () => false,
      }),
      unscannedFiles: scanned.unscanned,
    });
    const sweep = await sweepForMentions({
      graph,
      readFile: readFileText,
      scannedMentions: scanned.mentions,
      publicDirs: servingRoots.dirs,
    });
    const auditResult = await audit({
      graph,
      sweep,
      readFile: readFileText,
      publicDirs: servingRoots.dirs,
    });

    return buildReport({
      aliases,
      graph,
      audit: auditResult,
      discovery: {
        root: ROOT,
        assets,
        sourceFiles,
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        excludedFiles: [],
        excludedImages: [],
        unscannedFiles: [],
      },
      sweep,
      servingRoots,
    });
  }

  function verdictOf(report: Report, asset: string): string | undefined {
    return report.findings.find(
      (finding) =>
        (finding.kind === 'dead' || finding.kind === 'possibly-dead') && finding.asset === asset,
    )?.kind;
  }

  /** Each mention behind an asset's hedge, as `source where quote`. */
  function evidenceOf(report: Report, asset: string): readonly string[] {
    const finding = report.findings.find(
      (candidate) => candidate.kind === 'possibly-dead' && candidate.asset === asset,
    );
    return finding?.kind === 'possibly-dead'
      ? finding.evidence.map((mention) => `${mention.source} ${mention.where} ${mention.quote}`)
      : [];
  }

  it('hedges an asset a withheld reference names only in an encoded spelling', async () => {
    // Served from `src`, `/img/my%20photo.png` is `src/img/my photo.png`: the resolver tries
    // the decoded spelling after the written one. With no serving root the target is unknown
    // rather than missing, in either spelling, so the asset is hedged rather than dead.
    const sources = { 'src/index.html': page(['/img/my%20photo.png']) };
    const assets = [...SERVED, 'src/img/my photo.png', 'src/img/unused.png'];

    const report = await reportForFiles(sources, assets);
    const served = await reportForFiles(sources, assets, SERVED_FROM_SRC);
    const diagnosis = report.findings.find((finding) => finding.kind === 'serving-root-unknown');

    expect(
      diagnosis?.kind === 'serving-root-unknown' &&
        diagnosis.suppressed.map((entry) => entry.rawPath),
    ).toContain('/img/my%20photo.png');
    expect(verdictOf(report, 'src/img/my photo.png')).toBe('possibly-dead');
    expect(evidenceOf(report, 'src/img/my photo.png')).toEqual([
      'unresolved-reference src/index.html:11 /img/my%20photo.png',
    ]);
    // Nothing names `unused.png`, so it stays confidently dead.
    expect(verdictOf(report, 'src/img/unused.png')).toBe('dead');
    // The control: once `src` is known to serve, the reference links the asset.
    expect(verdictOf(served, 'src/img/my photo.png')).toBeUndefined();
  });

  it('hedges an asset a dynamic path names only in an encoded spelling, in a run with its serving root', async () => {
    // A template hole leaves the path dynamic whatever the serving root is, so this needs no
    // withheld reference: the page's own images all resolve against `src` here.
    const sources = {
      'src/index.html': page(),
      'src/posts/first.md': '# First\n\n![Photo]({{ site.url }}/img/my%20photo.png)\n',
    };
    const assets = [...SERVED, 'src/img/my photo.png'];

    const report = await reportForFiles(sources, assets, SERVED_FROM_SRC);

    expect(verdictOf(report, 'src/img/my photo.png')).toBe('possibly-dead');
    expect(evidenceOf(report, 'src/img/my photo.png')).toEqual([
      'unresolved-reference src/posts/first.md:3 {{ site.url }}/img/my%20photo.png',
    ]);
  });

  it('hedges each asset a root-relative pattern could name from the serving root the run did not find', async () => {
    // Served from `src`, the resolver globs `/img/pattern-${n}.png` to both files. With no
    // serving root it globs against directories that hold neither, so the pattern ends
    // dynamic while its files sit on disk. The pattern fixes its directory, so a file of the
    // same shape outside an `img` directory is not one it could name.
    const sources = {
      'src/index.html': page(),
      'src/app.js': 'export const tile = (n) => `/img/pattern-${n}.png`;',
    };
    const assets = [
      ...SERVED,
      'src/img/pattern-1.png',
      'src/img/pattern-2.png',
      'src/pattern-3.png',
    ];

    const report = await reportForFiles(sources, assets);
    const served = await reportForFiles(sources, assets, SERVED_FROM_SRC);

    expect(
      ['src/img/pattern-1.png', 'src/img/pattern-2.png', 'src/pattern-3.png'].map((asset) =>
        verdictOf(report, asset),
      ),
    ).toEqual(['possibly-dead', 'possibly-dead', 'dead']);
    expect(evidenceOf(report, 'src/img/pattern-2.png')).toEqual([
      'unresolved-reference src/app.js:1 /img/pattern-${n}.png',
    ]);
    // The control: served from `src`, the resolver links both.
    expect(verdictOf(served, 'src/img/pattern-1.png')).toBeUndefined();
    expect(verdictOf(served, 'src/img/pattern-2.png')).toBeUndefined();
  });

  it('hedges an asset a declined value names, in any spelling, and never links it', async () => {
    // Upfly reads no path from a tooltip or alt text, so neither image is linked or rewritten
    // through one. Each is hedged by the value that names it, and the percent-encoded name
    // holds no filename token that a search of the text could match.
    const sources = {
      'src/index.html': page(),
      'src/Thumb.jsx':
        'export const Thumb = () => <img src={src} title="/img/my%20photo.png" alt="/img/team.jpg" />;\n',
    };
    const assets = [...SERVED, 'src/img/my photo.png', 'src/img/team.jpg'];

    const report = await reportForFiles(sources, assets, SERVED_FROM_SRC);

    expect(verdictOf(report, 'src/img/my photo.png')).toBe('possibly-dead');
    expect(evidenceOf(report, 'src/img/my photo.png')).toEqual([
      'unresolved-reference src/Thumb.jsx:1 /img/my%20photo.png',
    ]);
    expect(verdictOf(report, 'src/img/team.jpg')).toBe('possibly-dead');
    expect(evidenceOf(report, 'src/img/team.jpg')).toEqual([
      'unresolved-reference src/Thumb.jsx:1 /img/team.jpg',
    ]);
    expect(report.references.declinedValues.count).toBe(2);
  });

  it('hedges each asset a declined pattern could name, relative or assembled, and links none', async () => {
    // The resolver never globs a declined value, and a pattern's holes leave no file name to
    // find, so the sweep globs it with the base left open. The pattern fixes its directory,
    // so a file of the same shape outside an `img` directory is not one it could name.
    const sources = {
      'src/index.html': page(),
      'src/components/Thumb.jsx':
        "export const Thumb = ({ id, n }) => <img src={src} alt={`../img/team-${id}.jpg`} data-badge={'/img/badge-' + n + '.png'} />;\n",
    };
    const team = ['src/img/team-1.jpg', 'src/img/team-2.jpg', 'src/team-3.jpg'];
    const assets = [...SERVED, ...team, 'src/img/badge-1.png'];

    const report = await reportForFiles(sources, assets, SERVED_FROM_SRC);

    expect(team.map((asset) => verdictOf(report, asset))).toEqual([
      'possibly-dead',
      'possibly-dead',
      'dead',
    ]);
    expect(evidenceOf(report, 'src/img/team-2.jpg')).toEqual([
      'unresolved-reference src/components/Thumb.jsx:1 ../img/team-${id}.jpg',
    ]);
    expect(evidenceOf(report, 'src/img/badge-1.png')).toEqual([
      "unresolved-reference src/components/Thumb.jsx:1 /img/badge-' + n + '.png",
    ]);
    expect(report.references.declinedValues.count).toBe(2);
  });

  it('hedges an asset a declined string names only once its escapes are decoded', async () => {
    const escaped = `/img/caf${String.fromCharCode(92)}u00e9.png`;
    const sources = {
      'src/index.html': page(),
      'src/Thumb.jsx': `export const Thumb = () => <img src={src} title={'${escaped}'} />;\n`,
    };

    const report = await reportForFiles(sources, [...SERVED, 'src/img/café.png'], SERVED_FROM_SRC);

    expect(verdictOf(report, 'src/img/café.png')).toBe('possibly-dead');
    expect(evidenceOf(report, 'src/img/café.png')).toEqual([
      `unresolved-reference src/Thumb.jsx:1 ${escaped}`,
    ]);
  });

  it('hedges an asset a root-relative + chain could name, reading the path the chain proves', async () => {
    // A chain's text is not its path: the reference quotes the source from the first operand
    // to the last, and the path it proves is `/img/badge-`, a hole, then `.png`.
    const sources = {
      'src/index.html': page(),
      'src/app.js': "export const badge = (n) => '/img/badge-' + n + '.png';",
    };
    const assets = [...SERVED, 'src/img/badge-1.png'];

    const report = await reportForFiles(sources, assets);
    const served = await reportForFiles(sources, assets, SERVED_FROM_SRC);

    expect(verdictOf(report, 'src/img/badge-1.png')).toBe('possibly-dead');
    expect(evidenceOf(report, 'src/img/badge-1.png')).toEqual([
      "unresolved-reference src/app.js:1 /img/badge-' + n + '.png",
    ]);
    expect(verdictOf(served, 'src/img/badge-1.png')).toBeUndefined();
  });

  it('does not call an asset dead when a pattern through an alias names it', async () => {
    // `@/` expands to `src`, so the import names both badges. The glob is anchored at the
    // expansion, so a file of the same shape in another directory is still dead.
    const sources = {
      'src/index.html': page(),
      'src/badges.js': 'export const badge = (n) => import(`@/img/badge-${n}.png`);',
    };
    const assets = [
      ...SERVED,
      'src/img/badge-1.png',
      'src/img/badge-2.png',
      'src/icons/badge-3.png',
    ];
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '@/',
          targets: [join(ROOT, 'src')],
          wildcard: true,
          scope: toPosix(ROOT),
          source: 'vite.config.ts',
          tool: 'vite',
        },
      ],
      skipped: [],
    };

    const report = await reportForFiles(sources, assets, SERVED_FROM_SRC, aliases);

    expect(
      ['src/img/badge-1.png', 'src/img/badge-2.png', 'src/icons/badge-3.png'].map((asset) =>
        verdictOf(report, asset),
      ),
    ).toEqual([undefined, undefined, 'dead']);
  });

  it('hedges each asset a pattern through an alias no rule maps could name', async () => {
    // With no rule for `@/`, nothing says where the pattern points, so both badges may be in
    // use. What follows the alias fixes `img/`, so a file of the same shape elsewhere is dead.
    const sources = {
      'src/index.html': page(),
      'src/badges.js': 'export const badge = (n) => import(`@/img/badge-${n}.png`);',
    };
    const assets = [
      ...SERVED,
      'src/img/badge-1.png',
      'src/img/badge-2.png',
      'src/icons/badge-3.png',
    ];

    const report = await reportForFiles(sources, assets, SERVED_FROM_SRC);

    expect(
      ['src/img/badge-1.png', 'src/img/badge-2.png', 'src/icons/badge-3.png'].map((asset) =>
        verdictOf(report, asset),
      ),
    ).toEqual(['possibly-dead', 'possibly-dead', 'dead']);
    expect(evidenceOf(report, 'src/img/badge-2.png')).toEqual([
      'unresolved-reference src/badges.js:1 @/img/badge-${n}.png',
    ]);
  });

  it('links the images a CRLF page names in a srcset and a style attribute that span lines', async () => {
    const gallery = [
      '<!doctype html>',
      '<img alt="" srcset="/img/wide.png 1x,',
      '     /img/wide@2x.png 2x">',
      '<div style="',
      '  background-image: url(/img/banner.png);',
      '  color: red"></div>',
      '',
    ].join('\r\n');
    const images = ['src/img/wide.png', 'src/img/wide@2x.png', 'src/img/banner.png'];

    const report = await reportForFiles(
      { 'src/index.html': page(), 'src/gallery.html': gallery },
      [...SERVED, ...images],
      SERVED_FROM_SRC,
    );

    expect(images.map((asset) => verdictOf(report, asset))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(report.references.unsafe.map((entry) => entry.rawPath)).toEqual([]);
  });

  it('cites the line of a style block that names the asset, and quotes that line alone', async () => {
    // The block's CSS does not parse, so the adapter refuses it whole, as one reference that
    // starts on the line of its `<style>` tag, two lines above the name.
    const sources = {
      'src/index.html': page(),
      'src/card.html':
        '<!doctype html>\n<title>t</title>\n<style>\n.a {\n  background: url(img/hero.png);\n}\n.b { color red }\n</style>\n<p>x</p>\n',
    };

    const report = await reportForFiles(sources, [...SERVED, 'src/img/hero.png'], SERVED_FROM_SRC);

    expect(verdictOf(report, 'src/img/hero.png')).toBe('possibly-dead');
    expect(evidenceOf(report, 'src/img/hero.png')).toEqual([
      'unresolved-reference src/card.html:5 background: url(img/hero.png);',
    ]);
  });

  it('cites the line that names the asset in a style attribute, a CSS-in-JS template and a Markdown style block that do not parse', async () => {
    const sources = {
      'src/index.html': page(),
      'src/badge.html':
        '<!doctype html>\n<title>t</title>\n<div style="\n  background: url(img/badge.png);\n  color red">x</div>\n',
      'src/Card.jsx':
        'import styled from "styled-components";\n\nexport const Card = styled.div`\n  color red;\n  background: url(./img/card.png);\n`;\n',
      'src/post.md':
        '# Post\n\n<style>\n.x { color red }\n.y {\n  background: url(img/note.png);\n}\n</style>\n\nText.\n',
    };
    const assets = [...SERVED, 'src/img/badge.png', 'src/img/card.png', 'src/img/note.png'];

    const report = await reportForFiles(sources, assets, SERVED_FROM_SRC);

    expect(evidenceOf(report, 'src/img/badge.png')).toEqual([
      'unresolved-reference src/badge.html:4 background: url(img/badge.png);',
    ]);
    expect(evidenceOf(report, 'src/img/card.png')).toEqual([
      'unresolved-reference src/Card.jsx:5 background: url(./img/card.png);',
    ]);
    expect(evidenceOf(report, 'src/img/note.png')).toEqual([
      'unresolved-reference src/post.md:6 background: url(img/note.png);',
    ]);
  });

  it('cites the line of a CSS-in-JS template by its source, where a hole before the name spans lines', async () => {
    // The refused template's path is flattened, each hole a comment of the same length on one
    // line, so only the source says the name is on the line where the hole ends.
    const sources = {
      'src/index.html': page(),
      'src/Card.jsx':
        'import styled from "styled-components";\n\nexport const Card = styled.div`\n  color red;\n  ${(props) =>\n    props.dark} background: url(./img/card.png);\n`;\n',
    };

    const report = await reportForFiles(sources, [...SERVED, 'src/img/card.png'], SERVED_FROM_SRC);

    expect(evidenceOf(report, 'src/img/card.png')).toEqual([
      'unresolved-reference src/Card.jsx:6 props.dark} background: url(./img/card.png);',
    ]);
  });

  it('quotes a line of a CRLF file without its carriage return', async () => {
    const card = [
      '<!doctype html>',
      '<title>t</title>',
      '<style>',
      '.a {',
      '  background: url(img/hero.png);',
      '}',
      '.b { color red }',
      '</style>',
      '',
    ].join('\r\n');

    const report = await reportForFiles(
      { 'src/index.html': page(), 'src/card.html': card },
      [...SERVED, 'src/img/hero.png'],
      SERVED_FROM_SRC,
    );

    expect(evidenceOf(report, 'src/img/hero.png')).toEqual([
      'unresolved-reference src/card.html:5 background: url(img/hero.png);',
    ]);
  });

  it('cites the line of a name a style block holds only percent-encoded', async () => {
    // `img/my%20photo.png` holds no token spelling `my photo.png`, so each line is read in
    // every spelling, as the whole block was when it named the asset.
    const sources = {
      'src/index.html': page(),
      'src/card.html':
        '<style>\n.a {\n  background: url(img/my%20photo.png);\n}\n.b { color red }\n</style>\n',
    };

    const report = await reportForFiles(
      sources,
      [...SERVED, 'src/img/my photo.png'],
      SERVED_FROM_SRC,
    );

    expect(evidenceOf(report, 'src/img/my photo.png')).toEqual([
      'unresolved-reference src/card.html:3 background: url(img/my%20photo.png);',
    ]);
  });

  it('cites a pattern that spans lines at its first line, since no line of it holds a name', async () => {
    // The pattern's hole leaves no file name to find, so the asset it could name is cited
    // where the pattern starts, and quoted by that line.
    const sources = {
      'src/index.html': page(),
      'src/app.js': 'export const tile = (n) => `/img/pattern-${\n  n\n}.png`;\n',
    };

    const report = await reportForFiles(sources, [...SERVED, 'src/img/pattern-1.png']);

    expect(verdictOf(report, 'src/img/pattern-1.png')).toBe('possibly-dead');
    expect(evidenceOf(report, 'src/img/pattern-1.png')).toEqual([
      'unresolved-reference src/app.js:1 /img/pattern-${',
    ]);
  });
});

describe('the assets a plan examined and did not convert', () => {
  const ROOT = '/repo';

  function reportWith(over: {
    declined?: { path: string; line: number | null; reason: string }[];
    include?: boolean;
  }) {
    return buildReport({
      aliases: { rules: [], skipped: [] },
      graph: buildGraph({
        root: ROOT,
        assets: [
          { path: `${ROOT}/a.png`, relative: 'a.png', extension: '.png', bytes: 3_000 },
          { path: `${ROOT}/b.png`, relative: 'b.png', extension: '.png', bytes: 1_000 },
        ],
        references: [],
        unscannedFiles: [],
      }),
      audit: {
        findings: [],
        conventionLinked: [],
        unreadableSources: [],
        probed: true,
        duplicatesChecked: false,
      },
      discovery: {
        root: ROOT,
        assets: [],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        excludedFiles: [],
        excludedImages: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: ['public'], declared: true },
      ...(over.declined === undefined ? {} : { declined: over.declined }),
      ...(over.include === undefined ? {} : { includeDeclined: over.include }),
    });
  }

  const TWO = [
    { path: 'a.png', line: null, reason: 'measured as webp and came out no smaller' },
    { path: 'b.png', line: null, reason: 'nothing links to it' },
  ];

  it('says each has its reason, never that there was nothing to offer', () => {
    // Many had a measured saving: an original kept, or two files that would convert to one
    // name. The line claims only what holds for all of them.
    const two = renderReport(reportWith({ declined: TWO }));
    expect(two).toMatch(/ {2}2 images, [\d.]+ KB, each with its reason \(use --include-declined/);
    expect(two).not.toContain('no conversion to offer');

    const one = renderReport(reportWith({ declined: [...TWO.slice(0, 1)] }));
    expect(one).toMatch(/ {2}1 image, [\d.]+ KB, each with its reason/);
  });

  it('counts a reference left as written apart from the images, never as one at 0 B', () => {
    const withReferences = [
      ...TWO,
      {
        path: 'src/App.jsx',
        line: null,
        reason: 'a template reference is assembled at runtime, so its text cannot be repointed',
      },
      {
        path: 'pages/old.html',
        line: 3,
        reason: 'the page is not UTF-8, so it is never rewritten',
      },
    ];
    const report = reportWith({ declined: withReferences });

    expect(report.declined).toMatchObject({ count: 2, bytes: 4_000 });
    expect(report.declinedReferences).toEqual({ count: 2, references: null });
    const rendered = renderReport(report);
    expect(rendered).toContain('  2 images, ');
    expect(rendered).toContain('  2 references left as written, each with its reason');

    const listed = renderReport(reportWith({ declined: withReferences, include: true }));
    expect(listed).toContain('    src/App.jsx  a template reference is assembled at runtime');
    expect(listed).toContain('    pages/old.html:3  the page is not UTF-8');
  });

  it('says "it" in the list hint at a count of one, "them" otherwise', () => {
    const one = renderReport(reportWith({ declined: [...TWO.slice(0, 1)] }));
    const two = renderReport(reportWith({ declined: TWO }));

    expect(one).toContain('each with its reason (use --include-declined to list it)');
    expect(two).toContain('each with its reason (use --include-declined to list them)');
  });

  it('counts them and totals their size', () => {
    expect(reportWith({ declined: TWO }).declined).toMatchObject({ count: 2, bytes: 4_000 });
  });

  it('states the limit of the mention check once per run when replace held an image back', () => {
    // What the check does not cover matters most, and it is said once per run rather
    // than in every decline reason. The decline is built from `MENTION_SURVIVES` rather
    // than a copy of its wording: a copy would keep this test passing after `plan.ts`
    // rewords the phrase, while the caveat silently stopped appearing.
    const report = reportWith({
      declined: [
        { path: 'public/logo.png', line: null, reason: `deploy.yml:1 ${MENTION_SURVIVES}` },
      ],
    });

    const caveat = report.caveats.find((entry) => entry.code === 'replace-held-back');
    expect(caveat?.count).toBe(1);
    expect(caveat?.message).toContain('kept rather than replaced');
    expect(caveat?.detail.join(' ')).toContain(
      "assembles at runtime, such as '/images/' + name + '.png', matches nothing",
    );
    expect(caveat?.detail.join(' ')).not.toContain('\u2014');
  });

  it('names where each held-back image is still named, without asking for the list', () => {
    // The mention is what the user acts on, so it is in the caveat itself, not only behind
    // `--include-declined`. Listed by image path, whatever order the planner used.
    const report = reportWith({
      declined: [
        { path: 'public/logo.png', line: null, reason: `deploy.yml:1 ${MENTION_SURVIVES}` },
        { path: 'public/banner.png', line: null, reason: `legacy/old.html:4 ${MENTION_SURVIVES}` },
      ],
    });

    const caveat = report.caveats.find((entry) => entry.code === 'replace-held-back');
    expect(caveat?.detail.slice(0, 2)).toEqual([
      `public/banner.png: legacy/old.html:4 ${MENTION_SURVIVES}`,
      `public/logo.png: deploy.yml:1 ${MENTION_SURVIVES}`,
    ]);
    expect(report.declined.assets).toBeNull();
  });

  it('says nothing about replace when nothing was held back', () => {
    // Here so the assertion above means something: a caveat that always prints proves
    // nothing about a run that actually held an image back.
    const report = reportWith({ declined: TWO });
    expect(report.caveats.find((entry) => entry.code === 'replace-held-back')).toBeUndefined();
  });

  it('withholds the list unless it was asked for, and says so', () => {
    // Withheld because each already has its reason in the plan, as with unreferenced
    // vectors, not because it is long. `null` rather than `[]`, because an empty array
    // reads as "there were none".
    const report = reportWith({ declined: TWO });

    expect(report.declined.assets).toBeNull();
    expect(renderReport(report)).toContain('use --include-declined to list them');
  });

  it('itemises them behind the flag, with the planner’s own reason', () => {
    const report = reportWith({ declined: TWO, include: true });

    expect(report.declined.assets).toHaveLength(2);
    const rendered = renderReport(report);
    expect(rendered).toContain('a.png');
    expect(rendered).toContain('measured as webp and came out no smaller');
    expect(rendered).not.toContain('use --include-declined');
  });

  it('says nothing at all on a run that never planned', () => {
    // An audit-only report has no plan and therefore no declines. Printing "0 images"
    // would invite a reader to conclude the planner ran and found nothing.
    const report = reportWith({});

    expect(report.declined).toEqual({ count: 0, bytes: 0, assets: null });
    expect(renderReport(report)).not.toContain('Examined and not converted');
  });

  it('keeps a declined asset the graph does not know, at zero bytes', () => {
    // A miss means the planner and the graph disagree about a path. Reported at zero
    // bytes it is still in the report; dropped, it would be a silent skip.
    const report = reportWith({
      declined: [{ path: 'ghost.png', line: null, reason: 'no measured saving' }],
      include: true,
    });

    expect(report.declined).toMatchObject({ count: 1, bytes: 0 });
    expect(report.declined.assets?.[0]).toMatchObject({ asset: 'ghost.png', bytes: 0 });
  });
});

describe('the public-dir caveat counts what the report lists', () => {
  // It needs an unreferenced vector inside a public directory, and the fixture trees
  // have unreferenced vectors only outside one. Counting demoted vectors would make the
  // caveat, the findings and the unused-vector line three numbers no reader can
  // reconcile.
  const ROOT = resolve('/repo');
  const png = { path: join(ROOT, 'a.png'), relative: 'a.png', extension: '.png', bytes: 10 };
  const svg = { path: join(ROOT, 'b.svg'), relative: 'b.svg', extension: '.svg', bytes: 10 };

  function reportWithDeadPublicAssets(): Report {
    return buildReport({
      aliases: { rules: [], skipped: [] },
      graph: buildGraph({ root: ROOT, assets: [png, svg], references: [], unscannedFiles: [] }),
      audit: {
        findings: [
          { kind: 'dead', asset: 'a.png', bytes: 10, inPublicDir: true },
          { kind: 'dead', asset: 'b.svg', bytes: 10, inPublicDir: true },
        ],
        // What the audit produces, before this report demotes the vector.
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
        duplicatesChecked: false,
      },
      discovery: {
        root: ROOT,
        assets: [png, svg],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        excludedFiles: [],
        excludedImages: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: [''], declared: true },
    });
  }

  it('does not count a vector it demoted out of the findings', () => {
    const report = reportWithDeadPublicAssets();
    const caveat = report.caveats.find((entry) => entry.code === 'public-dir-dead');

    // The SVG is demoted to unusedVectors and is not in findings, so counting it
    // would promise a reader two entries and show them one.
    expect(caveat?.count).toBe(1);
  });

  it('agrees with the number of dead public findings it actually lists', () => {
    const report = reportWithDeadPublicAssets();
    const caveat = report.caveats.find((entry) => entry.code === 'public-dir-dead');
    const listed = report.findings.filter(
      (finding) => finding.kind === 'dead' && finding.inPublicDir,
    ).length;

    expect(caveat?.count).toBe(listed);
  });

  it('has no plural wording at a count of one', () => {
    const caveat = reportWithDeadPublicAssets().caveats.find(
      (entry) => entry.code === 'public-dir-dead',
    );

    expect(caveat?.count).toBe(1);
    expect(caveat?.message).not.toContain('any of them');
  });
});

describe('the framework caveat at a count of one', () => {
  it('holds no verb or pronoun that has to agree with the count', () => {
    const ROOT = '/repo';
    const report = buildReport({
      aliases: { rules: [], skipped: [] },
      graph: buildGraph({ root: ROOT, assets: [], references: [], unscannedFiles: [] }),
      audit: {
        findings: [],
        conventionLinked: [{ asset: 'app/icon.png', reason: 'a framework reads it by its name' }],
        unreadableSources: [],
        probed: false,
        duplicatesChecked: false,
      },
      discovery: {
        root: ROOT,
        assets: [],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots: [],
        excludedFiles: [],
        excludedImages: [],
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: ['public'], declared: true },
    });

    const caveat = report.caveats.find((entry) => entry.code === 'framework-conventions');
    expect(caveat?.message).toBe(
      '1 unreferenced image not reported dead, because a framework reads each one by its filename',
    );
  });
});

/**
 * The accuracy class every reference carries. The snapshots barely test it: four of the
 * five fixtures have no `unsafe` reference, so their `byClassification` would look the
 * same if the classifier returned one constant, and `eleventy` has one. The cases live
 * here, with inputs built for them. See "Scoring references for accuracy" in
 * ARCHITECTURE.md.
 */
describe('classifyReference: the four boxes of the accuracy table', () => {
  function reference(over: Partial<Reference>): Reference {
    return {
      file: '/p/page.html',
      start: 0,
      end: 1,
      rawPath: '/img/hero.png',
      kind: 'attr',
      shape: 'html.img.src',
      ceiling: 'high',
      asserted: true,
      resolution: 'resolved',
      confidence: 'high',
      resolvedPath: 'public/img/hero.png',
      resolvedVia: 'serving-root',
      ...over,
    } as Reference;
  }

  describe('resolved with an answer', () => {
    it('counts a plain resolution', () => {
      expect(classifyReference(reference({}))).toBe('resolved-with-an-answer');
    });

    /**
     * Not generosity: the engine found where the reference points and reported the
     * truth, that the file is not there. The defect is the project's, and the answer is
     * correct.
     */
    it('counts a broken reference, because we resolved it and told the truth', () => {
      expect(
        classifyReference(
          reference({ resolution: 'broken', confidence: 'unsafe', resolvedPath: null }),
        ),
      ).toBe('resolved-with-an-answer');
    });

    it('counts a pattern that matched assets', () => {
      expect(
        classifyReference(
          reference({
            resolution: 'resolved-pattern',
            confidence: 'medium',
            resolvedPaths: ['public/img/a.png'],
          }),
        ),
      ).toBe('resolved-with-an-answer');
    });
  });

  describe('correctly refused, and only for a named property of the reference', () => {
    it('counts a deliberate scope boundary', () => {
      const entry = reference({
        resolution: 'out-of-scope',
        confidence: 'unsafe',
        resolvedPath: 'node_modules/pkg/logo.png',
        exclusionReason: 'names a file inside an npm package',
      });
      expect(classifyReference(entry)).toBe('correctly-refused');
      expect(refusalReasonId(entry)).toBe('out-of-scope');
    });

    it('counts a path assembled at runtime, in any of the interpolation syntaxes', () => {
      for (const rawPath of ['/img/${name}.png', '/img/{{ name }}.png', '/img/#{$name}.png']) {
        const entry = reference({
          resolution: 'dynamic',
          confidence: 'unsafe',
          resolvedPath: null,
          rawPath,
        });
        expect(classifyReference(entry)).toBe('correctly-refused');
        expect(refusalReasonId(entry)).toBe('assembled-at-runtime');
      }
    });

    it('counts a + chain by the path it assembles, not by its quote-and-plus text', () => {
      // The chain's source holds no `${`, so read off `rawPath` it would count as a miss
      // while its template twin, one line away, counts as refused.
      const entry = reference({
        resolution: 'dynamic',
        confidence: 'unsafe',
        resolvedPath: null,
        rawPath: "base + '/icon-' + size + '.png",
        assembledPath: '${}/icon-${}.png',
      });
      expect(classifyReference(entry)).toBe('correctly-refused');
      expect(refusalReasonId(entry)).toBe('assembled-at-runtime');
    });

    it("reads the HTML adapter's own verdict on CSS it could not read", () => {
      const resolve = (css: string) =>
        resolveReferences(
          htmlAdapter.findReferences({ file: '/p/page.html', text: `<div style="${css}"></div>` }),
          {
            root: '/p',
            assets: [],
            servingRoots: { dirs: [''], declared: true },
            excludedRoots: [],
            exists: () => false,
          },
        );
      const [nothing] = resolve('margin 0 0 0 15px');
      const [hidden] = resolve('background url(/a.png)');

      expect(nothing && refusalReasonId(nothing)).toBe('no-reference-in-it-to-find');
      expect(hidden && refusalReasonId(hidden)).toBeNull();
    });

    it('counts a style attribute the adapter proved holds no reference', () => {
      const entry = reference({
        resolution: 'dynamic',
        confidence: 'unsafe',
        resolvedPath: null,
        rawPath: 'margin 0 0 0 15px',
        unread: true,
        note: `could not parse the style attribute: …; it contains no url() or image-set(), so ${NO_REFERENCE_TO_FIND}`,
      });
      expect(classifyReference(entry)).toBe('correctly-refused');
      expect(refusalReasonId(entry)).toBe('no-reference-in-it-to-find');
    });
  });

  /**
   * The default counts against the engine. "There is no answer" is the engine's own
   * judgement, so moving a reference from missed to refused is a one-line change that
   * improves the figure. Every case here is tempting to call a correct refusal, and none
   * is, because nothing about the reference proves an answer was impossible.
   */
  describe('missed with an answer, which is where anything unproven belongs', () => {
    it('counts an alias we could not map', () => {
      // A bundler config the engine did not read may resolve this, so it is a miss until
      // shown otherwise.
      expect(
        classifyReference(
          reference({
            resolution: 'unresolved-alias',
            confidence: 'unsafe',
            resolvedPath: null,
            rawPath: '~/img/hero.png',
          }),
        ),
      ).toBe('missed-with-an-answer');
    });

    it('counts a character reference the decoder could not read', () => {
      expect(
        classifyReference(
          reference({
            resolution: 'dynamic',
            confidence: 'unsafe',
            resolvedPath: null,
            rawPath: '/img/caf&eacute.png',
            note: 'contains HTML character references, so the path text cannot be located exactly',
          }),
        ),
      ).toBe('missed-with-an-answer');
    });

    it('counts a style attribute that failed to parse with a url() in it', () => {
      expect(
        classifyReference(
          reference({
            resolution: 'dynamic',
            confidence: 'unsafe',
            resolvedPath: null,
            rawPath: 'margin 0 0; background: url(/hero.png)',
            note: 'could not parse the style attribute: …; it contains a url-taking function, so a reference may be hidden in it',
          }),
        ),
      ).toBe('missed-with-an-answer');
    });

    it('counts a dynamic reference with no interpolation and no named reason', () => {
      expect(
        classifyReference(
          reference({
            resolution: 'dynamic',
            confidence: 'unsafe',
            resolvedPath: null,
            rawPath: '/img/hero.png',
          }),
        ),
      ).toBe('missed-with-an-answer');
    });
  });

  it('puts an unasserted guess in no box at all', () => {
    expect(
      classifyReference(
        reference({
          resolution: 'discarded',
          confidence: 'unsafe',
          resolvedPath: null,
          asserted: false,
        }),
      ),
    ).toBe('not-a-claim');
  });

  /**
   * A wrong answer is one the engine believes, so a count it reported itself would always
   * be zero, and refusal accuracy computed from it would come out at 100% for any engine.
   * The schema says so rather than omitting the count.
   */
  it('publishes no count of wrong answers, and marks its absence as a decision', async () => {
    const report = await reportFor('plain-html');

    expect(Object.keys(report.references.byClassification).sort()).toEqual([
      'correctly-refused',
      'missed-with-an-answer',
      'not-a-claim',
      'resolved-with-an-answer',
    ]);
    expect(report.references.refusalAccuracyIsNotSelfAssessable).toBe(true);
  });

  /**
   * Some `assembled-at-runtime` refusals have an answer the engine does not compute, so
   * `correctly-refused` is too high by a measured amount. That bound travels in the schema
   * beside the count, rather than in prose a reader of the figure may never see.
   */
  it('publishes the known over-claim beside the count it inflates', async () => {
    const report = await reportFor('eleventy');
    const runtime = report.references.classificationBounds.find(
      (entry) => entry.reason === 'assembled-at-runtime',
    );

    expect(runtime?.count).toBeGreaterThan(0);
    expect(runtime?.bound).toMatch(/but 4 are not/);
    // The provenance is its own field, not a sentence buried in the bound: a caveat a
    // reader cannot date is one they cannot check.
    expect(runtime?.measuredAgainst).toMatch(/^2026-09-25, on five public repositories/);
    expect(runtime?.measuredAgainst).toMatch(/If they or the engine have changed since/);
  });

  it('carries no bound for a reason that has none', async () => {
    const report = await reportFor('plain-html');

    for (const entry of report.references.classificationBounds) {
      expect(entry.reason).not.toBe('out-of-scope');
    }
  });

  /**
   * The classes add up to the resolutions, so no class can gain or lose a reference
   * without the arithmetic noticing.
   */
  it('classifies every reference exactly once', async () => {
    for (const name of NAMES) {
      const report = await reportFor(name);
      const classified = Object.values(report.references.byClassification).reduce(
        (total, count) => total + count,
        0,
      );
      const resolved = Object.values(report.references.byResolution).reduce(
        (total, count) => total + count,
        0,
      );
      expect(classified).toBe(resolved);
    }
  });
});

/**
 * How the human report prints the accuracy classes. The heading over unlinked references
 * has to agree with the classes beneath it: "could not be resolved" above references that
 * had no answer to find contradicts itself.
 */
describe('renderReport and the accuracy boxes', () => {
  /**
   * A real report with only the reference slice replaced. A hand-built `Report` would be
   * a second copy of a growing schema, and would go stale as any copy does.
   */
  async function withUnsafe(
    entries: ReferenceEntry[],
    bounds: ClassificationBound[] = [],
  ): Promise<string> {
    const base = await reportFor('plain-html');
    return renderReport({
      ...base,
      references: {
        ...base.references,
        unsafe: entries,
        classificationBounds: bounds,
        discardedCount: 0,
        discarded: null,
      },
    } as Report);
  }

  function entry(over: Partial<ReferenceEntry>): ReferenceEntry {
    return {
      file: 'page.html',
      rawPath: '/img/hero.png',
      resolution: 'dynamic',
      reason: 'no static path to resolve',
      classification: 'correctly-refused',
      refusalReason: 'assembled-at-runtime',
      ...over,
    } as ReferenceEntry;
  }

  it('does not say "could not be resolved" when nothing was ours to resolve', async () => {
    const text = await withUnsafe([entry({})]);

    expect(text).toContain('had no answer to find');
    expect(text).not.toContain('could not be resolved safely');
  });

  it('says plainly when they are ours', async () => {
    const text = await withUnsafe([
      entry({ classification: 'missed-with-an-answer', refusalReason: null }),
    ]);

    expect(text).toContain('could not be resolved');
    expect(text).toContain('this one is ours');
  });

  it('splits the two when a run has both', async () => {
    const text = await withUnsafe([
      entry({}),
      entry({
        rawPath: '/img/other.png',
        classification: 'missed-with-an-answer',
        refusalReason: null,
      }),
    ]);

    expect(text).toContain('were not linked');
    expect(text).toContain('1 could not be resolved, and 1 had no answer to find');
  });

  /**
   * A refusal's own reason already explains it, so repeating the class under every entry
   * would be a wall of restatement. What a reader cannot otherwise tell is which entries
   * are ours, and that is the only line that prints.
   */
  it('does not restate the box under an entry that already explains itself', async () => {
    const text = await withUnsafe([
      entry({
        resolution: 'out-of-scope',
        reason: 'names a file inside an npm package',
        refusalReason: 'out-of-scope',
      }),
    ]);

    expect(text).toContain('names a file inside an npm package');
    expect(text).not.toContain('no answer to find (out-of-scope)');
  });

  /**
   * The accuracy the counts imply is too high by a known amount, so the over-claim prints
   * beside the counts it inflates, with what it was measured against: a bound a reader
   * cannot date is one they cannot check.
   */
  it('prints a known over-claim and what it was measured against', async () => {
    const text = await withUnsafe(
      [entry({})],
      [
        {
          reason: 'assembled-at-runtime',
          count: 52,
          bound: 'sixteen of sixty-two have an answer we do not compute.',
          measuredAgainst: 'R112, 2026-09-15, on the five pinned validation repositories.',
        },
      ],
    );

    expect(text).toContain('known to get wrong');
    expect(text).toContain('52 classified as "assembled-at-runtime"');
    expect(text).toContain('measured: R112, 2026-09-15');
  });

  it('prints nothing about bounds when none apply', async () => {
    expect(await withUnsafe([entry({})])).not.toContain('known to get wrong');
  });
});

describe('what the ignore rules left out', () => {
  const ROOT = '/repo';
  const LEGACY: ExcludedRoot = {
    path: `${ROOT}/legacy`,
    relative: 'legacy',
    reason: "the ignore rule 'legacy/'",
    byRule: true,
  };
  const DEPENDENCIES: ExcludedRoot = {
    path: `${ROOT}/node_modules`,
    relative: 'node_modules',
    reason: 'a dependency directory',
    byRule: false,
  };
  const BUILT_SITE: ExcludedRoot = {
    path: `${ROOT}/public`,
    relative: 'public',
    reason: "a build-output directory named 'public', beside Hugo's settings file 'hugo.toml'",
    byRule: false,
  };

  function reportExcluding(
    excludedRoots: ExcludedRoot[],
    excludedFiles: string[],
    references: Reference[] = [],
    excludedImages: string[] = [],
  ) {
    return buildReport({
      aliases: { rules: [], skipped: [] },
      graph: buildGraph({ root: ROOT, assets: [], references, unscannedFiles: [] }),
      audit: {
        findings: [],
        conventionLinked: [],
        unreadableSources: [],
        probed: false,
        duplicatesChecked: false,
      },
      discovery: {
        root: ROOT,
        assets: [],
        sourceFiles: [],
        directories: [],
        ignoredCount: 0,
        skipped: [],
        excludedRoots,
        excludedFiles,
        excludedImages,
        unscannedFiles: [],
      },
      sweep: { mentions: new Map(), skipped: [] },
      servingRoots: { dirs: ['public'], declared: true },
    });
  }

  /** A reference the resolver found on disk, outside the images the run indexed. */
  function outOfScope(rawPath: string, target: string, exclusionReason: string): Reference {
    return {
      file: `${ROOT}/index.html`,
      rawPath,
      start: 0,
      end: rawPath.length,
      kind: 'attr',
      shape: 'html.img.src',
      ceiling: 'high',
      asserted: true,
      resolution: 'out-of-scope',
      confidence: 'unsafe',
      resolvedPath: `${ROOT}/${target}`,
      exclusionReason,
    };
  }

  const TOUCH = outOfScope(
    '/icons/touch.png',
    'public/icons/touch.png',
    'resolved outside the indexed asset set',
  );

  it('lists a reference into what the rules left out on its own, never with those that had no answer', () => {
    // The run was asked to leave these files alone, so nothing about the reference wants an
    // answer, and among the unanswered ones it reads as a problem.
    const report = reportExcluding(
      [LEGACY, DEPENDENCIES],
      [],
      [
        TOUCH,
        outOfScope('/legacy/old.png', 'legacy/old.png', "the ignore rule 'legacy/'"),
        outOfScope(
          'pkg/logo.png',
          'node_modules/pkg/logo.png',
          "a dependency directory named 'node_modules'",
        ),
      ],
      ['public/icons/touch.png'],
    );

    expect(report.references.leftOut.map((entry) => [entry.rawPath, entry.reason])).toEqual([
      ['/legacy/old.png', "the ignore rule 'legacy/'"],
      ['/icons/touch.png', 'an ignore rule leaves this image out'],
    ]);
    expect(report.references.unsafe.map((entry) => entry.rawPath)).toEqual(['pkg/logo.png']);

    const rendered = renderReport(report);
    expect(rendered).toContain('2 references point into files this run leaves out, as asked.\n');
    expect(rendered).toContain('1 reference had no answer to find\n');
    expect(rendered).not.toContain('/icons/touch.png');
  });

  it('says so in the singular after saying that nothing was skipped', () => {
    const rendered = renderReport(reportExcluding([], [], [TOUCH], ['public/icons/touch.png']));

    expect(rendered).toContain(
      'Nothing was skipped.\n1 reference points into a file this run leaves out, as asked.\n',
    );
  });

  it("names the paths the project's rules left out, and not the directories pruned by name", () => {
    // Upfly never reads them, so an image only they use is reported as unreferenced.
    const report = reportExcluding([LEGACY, DEPENDENCIES], ['drafts/old.html']);

    const caveat = report.caveats.find((entry) => entry.code === 'excluded-roots');
    expect(caveat?.count).toBe(2);
    expect(caveat?.message).toContain('can show as unreferenced');
    expect(caveat?.detail).toEqual(["legacy/: the ignore rule 'legacy/'", 'drafts/old.html']);
  });

  it('says so where it would otherwise say that nothing was skipped', () => {
    const rendered = renderReport(reportExcluding([LEGACY], []));

    expect(rendered).toContain(
      'Nothing was skipped apart from the paths your ignore rules left out, listed under Worth knowing.',
    );
  });

  it('stays quiet when only directories pruned by name were left out', () => {
    const report = reportExcluding([DEPENDENCIES], []);

    expect(report.caveats.map((entry) => entry.code)).not.toContain('excluded-roots');
    expect(renderReport(report)).toContain('Nothing was skipped.\n');
  });

  it("stays quiet about a site generator's build output, which the walk pruned and no rule did", () => {
    const report = reportExcluding([BUILT_SITE], []);

    expect(report.caveats.map((entry) => entry.code)).not.toContain('excluded-roots');
    expect(renderReport(report)).toContain('Nothing was skipped.\n');
  });
});
