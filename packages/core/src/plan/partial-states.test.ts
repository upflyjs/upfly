import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultAdapters } from '../adapters/default-adapters.js';
import { discover } from '../discover/discover.js';
import { buildGraph } from '../graph/graph.js';
import { createSharpProbe } from '../probe/probe-sharp.js';
import { probeAssets } from '../probe/probe.js';
import { resolveReferences } from '../resolve/resolve.js';
import { scanSources } from '../scan/scan.js';
import type { ProjectBuilds } from './builds.js';
import { type PublicPolicy, planOptimization } from './plan.js';

/**
 * Planning a tree that is half working, which real repositories rarely are.
 *
 * A real repository is usually either working or misconfigured. Partial states, such as
 * half a monorepo's serving roots detected, or a pattern where some siblings convert and
 * one does not, do not occur naturally, so adding real repositories never produces one.
 * `fixtures/partial-pattern` is built by hand to hold one.
 *
 * Everything below runs the real pipeline and a real sharp probe. The sibling that cannot
 * convert fails because its bytes are not an image, not because a test double says so.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/partial-pattern');

/** The serving root this tree declares. `public/` is served; `src/` is bundled. */
const SERVING_ROOTS = { declared: true, dirs: ['public'] } as const;

/**
 * The build that bundles `src/`, stated as the serving root is: the tree names none, and an
 * image an unnamed build loads keeps its format, which would take away the converted-but-kept
 * original these cases are about.
 */
const BUILDS: ProjectBuilds = {
  packages: [{ folder: '', build: { kind: 'known', name: 'Vite' } }],
};

async function planFor(publicPolicy: PublicPolicy) {
  const discovered = await discover({ root: ROOT, adapters: defaultAdapters });
  const scanned = await scanSources({
    sourceFiles: discovered.sourceFiles,
    adapters: defaultAdapters,
    readFile: (path) => readFile(path, 'utf8'),
  });
  const references = await resolveReferences(scanned.references, {
    root: discovered.root,
    assets: discovered.assets,
    servingRoots: SERVING_ROOTS,
    excludedRoots: discovered.excludedRoots,
    exists: (path) => existsSync(path),
  });
  const graph = buildGraph({
    root: discovered.root,
    assets: discovered.assets,
    references,
    unscannedFiles: [...discovered.unscannedFiles, ...scanned.unscanned],
  });

  // The real encoder, not a table of numbers. Which sibling blocks the pattern is
  // then a measurement rather than a decision this test made about itself.
  const probe = await createSharpProbe();
  const probes = await probeAssets(discovered.assets, { probe, formats: ['webp'] });

  return {
    graph,
    probes,
    plan: planOptimization({
      graph,
      probes,
      format: 'webp',
      publicPolicy,
      hedged: new Map(),
      servingRoots: SERVING_ROOTS,
      builds: BUILDS,
    }),
  };
}

describe('a partial-failure state, built by hand because no real repository has one', () => {
  describe('the premise, which every assertion below depends on', () => {
    it('resolves one reference to four separate assets', async () => {
      // If this became two references, or resolved to one asset, the state below would
      // stop being a partial failure, and the fixture would stop testing what it exists
      // for while still passing.
      const { graph } = await planFor('replace');

      const targets = graph.references.flatMap((reference) =>
        reference.resolution === 'resolved-pattern' ? reference.resolvedPaths : [],
      );
      expect(targets.map((path) => path.split(/[\\/]/).pop()).sort()).toEqual([
        'theme-dark.png',
        'theme-light.png',
        'theme-not-an-image.png',
        'theme-sepia.png',
      ]);
    });

    it('has exactly one sibling that cannot convert, pinned to its reason', async () => {
      // Asserts the skip code, not only that one sibling did not convert, so the cause
      // cannot change without this test noticing. A blocker that fails because of how the
      // encoder behaves stops failing when the encoder improves; a file that is not an
      // image never converts. A tiny PNG cannot do the job, since lossless WebP beats even
      // the 70-byte `theme-dark.png`. Real repositories hold files of this shape, such as
      // railsgirls-com's `rg-lisboa-header.png`.
      const { probes } = await planFor('keep-original');
      const blocked = probes.filter((entry) =>
        entry.skipped.some((skip) => skip.code === 'not-an-image'),
      );

      expect(blocked.map((entry) => entry.relative)).toEqual(['public/theme-not-an-image.png']);
    });

    it('keeps theme-dark as the image that lossy webp grows and lossless shrinks', async () => {
      // The case for lossless WebP in one file: webp 80 makes this 70-byte PNG larger,
      // and lossless makes it smaller.
      const { graph, probes } = await planFor('keep-original');
      const source = graph.assets.find((node) => node.asset.relative === 'public/theme-dark.png');
      const probe = probes.find((entry) => entry.relative === 'public/theme-dark.png');
      const webp = probe?.encoded.find((size) => size.format === 'webp');

      if (source === undefined || webp === undefined) {
        throw new Error('theme-dark.png must be probed for webp');
      }

      // The setting chosen is lossless, and it beats a source the lossy encode grew.
      expect(webp.quality).toBe('lossless');
      expect(webp.bytes).toBeLessThan(source.asset.bytes);
    });
  });

  describe('the partial pattern on a real tree under replace, where only the template reaches the siblings', () => {
    it('converts none of the siblings the template alone reaches, and says why for each', async () => {
      // The template still asks for `.png`, so no reference would ever ask for a converted
      // sibling: under `replace` each would be a new file beside an original that has to
      // stay. `theme-dark` would convert losslessly and is declined like the others: the
      // rule is about who uses the file, not its size.
      const { plan } = await planFor('replace');
      const byTemplate = plan.declined.filter((entry) =>
        entry.reason.includes('reaches it only through'),
      );

      expect(byTemplate.map((entry) => entry.path)).toEqual([
        'public/theme-dark.png',
        'public/theme-light.png',
        'public/theme-sepia.png',
      ]);
      for (const entry of byTemplate) {
        // Where the reference is and what it says: the line that holds them.
        expect(entry.reason).toContain(
          '`src/App.jsx` reaches it only through `/theme-${mode}.png`',
        );
      }
      expect(plan.keptOriginals.some((kept) => kept.asset.includes('theme-'))).toBe(false);
      expect(plan.declined.some((entry) => entry.reason.includes('shares a pattern'))).toBe(false);
    });

    it('accounts for all four targets, with none left over', async () => {
      // Stated as arithmetic rather than as a spot check: an asset in no list would be a
      // silent skip, and this fails the moment one appears.
      const { plan, probes } = await planFor('replace');
      const converted = plan.conversions.map((conversion) => conversion.asset);
      const declined = plan.declined.map((entry) => entry.path);
      // `theme-not-an-image.png` was never measured, so the plan has no entry for it. Its
      // probe skip (`not-an-image`) accounts for it instead, and the report prints that
      // skip.
      const skipped = probes
        .filter((entry) => entry.skipped.length > 0)
        .map((entry) => entry.relative);

      for (const target of ['theme-dark', 'theme-light', 'theme-not-an-image', 'theme-sepia']) {
        const asset = `public/${target}.png`;
        expect(
          [...converted, ...declined, ...skipped],
          `${asset} is in no list at all: not converted, not declined, not skipped`,
        ).toContain(asset);
      }
      expect(declined).toContain('public/theme-light.png');
    });

    it('leaves the ordinary reference beside it untouched', async () => {
      // The control: a change that emptied the whole plan would satisfy every assertion
      // above.
      const { plan } = await planFor('replace');

      expect(plan.conversions.map((conversion) => conversion.asset)).toContain('public/banner.png');
      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['src/App.jsx']);
    });

    it('converts under keep-original only what replace converts: what a moved reference uses', async () => {
      // The same tree, the same measurements, the other policy. The siblings only the
      // template reaches are declined under either, since the template still asks for the
      // originals and a converted copy would be loaded by nobody.
      const { plan } = await planFor('keep-original');
      const replaced = (await planFor('replace')).plan;

      const converted = ['public/banner.png', 'public/screenshot.png', 'src/inline-logo.jpg'];
      expect(replaced.conversions.map((conversion) => conversion.asset)).toEqual(converted);
      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(converted);
      expect(plan.declined.some((entry) => entry.reason.includes('shares a pattern'))).toBe(false);
    });
  });

  describe('the kept original, on a real tree', () => {
    it('removes the originals whose references all move, served or loaded by the build', async () => {
      // `src/inline-logo.jpg` is one the build loads, and goes as a served one does. The
      // positive control too: a planner that stopped replacing anything would pass every
      // other assertion here.
      const { plan } = await planFor('replace');

      expect(
        plan.conversions
          .filter((conversion) => conversion.replacesOriginal)
          .map((conversion) => conversion.asset),
      ).toEqual(['public/banner.png', 'public/screenshot.png', 'src/inline-logo.jpg']);
      expect(plan.keptOriginals.map((kept) => kept.asset)).not.toContain('src/inline-logo.jpg');
    });

    it('never files a kept original as declined, which would deny it converted', async () => {
      // The lists are disjoint by construction: the report renders `declined` under
      // "Examined and not converted", and this asset was converted.
      const { plan } = await planFor('replace');

      expect(plan.conversions.map((conversion) => conversion.asset)).toContain(
        'src/inline-logo.jpg',
      );
      expect(plan.declined.map((entry) => entry.path)).not.toContain('src/inline-logo.jpg');
    });

    it('reports no kept originals under keep-original, where every original stays', async () => {
      // Saying it for every conversion would bury the one case that means something.
      expect((await planFor('keep-original')).plan.keptOriginals).toEqual([]);
    });
  });
});
