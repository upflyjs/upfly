import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { optimizeFromPipeline, optimizeProject } from './optimize-project.js';
import { runPipeline, servingRootsFor } from './pipeline.js';
import { convertibleImages } from './plan/plan.js';
import type { PublicPolicy } from './plan/plan.js';
import type { ServingRoots } from './resolve/resolve.js';
import type { OptimizeResult } from './write/optimize.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** What a plan converts and keeps, and why it leaves each image as it is. */
function decisions(result: OptimizeResult) {
  return {
    conversions: result.plan.conversions,
    keptOriginals: result.plan.keptOriginals,
    rewrites: result.plan.rewrites,
    declined: result.plan.declined,
  };
}

/** A dry run planned from the measurements of only the images a plan could convert. */
async function plannedFromConvertible(
  root: string,
  publicPolicy: PublicPolicy,
  declared?: ServingRoots,
  maxEncodedAssets?: number,
) {
  const pipeline = await runPipeline({
    root,
    servingRoots: servingRootsFor(declared),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: {
      formats: ['webp'],
      ...(maxEncodedAssets === undefined ? {} : { maxEncodedAssets }),
    },
    encodeOnly: (built) => convertibleImages({ ...built, format: 'webp' }),
  });
  return {
    pipeline,
    result: await optimizeFromPipeline(pipeline, { format: 'webp', publicPolicy, apply: false }),
  };
}

/** A dry run planned from the measurements of every image, as `optimize` used to measure. */
async function plannedFromEverything(root: string, publicPolicy: PublicPolicy) {
  const pipeline = await runPipeline({
    root,
    servingRoots: servingRootsFor(),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: { formats: ['webp'] },
  });
  return await optimizeFromPipeline(pipeline, { format: 'webp', publicPolicy, apply: false });
}

describe('a plan from the measurements of the images it could convert', () => {
  it.each([
    ['plain-html', 'keep-original'],
    ['plain-html', 'replace'],
    ['vite-react', 'keep-original'],
    ['vite-react', 'replace'],
    ['partial-pattern', 'replace'],
  ] as const)(
    'is the plan made from every image measured, reasons included (%s, %s)',
    async (fixture, policy) => {
      const root = join(FIXTURES, fixture);

      const everything = await plannedFromEverything(root, policy);
      const { result } = await plannedFromConvertible(root, policy);

      expect(everything.plan.conversions.length).toBeGreaterThan(0);
      expect(decisions(result)).toEqual(decisions(everything));
    },
    60_000,
  );

  it.each([
    ['plain-html', 'keep-original'],
    ['vite-react', 'replace'],
    ['partial-pattern', 'replace'],
  ] as const)(
    'is what `optimizeProject` itself plans (%s, %s)',
    async (fixture, policy) => {
      const root = join(FIXTURES, fixture);

      const everything = await plannedFromEverything(root, policy);
      const mine = await optimizeProject({
        root,
        format: 'webp',
        publicPolicy: policy,
        apply: false,
      });

      expect(decisions(mine.optimize)).toEqual(decisions(everything));
      // What the filter is for: an image no conversion of could be used is not encoded.
      const measured = (mine.pipeline.probes ?? []).filter((probe) =>
        probe.encoded.some((encoded) => encoded.format === 'webp'),
      );
      expect(measured.length).toBeLessThan(mine.pipeline.graph.assets.length);
    },
    60_000,
  );
});

describe('a plan from a capped measurement', () => {
  it('converts no image the full plan would not, measuring together images whose converted files share a name', async () => {
    // logo.png and logo.jpg would both become a/logo.webp, so the full plan converts neither.
    // A cap of two takes big.png and logo.png; measured without logo.jpg, logo.png would
    // seem free to convert.
    const root = await mkdtemp(join(tmpdir(), 'upfly-capped-plan-'));
    roots.push(root);
    const image = (name: string) => readFile(join(FIXTURES, 'plain-html/images', name));
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    await writeFile(join(root, 'b/big.png'), await image('inline.png'));
    await writeFile(join(root, 'a/logo.png'), await image('texture.png'));
    await writeFile(join(root, 'a/logo.jpg'), await image('hero.jpg'));
    await writeFile(
      join(root, 'index.html'),
      '<img src="b/big.png" alt=""><img src="a/logo.png" alt=""><img src="a/logo.jpg" alt="">\n',
    );
    const declared = { dirs: [''], declared: true };

    const everything = await optimizeProject({
      root,
      declared,
      format: 'webp',
      publicPolicy: 'replace',
      apply: false,
    });
    const capped = await plannedFromConvertible(root, 'replace', declared, 2);
    const converted = (result: OptimizeResult) =>
      result.plan.conversions.map((conversion) => conversion.asset);

    expect(converted(everything.optimize)).toEqual(['b/big.png']);
    expect(converted(capped.result)).toEqual(['b/big.png']);
    const jpg = capped.pipeline.probes?.find((probe) => probe.relative === 'a/logo.jpg');
    expect(jpg?.encoded.length).toBe(1);
  }, 60_000);
});

describe('an original under the default policy', () => {
  /** A copy of vite-react outside the workspace, with more files beside it. */
  async function viteCopy(extra: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'upfly-bundled-'));
    roots.push(root);
    await cp(join(FIXTURES, 'vite-react'), root, {
      recursive: true,
      filter: (source) => !source.includes('node_modules'),
    });
    for (const [path, text] of Object.entries(extra)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    return root;
  }

  async function planned(root: string) {
    const { plan } = (
      await optimizeProject({ root, format: 'webp', publicPolicy: 'replace', apply: false })
    ).optimize;
    const removed = plan.conversions
      .filter((conversion) => conversion.replacesOriginal)
      .map((conversion) => conversion.asset);
    return { plan, removed };
  }

  it('is removed among the images a build loads, as in a served folder', async () => {
    const { removed } = await planned(join(FIXTURES, 'vite-react'));

    expect(removed).toEqual([
      'public/photos/wide.jpg',
      'public/photos/wide@2x.jpg',
      'public/screenshot.png',
      'src/assets/banner.png',
      'src/assets/logo.png',
    ]);
  }, 60_000);

  it('stays when a file names it where the run cannot rewrite it, or a glob could load it', async () => {
    const named = await planned(
      await viteCopy({ 'docs/assets.txt': 'The logo is src/assets/logo.png.\n' }),
    );
    const globbed = await planned(
      await viteCopy({
        'src/gallery.js': "export const images = import.meta.glob('./assets/*.png');\n",
      }),
    );

    expect(named.plan.conversions.map((conversion) => conversion.asset)).not.toContain(
      'src/assets/logo.png',
    );
    expect(named.removed).toContain('src/assets/banner.png');
    expect(globbed.removed).not.toContain('src/assets/banner.png');
    expect(globbed.plan.keptOriginals.map((kept) => kept.asset)).toEqual(
      expect.arrayContaining(['src/assets/banner.png', 'src/assets/logo.png']),
    );
  }, 60_000);
});
