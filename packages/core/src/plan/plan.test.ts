import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SHAPES, whyFormatKept } from '../adapters/shapes.js';
import { buildGraph } from '../graph/graph.js';
import { compareStrings, toPosix } from '../paths.js';
import type { AssetProbe } from '../probe/probe.js';
import type { AliasMap } from '../resolve/aliases.js';
import type { Asset, RawReference, Reference } from '../types.js';
import type { ProjectBuilds } from './builds.js';
import {
  type LinkedReference,
  type PlanInput,
  planOptimization,
  whyReferenceStays,
} from './plan.js';

// Resolved, as `discover` returns it: the planner resolves each rewritten path again, and on
// Windows `path.resolve` gives a bare '/repo' the current drive, which no asset here would have.
const ROOT = resolve('/repo');

/**
 * Most cases here name images outside the served folder, which only a build can load, so the
 * build is stated as one known to load the new format. The cases about other builds say so.
 */
const BUILT_BY_VITE: ProjectBuilds = {
  packages: [{ folder: '', build: { kind: 'known', name: 'Vite' } }],
};

function asset(relative: string, bytes = 10_000): Asset {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

/**
 * A measurement that says this asset shrinks to `bytes` as webp. The header's format follows
 * the asset's name, as it does in a project where nothing is mislabelled.
 */
function probe(relative: string, bytes = 4_000): AssetProbe {
  const extension = relative.slice(relative.lastIndexOf('.') + 1).toLowerCase();
  const format = extension === 'jpg' ? 'jpeg' : extension;
  return {
    relative,
    metadata: { width: 100, height: 100, format, pages: 1 },
    encoded: [{ format: 'webp', bytes, quality: 80 }],
    skipped: [],
  };
}

const RAW: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
  kind: 'attr',
  shape: 'html.img.src',
  ceiling: 'high',
  asserted: true,
};

function resolved(
  file: string,
  rawPath: string,
  target: string,
  over: Partial<Reference> = {},
): Reference {
  return {
    ...RAW,
    file: `${ROOT}/${file}`,
    rawPath,
    start: 10,
    end: 10 + rawPath.length,
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'file',
    ...over,
  } as Reference;
}

function pattern(file: string, rawPath: string, targets: readonly string[]): Reference {
  return {
    ...RAW,
    file: `${ROOT}/${file}`,
    rawPath,
    start: 10,
    end: 10 + rawPath.length,
    ceiling: 'medium',
    resolution: 'resolved-pattern',
    confidence: 'medium',
    resolvedPaths: targets.map((target) => `${ROOT}/${target}`) as [string, ...string[]],
    resolvedVia: 'file',
  } as Reference;
}

function input(
  over: Partial<PlanInput> & {
    assets: Asset[];
    references: Reference[];
    /** Shorthand for undeclared serving roots. */
    served?: readonly string[];
  },
): PlanInput {
  return {
    graph: buildGraph({
      root: ROOT,
      assets: over.assets,
      references: over.references,
      unscannedFiles: [],
    }),
    probes: over.probes ?? over.assets.map((a) => probe(a.relative)),
    format: 'webp',
    publicPolicy: over.publicPolicy ?? 'keep-original',
    hedged: over.hedged ?? new Set(),
    servingRoots: over.servingRoots ?? { dirs: over.served ?? ['public'], declared: false },
    builds: over.builds ?? BUILT_BY_VITE,
    ...(over.aliases === undefined ? {} : { aliases: over.aliases }),
    ...(over.listDirectory === undefined ? {} : { listDirectory: over.listDirectory }),
    ...(over.rootLinkPolicy === undefined ? {} : { rootLinkPolicy: over.rootLinkPolicy }),
  };
}

describe('why a reference stays as it is', () => {
  it('is the answer the planner gives: none for a reference it moves, the reason for each it leaves', () => {
    const plain = resolved('index.html', 'img/logo.png', 'img/logo.png');
    const guess = resolved('app.js', 'img/logo.png', 'img/logo.png', {
      resolvedVia: 'speculative-root',
    });
    const template = pattern('app.js', '`img/${name}.png`', ['img/logo.png', 'img/other.png']);
    const bare = resolved('app.js', 'img/logo', 'img/logo.png');
    const planned = input({
      assets: [asset('img/logo.png'), asset('img/other.png')],
      references: [plain, guess, template, bare],
    });

    expect(whyReferenceStays(plain as LinkedReference, planned)).toBeNull();
    expect(whyReferenceStays(guess as LinkedReference, planned)).toBe(
      'the path is a guess that happened to resolve against the project root, which shows the asset is alive but not that this text may be edited',
    );
    expect(whyReferenceStays(template as LinkedReference, planned)).toBe(
      'a template reference is assembled at runtime, so its text cannot be repointed',
    );
    expect(whyReferenceStays(bare as LinkedReference, planned)).toBe(
      'the path has no extension, so there is nothing in it to change',
    );
  });
});

describe('an image two builds load', () => {
  // The build of the file holding the reference decides, not the image's folder: the same
  // shared image is loaded by each app's own build.
  const IMPORT = { kind: 'import', shape: 'js.import.static' } as const;
  const viteImport = resolved(
    'apps/web/src/App.jsx',
    '../../../shared/logo.png',
    'shared/logo.png',
    IMPORT,
  );
  const webpackImport = resolved(
    'apps/legacy/src/App.jsx',
    '../../../shared/logo.png',
    'shared/logo.png',
    IMPORT,
  );
  const TWO_APPS: ProjectBuilds = {
    packages: [
      { folder: 'apps/legacy', build: { kind: 'other', file: 'apps/legacy/webpack.config.js' } },
      { folder: 'apps/web', build: { kind: 'known', name: 'Vite' } },
    ],
  };
  const twoApps = (publicPolicy: 'keep-original' | 'replace') =>
    input({
      assets: [asset('shared/logo.png')],
      references: [viteImport, webpackImport],
      builds: TWO_APPS,
      publicPolicy,
    });

  it('converts it for the build known to load the new format, and leaves the other import as written', () => {
    const plan = planOptimization(twoApps('keep-original'));

    expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(['shared/logo.png']);
    expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['apps/web/src/App.jsx']);
    expect(plan.declined).toEqual([
      {
        path: 'apps/legacy/src/App.jsx',
        line: null,
        reason:
          'the build loads this path, and that build is set up in `apps/legacy/webpack.config.js`, which may have no rule for WebP files, so shared/logo.png was converted without this reference moving',
      },
    ]);
  });

  it('keeps the original under replace, since the other import still names it', () => {
    const plan = planOptimization(twoApps('replace'));

    expect(plan.conversions.map((conversion) => conversion.replacesOriginal)).toEqual([false]);
    expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual(['shared/logo.png']);
  });

  it('gives the refs command the same reason the plan gives', () => {
    expect(whyReferenceStays(webpackImport as LinkedReference, twoApps('keep-original'))).toBe(
      'the build loads this path, and that build is set up in `apps/legacy/webpack.config.js`, which may have no rule for WebP files; Upfly converts an image a build loads only for Vite, Next.js and Astro, which load WebP by themselves',
    );
    expect(whyReferenceStays(viteImport as LinkedReference, twoApps('keep-original'))).toBeNull();
  });
});

describe('a path holding a backslash', () => {
  it('swaps the extension after an escaped dot in a Markdown destination, as on every platform', () => {
    const rawPath = 'img/hero\\.png';
    const plan = planOptimization(
      input({
        assets: [asset('img/hero.png')],
        references: [
          resolved('page.md', rawPath, 'img/hero.png', { kind: 'md', shape: 'md.image' }),
        ],
      }),
    );

    expect(plan.rewrites).toEqual([
      {
        file: 'page.md',
        edits: [
          {
            start: 10,
            end: 10 + rawPath.length,
            replacement: 'img/hero\\.webp',
            expected: rawPath,
          },
        ],
      },
    ]);
  });
});

describe('the ordinary case', () => {
  it('converts a linked asset and repoints the reference that names it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png')],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
      }),
    );

    expect(plan.conversions).toEqual([
      {
        asset: 'src/logo.png',
        target: 'src/logo.webp',
        format: 'webp',
        quality: 80,
        savedBytes: 6_000,
        replacesOriginal: false,
      },
    ]);
    expect(plan.rewrites).toEqual([
      {
        file: 'src/App.jsx',
        edits: [{ start: 10, end: 20, replacement: './logo.webp', expected: './logo.png' }],
      },
    ]);
    expect(plan.declined).toEqual([]);
  });

  it('gives each rewrite the hash of the text its offsets count into', () => {
    const assets = [asset('src/logo.png')];
    const references = [resolved('src/App.jsx', './logo.png', 'src/logo.png')];
    const texts = [
      {
        path: `${ROOT}/src/App.jsx`,
        hash: 'hash-of-the-scanned-text',
        holdsReplacementCharacter: false,
      },
    ];

    const plan = planOptimization({
      ...input({ assets, references }),
      graph: buildGraph({ root: ROOT, assets, references, unscannedFiles: [], texts }),
    });

    expect(plan.rewrites.map((rewrite) => rewrite.textHash)).toEqual(['hash-of-the-scanned-text']);
  });

  it('does not convert an asset the encode made bigger', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png', 1_000)],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        probes: [probe('src/logo.png', 4_000)],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
  });
});

describe('without --replace, an image converts only when a reference moves to it', () => {
  // A new file nothing loads saves no visitor a byte, so its size is not a saving.
  it('declines an image nothing links to, in a served directory too', () => {
    const plan = planOptimization(
      input({ assets: [asset('public/img/orphan.png')], references: [], served: ['public'] }),
    );

    expect(plan.conversions).toEqual([]);
    expect(reasonsByPath(plan)['public/img/orphan.png']).toBe(
      'nothing links to it, so converting it would rewrite no reference and gain only bytes',
    );
  });

  it('declines an image only a link names, saying which reference holds it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('public/img/photo.png')],
        references: [
          resolved('index.html', '/img/photo.png', 'public/img/photo.png', {
            kind: 'attr',
            shape: 'html.a.href.image',
          }),
        ],
        served: ['public'],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(reasonsByPath(plan)['public/img/photo.png']).toContain(
      '`index.html` names it as `/img/photo.png`, and this run does not rewrite that reference',
    );
  });
});

describe('an asset nothing links to', () => {
  it('is left alone outside a public directory, with the reason recorded', () => {
    const plan = planOptimization({
      ...input({ assets: [asset('src/orphan.png')], references: [] }),
    });

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'src/orphan.png',
        line: null,
        reason:
          'nothing links to it, so converting it would rewrite no reference and gain only bytes',
      },
    ]);
  });

  it('says so differently when something unreadable mentions it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/maybe.png')],
        references: [],
        hedged: new Set(['src/maybe.png']),
      }),
    );

    expect(plan.declined[0]?.reason).toContain('something we could not read mentions it');
  });

  it('is not converted under replace, because the new file would be used by nobody', () => {
    // Under `replace` the original has to stay, since nothing moved away from it, and no
    // reference would ask for the new file: converting would leave exactly the pair of
    // files `replace` exists to avoid. Hedged or not: something unreadable still names
    // the original, not the new file.
    const plan = planOptimization(
      input({
        assets: [asset('public/hero.png'), asset('public/maybe.png')],
        references: [],
        hedged: new Set(['public/maybe.png']),
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.keptOriginals).toEqual([]);
    expect(reasonsByPath(plan)).toEqual({
      'public/hero.png':
        'nothing links to it, so converting it would rewrite no reference and gain only bytes',
      'public/maybe.png': expect.stringContaining('something we could not read mentions it'),
    });
  });
});

describe('references it refuses to rewrite', () => {
  it('leaves an unsafe reference alone and says the asset moved without it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('public/hero.png')],
        references: [
          resolved('src/App.jsx', './hero.png', 'public/hero.png', { confidence: 'unsafe' }),
          // The reference that moves, so the asset converts.
          resolved('index.html', '/hero.png', 'public/hero.png'),
        ],
      }),
    );

    expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['index.html']);
    expect(plan.declined[0]?.reason).toContain('no static path to replace');
    expect(plan.declined[0]?.reason).toContain('public/hero.png was converted');
  });

  it('leaves a speculative path that happened to resolve against the root', () => {
    const plan = planOptimization(
      input({
        assets: [asset('public/hero.png')],
        references: [
          resolved('src/data.json', './hero.png', 'public/hero.png', {
            asserted: false,
            resolvedVia: 'speculative-root',
          }),
        ],
      }),
    );

    expect(plan.rewrites).toEqual([]);
    expect(plan.declined[0]?.reason).toContain('shows the asset is alive but not that this text');
  });
});

/**
 * A link preview is fetched by other sites, which may not decode a converted format, and a
 * link hands the file itself to whoever follows it. Such a reference links its asset, so the
 * asset is alive, but no plan repoints it, and under `replace` its original stays.
 */
describe('a reference whose shape keeps the format: a link preview, a link to an image', () => {
  const assets = [asset('public/img/banner.png')];
  const preview = resolved('index.html', '/img/banner.png', 'public/img/banner.png', {
    shape: 'html.meta.content.image',
  });
  const image = resolved('index.html', '/img/banner.png', 'public/img/banner.png', {
    start: 60,
    end: 75,
  });

  it('is left as it is while the image beside it moves, with the reason given', () => {
    const plan = planOptimization(input({ assets, references: [preview, image] }));

    expect(plan.conversions.map((conversion) => conversion.asset)).toEqual([
      'public/img/banner.png',
    ]);
    expect(plan.rewrites).toEqual([
      {
        file: 'index.html',
        edits: [
          { start: 60, end: 75, replacement: '/img/banner.webp', expected: '/img/banner.png' },
        ],
      },
    ]);
    expect(plan.declined).toEqual([
      {
        path: 'index.html',
        line: null,
        reason: expect.stringMatching(
          /^a link preview .+, so public\/img\/banner\.png was converted without this reference moving$/,
        ),
      },
    ]);
  });

  it('keeps the original under replace while the preview still names it', () => {
    const plan = planOptimization(
      input({ assets, references: [preview, image], publicPolicy: 'replace' }),
    );

    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['public/img/banner.png', false],
    ]);
    expect(plan.keptOriginals[0]?.reason).toContain(
      '`index.html` names it as `/img/banner.png`, and this run does not rewrite that reference',
    );
  });

  it('converts nothing under replace for an image only a preview or a link names', () => {
    for (const shape of ['html.meta.content.image', 'js.jsx.a.href.image'] as const) {
      const only = { ...preview, shape } as Reference;
      const plan = planOptimization(input({ assets, references: [only], publicPolicy: 'replace' }));

      expect(plan.conversions, shape).toEqual([]);
      expect(reasonsByPath(plan)['public/img/banner.png'], shape).toContain(
        '`index.html` names it as `/img/banner.png`, and this run does not rewrite that reference',
      );
    }
  });

  it('reads the rule from the shape table, where previews, links, icons and manifests alone carry it', () => {
    const kept = SHAPES.filter((shape) => whyFormatKept(shape.id) !== null).map((s) => s.id);
    expect(kept).toEqual([
      'html.link.href.icon',
      'html.meta.content.image',
      'html.a.href.image',
      'js.jsx.meta.content.image',
      'js.jsx.a.href.image',
      'js.jsx.link.href.icon',
      'md.link',
      'md.reference-definition.link',
      'json.webmanifest.icon',
      'json.webmanifest.other',
    ]);
  });
});

/**
 * Browsers and phones read an icon, a Windows tile and a web app manifest's images outside
 * the page, and not all of them read a converted format: iOS shows a home-screen icon only as
 * PNG. So no plan repoints such a reference, and an image nothing else names stays as it is.
 */
describe('an image a platform reads outside the page: an icon, a tile, a manifest entry', () => {
  const assets = [asset('public/icons/touch.png')];

  it.each([
    ['index.html', 'html.link.href.icon', 'attr'],
    ['src/Head.jsx', 'js.jsx.link.href.icon', 'attr'],
    ['index.html', 'html.meta.content.image', 'attr'],
    ['public/site.webmanifest', 'json.webmanifest.icon', 'json'],
  ] as const)(
    'is not converted when %s names it only as %s, under either policy',
    (file, shape, kind) => {
      const only = resolved(file, '/icons/touch.png', 'public/icons/touch.png', { shape, kind });
      for (const publicPolicy of ['keep-original', 'replace'] as const) {
        const plan = planOptimization(input({ assets, references: [only], publicPolicy }));
        const reason = reasonsByPath(plan)['public/icons/touch.png'];

        expect(plan.conversions, publicPolicy).toEqual([]);
        expect(plan.rewrites, publicPolicy).toEqual([]);
        expect(reason, publicPolicy).toContain(
          `\`${file}\` names it as \`/icons/touch.png\`, and this run does not rewrite that reference`,
        );
        expect(reason, publicPolicy).toContain(`${whyFormatKept(shape)}`);
      }
    },
  );
});

/**
 * The report counts a saving only from 1 KB, and then only when it is 10% of the file or
 * 100 KB. A conversion below that is not counted there, so converting it made the plan's
 * saving differ from the report's.
 */
describe('a saving too small for the report to count', () => {
  const reference = resolved('index.html', '/img/a.png', 'public/img/a.png');
  const plan = (bytes: number, after: number) =>
    planOptimization(
      input({
        assets: [asset('public/img/a.png', bytes)],
        references: [reference],
        probes: [probe('public/img/a.png', after)],
      }),
    );

  it('is not converted when it is under 1 KB, with the reason', () => {
    const small = plan(10_000, 9_200);

    expect(small.conversions).toEqual([]);
    expect(reasonsByPath(small)['public/img/a.png']).toBe(
      'converting it would save 800 B, under the 1 KB a saving must reach to be reported or converted',
    );
  });

  it('is not converted when it is under 10% of the file and under 100 KB, with the reason', () => {
    const slight = plan(50_000, 47_000);

    expect(slight.conversions).toEqual([]);
    expect(reasonsByPath(slight)['public/img/a.png']).toBe(
      'converting it would save 3 KB, 6% of the file, under the 10% of the file or 100 KB a saving must reach to be reported or converted',
    );
  });

  it('is converted from 1 KB and 10%, and from 100 KB at any share, as the report counts it', () => {
    expect(plan(10_000, 8_976).conversions.map((c) => c.savedBytes)).toEqual([1_024]);
    expect(plan(2_000_000, 1_890_000).conversions.map((c) => c.savedBytes)).toEqual([110_000]);
  });
});

describe('a path that resolved through its decoded spelling', () => {
  it('is rewritten as the author spelled it, so it decodes to the converted file', () => {
    // Only the extension is swapped, so the reference still spells the accent the same way.
    const cafe = `public/img/caf${String.fromCodePoint(0xe9)}`;
    const plan = planOptimization(
      input({
        assets: [asset(`${cafe}.png`)],
        references: [
          resolved('docs/guide.md', '/img/caf&eacute;.png', `${cafe}.png`, {
            kind: 'md',
            shape: 'md.image',
            resolvedVia: 'serving-root',
            spelling: 'html-entities',
          }),
        ],
      }),
    );

    expect(plan.conversions.map((conversion) => conversion.target)).toEqual([`${cafe}.webp`]);
    expect(plan.rewrites.flatMap((rewrite) => rewrite.edits)).toEqual([
      {
        start: 10,
        end: 30,
        replacement: '/img/caf&eacute;.webp',
        expected: '/img/caf&eacute;.png',
      },
    ]);
  });

  it('keeps a Markdown escape, so the new text reads as the converted file', () => {
    // `my\_photo.webp` is what CommonMark reads as `my_photo.webp`.
    const plan = planOptimization(
      input({
        assets: [asset('public/img/my_photo.png')],
        references: [
          resolved('docs/guide.md', '/img/my\\_photo.png', 'public/img/my_photo.png', {
            kind: 'md',
            shape: 'md.image',
            resolvedVia: 'serving-root',
            spelling: 'markdown-escapes',
          }),
        ],
      }),
    );

    expect(plan.rewrites.flatMap((rewrite) => rewrite.edits)).toEqual([
      {
        start: 10,
        end: 28,
        replacement: '/img/my\\_photo.webp',
        expected: '/img/my\\_photo.png',
      },
    ]);
  });
});

describe('a root-relative path that resolved at the project root', () => {
  const tree = {
    assets: [asset('public/hero.png')],
    references: [
      resolved('index.html', '/hero.png', 'public/hero.png', { resolvedVia: 'project-root' }),
    ],
  };

  it('is rewritten on a project with no serving root, which is the ordinary static site', () => {
    const plan = planOptimization(
      input({ ...tree, servingRoots: { dirs: ['public'], declared: false } }),
    );

    // The end is derived from the path being replaced rather than written down:
    // `/hero.png` is nine characters, not the ten of `./logo.png` above.
    expect(plan.rewrites).toEqual([
      {
        file: 'index.html',
        edits: [
          {
            start: 10,
            end: 10 + '/hero.png'.length,
            replacement: '/hero.webp',
            expected: '/hero.png',
          },
        ],
      },
    ]);
  });

  it('is declined when a serving root was configured and the path missed it', () => {
    // The sub-case that is real but unevidenced: the path missed a root that was
    // configured, so existing at the project root may be coincidence.
    const plan = planOptimization(
      input({ ...tree, servingRoots: { dirs: ['public'], declared: true } }),
    );

    expect(plan.rewrites).toEqual([]);
    expect(plan.declined[0]?.reason).toContain('missed the configured serving root');
  });

  it('can be forced either way, because the policy is named rather than implied', () => {
    const forced = planOptimization(
      input({
        ...tree,
        servingRoots: { dirs: ['public'], declared: true },
        rootLinkPolicy: 'always',
      }),
    );
    const refused = planOptimization(
      input({
        ...tree,
        servingRoots: { dirs: ['public'], declared: false },
        rootLinkPolicy: 'never',
      }),
    );

    expect(forced.rewrites).toHaveLength(1);
    expect(refused.rewrites).toEqual([]);
  });
});

/** Declined reasons keyed by path, so two plans compare without depending on order. */
function reasonsByPath(plan: { declined: readonly { path: string; reason: string }[] }) {
  return Object.fromEntries(plan.declined.map((entry) => [entry.path, entry.reason]));
}

describe('a template reference standing for many assets', () => {
  const assets = [asset('public/a-light.png'), asset('public/a-dark.png', 1_000)];
  const references = [
    pattern('src/App.jsx', './a-${mode}.png', ['public/a-light.png', 'public/a-dark.png']),
  ];

  // a-dark is measured larger than its source, so it does not convert.
  const probes = [probe('public/a-light.png', 4_000), probe('public/a-dark.png', 4_000)];

  it('says it stays as written, and how many of its targets do not convert', () => {
    const plan = planOptimization(input({ assets, references, probes }));

    expect(plan.rewrites).toEqual([]);
    expect(plan.declined.map((d) => d.reason)).toContainEqual(
      expect.stringContaining('none of the 2 assets it matches converts'),
    );
  });

  it('says so of its one target at a count of one', () => {
    const plan = planOptimization(
      input({
        assets: [asset('public/a-dark.png', 1_000)],
        references: [pattern('src/App.jsx', './a-${mode}.png', ['public/a-dark.png'])],
        probes: [probe('public/a-dark.png', 4_000)],
      }),
    );

    expect(plan.declined.map((d) => d.reason)).toContainEqual(
      expect.stringContaining('cannot be repointed, and the one asset it matches does not convert'),
    );
  });

  it('converts none of them under keep-original either, and says the reference stayed', () => {
    // The template still asks for `.png`, so a converted copy would be loaded by nobody.
    const plan = planOptimization(input({ assets, references, probes }));

    expect(plan.conversions).toEqual([]);
    expect(plan.declined.some((d) => d.reason.includes('its text cannot be repointed'))).toBe(true);
  });

  it('converts none of them under replace, because no reference would move to a new file', () => {
    // The template still asks for `.png` whatever converts, so a converted copy would sit
    // beside an original that has to stay.
    const plan = planOptimization(input({ assets, references, probes, publicPolicy: 'replace' }));

    expect(plan.conversions).toEqual([]);
    expect(plan.keptOriginals).toEqual([]);
    expect(reasonsByPath(plan)['public/a-light.png']).toContain(
      '`src/App.jsx` reaches it only through `./a-${mode}.png`, a path assembled at runtime',
    );
  });

  it('says the reference stayed once, and truthfully, when only some targets convert', () => {
    // One decline for the reference, "1 of the 2 assets it matches does not convert", and
    // not also "... even though every asset it matches converted", which is false when one
    // did not. A plain reference moves to a-light, so it converts under either policy.
    const moving = [...references, resolved('index.html', '/a-light.png', 'public/a-light.png')];
    const expected = {
      'keep-original': '1 of the 2 assets it matches does not convert',
      replace: '1 of the 2 assets it matches does not convert',
    } as const;
    for (const publicPolicy of ['keep-original', 'replace'] as const) {
      const plan = planOptimization(input({ assets, references: moving, probes, publicPolicy }));
      const reasons = plan.declined
        .filter((entry) => entry.path === 'src/App.jsx')
        .map((entry) => entry.reason);

      expect(reasons).toEqual([expect.stringContaining(expected[publicPolicy])]);
    }
  });

  describe('a partial pattern under replace, where a target only the pattern reaches is not converted', () => {
    /**
     * Under `replace` a target only the pattern reaches is declined: the pattern still
     * asks for the original, so no reference would ever ask for a converted copy.
     *
     * Asserted here: every asset the pattern matched is accounted for, nothing is
     * reported twice, and the plan is the same on every run.
     */
    const three = [
      asset('public/a-light.png'),
      asset('public/a-mid.png'),
      asset('public/a-dark.png', 1_000),
    ];
    const threeReferences = [
      pattern('src/App.jsx', './a-${mode}.png', [
        'public/a-light.png',
        'public/a-mid.png',
        'public/a-dark.png',
      ]),
    ];
    const threeProbes = [
      probe('public/a-light.png', 4_000),
      probe('public/a-mid.png', 4_000),
      probe('public/a-dark.png', 4_000),
    ];

    function replacePlan() {
      return planOptimization(
        input({
          assets: three,
          references: threeReferences,
          probes: threeProbes,
          publicPolicy: 'replace',
        }),
      );
    }

    it('accounts for every asset the pattern matched, with nothing left over', () => {
      // The whole claim, stated as arithmetic rather than as a spot check: three assets
      // went in and all three are declined, one for its own reason and two because only
      // the pattern reaches them. An asset in neither list would be a silent skip, and
      // this fails the moment one appears.
      const plan = replacePlan();
      const declinedAssets = plan.declined
        .map((entry) => entry.path)
        .filter((path) => path.startsWith('public/'));

      expect(plan.conversions).toEqual([]);
      expect(declinedAssets).toEqual([
        'public/a-dark.png',
        'public/a-light.png',
        'public/a-mid.png',
      ]);
    });

    it('declines every target only the pattern reaches, naming the reference that holds it', () => {
      // The actionable part: where the reference is and what it says, so a reader who
      // wants these converted under `replace` knows which line would have to change.
      const plan = replacePlan();
      const reasons = reasonsByPath(plan);

      expect(plan.keptOriginals).toEqual([]);
      for (const path of ['public/a-light.png', 'public/a-mid.png']) {
        expect(reasons[path]).toContain('`src/App.jsx` reaches it only through `./a-${mode}.png`');
        expect(reasons[path]).toContain('used by nobody');
      }
    });

    it('does not report a blocker twice under two different explanations', () => {
      // `a-dark.png` failed for its own reason and already has an entry. Adding a
      // second one saying it was withdrawn would describe one failure as two.
      const entries = replacePlan().declined.filter((entry) => entry.path === 'public/a-dark.png');

      expect(entries).toHaveLength(1);
      expect(entries[0]?.reason).not.toContain('shares a pattern reference');
    });

    it('converts none of them under keep-original either, since the pattern still asks for the originals', () => {
      const keep = planOptimization(
        input({ assets: three, references: threeReferences, probes: threeProbes }),
      );

      expect(keep.conversions).toEqual([]);
      expect(replacePlan().conversions).toEqual([]);
    });

    it('decides the same on every run, whatever order the graph listed the targets in', () => {
      // The same input must give the same plan. Two blockers and one survivor, listed in
      // both orders: a plan that picked whichever the graph listed first would differ
      // between runs over an unchanged tree.
      // Its own assets, because `three` gives every asset 10 000 bytes by default and a
      // 4 000-byte encode is a saving, which would convert `a-mid` and leave one blocker.
      // Here `a-mid` and `a-dark` are both smaller than their own encode, so both fail.
      const twoSmall = [
        asset('public/a-light.png'),
        asset('public/a-mid.png', 1_000),
        asset('public/a-dark.png', 1_000),
      ];
      const twoBlockers = [
        probe('public/a-light.png', 400),
        probe('public/a-mid.png', 4_000),
        probe('public/a-dark.png', 4_000),
      ];
      const reversed = [
        pattern('src/App.jsx', './a-${mode}.png', [
          'public/a-dark.png',
          'public/a-mid.png',
          'public/a-light.png',
        ]),
      ];

      const forwards = planOptimization(
        input({
          assets: twoSmall,
          references: threeReferences,
          probes: twoBlockers,
          publicPolicy: 'replace',
        }),
      );
      const backwards = planOptimization(
        input({
          assets: twoSmall,
          references: reversed,
          probes: twoBlockers,
          publicPolicy: 'replace',
        }),
      );

      // Stated as well as compared: an implementation that reversed both would satisfy
      // the equality without deciding anything stable.
      expect(reasonsByPath(forwards)['public/a-light.png']).toContain('reaches it only through');
      expect(backwards.conversions).toEqual(forwards.conversions);
      expect(reasonsByPath(backwards)).toEqual(reasonsByPath(forwards));
    });

    it('declines an asset once when two patterns both hold it, and counts the second', () => {
      // One asset, two references holding it: one entry naming the first and counting
      // the rest, as the kept-original sentences do. Two entries for one asset would
      // inflate every count built from `declined`.
      const twoPatterns = [
        pattern('src/App.jsx', './a-${mode}.png', ['public/a-light.png', 'public/a-dark.png']),
        pattern('src/Other.jsx', './a-${theme}.png', ['public/a-light.png', 'public/a-dark.png']),
      ];
      const plan = planOptimization(
        input({
          assets: three,
          references: twoPatterns,
          probes: threeProbes,
          publicPolicy: 'replace',
        }),
      );
      const entries = plan.declined.filter((entry) => entry.path === 'public/a-light.png');

      expect(entries).toHaveLength(1);
      expect(entries[0]?.reason).toContain(
        '`src/App.jsx` reaches it only through `./a-${mode}.png` (and 1 more)',
      );
      expect(plan.keptOriginals).toEqual([]);
    });
  });

  it('declines a template whose targets all convert, because the text is not a path', () => {
    // A plain reference moves to each target, so both convert.
    const plan = planOptimization(
      input({
        assets: [asset('public/a-light.png'), asset('public/a-dark.png')],
        references: [
          ...references,
          resolved('a.html', '/a-light.png', 'public/a-light.png'),
          resolved('b.html', '/a-dark.png', 'public/a-dark.png'),
        ],
        probes: [probe('public/a-light.png', 4_000), probe('public/a-dark.png', 400)],
      }),
    );

    expect(plan.conversions).toHaveLength(2);
    expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['a.html', 'b.html']);
    expect(plan.declined.some((d) => d.reason.includes('assembled at runtime'))).toBe(true);
  });
});

describe('the public policy', () => {
  it('marks a public asset for replacement only when asked', () => {
    const tree = {
      assets: [asset('public/hero.png')],
      references: [resolved('index.html', '/hero.png', 'public/hero.png')],
    };

    expect(planOptimization(input(tree)).conversions[0]?.replacesOriginal).toBe(false);
    expect(
      planOptimization(input({ ...tree, publicPolicy: 'replace' })).conversions[0]
        ?.replacesOriginal,
    ).toBe(true);
  });

  it('replaces an original the build loads, as one in a served folder', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png')],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions[0]?.replacesOriginal).toBe(true);
  });

  describe('an original the build loads', () => {
    const outside = {
      assets: [asset('src/logo.png')],
      references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
      publicPolicy: 'replace' as const,
    };

    it('is removed once every reference to it moves, so no kept original is reported', () => {
      const plan = planOptimization(input(outside));

      expect(plan.keptOriginals).toEqual([]);
    });

    it('keeps the asset out of declined, which says it was not converted', () => {
      // The report renders `declined` under "Examined and not converted", so filing a
      // converted asset there would put it under a heading saying the opposite, and two
      // of the report's counts could not both be true. The lists are disjoint and
      // `conversions` is complete.
      const plan = planOptimization(input(outside));

      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(['src/logo.png']);
      expect(plan.declined.map((entry) => entry.path)).not.toContain('src/logo.png');
    });

    it('says nothing under keep-original, where every original is kept', () => {
      // Reporting it there would repeat a sentence that means nothing once per
      // conversion, burying the case that does. The same argument as `PlanRefusal`'s.
      expect(
        planOptimization(input({ ...outside, publicPolicy: 'keep-original' })).keptOriginals,
      ).toEqual([]);
    });

    it('says nothing about a public asset, whose original really is removed', () => {
      const plan = planOptimization(
        input({
          assets: [asset('public/hero.png')],
          references: [resolved('index.html', '/hero.png', 'public/hero.png')],
          publicPolicy: 'replace',
        }),
      );

      expect(plan.conversions[0]?.replacesOriginal).toBe(true);
      expect(plan.keptOriginals).toEqual([]);
    });

    it('does not claim a kept original for an asset that never converted', () => {
      // Kept originals are derived from the surviving conversions, not collected as they
      // were decided. A collision withdraws both conversions after they were decided, so
      // a list built earlier would report a kept original for a file that was never
      // written: a false statement about a file on disk.
      const plan = planOptimization(
        input({
          assets: [asset('src/a.png'), asset('src/a.gif')],
          references: [
            resolved('src/App.jsx', './a.png', 'src/a.png'),
            resolved('src/Other.jsx', './a.gif', 'src/a.gif'),
          ],
          publicPolicy: 'replace',
        }),
      );

      expect(plan.conversions).toEqual([]);
      expect(plan.keptOriginals).toEqual([]);
    });
  });

  describe('under replace: an asset converts only if a reference moves to it, and its original goes only if all do', () => {
    /**
     * Both halves of one property, stated for every kind of reference that does not move:
     * a pattern, a refused literal, a path with no extension to change. Without the
     * deletion half, the originals behind `/theme-${mode}.png` would go while it still
     * asks for `.png`; without the conversion half, their converted copies would sit
     * beside them used by nothing.
     *
     * So each member appears twice. Alone, nothing moves to its asset, and the asset is
     * not converted. Beside a literal that does move, the asset converts and the member
     * keeps its original. The first two tests are the positive controls: a fix that
     * switched `replace` off passes every other test here, and fails those.
     */
    const theme = [asset('public/theme-light.png'), asset('public/theme-dark.png')];
    const template = pattern('src/Theme.jsx', '/theme-${mode}.png', [
      'public/theme-light.png',
      'public/theme-dark.png',
    ]);

    function replacing(assets: Asset[], references: Reference[], over: Partial<PlanInput> = {}) {
      return planOptimization(input({ assets, references, publicPolicy: 'replace', ...over }));
    }

    it('deletes the original whose one reference is rewritten (the positive control)', () => {
      const plan = replacing(
        [asset('public/logo.png')],
        [resolved('index.html', '/logo.png', 'public/logo.png')],
      );

      expect(plan.conversions[0]?.replacesOriginal).toBe(true);
      expect(plan.rewrites).toHaveLength(1);
      expect(plan.keptOriginals).toEqual([]);
    });

    it('deletes it when two references link it and both are rewritten', () => {
      const plan = replacing(
        [asset('public/logo.png')],
        [
          resolved('about.html', '/logo.png', 'public/logo.png'),
          resolved('index.html', '/logo.png', 'public/logo.png'),
        ],
      );

      expect(plan.conversions[0]?.replacesOriginal).toBe(true);
      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['about.html', 'index.html']);
      expect(plan.keptOriginals).toEqual([]);
    });

    it('converts nothing a template alone reaches, so it deletes nothing and writes no unused copy', () => {
      const plan = replacing(theme, [template]);

      expect(plan.conversions).toEqual([]);
      expect(plan.keptOriginals).toEqual([]);
      for (const path of ['public/theme-dark.png', 'public/theme-light.png']) {
        expect(reasonsByPath(plan)[path]).toContain(
          '`src/Theme.jsx` reaches it only through `/theme-${mode}.png`, a path assembled at runtime that no run can rewrite',
        );
      }
    });

    it('converts nothing a + chain alone reaches, as for its template twin', () => {
      const chain = {
        ...pattern('src/theme.ts', "/theme-' + mode + '.png", [
          'public/theme-light.png',
          'public/theme-dark.png',
        ]),
        kind: 'string',
        shape: 'js.concat.pattern',
        asserted: false,
        assembledPath: '/theme-${}.png',
      } as Reference;
      const plan = replacing(theme, [chain]);

      expect(plan.conversions).toEqual([]);
      expect(reasonsByPath(plan)['public/theme-light.png']).toContain(
        "reaches it only through `/theme-' + mode + '.png`",
      );
    });

    it('keeps every original a glob matches, and says it is a glob the bundler expands', () => {
      const glob = {
        ...pattern('src/theme.ts', '/theme-*.png', [
          'public/theme-light.png',
          'public/theme-dark.png',
        ]),
        kind: 'import',
        shape: 'js.import.meta.glob',
        glob: { exclude: [], dot: false },
      } as Reference;
      const alone = replacing(theme, [glob]);
      const withLiteral = replacing(theme, [
        resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
        glob,
      ]);

      expect(alone.conversions).toEqual([]);
      expect(reasonsByPath(alone)['public/theme-dark.png']).toContain(
        '`src/theme.ts` reaches it only through `/theme-*.png`, a glob the bundler expands when it builds, which no run can rewrite',
      );
      expect(withLiteral.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
        ['public/theme-light.png', false],
      ]);
      expect(withLiteral.keptOriginals[0]?.reason).toContain(
        'reaches it through `/theme-*.png`, a glob the bundler expands when it builds',
      );
    });

    it('keeps every original a context loads, and says the bundler loads it from a directory', () => {
      const loaded = {
        ...pattern('src/theme.js', '../public', [
          'public/theme-light.png',
          'public/theme-dark.png',
        ]),
        kind: 'import',
        shape: 'js.require.context',
        bundlerContext: { recursive: false, filter: { source: '^\\./theme-', flags: '' } },
      } as Reference;
      const alone = replacing(theme, [loaded]);
      const withLiteral = replacing(theme, [
        resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
        loaded,
      ]);

      expect(alone.conversions).toEqual([]);
      expect(reasonsByPath(alone)['public/theme-dark.png']).toContain(
        '`src/theme.js` reaches it only through `../public`, a directory the bundler loads files from when it builds, which no run can rewrite',
      );
      expect(withLiteral.keptOriginals[0]?.reason).toContain(
        'reaches it through `../public`, a directory the bundler loads files from when it builds',
      );
    });

    it('keeps it when a literal naming it is rewritten but a pattern still needs it', () => {
      const plan = replacing(theme, [
        resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
        template,
      ]);
      const light = plan.conversions.find((c) => c.asset === 'public/theme-light.png');

      // The literal moves, which is what makes the new file worth writing, and the
      // original stays for the template. `theme-dark` has only the template, so it is
      // not converted at all.
      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['index.html']);
      expect(light?.replacesOriginal).toBe(false);
      expect(plan.keptOriginals.map((kept) => kept.asset)).toEqual(['public/theme-light.png']);
      expect(plan.keptOriginals[0]?.reason).toContain(
        '`src/Theme.jsx` reaches it through `/theme-${mode}.png`, a path assembled at runtime that no run can rewrite: deleting the original would break it',
      );
      expect(plan.conversions.map((c) => c.asset)).toEqual(['public/theme-light.png']);
    });

    /** A root-relative path that missed the declared root, so its rewrite is refused. */
    const refused = resolved('index.html', '/public/h%65ro.png', 'public/hero.png', {
      resolvedVia: 'project-root',
    });
    const declared = { servingRoots: { dirs: ['public'], declared: true } };

    it('declines it when the only literal naming it is refused, saying why that literal stays', () => {
      const plan = replacing([asset('public/hero.png')], [refused], declared);

      expect(plan.conversions).toEqual([]);
      expect(reasonsByPath(plan)['public/hero.png']).toContain(
        '`index.html` names it as `/public/h%65ro.png`, and this run does not rewrite that reference: the path is root-relative and missed the configured serving root',
      );
    });

    it('keeps it when a refused literal still needs it beside one that moves, without the text search finding it', () => {
      // The old-path text search looks for the path as written, and `h%65ro.png` holds
      // none of its spellings, so the planner has to keep this original by itself.
      // `blockedByMention` is absent here, so the planner alone decides.
      const plan = replacing(
        [asset('public/hero.png')],
        [resolved('about.html', '/hero.png', 'public/hero.png'), refused],
        declared,
      );

      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['about.html']);
      expect(plan.conversions[0]?.replacesOriginal).toBe(false);
      expect(plan.keptOriginals[0]?.reason).toContain(
        '`index.html` names it as `/public/h%65ro.png`, and this run does not rewrite that reference: deleting the original would break it',
      );
    });

    /** `./logo` has no extension to swap, so no edit is recorded for it. */
    const unchanged = resolved('src/App.jsx', './logo', 'public/logo.png');

    it('declines it when the only reference has no extension to change', () => {
      // "Moves" means an edit this plan holds, not a reference it looked at.
      const plan = replacing([asset('public/logo.png')], [unchanged]);

      expect(plan.conversions).toEqual([]);
      expect(reasonsByPath(plan)['public/logo.png']).toContain(
        '`src/App.jsx` names it as `./logo`, which has no extension to change',
      );
    });

    it('keeps it when a reference with no extension to change sits beside one that moves', () => {
      const plan = replacing(
        [asset('public/logo.png')],
        [resolved('index.html', '/logo.png', 'public/logo.png'), unchanged],
      );

      expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['index.html']);
      expect(plan.conversions[0]?.replacesOriginal).toBe(false);
      expect(plan.keptOriginals[0]?.reason).toContain('`src/App.jsx` names it as `./logo`');
    });

    describe('a reference that reaches the original only in another letter case', () => {
      // Read by case, as a Linux server reads it, `img/lvm.jpg` links nothing when the file is
      // `img/LVM.jpg`. Windows and macOS still load the original through it, so it stays.
      const LETTER_CASE =
        'on Windows and macOS, where a file is found whatever the case of its name';
      const lvm = [asset('public/img/LVM.jpg')];
      const moving = resolved('public/index.html', 'img/LVM.jpg', 'public/img/LVM.jpg');

      function unlinked(file: string, rawPath: string, over: Partial<Reference> = {}): Reference {
        return {
          ...RAW,
          file: `${ROOT}/${file}`,
          rawPath,
          start: 10,
          end: 10 + rawPath.length,
          resolution: 'broken',
          confidence: 'unsafe',
          resolvedPath: null,
          ...over,
        } as Reference;
      }

      it('keeps the original a literal names in another letter case', () => {
        const plan = replacing(lvm, [moving, unlinked('public/about.html', 'img/lvm.jpg')]);

        expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['public/index.html']);
        expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
          ['public/img/LVM.jpg', false],
        ]);
        expect(plan.keptOriginals).toEqual([
          {
            asset: 'public/img/LVM.jpg',
            reason: `converted, but the original was kept: \`public/about.html\` names it as \`img/lvm.jpg\`, which reaches it ${LETTER_CASE}: deleting the original would break it there. Fix the letter case.`,
          },
        ]);
      });

      it('keeps the original a pattern matches only in another letter case', () => {
        const shouting = unlinked('src/Gallery.jsx', '/img/${name}.JPG', {
          kind: 'string',
          shape: 'js.template.pattern',
          ceiling: 'medium',
          asserted: false,
          resolution: 'dynamic',
        });
        const plan = replacing(lvm, [moving, shouting]);

        expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
          ['public/img/LVM.jpg', false],
        ]);
        expect(plan.keptOriginals[0]?.reason).toBe(
          `converted, but the original was kept: \`src/Gallery.jsx\` reaches it through \`/img/\${name}.JPG\` ${LETTER_CASE}: deleting the original would break it there. Fix the letter case.`,
        );
      });

      it('still removes the original when the reference in another case names a different file', () => {
        // The positive control: folding case must not keep an original the reference cannot reach.
        const plan = replacing(lvm, [moving, unlinked('public/about.html', 'img/lvm.png')]);

        expect(plan.conversions[0]?.replacesOriginal).toBe(true);
        expect(plan.keptOriginals).toEqual([]);
      });
    });

    it('converts an asset when any one of its references moves, not only when all of them do', () => {
      // The conversion half asks for one moving reference, the deletion half for all of
      // them. Requiring all of them to convert would decline both assets here, though each
      // has a literal moving to its new file and a template still asking for its original.
      const plan = replacing(theme, [
        template,
        resolved('about.html', '/theme-dark.png', 'public/theme-dark.png'),
        resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
      ]);

      expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
        ['public/theme-dark.png', false],
        ['public/theme-light.png', false],
      ]);
    });

    it('keeps only the original a pattern still needs, and removes one the build loads', () => {
      const plan = replacing(
        [asset('src/logo.png'), ...theme],
        [
          resolved('src/App.jsx', './logo.png', 'src/logo.png'),
          resolved('index.html', '/theme-light.png', 'public/theme-light.png'),
          template,
        ],
      );

      expect(Object.fromEntries(plan.keptOriginals.map((k) => [k.asset, k.reason]))).toEqual({
        'public/theme-light.png': expect.stringContaining('assembled at runtime'),
      });
    });

    it('declines an asset outside a served directory that only a pattern reaches, rather than keep a copy nobody uses', () => {
      // Outside a served directory `replace` never deletes, but no reference would move to
      // the new file there either. Converting would leave the same unused pair, reported
      // under a misleading reason: kept for the build's sake.
      const icons = [asset('src/icons/a.png'), asset('src/icons/b.png')];
      const byPattern = pattern('src/Icon.jsx', './icons/${name}.png', [
        'src/icons/a.png',
        'src/icons/b.png',
      ]);

      const plan = replacing(icons, [byPattern]);
      const keep = planOptimization(input({ assets: icons, references: [byPattern] }));

      expect(plan.conversions).toEqual([]);
      expect(plan.keptOriginals).toEqual([]);
      expect(reasonsByPath(plan)['src/icons/a.png']).toContain('reaches it only through');
      expect(keep.conversions).toEqual([]);
    });

    it('converts no member under keep-original either, since no reference moves to any of them', () => {
      // No reference moves to any of these, so a new file would be loaded by nobody,
      // whichever policy keeps or removes the originals.
      const everyMember = {
        assets: [
          asset('public/orphan.png'),
          asset('public/hero.png'),
          asset('public/logo.png'),
          ...theme,
        ],
        references: [refused, unchanged, template],
        ...declared,
      };

      const keep = planOptimization(input(everyMember));
      const replace = planOptimization(input({ ...everyMember, publicPolicy: 'replace' }));

      expect(keep.conversions).toEqual([]);
      expect(replace.conversions).toEqual([]);
    });
  });
});

describe('everything declined carries a reason', () => {
  it('has no empty reasons anywhere in a plan that declines several things', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/orphan.png'), asset('public/hero.png')],
        references: [
          resolved('src/App.jsx', './hero.png', 'public/hero.png', { confidence: 'unsafe' }),
        ],
      }),
    );

    expect(plan.declined.length).toBeGreaterThan(1);
    for (const item of plan.declined) {
      expect(item.reason.length).toBeGreaterThan(20);
      expect(item.path).not.toBe('');
    }
  });
});

describe('refusing to plan a run whose serving root is unknown', () => {
  function unresolvedRootRelative(n: number): Reference[] {
    return Array.from(
      { length: n },
      (_, index) =>
        ({
          ...RAW,
          file: `${ROOT}/index.html`,
          rawPath: `/missing${index}.png`,
          start: index * 40,
          end: index * 40 + 10,
          resolution: 'broken',
          confidence: 'unsafe',
          resolvedPath: null,
        }) as Reference,
    );
  }

  it('returns a refusal rather than throwing, so the caller is holding something', () => {
    // A thrown error leaves a user with nothing; a returned refusal is a finding with a
    // reason, which reaches the report like every other declined item.
    const plan = planOptimization(
      input({ assets: [asset('src/logo.png')], references: unresolvedRootRelative(20) }),
    );

    expect(plan.refusal).toMatchObject({
      code: 'serving-root-unknown',
      linked: 0,
      checkable: 20,
    });
    expect(plan.refusal?.reason).toContain('Declare the directory your site serves from');
  });

  it('says what resolved in a folder the project named, and does not ask for it again', () => {
    for (const dirs of [['public'], ['public', 'static']]) {
      const plan = planOptimization(
        input({
          assets: [asset('src/logo.png')],
          references: unresolvedRootRelative(20),
          servingRoots: { dirs, declared: true },
        }),
      );

      expect(plan.refusal).toMatchObject({
        code: 'serving-root-unknown',
        linked: 0,
        checkable: 20,
      });
      expect(plan.refusal?.reason).toContain(
        `None of the 20 root-relative references resolved in ${dirs.join(' and ')}, named as the`,
      );
      expect(plan.refusal?.reason).toContain('Upfly rewrites nothing while so few resolve.');
      expect(plan.refusal?.reason).not.toMatch(/declare|--public|publicDirs/i);
    }
  });

  it('plans nothing at all, so a caller that ignores the refusal writes nothing', () => {
    const plan = planOptimization(
      input({ assets: [asset('src/logo.png')], references: unresolvedRootRelative(20) }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.declined).toEqual([]);
  });

  it('leaves an ordinary plan with no refusal on it', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png')],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
      }),
    );

    expect(plan.refusal).toBeNull();
    expect(plan.conversions).toHaveLength(1);
  });
});

describe('an asset that was measured and gained nothing', () => {
  it('is declined with a reason rather than dropped in silence', () => {
    // Nothing else reports this case: a format-opportunity finding exists only when there
    // is an opportunity, and the audit's skip list holds only measurements never taken.
    // Without a reason here the asset would be skipped silently.
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png', 70)],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        probes: [probe('src/logo.png', 94)],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'src/logo.png',
        line: null,
        reason:
          'measured as webp and came out no smaller, so converting it would cost bytes rather than save them',
      },
    ]);
  });

  it('stays silent about an asset nothing measured, which the audit does report', () => {
    // An asset nothing measured has a probe skip naming the cap, the vector or the
    // format, which reaches the report on its own; saying it twice would bury the real
    // decisions under every file in the repository.
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png', 70)],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        probes: [],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([]);
  });
});

describe('an asset the measuring left out because no conversion of it could be used', () => {
  /** A header read with no encode, as the measuring leaves an asset it was told to skip. */
  function leftOut(relative: string, format = 'png'): AssetProbe {
    return {
      relative,
      metadata: { width: 100, height: 100, format, pages: 1 },
      encoded: [],
      skipped: [
        {
          measurement: 'webp',
          code: 'would-not-convert',
          reason: 'not measured: optimize would not convert it, so a saving would reach no visitor',
        },
      ],
    };
  }

  it('keeps the reason a run that measured it would give', () => {
    const measured = planOptimization(
      input({ assets: [asset('public/img/orphan.png')], references: [], served: ['public'] }),
    );
    const unmeasured = planOptimization(
      input({
        assets: [asset('public/img/orphan.png')],
        references: [],
        served: ['public'],
        probes: [leftOut('public/img/orphan.png')],
      }),
    );

    expect(unmeasured.declined).toEqual(measured.declined);
    expect(reasonsByPath(unmeasured)['public/img/orphan.png']).toContain('nothing links to it');
  });

  it('keeps it for an image a reference reaches in a form Upfly cannot rewrite', () => {
    const icon = resolved('index.html', 'public/favicon.png', 'public/favicon.png', {
      shape: 'html.link.href.icon',
    });
    const assets = [asset('public/favicon.png')];
    const measured = planOptimization(input({ assets, references: [icon], served: ['public'] }));
    const unmeasured = planOptimization(
      input({
        assets,
        references: [icon],
        served: ['public'],
        probes: [leftOut('public/favicon.png')],
      }),
    );

    expect(unmeasured.declined).toEqual(measured.declined);
    expect(reasonsByPath(unmeasured)['public/favicon.png']).toContain('No reference would move');
  });

  it('stays silent about one the measuring skipped for a reason of its own', () => {
    const vector: AssetProbe = {
      relative: 'public/img/orphan.svg',
      metadata: { width: 100, height: 100, format: 'svg', pages: 1 },
      encoded: [],
      skipped: [
        {
          measurement: 'webp',
          code: 'vector',
          reason: 'SVG is a vector: encoding it measures a rasterisation, not a saving',
        },
      ],
    };

    const plan = planOptimization(
      input({
        assets: [asset('public/img/orphan.svg')],
        references: [],
        served: ['public'],
        probes: [vector],
      }),
    );

    expect(plan.declined).toEqual([]);
  });
});

describe('an image whose name says a format the file is not', () => {
  /** The measuring's header read: the name ends in `.webp`, the bytes are something else. */
  function mislabelled(relative: string, format: string): AssetProbe {
    return {
      relative,
      metadata: { width: 952, height: 1078, format, pages: 1 },
      encoded: [],
      skipped: [
        {
          measurement: 'webp',
          code: 'would-not-convert',
          reason: 'not measured: optimize would not convert it, so a saving would reach no visitor',
        },
      ],
    };
  }

  it('says so, rather than leaving the full plan with no reason', () => {
    const plan = planOptimization(
      input({
        assets: [asset('public/erp/login-bg.webp')],
        references: [
          resolved('index.html', '/erp/login-bg.webp', 'public/erp/login-bg.webp', {
            resolvedVia: 'serving-root',
          }),
        ],
        served: ['public'],
        probes: [mislabelled('public/erp/login-bg.webp', 'jpeg')],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(reasonsByPath(plan)['public/erp/login-bg.webp']).toBe(
      'its name already ends in .webp, but the file is JPEG, so there is no new name to convert it to. A browser reads the bytes rather than the name, so the image loads as it is; saving it again as a real .webp file would need no other change',
    );
  });

  it('says nothing about one that really is in that format, which the audit reports', () => {
    const genuine: AssetProbe = {
      relative: 'public/hero.webp',
      metadata: { width: 100, height: 100, format: 'webp', pages: 1 },
      encoded: [],
      skipped: [{ measurement: 'webp', code: 'already-target-format', reason: 'already webp' }],
    };

    const plan = planOptimization(
      input({
        assets: [asset('public/hero.webp')],
        references: [
          resolved('index.html', '/hero.webp', 'public/hero.webp', {
            resolvedVia: 'serving-root',
          }),
        ],
        served: ['public'],
        probes: [genuine],
      }),
    );

    expect(plan.declined).toEqual([]);
  });
});

describe('two assets that would convert to one name', () => {
  // Swapping the extension is not injective, so a repository holding both distance.png
  // and distance.gif would produce a plan with two creates at distance.webp.
  const assets = [asset('static/distance.gif'), asset('static/distance.png')];
  const references = [
    resolved('index.html', 'static/distance.gif', 'static/distance.gif'),
    resolved('index.html', 'static/distance.png', 'static/distance.png'),
  ];

  it('converts neither, and tells each one which file it collided with', () => {
    const plan = planOptimization(input({ assets, references, served: ['static'] }));

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'static/distance.gif',
        line: null,
        reason:
          'static/distance.png would also convert to static/distance.webp, so converting it would replace a file rather than add one. Rename one of them and run again.',
      },
      {
        path: 'static/distance.png',
        line: null,
        reason:
          'static/distance.gif would also convert to static/distance.webp, so converting it would replace a file rather than add one. Rename one of them and run again.',
      },
    ]);
  });

  it('leaves the references to both of them exactly as they were', () => {
    const plan = planOptimization(input({ assets, references, served: ['static'] }));

    expect(plan.rewrites).toEqual([]);
  });

  it('names all the others when three collide, in a fixed order', () => {
    const three = [asset('img/a.gif'), asset('img/a.jpeg'), asset('img/a.png')];
    const plan = planOptimization(
      input({
        assets: three,
        references: three.map((a) => resolved('index.html', a.relative, a.relative)),
        served: ['img'],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined.map((d) => d.reason)).toEqual([
      expect.stringContaining('img/a.jpeg and img/a.png would also convert to img/a.webp'),
      expect.stringContaining('img/a.gif and img/a.png would also convert to img/a.webp'),
      expect.stringContaining('img/a.gif and img/a.jpeg would also convert to img/a.webp'),
    ]);
  });

  // The near miss, and the reason the count of colliding basenames in a repository is
  // not the count of conversions this costs. Sharing a basename is not a collision
  // when only one of the two was ever going to be written: nothing is overwritten, the
  // other file stays where it is, and every reference to it keeps resolving.
  it('still converts the one that converts when the other was never going to', () => {
    const plan = planOptimization(
      input({
        assets,
        references,
        served: ['static'],
        probes: [probe('static/distance.gif', 40_000), probe('static/distance.png', 4_000)],
      }),
    );

    expect(plan.conversions.map((c) => c.asset)).toEqual(['static/distance.png']);
    expect(plan.declined.map((d) => d.reason)).not.toContainEqual(
      expect.stringContaining('would also convert'),
    );
  });

  it('withdraws the rewrite of a template that matches a collided asset', () => {
    const three = [
      asset('public/a-light.png'),
      asset('public/a-light.gif'),
      asset('public/a-dark.png'),
    ];
    const plan = planOptimization(
      input({
        assets: three,
        references: [
          pattern('src/App.jsx', './a-${mode}.png', ['public/a-light.png', 'public/a-dark.png']),
          // A plain reference moves to each, so each would convert.
          resolved('a.html', '/a-light.png', 'public/a-light.png'),
          resolved('b.html', '/a-light.gif', 'public/a-light.gif'),
          resolved('c.html', '/a-dark.png', 'public/a-dark.png'),
        ],
      }),
    );

    // a-light collided with a-light.gif and was withdrawn. The collision is settled before
    // the pattern's decline is written, so the decline counts a-light as not converting.
    expect(plan.conversions.map((c) => c.asset)).toEqual(['public/a-dark.png']);
    // Only the plain reference to a-dark moves; the template stays as written.
    expect(plan.rewrites.map((rewrite) => rewrite.file)).toEqual(['c.html']);
    expect(plan.declined.map((d) => d.reason)).toContainEqual(
      expect.stringContaining('1 of the 2 assets it matches does not convert'),
    );
  });
});

describe('an asset whose converted name is already taken', () => {
  // Left to prepare, the create would be refused, which aborts the whole run rather than
  // declining the one asset.
  const assets = [asset('img/possum.png'), asset('img/possum.webp')];
  const references = [resolved('index.html', 'img/possum.png', 'img/possum.png')];

  it('declines that one asset when the file there is one the walk excluded, found by listing', () => {
    const listings = new Map([
      [ROOT, ['img', 'index.html']],
      [join(ROOT, 'img'), ['hero.png', 'hero.webp', 'other.png']],
    ]);
    const plan = planOptimization(
      input({
        assets: [asset('img/hero.png'), asset('img/other.png')],
        references: [
          resolved('index.html', 'img/hero.png', 'img/hero.png'),
          resolved('index.html', 'img/other.png', 'img/other.png'),
        ],
        served: ['img'],
        listDirectory: (path) => listings.get(path) ?? [],
      }),
    );

    expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(['img/other.png']);
    expect(plan.declined).toEqual([
      {
        path: 'img/hero.png',
        line: null,
        reason:
          'img/hero.webp already exists and this run excludes it, so converting it would replace a file rather than add one. Rename one of them and run again.',
      },
    ]);
  });

  it('declines rather than writing over the file that is there', () => {
    const plan = planOptimization(input({ assets, references, served: ['img'] }));

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'img/possum.png',
        line: null,
        reason:
          'img/possum.webp already exists, so converting it would replace a file rather than add one. Rename one of them and run again.',
      },
    ]);
  });

  it('reports both obstacles when a colliding pair also lands on an existing file', () => {
    const plan = planOptimization(
      input({
        assets: [asset('img/possum.jpg'), asset('img/possum.png'), asset('img/possum.webp')],
        references: [
          resolved('index.html', 'img/possum.jpg', 'img/possum.jpg'),
          resolved('index.html', 'img/possum.png', 'img/possum.png'),
        ],
        served: ['img'],
      }),
    );

    // Renaming one of the pair leaves the other still blocked by the file that is
    // already there, so a reason naming only the pair would send somebody round twice.
    expect(plan.declined.map((d) => d.reason)).toEqual([
      'img/possum.png would also convert to img/possum.webp, and img/possum.webp already exists, so converting it would replace a file rather than add one. Rename one of them and run again.',
      'img/possum.jpg would also convert to img/possum.webp, and img/possum.webp already exists, so converting it would replace a file rather than add one. Rename one of them and run again.',
    ]);
  });
});

describe('an asset whose converted name a reference would find elsewhere first', () => {
  // A rewrite changes only the extension, and the new path is resolved again against the
  // files the plan leaves. A nearer serving root, or an alias tried before the one that
  // linked the original, can hold another file of the new name.
  const TWO_ROOTS = { dirs: ['public', 'apps/web/public'], declared: true };
  const PAGE = 'apps/web/src/App.tsx';
  const scope = toPosix(ROOT);
  const IMPORT: Partial<Reference> = {
    kind: 'import',
    shape: 'js.import.static',
    ceiling: 'certain',
    confidence: 'certain',
    resolvedVia: 'serving-root',
  };

  /** A root-relative reference in `file`, starting at `start`. */
  function url(file: string, rawPath: string, target: string, start = 10): Reference {
    return resolved(file, rawPath, target, {
      resolvedVia: 'serving-root',
      start,
      end: start + rawPath.length,
    });
  }

  it('declines it, naming the file a nearer serving root holds, while the image beside it converts', () => {
    const plan = planOptimization(
      input({
        assets: [
          asset('apps/web/public/img/logo.webp'),
          asset('public/img/logo.png'),
          asset('public/img/texture.png'),
        ],
        references: [
          url(PAGE, '/img/logo.png', 'public/img/logo.png'),
          url(PAGE, '/img/texture.png', 'public/img/texture.png', 100),
        ],
        servingRoots: TWO_ROOTS,
        publicPolicy: 'replace',
      }),
    );

    // Not converted, so its original stays whatever the policy.
    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['public/img/texture.png', true],
    ]);
    expect(
      plan.rewrites.flatMap((rewrite) => rewrite.edits.map((edit) => edit.replacement)),
    ).toEqual(['/img/texture.webp']);
    expect(plan.keptOriginals).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'public/img/logo.png',
        line: null,
        reason:
          '`/img/logo.png` in `apps/web/src/App.tsx` would become `/img/logo.webp`, which reaches apps/web/public/img/logo.webp first, so the reference would load that file instead. Rename one of the two images and run again.',
      },
    ]);
  });

  it('declines it when a longer alias key maps the new name to another file', () => {
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '@/img/',
          targets: [`${scope}/assets/img`],
          wildcard: true,
          scope,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
        {
          prefix: '@/',
          targets: [`${scope}/src`],
          wildcard: true,
          scope,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const plan = planOptimization(
      input({
        assets: [asset('assets/img/hero.webp'), asset('src/img/hero.png')],
        references: [resolved('src/App.tsx', '@/img/hero.png', 'src/img/hero.png', IMPORT)],
        aliases,
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'src/img/hero.png',
        line: null,
        reason:
          '`@/img/hero.png` in `src/App.tsx` would become `@/img/hero.webp`, which reaches assets/img/hero.webp first, so the reference would load that file instead. Rename one of the two images and run again.',
      },
    ]);
  });

  it('declines it when the new name reaches no file, as through an alias whose key is the old name', () => {
    const aliases: AliasMap = {
      rules: [
        {
          prefix: 'brand-logo.png',
          targets: [`${scope}/src/img/logo.png`],
          wildcard: false,
          scope,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const plan = planOptimization(
      input({
        assets: [asset('src/img/logo.png')],
        references: [resolved('src/App.tsx', 'brand-logo.png', 'src/img/logo.png', IMPORT)],
        aliases,
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined).toEqual([
      {
        path: 'src/img/logo.png',
        line: null,
        reason:
          '`brand-logo.png` in `src/App.tsx` would become `brand-logo.webp`, which names no file Upfly can find, so repointing the reference would break it.',
      },
    ]);
  });

  it('names the first reference that would miss and counts the rest', () => {
    const plan = planOptimization(
      input({
        assets: [asset('apps/web/public/img/logo.webp'), asset('public/img/logo.png')],
        references: [
          url(PAGE, '/img/logo.png', 'public/img/logo.png'),
          url('apps/web/src/Nav.tsx', '/img/logo.png', 'public/img/logo.png'),
        ],
        servingRoots: TWO_ROOTS,
      }),
    );

    expect(plan.declined.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(
        /^`\/img\/logo\.png` in `apps\/web\/src\/App\.tsx` \(and 1 more\) would become /,
      ),
    ]);
  });

  it('plans again without the conversion, so no other sentence says it converted', () => {
    // A link preview naming the image is refused on its own account, in a sentence saying the
    // image converted without it, which is true only while the conversion stands.
    const preview = resolved(PAGE, '/img/logo.png', 'public/img/logo.png', {
      shape: 'html.meta.content.image',
      resolvedVia: 'serving-root',
      start: 100,
      end: 113,
    });
    const plan = planOptimization(
      input({
        assets: [asset('apps/web/public/img/logo.webp'), asset('public/img/logo.png')],
        references: [url(PAGE, '/img/logo.png', 'public/img/logo.png'), preview],
        servingRoots: TWO_ROOTS,
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.keptOriginals).toEqual([]);
    expect(plan.declined.map((entry) => entry.reason)).toEqual([
      expect.stringContaining('which reaches apps/web/public/img/logo.webp first'),
    ]);
  });

  it('declines it when an alias target outside the project holds the new name first, found by listing it', () => {
    // A monorepo package whose alias reads a shared folder beside it before its own `src`.
    const shared = join(ROOT, '../shared');
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '@/',
          targets: [toPosix(shared), `${scope}/src`],
          wildcard: true,
          scope,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const listings = new Map([
      [shared, ['img']],
      [join(shared, 'img'), ['logo.webp']],
    ]);
    const plan = planOptimization(
      input({
        assets: [asset('src/img/logo.png')],
        references: [resolved('src/App.tsx', '@/img/logo.png', 'src/img/logo.png', IMPORT)],
        aliases,
        listDirectory: (path) => listings.get(path) ?? [],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined.map((entry) => entry.reason)).toEqual([
      expect.stringContaining('which reaches ../shared/img/logo.webp first'),
    ]);
  });

  it('declines it when a file the walk excluded holds the new name nearer, found by listing its folders', () => {
    const listings = new Map([
      [ROOT, ['apps', 'public']],
      [join(ROOT, 'apps'), ['web']],
      [join(ROOT, 'apps/web'), ['public', 'src']],
      [join(ROOT, 'apps/web/public'), ['img']],
      [join(ROOT, 'apps/web/public/img'), ['logo.webp']],
      [join(ROOT, 'public'), ['img']],
      [join(ROOT, 'public/img'), ['logo.png', 'texture.png']],
    ]);
    const plan = planOptimization(
      input({
        assets: [asset('public/img/logo.png'), asset('public/img/texture.png')],
        references: [
          url(PAGE, '/img/logo.png', 'public/img/logo.png'),
          url(PAGE, '/img/texture.png', 'public/img/texture.png', 100),
        ],
        servingRoots: TWO_ROOTS,
        publicPolicy: 'replace',
        listDirectory: (path) => listings.get(path) ?? [],
      }),
    );

    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['public/img/texture.png', true],
    ]);
    expect(plan.declined).toEqual([
      {
        path: 'public/img/logo.png',
        line: null,
        reason:
          '`/img/logo.png` in `apps/web/src/App.tsx` would become `/img/logo.webp`, which reaches apps/web/public/img/logo.webp first, so the reference would load that file instead. Rename one of the two images and run again.',
      },
    ]);
  });

  describe('a name that differs only in case', () => {
    // Windows and macOS find a file whatever the case of its name, so the check does too, on
    // every platform, as the collision check does.
    const CASE_BLIND = 'on Windows and macOS, where a file is found whatever the case of its name';

    it('declines it when a nearer image differs from the new name only in case', () => {
      const plan = planOptimization(
        input({
          assets: [asset('apps/web/public/img/Logo.webp'), asset('public/img/logo.png')],
          references: [url(PAGE, '/img/logo.png', 'public/img/logo.png')],
          servingRoots: TWO_ROOTS,
          publicPolicy: 'replace',
        }),
      );

      expect(plan.conversions).toEqual([]);
      expect(plan.declined).toEqual([
        {
          path: 'public/img/logo.png',
          line: null,
          reason: `\`/img/logo.png\` in \`apps/web/src/App.tsx\` would become \`/img/logo.webp\`, which reaches apps/web/public/img/Logo.webp first ${CASE_BLIND}, so the reference would load that file instead. Rename one of the two images and run again.`,
        },
      ]);
    });

    it('declines it when a listing finds a nearer file in a folder named in another case', () => {
      const listings = new Map([
        [ROOT, ['apps']],
        [join(ROOT, 'apps'), ['web']],
        [join(ROOT, 'apps/web'), ['public']],
        [join(ROOT, 'apps/web/public'), ['IMG']],
        [join(ROOT, 'apps/web/public/IMG'), ['logo.webp']],
      ]);
      const plan = planOptimization(
        input({
          assets: [asset('public/img/logo.png')],
          references: [url(PAGE, '/img/logo.png', 'public/img/logo.png')],
          servingRoots: TWO_ROOTS,
          listDirectory: (path) => listings.get(path) ?? [],
        }),
      );

      expect(plan.conversions).toEqual([]);
      expect(plan.declined.map((entry) => entry.reason)).toEqual([
        expect.stringContaining(`reaches apps/web/public/IMG/logo.webp first ${CASE_BLIND},`),
      ]);
    });

    it('declines a conversion that would remove the file a reference reaches only by folding case', () => {
      const plan = planOptimization(
        input({
          assets: [asset('apps/web/public/img/Banner.png'), asset('public/img/banner.png')],
          references: [
            url(PAGE, '/img/banner.png', 'public/img/banner.png'),
            url('apps/web/src/Other.tsx', '/img/Banner.png', 'apps/web/public/img/Banner.png'),
          ],
          probes: [probe('apps/web/public/img/Banner.png'), probe('public/img/banner.png', 20_000)],
          servingRoots: TWO_ROOTS,
          publicPolicy: 'replace',
        }),
      );

      expect(plan.conversions).toEqual([]);
      expect(plan.rewrites).toEqual([]);
      expect(plan.declined).toContainEqual({
        path: 'apps/web/public/img/Banner.png',
        line: null,
        reason: `\`/img/banner.png\` in \`apps/web/src/App.tsx\` reaches apps/web/public/img/Banner.png ${CASE_BLIND}, and converting this image removes it, so the reference would load public/img/banner.png instead. Rename one of the two images and run again.`,
      });
    });
  });

  describe('a reference the plan leaves as written', () => {
    // A converted file is new, so a reference that goes on naming another file can find it
    // first. Every linked reference is resolved again, not only the rewritten ones.
    const OTHER = 'apps/web/src/Other.tsx';

    it('declines the conversion whose file it would find first, naming the file it reaches now', () => {
      const plan = planOptimization(
        input({
          assets: [
            asset('apps/web/public/img/banner.png'),
            asset('apps/web/public/img/texture.png'),
            asset('public/img/banner.webp'),
          ],
          references: [
            url(PAGE, '/img/banner.webp', 'public/img/banner.webp'),
            url(OTHER, '/img/banner.png', 'apps/web/public/img/banner.png'),
            url(OTHER, '/img/texture.png', 'apps/web/public/img/texture.png', 100),
          ],
          servingRoots: TWO_ROOTS,
        }),
      );

      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual([
        'apps/web/public/img/texture.png',
      ]);
      expect(plan.rewrites.map((rewrite) => rewrite.edits.map((edit) => edit.replacement))).toEqual(
        [['/img/texture.webp']],
      );
      expect(plan.declined).toEqual([
        {
          path: 'apps/web/public/img/banner.png',
          line: null,
          reason:
            '`/img/banner.webp` in `apps/web/src/App.tsx` reaches public/img/banner.webp, and once this image converts it would reach apps/web/public/img/banner.webp first, so the reference would load the converted image instead. Rename one of the two images and run again.',
        },
      ]);
    });

    it('declines a conversion whose file would move a pattern to a nearer serving root', () => {
      const icons = {
        ...pattern(PAGE, '/img/icon-${name}.webp', ['public/img/icon-a.webp']),
        resolvedVia: 'serving-root',
      } as Reference;
      const plan = planOptimization(
        input({
          assets: [asset('apps/web/public/img/icon-b.png'), asset('public/img/icon-a.webp')],
          references: [icons, url(OTHER, '/img/icon-b.png', 'apps/web/public/img/icon-b.png')],
          servingRoots: TWO_ROOTS,
        }),
      );

      expect(plan.conversions).toEqual([]);
      expect(plan.declined).toContainEqual({
        path: 'apps/web/public/img/icon-b.png',
        line: null,
        reason:
          '`/img/icon-${name}.webp` in `apps/web/src/App.tsx` reaches public/img/icon-a.webp, and once this image converts it would reach apps/web/public/img/icon-b.webp first, so the reference would load the converted image instead. Rename one of the two images and run again.',
      });
    });

    it('lets a converted file join the files a pattern already matches beside it', () => {
      const plan = planOptimization(
        input({
          assets: [asset('public/img/a.png')],
          references: [
            { ...pattern(PAGE, '/img/${name}', ['public/img/a.png']), resolvedVia: 'serving-root' },
            url(OTHER, '/img/a.png', 'public/img/a.png'),
          ] as Reference[],
          servingRoots: TWO_ROOTS,
        }),
      );

      expect(plan.conversions.map((conversion) => conversion.asset)).toEqual(['public/img/a.png']);
      // Only the sentence every pattern gets: its text is a template, so it is never rewritten.
      expect(plan.declined.map((entry) => entry.path)).toEqual(['apps/web/src/App.tsx']);
    });
  });
});

describe('two assets whose converted names differ only in case', () => {
  // What an exact-string comparison cannot see. Reaktor.jpg and reaktor.png produce
  // Reaktor.webp and reaktor.webp, which are two files on Linux and one file on Windows
  // and macOS. Neither exists yet, so both pass an absent check, and one image would be
  // written over the other. The planner declines the pair; `prepare` folds case too, but
  // a refusal there aborts the whole run.
  const assets = [asset('images/Reaktor.jpg'), asset('images/reaktor.png')];
  const references = [
    resolved('index.html', 'images/Reaktor.jpg', 'images/Reaktor.jpg'),
    resolved('index.html', 'images/reaktor.png', 'images/reaktor.png'),
  ];

  it('declines both rather than silently writing one image over the other', () => {
    const plan = planOptimization(input({ assets, references, served: ['images'] }));

    expect(plan.conversions).toEqual([]);
    expect(plan.rewrites).toEqual([]);
  });

  it('says why two different names are one file, so the report does not look broken', () => {
    const plan = planOptimization(input({ assets, references, served: ['images'] }));

    expect(plan.declined.map((d) => d.reason)).toEqual([
      'images/reaktor.png would convert to images/reaktor.webp, which is the same file as images/Reaktor.webp on Windows and macOS, so converting it would replace a file rather than add one. Rename one of them and run again.',
      'images/Reaktor.jpg would convert to images/Reaktor.webp, which is the same file as images/reaktor.webp on Windows and macOS, so converting it would replace a file rather than add one. Rename one of them and run again.',
    ]);
  });

  it('declines when the existing file differs from the target only in case', () => {
    const plan = planOptimization(
      input({
        assets: [asset('img/Logo.png'), asset('img/logo.webp')],
        references: [resolved('index.html', 'img/Logo.png', 'img/Logo.png')],
        served: ['img'],
      }),
    );

    expect(plan.conversions).toEqual([]);
    expect(plan.declined[0]?.reason).toContain(
      'img/logo.webp already exists, and is the same file as img/Logo.webp on Windows and macOS',
    );
  });
});

describe('a project that serves from its own project root', () => {
  // A serving directory of '' is the project root. Appending a slash to '' gives '/',
  // which no project-relative path begins with, so a prefix test built that way would
  // score every asset on a root-served site as not public. Here that decides whether an
  // original may be removed.
  const assets = [asset('images/orphan.png'), asset('images/hero.png')];
  const references = [resolved('index.html', '/images/hero.png', 'images/hero.png')];

  it('removes the original under replace, because the whole tree is the public dir', () => {
    const plan = planOptimization(
      input({ assets, references, served: [''], publicPolicy: 'replace' }),
    );

    // `hero.png` is what shows `''` is read as public: a linked asset whose reference is
    // rewritten loses its original. `orphan.png` is not converted, because nothing would
    // use its new file.
    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['images/hero.png', true],
    ]);
    expect(reasonsByPath(plan)['images/orphan.png']).toContain('nothing links to it');
  });

  it('treats a project that declares no served directory as serving nothing, the opposite', () => {
    const plan = planOptimization(
      input({ assets, references, servingRoots: { dirs: [], declared: true } }),
    );

    // An unlinked asset outside any public directory gains only bytes, so it is
    // declined. The empty string and the absent directory must not collapse together.
    expect(plan.conversions.map((c) => c.asset)).toEqual(['images/hero.png']);
    expect(reasonsByPath(plan)['images/orphan.png']).toBe(
      'nothing links to it, so converting it would rewrite no reference and gain only bytes',
    );
  });
});

describe('which assets are served, when the run decided several roots or none', () => {
  const roots = { dirs: ['apps/a/public', 'apps/b/public'], declared: false };
  const twoRoots = [asset('apps/a/public/a.png'), asset('apps/b/public/b.png')];
  const twoReferences = [
    resolved('apps/a/index.html', '/a.png', 'apps/a/public/a.png'),
    resolved('apps/b/index.html', '/b.png', 'apps/b/public/b.png'),
  ];

  it('removes the original of an image in the second root once its references move', () => {
    const plan = planOptimization(
      input({
        assets: twoRoots,
        references: twoReferences,
        servingRoots: roots,
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['apps/a/public/a.png', true],
      ['apps/b/public/b.png', true],
    ]);
    expect(plan.rewrites.map((r) => r.file)).toEqual(['apps/a/index.html', 'apps/b/index.html']);
    expect(plan.keptOriginals).toEqual([]);
  });

  it('finds no served image when no root was found, and says how to name one', () => {
    const plan = planOptimization(
      input({
        assets: [asset('images/hero.png'), asset('images/orphan.png')],
        references: [resolved('index.html', 'images/hero.png', 'images/hero.png')],
        servingRoots: { dirs: [], declared: false },
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['images/hero.png', false],
    ]);
    expect(plan.keptOriginals).toEqual([
      {
        asset: 'images/hero.png',
        reason:
          'converted, but the original was kept: no website folder was found in this project, so Upfly cannot tell which images a browser loads by URL, and Upfly removes an original only once it knows that. Name the folder the site is served from with `--public <dir>` or `publicDirs` in the config file, using "." for the project root itself, as on a plain HTML site.',
      },
    ]);
    expect(reasonsByPath(plan)['images/orphan.png']).toBe(
      'nothing links to it, and no website folder was found in this project, so Upfly cannot tell which images a browser loads by URL; converting it would gain only bytes. Name the folder the site is served from with `--public <dir>` or `publicDirs` in the config file, using "." for the project root itself, as on a plain HTML site',
    );
  });

  it('removes the original of an image the build loads, in a project that found a root elsewhere', () => {
    const plan = planOptimization(
      input({
        assets: [asset('src/logo.png')],
        references: [resolved('src/App.jsx', './logo.png', 'src/logo.png')],
        publicPolicy: 'replace',
      }),
    );

    expect(plan.conversions.map((c) => [c.asset, c.replacesOriginal])).toEqual([
      ['src/logo.png', true],
    ]);
    expect(plan.keptOriginals).toEqual([]);
  });
});

describe('the order of a plan', () => {
  // `a`, `B`, `z` and a-umlaut sort one way under English rules, another under Swedish, and
  // a third way by code unit, the one order every machine agrees on.
  const names = ['a', 'B', 'z', String.fromCodePoint(0xe4)];
  const planInput = () =>
    input({
      assets: names.flatMap((name) => [asset(`public/${name}.png`), asset(`src/${name}.png`)]),
      references: names.map((name) =>
        resolved(`src/${name}.jsx`, `../public/${name}.png`, `public/${name}.png`),
      ),
    });

  /** The plan, with every `localeCompare` call decided by `collator`. */
  function planUnder(collator: Intl.Collator) {
    const spy = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
      this: unknown,
      that: string,
    ) {
      return collator.compare(String(this), that);
    });
    try {
      return planOptimization(planInput());
    } finally {
      spy.mockRestore();
    }
  }

  const english = new Intl.Collator('en');
  const swedish = new Intl.Collator('sv', { caseFirst: 'upper' });

  it('rests on two locales that order these names differently', () => {
    expect([...names].sort(english.compare)).not.toEqual([...names].sort(swedish.compare));
  });

  it('is the same whichever locale the machine sorts text in', () => {
    expect(JSON.stringify(planUnder(english))).toBe(JSON.stringify(planUnder(swedish)));
  });

  it('orders every list by code unit', () => {
    const plan = planOptimization(planInput());
    const lists = [
      plan.conversions.map((conversion) => conversion.asset),
      plan.rewrites.map((rewrite) => rewrite.file),
      plan.declined.filter((entry) => entry.path.startsWith('src/')).map((entry) => entry.path),
    ];
    for (const list of lists) {
      expect(list).toHaveLength(4);
      expect(list).toEqual([...list].sort(compareStrings));
    }
  });
});
