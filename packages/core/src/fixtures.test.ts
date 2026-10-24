import { existsSync } from 'node:fs';
import { readFile as readFile_ } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from './adapters/default-adapters.js';
import { audit } from './audit/audit.js';
import { MINIMUM_ROOT_RELATIVE, resolutionHealth } from './audit/resolution-health.js';
import { sweepForMentions } from './audit/sweep.js';
import { discover } from './discover/discover.js';
import { buildGraph, unreferencedAssets } from './graph/graph.js';
import { createSharpProbe } from './probe/probe-sharp.js';
import { probeAssets } from './probe/probe.js';
import { buildReport } from './report/report.js';
import { isLinked } from './resolve/reference.js';
import {
  type ResolveOptions,
  resolveReferences,
  resolveReferencesInSlices,
} from './resolve/resolve.js';
import { detectServingRoots } from './resolve/serving-roots.js';
import { scanSources } from './scan/scan.js';
import type { ReadFilePort } from './scan/scan.js';
import type { Adapter, Reference } from './types.js';

/** The framework fixtures, run through the real pipeline from `discover` to `audit`. */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const ADAPTERS: readonly Adapter[] = defaultAdapters;

const NAMES = ['vite-react', 'next-app', 'astro', 'plain-html', 'eleventy'] as const;

/** Where each tree serves a root-relative `/hero.png` from. */
const PUBLIC_DIRS: Record<(typeof NAMES)[number], string> = {
  'vite-react': 'public',
  'next-app': 'public',
  astro: 'public',
  // A plain static site serves from the project root itself.
  'plain-html': '',
  // Eleventy passes `src/img` through to `/img`.
  eleventy: 'src',
};

async function scan(name: string) {
  const root = join(FIXTURES, name);
  const discovered = await discover({ root, adapters: ADAPTERS });

  const scanned = await scanSources({
    sourceFiles: discovered.sourceFiles,
    adapters: ADAPTERS,
    readFile: (path) => readFile_(path, 'utf8'),
  });

  // Read separately because `scanSources` does not keep a repository's source in memory.
  // The range check below needs the text, and a fixture tree is small enough to hold.
  const sources = new Map<string, string>();
  for (const sourceFile of discovered.sourceFiles) {
    sources.set(sourceFile.path, await readFile_(sourceFile.path, 'utf8'));
  }

  return { discovered, references: scanned.references, unscanned: scanned.unscanned, sources };
}

async function resolveTree(name: (typeof NAMES)[number]): Promise<Reference[]> {
  const { discovered, references } = await scan(name);
  return resolveReferences(references, {
    root: discovered.root,
    assets: discovered.assets,
    servingRoots: { declared: true, dirs: [PUBLIC_DIRS[name] ?? 'public'] },
    excludedRoots: discovered.excludedRoots,
    // The real port here: these are real trees, and a reference that would be
    // called broken deserves the one stat that proves it.
    exists: (path) => existsSync(path),
  });
}

/**
 * A filename that announces the asset is meant to have no references.
 *
 * The matching convention for references meant to be broken is in
 * `fixture-integrity.test.ts`. `removed.png` belongs here: its only mention is inside an
 * HTML comment, which is what that fixture tests.
 */
const DELIBERATELY_DEAD = /orphan|unused|unreferenced|never-|removed/;

describe('framework fixtures', () => {
  it.each(NAMES)('%s: discovery finds assets and source files', async (name) => {
    const { discovered } = await scan(name);

    expect(discovered.assets.length).toBeGreaterThan(0);
    expect(discovered.sourceFiles.length).toBeGreaterThan(0);
    // Nothing in a checked-in fixture should be unreadable or a symlink.
    expect(discovered.skipped).toEqual([]);
  });

  it.each(NAMES)('%s: every claimed source file parses', async (name) => {
    // `scanSources` records an adapter that throws as a `parse-failed` file rather than
    // rejecting, so the list of such files is what shows a parse failure.
    expect((await scan(name)).unscanned).toEqual([]);
  });

  it.each(NAMES)('%s: finds references', async (name) => {
    const { references } = await scan(name);
    expect(references.length).toBeGreaterThan(0);
  });

  it.each(NAMES)('%s: every reference range selects exactly its own path', async (name) => {
    // The invariant that rules out the whole class of offset bugs. `bench/` checks the
    // same property over the validation repositories; this is the fixture half.
    const { references, sources } = await scan(name);

    for (const reference of references) {
      const text = sources.get(reference.file);
      expect(text).toBeDefined();
      expect(text?.slice(reference.start, reference.end)).toBe(reference.rawPath);
    }
  });

  describe('resolved against the assets that exist', () => {
    it.each(NAMES)('%s: no reference is wrongly reported broken', async (name) => {
      // Every `broken` here must be one the fixture declares in its own filename.
      const broken = (await resolveTree(name))
        .filter((reference) => reference.resolution === 'broken')
        .map((reference) => reference.rawPath);

      expect(broken.filter((path) => !path.includes('missing-on-purpose'))).toEqual([]);
    });

    it.each(NAMES)('%s: links assets', async (name) => {
      const resolved = (await resolveTree(name)).filter(isLinked);
      expect(resolved.length).toBeGreaterThan(0);
    });

    it('keeps the one deliberately broken reference, so the check has teeth', async () => {
      const broken = (await resolveTree('plain-html')).filter(
        (reference) => reference.resolution === 'broken',
      );
      expect(broken.map((reference) => reference.rawPath)).toEqual([
        'images/missing-on-purpose.png',
      ]);
    });

    it('reports a templated eleventy path as dynamic rather than broken', async () => {
      const dynamic = (await resolveTree('eleventy')).filter(
        (reference) => reference.resolution === 'dynamic',
      );
      expect(dynamic.map((reference) => reference.rawPath)).toEqual([
        '{{ site.url }}/img/templated.png',
      ]);
    });

    it('drops non-asset references rather than reporting them', async () => {
      // vite-react references `.css`, `.jsx` and `.svg`; only the svg is tracked.
      const { references } = await scan('vite-react');
      const resolved = await resolveTree('vite-react');
      expect(resolved.length).toBeLessThan(references.length);
      expect(resolved.every((reference) => reference.rawPath.includes('.css'))).toBe(false);
    });
  });

  describe('linked into a graph', () => {
    async function graphTree(name: (typeof NAMES)[number]) {
      const { discovered, unscanned } = await scan(name);
      return buildGraph({
        root: discovered.root,
        assets: discovered.assets,
        references: await resolveTree(name),
        // Both sources, always. Discovery's unclaimed extensions and scan's parse
        // failures are one condition to the audit: we did not read that file.
        unscannedFiles: [...discovered.unscannedFiles, ...unscanned],
      });
    }

    it.each(NAMES)('%s: every asset becomes a node and no reference is lost', async (name) => {
      const { discovered } = await scan(name);
      const graph = await graphTree(name);
      const resolved = await resolveTree(name);

      expect(graph.assets).toHaveLength(discovered.assets.length);
      expect(graph.references).toHaveLength(resolved.length);
      // The graph is the layer most likely to drop a reference silently. Every reference is
      // in exactly one bucket, so none can vanish from the report without vanishing here.
      expect(Object.values(graph.byResolution).flat()).toHaveLength(resolved.length);
    });

    it.each(NAMES)(
      '%s: every unreferenced asset is declared dead or named in a file we could not read',
      async (name) => {
        // An asset with zero references is either meant to be dead, and says so in its
        // filename, or is named somewhere the engine could not follow, which makes it
        // `possibly-dead` rather than a false `dead`.
        const graph = await graphTree(name);
        const mentioned = new Set<string>();
        const haystack = [
          ...(await Promise.all(graph.unscannedFiles.map((file) => readFile_(file.path, 'utf8')))),
          // A reference that was read but not resolved links no asset, so an asset it may
          // point at looks dead. `first.md` names `templated.png` through the `dynamic`
          // `{{ site.url }}/img/templated.png`: alive, not missing.
          ...graph.byResolution.dynamic.map((reference) => reference.rawPath),
          ...graph.byResolution['unresolved-alias'].map((reference) => reference.rawPath),
          ...graph.byResolution.discarded.map((reference) => reference.rawPath),
        ];

        for (const text of haystack) {
          for (const node of graph.assets) {
            if (text.includes(basename(node.asset.relative))) {
              mentioned.add(node.asset.relative);
            }
          }
        }

        const unexplained = unreferencedAssets(graph)
          .map((node) => node.asset.relative)
          .filter((relative) => !DELIBERATELY_DEAD.test(relative) && !mentioned.has(relative));

        expect(unexplained).toEqual([]);
      },
    );

    it('links all three astro assets now that an adapter reads .astro', async () => {
      // `logo.png` is imported in the frontmatter fence, and `favicon.png` (a
      // `<link rel=icon>`) and `banner.png` (an `<img src>`) are named in the template
      // body, so an adapter that read only one half of the file would fail this.
      const graph = await graphTree('astro');

      expect(graph.unscannedExtensions).toEqual([]);
      expect(unreferencedAssets(graph).map((node) => node.asset.relative)).toEqual([
        'public/never-used.png',
      ]);
    });

    it('reports two eleventy templates as unread', async () => {
      const graph = await graphTree('eleventy');

      expect(graph.unscannedExtensions).toEqual([{ ext: '.njk', fileCount: 2 }]);
    });

    it('counts an SVG as unread even though it is also an asset', async () => {
      // An SVG can carry `<image href="hero.png">`, and no adapter reads one. It is
      // both an asset and a file we did not scan.
      //
      // Two of them: `public/favicon.svg` is referenced and `src/assets/unused-icon.svg`
      // is not. The second makes a tree reach the report's `unusedVectors`, where an
      // unreferenced SVG goes instead of `findings`; with a zero in every tree, the
      // fixtures could not test it.
      const graph = await graphTree('vite-react');

      expect(graph.unscannedExtensions).toEqual([{ ext: '.svg', fileCount: 2 }]);
      expect(graph.assets.some((node) => node.asset.relative.endsWith('.svg'))).toBe(true);
    });

    it.each(['next-app', 'plain-html'] as const)(
      '%s: was read completely, so a dead finding needs no hedge',
      async (name) => {
        // Real projects are rarely read completely, which is why the hedge is decided per
        // asset rather than for the whole run. These two trees are.
        expect((await graphTree(name)).unscannedExtensions).toEqual([]);
      },
    );

    describe('the sweep that decides dead against possibly-dead', () => {
      async function sweep(name: (typeof NAMES)[number]) {
        return sweepForMentions({
          graph: await graphTree(name),
          readFile: (path) => readFile_(path, 'utf8'),
        });
      }

      it('has nothing left to rescue in the astro tree', async () => {
        // Every asset in this tree is linked or named nowhere, so a hedge here would be the
        // engine hedging about a reference it can follow. The sweep of unread files is still
        // tested, in `sweep.test.ts` and by the eleventy tree's `.njk` templates below.
        const { mentions } = await sweep('astro');

        expect([...mentions.keys()].sort()).toEqual([]);
      });

      it('leaves astro-s deliberately dead asset confidently dead', async () => {
        // The other half, and the reason a per-asset hedge is worth the work:
        // `never-used.png` is in the same tree and is not rescued.
        const { mentions } = await sweep('astro');

        expect(mentions.has('public/never-used.png')).toBe(false);
      });

      it('rescues the eleventy asset only a dynamic reference names, citing file and line', async () => {
        // `first.md` parses, but its reference is `dynamic`, so it links nothing and the
        // asset would look confidently dead without the sweep.
        const { mentions } = await sweep('eleventy');

        expect(mentions.get('src/img/templated.png')).toEqual([
          {
            asset: 'src/img/templated.png',
            source: 'unresolved-reference',
            where: 'src/posts/first.md:7',
            quote: '{{ site.url }}/img/templated.png',
          },
        ]);
      });

      it('rescues the eleventy assets that only .njk templates reference', async () => {
        const { mentions } = await sweep('eleventy');

        expect(mentions.get('src/img/logo.png')?.[0]?.where).toBe('src/index.njk:5');
        expect(mentions.get('src/img/favicon.png')?.[0]?.where).toBe('src/_includes/base.njk:4');
        expect(mentions.has('src/img/unused.png')).toBe(false);
      });

      it.each(['next-app', 'plain-html'] as const)(
        '%s: every unreferenced asset stays confidently dead',
        async (name) => {
          // Fully read trees in which nothing unresolved names these assets, so they stay
          // `dead`: the case a per-asset hedge exists to keep reachable.
          const { mentions, skipped } = await sweep(name);

          expect(mentions.size).toBe(0);
          expect(skipped).toEqual([]);
        },
      );

      it.each(NAMES)('%s: reads nothing it cannot account for', async (name) => {
        expect((await sweep(name)).skipped).toEqual([]);
      });
    });

    describe('audited end to end', () => {
      async function auditTree(name: (typeof NAMES)[number], probed = true) {
        const graph = await graphTree(name);
        const readFile: ReadFilePort = (path) => readFile_(path, 'utf8');
        return audit({
          graph,
          sweep: await sweepForMentions({ graph, readFile }),
          readFile,
          publicDirs: [PUBLIC_DIRS[name] ?? 'public'],
          ...(probed
            ? {
                probes: await probeAssets(
                  graph.assets.map((node) => node.asset),
                  { probe: await createSharpProbe(), formats: ['webp'] },
                ),
              }
            : {}),
        });
      }

      it.each(NAMES)(
        '%s: reports no broken reference the fixture did not declare',
        async (name) => {
          // The resolver check above, at the layer a user reads.
          const result = await auditTree(name, false);
          const broken = result.findings.filter((finding) => finding.kind === 'broken');

          expect(
            broken.filter((finding) => !finding.rawPath.includes('missing-on-purpose')),
          ).toEqual([]);
        },
      );

      it('cites the one deliberately broken reference at its line', async () => {
        const result = await auditTree('plain-html', false);

        expect(result.findings.filter((finding) => finding.kind === 'broken')).toEqual([
          {
            kind: 'broken',
            // The deliberate dangling reference is in about.html, not index.html.
            file: 'about.html',
            line: 10,
            where: 'about.html:10',
            rawPath: 'images/missing-on-purpose.png',
          },
        ]);
      });

      it('reports astro-s one genuinely unused asset as dead, and hedges nothing', async () => {
        // Without an `.astro` adapter three assets here would be hedged; with it they link,
        // and the one asset nothing names is still `dead`.
        const result = await auditTree('astro', false);
        const dead = result.findings.filter((finding) => finding.kind === 'dead');
        const hedged = result.findings.filter((finding) => finding.kind === 'possibly-dead');

        expect(hedged).toEqual([]);
        expect(dead.map((finding) => finding.asset)).toEqual(['public/never-used.png']);
      });

      it('counts a dead public asset for the caveat instead of hedging it', async () => {
        // `never-used.png` is under `public/`, so something outside the repository could
        // request it. With no evidence of that it stays `dead`, and the report counts it.
        const result = await auditTree('astro', false);

        expect(result.findings.filter((f) => f.kind === 'dead' && f.inPublicDir)).toHaveLength(1);
      });

      it.each(['next-app', 'plain-html'] as const)(
        '%s: every unreferenced asset is confidently dead',
        async (name) => {
          const result = await auditTree(name, false);

          expect(result.findings.some((finding) => finding.kind === 'possibly-dead')).toBe(false);
          expect(result.findings.some((finding) => finding.kind === 'dead')).toBe(true);
        },
      );

      it('produces dead and broken findings without a probe at all', async () => {
        // Findings about references need no pixels, which is what makes `--no-probe` and a
        // low encode cap safe rather than merely fast.
        const result = await auditTree('plain-html', false);

        expect(result.probed).toBe(false);
        expect(result.findings.some((finding) => finding.kind === 'broken')).toBe(true);
        expect(result.findings.some((finding) => finding.kind === 'dead')).toBe(true);
      });

      it('reports a saving on the real fixture images, and every figure is arithmetic', async () => {
        // Every figure is measured rather than estimated, so each finding's arithmetic is
        // checked against itself: an estimate would have no reason to agree to the byte.
        const result = await auditTree('plain-html');
        const opportunities = result.findings.filter(
          (finding) => finding.kind === 'format-opportunity',
        );

        expect(result.probed).toBe(true);
        expect(opportunities.length).toBeGreaterThan(0);

        for (const finding of opportunities) {
          if (finding.kind !== 'format-opportunity') continue;
          expect(finding.wouldBe).toBeGreaterThan(0);
          expect(finding.wouldBe).toBeLessThan(finding.bytes);
          expect(finding.savedBytes).toBe(finding.bytes - finding.wouldBe);
        }

        // Nothing oversized: the fixture images are real photographs, but small ones.
        expect(result.findings.some((finding) => finding.kind === 'oversized')).toBe(false);
      });

      it.each(NAMES)('%s: accounts for every source it could not read', async (name) => {
        expect((await auditTree(name, false)).unreadableSources).toEqual([]);
      });
    });

    it('links a CSS-only reference, so the asset is not dead', async () => {
      // `unused-in-css.png` is named for the trap: unused in JSX, referenced from a
      // stylesheet. An engine that only read components would call it dead.
      const graph = await graphTree('vite-react');
      const node = graph.assets.find((entry) => entry.asset.relative.endsWith('unused-in-css.png'));

      expect(node?.references.length).toBeGreaterThan(0);
    });
  });

  it('covers the adapters the compatibility matrix claims', async () => {
    const seen = new Set<string>();
    for (const name of NAMES) {
      const { discovered } = await scan(name);
      for (const sourceFile of discovered.sourceFiles) seen.add(sourceFile.adapterId);
    }

    expect([...seen].sort()).toEqual(['astro', 'css', 'html', 'javascript', 'json', 'markdown']);
  });

  it('claims .astro and still leaves .njk unclaimed, which is the remaining gap', async () => {
    // `.njk` is still an empty cell in the compatibility matrix, left for a community
    // adapter. Its half is the assertion that can still fail: a test that only says
    // everything is claimed cannot notice the next gap.
    const astro = await scan('astro');
    const eleventy = await scan('eleventy');

    expect(astro.discovered.sourceFiles.some((file) => file.relative.endsWith('.astro'))).toBe(
      true,
    );
    expect(eleventy.discovered.sourceFiles.some((file) => file.relative.endsWith('.njk'))).toBe(
      false,
    );
  });
});

/**
 * The serving-root diagnosis, reached through a real tree.
 *
 * The diagnosis replaces findings, so it needs a fixture that reaches it through the whole
 * pipeline. It fires only with at least `MINIMUM_ROOT_RELATIVE` root-relative references
 * and a linked share under `RESOLUTION_FLOOR`. `eleventy` has both: it serves `src/img` at
 * `/img` through `addPassthroughCopy`, and nothing name-based detects `src` as a serving
 * root. `next-app` has the count with every reference linked, so the pair shows the guard
 * needs both conditions. The minimum is a product judgement, not lowered to suit the
 * fixtures. See "When the serving root cannot be found at all" in ARCHITECTURE.md.
 */
describe('the serving-root diagnosis, reached through a real tree', () => {
  /**
   * The tree as a first run sees it: the serving root detected, never declared.
   *
   * The other tests hand the resolver the right root from `PUBLIC_DIRS`, the configuration
   * a user reaches after reading a report. With it every root-relative reference links, so
   * this diagnosis cannot fire.
   */
  async function undetected(name: (typeof NAMES)[number]) {
    const { discovered, references, unscanned } = await scan(name);
    const servingRoots = detectServingRoots(discovered);
    const resolved = await resolveReferences(references, {
      root: discovered.root,
      assets: discovered.assets,
      servingRoots,
      excludedRoots: discovered.excludedRoots,
      exists: (path) => existsSync(path),
    });
    const graph = buildGraph({
      root: discovered.root,
      assets: discovered.assets,
      references: resolved,
      unscannedFiles: [...discovered.unscannedFiles, ...unscanned],
    });
    const readFile: ReadFilePort = (path) => readFile_(path, 'utf8');

    return {
      servingRoots,
      health: resolutionHealth(graph),
      result: await audit({
        graph,
        sweep: await sweepForMentions({ graph, readFile }),
        readFile,
        publicDirs: servingRoots.dirs,
      }),
    };
  }

  it('finds no serving root in the eleventy tree at all', async () => {
    // The premise of this block. `src` is a source directory, not a serving root by
    // convention, so a name-based detector must not claim it. If one did, the tests below
    // would fail for a reason that has nothing to do with the guard.
    expect((await undetected('eleventy')).servingRoots).toEqual({ dirs: [], declared: false });
  });

  it('fires the guard on a real tree, through the whole pipeline', async () => {
    const { health } = await undetected('eleventy');

    // Compared with the constant rather than its value, so a reference legitimately added
    // to this tree does not fail the test. The boundary itself is tested in
    // `resolution-health.test.ts`, at the minimum and one below it.
    expect(health.checkable).toBeGreaterThanOrEqual(MINIMUM_ROOT_RELATIVE);
    expect(health.linked).toBe(0);
    expect(health.servingRootUnknown).toBe(true);
  });

  it('reports one diagnosis instead of every root-relative symptom', async () => {
    const { result } = await undetected('eleventy');
    const diagnoses = result.findings.filter((finding) => finding.kind === 'serving-root-unknown');

    expect(diagnoses).toHaveLength(1);
    const [diagnosis] = diagnoses;
    if (diagnosis?.kind !== 'serving-root-unknown') throw new Error('unreachable');
    // Every root-relative reference in the tree, and nothing else: the count the user
    // reads has to agree with the findings that were taken away.
    expect(diagnosis.suppressedBroken).toBe(diagnosis.checkable);
    expect(diagnosis.linked).toBe(0);
  });

  it('suppresses only what it explains, and the relative break survives', async () => {
    // The tree holds one broken relative path so this case is reachable. The diagnosis
    // explains root-relative breaks only; a relative one is a real defect it must not hide.
    const { result } = await undetected('eleventy');
    const broken = result.findings.filter((finding) => finding.kind === 'broken');

    expect(broken.map((finding) => finding.kind === 'broken' && finding.rawPath)).toEqual([
      '../img/missing-on-purpose.png',
    ]);
  });

  it.each(NAMES.filter((name) => name !== 'eleventy'))(
    'does not fire on %s, which resolves its root-relative references',
    async (name) => {
      // The other direction: a diagnosis that fired everywhere would pass every test above
      // while suppressing every real finding. `next-app` matters most, because it reaches
      // the count with every reference linked, so it shows the guard reads the rate too.
      const { health } = await undetected(name);

      expect(health.servingRootUnknown).toBe(false);
    },
  );

  it('is healthy again once the same tree declares its serving root', async () => {
    // The diagnosis is about our knowledge, not the user's code. Nothing on disk changes
    // between this run and the ones above, only whether `src` is declared, so a guard that
    // stayed lit here would call a correctly configured project broken.
    const { discovered, references, unscanned } = await scan('eleventy');
    const resolved = await resolveReferences(references, {
      root: discovered.root,
      assets: discovered.assets,
      servingRoots: { declared: true, dirs: [PUBLIC_DIRS.eleventy] },
      excludedRoots: discovered.excludedRoots,
      exists: (path) => existsSync(path),
    });
    const health = resolutionHealth(
      buildGraph({
        root: discovered.root,
        assets: discovered.assets,
        references: resolved,
        unscannedFiles: [...discovered.unscannedFiles, ...unscanned],
      }),
    );

    expect(health.checkable).toBeGreaterThanOrEqual(MINIMUM_ROOT_RELATIVE);
    expect(health.rate).toBe(1);
    expect(health.servingRootUnknown).toBe(false);
  });
});

describe('a tree resolved in slices', () => {
  it.each(NAMES)(
    '%s: gives the graph and report of one stretch, with a slice ending inside a file',
    async (name) => {
      const { discovered, references, unscanned } = await scan(name);
      const options: ResolveOptions = {
        root: discovered.root,
        assets: discovered.assets,
        servingRoots: { declared: true, dirs: [PUBLIC_DIRS[name]] },
        excludedRoots: discovered.excludedRoots,
        exists: (path) => existsSync(path),
      };
      const size = 2;
      const endsInsideAFile = references.some(
        (reference, index) => index % size === 0 && references[index - 1]?.file === reference.file,
      );
      const readFile: ReadFilePort = (path) => readFile_(path, 'utf8');
      const engine = async (resolved: readonly Reference[]) => {
        const graph = buildGraph({
          root: discovered.root,
          assets: discovered.assets,
          references: resolved,
          unscannedFiles: [...discovered.unscannedFiles, ...unscanned],
        });
        const sweep = await sweepForMentions({ graph, readFile });
        const report = buildReport({
          graph,
          audit: await audit({ graph, sweep, readFile, publicDirs: options.servingRoots.dirs }),
          discovery: discovered,
          sweep,
          servingRoots: options.servingRoots,
          aliases: { rules: [], skipped: [] },
        });
        return { resolved, graph, report: JSON.stringify(report) };
      };

      const inOneStretch = await engine(resolveReferences(references, options));
      const inSlices = await engine(await resolveReferencesInSlices(references, options, size));

      expect(endsInsideAFile).toBe(true);
      expect(inSlices.resolved).toEqual(inOneStretch.resolved);
      expect(inSlices.graph).toEqual(inOneStretch.graph);
      expect(inSlices.report).toBe(inOneStretch.report);
    },
  );
});
