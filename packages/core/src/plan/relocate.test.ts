import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssAdapter } from '../adapters/css.js';
import { defaultAdapters } from '../adapters/default-adapters.js';
import { htmlAdapter } from '../adapters/html.js';
import { markdownAdapter } from '../adapters/markdown.js';
import type { PathSpelling } from '../adapters/reference-path.js';
import { discover } from '../discover/discover.js';
import { buildGraph } from '../graph/graph.js';
import { toPosix } from '../paths.js';
import { type AliasMap, expandAlias, loadAliases } from '../resolve/aliases.js';
import { linkedPaths } from '../resolve/reference.js';
import { resolveReferences } from '../resolve/resolve.js';
import { scanSources } from '../scan/scan.js';
import type { Asset, Reference } from '../types.js';
import { type Move, planRelocation } from './relocate.js';

/**
 * `relocate`: moving an asset and repointing what names it.
 *
 * Two layers. The fixture block runs the real pipeline over `fixtures/partial-pattern`,
 * because a template binding several assets is a partial-failure state no real
 * repository supplies. The spelling block uses hand-built graphs, because a re-derived
 * path has to be checked from many directions, and building a real tree for each
 * directory would test the fixtures rather than the arithmetic.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/partial-pattern',
);
const SERVING = { declared: true, dirs: ['public'] } as const;
const NO_ALIASES: AliasMap = { rules: [], skipped: [] };
/** A project root as the resolver spells one, which on Windows starts at a drive. */
const REPO = toPosix(resolve('/repo'));

async function fixtureGraph() {
  const discovered = await discover({ root: FIXTURE, adapters: defaultAdapters });
  const scanned = await scanSources({
    sourceFiles: discovered.sourceFiles,
    adapters: defaultAdapters,
    readFile: (path) => readFile(path, 'utf8'),
  });
  const references = await resolveReferences(scanned.references, {
    root: discovered.root,
    assets: discovered.assets,
    servingRoots: SERVING,
    excludedRoots: discovered.excludedRoots,
    exists: (path) => existsSync(path),
  });
  return buildGraph({
    root: discovered.root,
    assets: discovered.assets,
    references,
    unscannedFiles: [...discovered.unscannedFiles, ...scanned.unscanned],
  });
}

async function relocateFixture(moves: Move[]) {
  return planRelocation({
    graph: await fixtureGraph(),
    moves,
    servingRoots: SERVING,
    aliases: NO_ALIASES,
  });
}

describe('relocate, on the real tree', () => {
  it('moves a served asset within the served directory and repoints the URL', async () => {
    // The ordinary case, and the one the product claims: change where an image lives
    // and nothing breaks. A root-relative reference stays root-relative.
    const plan = await relocateFixture([
      { from: 'public/banner.png', to: 'public/img/banner.png' },
    ]);

    expect(plan.refused).toEqual([]);
    expect(plan.moves).toEqual([{ from: 'public/banner.png', to: 'public/img/banner.png' }]);
    expect(plan.rewrites).toEqual([
      { file: 'src/App.jsx', edits: [expect.objectContaining({ replacement: '/img/banner.png' })] },
    ]);
  });

  it('moves a bundled asset within the source tree and re-derives the relative path', async () => {
    // `./inline-logo.jpg` is expressed from the file that holds it, so moving the asset
    // one directory down makes it `./img/inline-logo.jpg`. The `./` survives, because a
    // diff where `./` appears and disappears is a diff nobody can review.
    const plan = await relocateFixture([
      { from: 'src/inline-logo.jpg', to: 'src/img/inline-logo.jpg' },
    ]);

    expect(plan.refused).toEqual([]);
    expect(plan.rewrites[0]?.edits[0]?.replacement).toBe('./img/inline-logo.jpg');
  });

  describe('the moves it refuses', () => {
    it.each([
      ['served to bundled', 'public/banner.png', 'src/banner.png'],
      ['bundled to served', 'src/inline-logo.jpg', 'public/inline-logo.jpg'],
    ])('refuses %s', async (_name, from, to) => {
      // The refusal a reader is most likely to think over-cautious. After this move no
      // path text reaches the file, whatever is written: a bundled asset is imported and
      // emitted by the build, a served one is fetched by URL. Turning one into the other
      // is a code change, and `relocate` rewrites paths.
      const plan = await relocateFixture([{ from, to }]);

      expect(plan.moves).toEqual([]);
      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['crosses-serving-boundary']);
      expect(plan.refused[0]?.reason).toContain('rewrites paths, not code');
    });

    it('makes no edits at all for a refused move', async () => {
      // Nothing partially applies. A caller that ignores `refused` writes less than it
      // asked for, never something wrong: the rewrites would otherwise point at a file
      // that never moved.
      const plan = await relocateFixture([{ from: 'public/banner.png', to: 'src/banner.png' }]);

      expect(plan.rewrites).toEqual([]);
      expect(plan.declined).toEqual([]);
    });

    it('refuses a pattern sibling and names every asset the pattern binds', async () => {
      // The user asked for one file. Moving all of them silently is not the fix, and
      // moving one breaks the single edit that stands for all of them. This is the case
      // `fixtures/partial-pattern` was built for.
      //
      // The count is asserted because the refusal quotes it: a message naming three
      // assets while binding four is the kind of wrong that reads as right.
      const plan = await relocateFixture([
        { from: 'public/theme-dark.png', to: 'public/img/theme-dark.png' },
      ]);

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['binds-a-pattern']);
      expect(plan.refused[0]?.reason).toContain('public/theme-light.png');
      expect(plan.refused[0]?.reason).toContain('public/theme-sepia.png');
      expect(plan.refused[0]?.reason).toContain('public/theme-not-an-image.png');
      expect(plan.refused[0]?.reason).toContain('moving any of the 4 breaks it');
    });

    it('offers no move it would refuse: moving every file the pattern matches is refused too', async () => {
      // Following a refusal's advice must not meet the same refusal. The pattern's text is
      // the same whichever files move, so moving all of them breaks it as surely as one.
      const theme = ['dark', 'light', 'sepia', 'not-an-image'];
      const plan = await relocateFixture(
        theme.map((name) => ({
          from: `public/theme-${name}.png`,
          to: `public/img/theme-${name}.png`,
        })),
      );

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(
        theme.map(() => 'binds-a-pattern'),
      );
      for (const refusal of plan.refused) {
        expect(refusal.reason).not.toMatch(/move all/i);
        expect(refusal.reason).toContain('Change it by hand first');
      }
    });

    it('refuses a destination outside the project', async () => {
      const plan = await relocateFixture([{ from: 'public/banner.png', to: '../banner.png' }]);

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['outside-project']);
    });

    describe('judges a destination by where it leads, not how it is spelled', () => {
      it('refuses one that climbs out of the project from a folder inside it', async () => {
        const plan = await relocateFixture([
          { from: 'public/banner.png', to: 'public/../../banner.png' },
        ]);

        expect(plan.refused.map((refusal) => refusal.code)).toEqual(['outside-project']);
        expect(plan.moves).toEqual([]);
      });

      it('refuses one that climbs back onto a file that exists', async () => {
        const plan = await relocateFixture([
          { from: 'public/banner.png', to: 'public/img/../theme-dark.png' },
        ]);

        expect(plan.refused.map((refusal) => refusal.code)).toEqual(['destination-occupied']);
      });

      it('refuses two moves to one place written two ways, and moves to it by its plain path', async () => {
        const plan = await relocateFixture([
          { from: 'public/banner.png', to: 'public/img/./a.png' },
          { from: 'public/theme-dark.png', to: 'public/img/x/../a.png' },
        ]);

        expect(plan.refused.map((refusal) => refusal.code)).toEqual(['destination-claimed-twice']);
        expect(plan.moves).toEqual([{ from: 'public/banner.png', to: 'public/img/a.png' }]);
      });
    });

    it('refuses a move onto a file that already exists', async () => {
      const plan = await relocateFixture([
        { from: 'public/banner.png', to: 'public/theme-dark.png' },
      ]);

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['destination-occupied']);
    });

    it('refuses a path that is not an asset, rather than moving nothing quietly', async () => {
      const plan = await relocateFixture([{ from: 'public/not-here.png', to: 'public/x.png' }]);

      expect(plan.refused.map((refusal) => refusal.code)).toEqual(['not-an-asset']);
    });
  });
});

/** A hand-built graph, for the spelling cases that vary only by directory. */
function graphFor(input: {
  readonly assets: readonly string[];
  readonly references: readonly {
    file: string;
    rawPath: string;
    target: string;
    via?: 'file' | 'serving-root' | 'project-root' | 'speculative-root';
    spelling?: PathSpelling;
    confidence?: 'high' | 'unsafe';
    /** How the file holds the path, which decides how it is read and written. */
    kind?: 'attr' | 'md' | 'import';
  }[];
}) {
  const ROOT = REPO;
  const assets: Asset[] = input.assets.map((relative) => ({
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes: 1_000,
  }));
  const shapes = { attr: 'html.img.src', md: 'md.image', import: 'js.import.static' } as const;
  const references = input.references.map(
    (entry) =>
      ({
        kind: entry.kind ?? 'attr',
        shape: shapes[entry.kind ?? 'attr'],
        ceiling: 'high',
        asserted: true,
        file: `${ROOT}/${entry.file}`,
        rawPath: entry.rawPath,
        start: 10,
        end: 10 + entry.rawPath.length,
        resolution: 'resolved',
        confidence: entry.confidence ?? 'high',
        resolvedPath: `${ROOT}/${entry.target}`,
        resolvedVia: entry.via ?? 'file',
        ...(entry.spelling === undefined ? {} : { spelling: entry.spelling }),
      }) as Reference,
  );

  return buildGraph({ root: ROOT, assets, references, unscannedFiles: [] });
}

describe('relocate, and how a path is re-spelled', () => {
  function replacementFor(
    graph: ReturnType<typeof graphFor>,
    move: Move,
    over: { aliases?: AliasMap; servingRoots?: { declared: boolean; dirs: string[] } } = {},
  ) {
    const plan = planRelocation({
      graph,
      moves: [move],
      servingRoots: over.servingRoots ?? SERVING,
      aliases: over.aliases ?? NO_ALIASES,
    });
    return { plan, text: plan.rewrites[0]?.edits[0]?.replacement };
  }

  it('climbs out of a directory when the asset moves above the referencing file', () => {
    const graph = graphFor({
      assets: ['src/deep/logo.png'],
      references: [
        { file: 'src/deep/App.jsx', rawPath: './logo.png', target: 'src/deep/logo.png' },
      ],
    });

    expect(replacementFor(graph, { from: 'src/deep/logo.png', to: 'src/logo.png' }).text).toBe(
      '../logo.png',
    );
  });

  it('does not invent a ./ the original did not have', () => {
    // The reference is expressed as the author wrote it. Adding `./` would be a change
    // to every line we touch that has nothing to do with the move.
    const graph = graphFor({
      assets: ['src/logo.png'],
      references: [{ file: 'src/App.jsx', rawPath: 'logo.png', target: 'src/logo.png' }],
    });

    expect(replacementFor(graph, { from: 'src/logo.png', to: 'src/img/logo.png' }).text).toBe(
      'img/logo.png',
    );
  });

  it('keeps a query or fragment, which is not part of the path', () => {
    // `?v=2` is a cache-buster the author put there on purpose. Dropping it on the way
    // past would be a silent change to behaviour in a tool that claims to move files.
    const graph = graphFor({
      assets: ['public/hero.png'],
      references: [
        {
          file: 'index.html',
          rawPath: '/hero.png?v=2',
          target: 'public/hero.png',
          via: 'serving-root',
        },
      ],
    });

    expect(replacementFor(graph, { from: 'public/hero.png', to: 'public/img/hero.png' }).text).toBe(
      '/img/hero.png?v=2',
    );
  });

  it.each([
    ['a name that needs no escape', 'public/photos/my_photo.png', '/photos/my_photo.png'],
    [
      'an ampersand CommonMark would read as a character reference',
      'public/photos/my&amp;photo.png',
      '/photos/my\\&amp;photo.png',
    ],
  ])(
    'writes a Markdown-escaped path so that it reads as the moved file: %s',
    (_name, to, written) => {
      // `my\_photo.png` named `my_photo.png`. The new path is escaped where CommonMark needs it.
      const graph = graphFor({
        assets: ['public/img/my_photo.png'],
        references: [
          {
            file: 'docs/guide.md',
            rawPath: '/img/my\\_photo.png',
            target: 'public/img/my_photo.png',
            via: 'serving-root',
            spelling: 'markdown-escapes',
            kind: 'md',
          },
        ],
      });

      const { plan, text } = replacementFor(graph, { from: 'public/img/my_photo.png', to });

      expect(text).toBe(written);
      expect(plan.declined).toEqual([]);
    },
  );

  it('re-derives a root-relative path against the serving root, not the project root', () => {
    // The URL is what the browser asks for, so it is relative to what the server
    // serves. `/public/img/hero.png` would be a path that exists on disk and 404s in a
    // browser, the most convincing kind of wrong.
    const graph = graphFor({
      assets: ['public/hero.png'],
      references: [
        {
          file: 'index.html',
          rawPath: '/hero.png',
          target: 'public/hero.png',
          via: 'serving-root',
        },
      ],
    });

    expect(replacementFor(graph, { from: 'public/hero.png', to: 'public/img/hero.png' }).text).toBe(
      '/img/hero.png',
    );
  });

  it.each([
    ['the project root listed first', ['', 'public']],
    ['the project root listed last', ['public', '']],
  ])('re-spells a URL from the deepest serving root that holds the new path: %s', (_name, dirs) => {
    // Where one serving root holds another, the planner reads a path's URL from the deepest,
    // so a move and a conversion spell the same file the same way whatever the list's order.
    const graph = graphFor({
      assets: ['public/hero.png'],
      references: [
        {
          file: 'index.html',
          rawPath: '/hero.png',
          target: 'public/hero.png',
          via: 'serving-root',
        },
      ],
    });

    const { plan, text } = replacementFor(
      graph,
      { from: 'public/hero.png', to: 'public/img/hero.png' },
      { servingRoots: { declared: true, dirs } },
    );

    expect(plan.refused).toEqual([]);
    expect(text).toBe('/img/hero.png');
  });

  it('re-spells an aliased import through the same alias', () => {
    // `astro-docs` imports `~/assets/houston.png`. Moving it within the alias's root
    // keeps the alias: the import statement is untouched apart from the path.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '~/',
          targets: [`${REPO}/src`],
          wildcard: true,
          scope: REPO,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['src/assets/houston.png'],
      references: [
        {
          file: 'src/App.astro',
          rawPath: '~/assets/houston.png',
          target: 'src/assets/houston.png',
          via: 'serving-root',
          kind: 'import',
        },
      ],
    });

    expect(
      replacementFor(
        graph,
        { from: 'src/assets/houston.png', to: 'src/img/houston.png' },
        { aliases },
      ).text,
    ).toBe('~/img/houston.png');
  });

  it('re-spells a bare import through the baseUrl that linked it, and refuses a place it cannot name', () => {
    // `import logo from 'assets/logo.png'` with `"baseUrl": "src"` and no `paths` names
    // src/assets/logo.png. A bare name stays bare: a URL or a relative path is another kind.
    const aliases: AliasMap = {
      rules: [],
      skipped: [],
      tsconfigs: [{ scope: REPO, baseUrl: `${REPO}/src` }],
    };
    const graph = graphFor({
      assets: ['src/assets/logo.png'],
      references: [
        {
          file: 'src/App.tsx',
          rawPath: 'assets/logo.png',
          target: 'src/assets/logo.png',
          via: 'serving-root',
          kind: 'import',
        },
      ],
    });
    const move = { from: 'src/assets/logo.png', to: 'src/img/logo.png' };

    const within = replacementFor(graph, move, { aliases });
    const served = replacementFor(graph, move, {
      aliases,
      servingRoots: { declared: true, dirs: ['src'] },
    });
    const outside = replacementFor(graph, { ...move, to: 'lib/logo.png' }, { aliases });

    expect(within.plan.declined).toEqual([]);
    expect(within.text).toBe('img/logo.png');
    expect(served.text).toBe('img/logo.png');
    expect(outside.plan.moves).toEqual([]);
    expect(outside.plan.refused).toEqual([
      expect.objectContaining({ code: 'crosses-serving-boundary' }),
    ]);
  });

  it('re-spells a Vite alias read from a real config through the key and its slash', async () => {
    // Vite's `@` maps `@` and `@/...`, never `@img/...`, which here is the tsconfig's own
    // alias for a folder holding another image of the same name.
    const files = new Map([
      [
        `${REPO}/vite.config.ts`,
        [
          "import path from 'node:path';",
          "import { defineConfig } from 'vite';",
          '',
          'export default defineConfig({',
          "  resolve: { alias: { '@': path.resolve(__dirname, './src') } },",
          '});',
          '',
        ].join('\n'),
      ],
      [
        `${REPO}/tsconfig.json`,
        '{ "compilerOptions": { "paths": { "@img/*": ["./shared/img/*"] } } }',
      ],
    ]);
    const aliases = await loadAliases({
      root: REPO,
      files: [...files.keys()].map((path) => ({ path, relative: path.slice(`${REPO}/`.length) })),
      readFile: async (path) => {
        const text = files.get(toPosix(path));
        if (text === undefined) throw new Error(`not in this test: ${path}`);
        return text;
      },
      isFile: (path) => files.has(toPosix(path)),
    });
    const graph = graphFor({
      assets: ['src/assets/x.png', 'shared/img/x.png'],
      references: [
        {
          file: 'src/App.tsx',
          rawPath: '@/assets/x.png',
          target: 'src/assets/x.png',
          via: 'serving-root',
        },
      ],
    });

    const { text } = replacementFor(
      graph,
      { from: 'src/assets/x.png', to: 'src/img/x.png' },
      { aliases },
    );

    expect(aliases.skipped).toEqual([]);
    expect(text).toBe('@/img/x.png');
    // The new text reaches the file that moved, not `shared/img/x.png`.
    expect(expandAlias(aliases, text ?? '', `${REPO}/src/App.tsx`)[0]).toBe(
      `${REPO}/src/img/x.png`,
    );
  });

  it('spells only what follows the alias when the path was written percent-encoded', () => {
    // The prefix is the project's own text: `@/` encoded is `%40/`, which no alias matches.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '@/',
          targets: [`${REPO}/src`],
          wildcard: true,
          scope: REPO,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['src/assets/hero image.png'],
      references: [
        {
          file: 'src/App.astro',
          rawPath: '@/assets/hero%20image.png',
          target: 'src/assets/hero image.png',
          via: 'serving-root',
          spelling: 'percent-encoded',
        },
      ],
    });

    expect(
      replacementFor(
        graph,
        { from: 'src/assets/hero image.png', to: 'src/img/new name.png' },
        { aliases },
      ).text,
    ).toBe('@/img/new%20name.png');
  });

  it('does not re-spell through an alias whose scope does not cover the file', () => {
    // An alias rule applies only to references from inside the directory its config
    // governs, which is what `expandAlias` enforces. A matcher here that looked only at
    // the `~/` prefix would re-spell a reference through a rule the resolver never
    // used, producing text that looks right and reaches nothing.
    //
    // `packages/site` is outside the rule's scope, so the reference is treated as the
    // ordinary relative one it resolved as.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '~/',
          targets: [`${REPO}/src`],
          wildcard: true,
          scope: `${REPO}/src`,
          source: 'x',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['packages/site/~/logo.png'],
      references: [
        {
          file: 'packages/site/App.jsx',
          rawPath: '~/logo.png',
          target: 'packages/site/~/logo.png',
        },
      ],
    });

    const { text } = replacementFor(
      graph,
      { from: 'packages/site/~/logo.png', to: 'packages/site/img/logo.png' },
      { aliases },
    );

    expect(text).toBe('img/logo.png');
  });

  it('re-derives a relative link whose text an alias also matches, as the resolver linked it', () => {
    // A file at the written path wins over an alias, so `~/logo.png` here is the folder `~`
    // beside the page. Read as the alias, the move would be refused as out of its reach.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '~/',
          targets: [`${REPO}/src`],
          wildcard: true,
          scope: REPO,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['lib/~/logo.png'],
      references: [{ file: 'lib/App.jsx', rawPath: '~/logo.png', target: 'lib/~/logo.png' }],
    });

    const { plan, text } = replacementFor(
      graph,
      { from: 'lib/~/logo.png', to: 'lib/~/img/logo.png' },
      { aliases },
    );

    expect(plan.refused).toEqual([]);
    expect(text).toBe('~/img/logo.png');
  });

  it('re-spells an alias written encoded at its start through the rule the resolver read', () => {
    // `%7E/` decodes to `~/`, and the resolver asks the alias question of that spelling.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '~/',
          targets: [`${REPO}/src`],
          wildcard: true,
          scope: REPO,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['src/assets/x.png'],
      references: [
        {
          file: 'src/page.html',
          rawPath: '%7E/assets/x.png',
          target: 'src/assets/x.png',
          via: 'serving-root',
          spelling: 'percent-encoded',
        },
      ],
    });

    const { plan, text } = replacementFor(
      graph,
      { from: 'src/assets/x.png', to: 'src/img/x.png' },
      { aliases },
    );

    expect(plan.declined).toEqual([]);
    expect(text).toBe('~/img/x.png');
  });

  it('re-spells through a key with text after its *, and refuses a name the key cannot hold', () => {
    // `@icons/*.svg` maps only a path ending in `.svg`, so `@icons/star.png` is text no
    // key maps: the import would break.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '@icons/',
          suffix: '.svg',
          targets: [`${REPO}/src/icons`],
          targetPatterns: ['*.svg'],
          wildcard: true,
          scope: REPO,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['src/icons/star.svg'],
      references: [
        {
          file: 'src/App.tsx',
          rawPath: '@icons/star.svg',
          target: 'src/icons/star.svg',
          via: 'serving-root',
        },
      ],
    });
    const moved = (to: string) =>
      replacementFor(graph, { from: 'src/icons/star.svg', to }, { aliases });

    expect(moved('src/icons/ui/moon.svg').text).toBe('@icons/ui/moon.svg');
    expect(moved('src/icons/star.png').plan.moves).toEqual([]);
    expect(moved('src/icons/star.png').plan.refused[0]?.reason).toContain(
      'cannot express src/icons/star.png',
    );
  });

  it('refuses when the alias cannot express the destination', () => {
    // `~/* → src/*` cannot name anything outside `src/`, so after the move no alias path
    // reaches the file. The import would have to become a URL string, which is a code
    // change.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '~/',
          targets: [`${REPO}/src`],
          wildcard: true,
          scope: REPO,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['src/assets/houston.png'],
      references: [
        {
          file: 'src/App.astro',
          rawPath: '~/assets/houston.png',
          target: 'src/assets/houston.png',
          via: 'serving-root',
          kind: 'import',
        },
      ],
    });

    const { plan } = replacementFor(
      graph,
      { from: 'src/assets/houston.png', to: 'public/img/houston.png' },
      { aliases },
    );

    expect(plan.moves).toEqual([]);
    expect(plan.refused[0]?.code).toBe('crosses-serving-boundary');
  });

  it('refuses a move when the rewritten alias path would reach another file first', () => {
    // `@/img/*` is the longer key, so TypeScript reads `@/img/x.png` through it: the import
    // re-spelled for `src/img/x.png` would load `assets/img/x.png`, another picture.
    const aliases: AliasMap = {
      rules: [
        {
          prefix: '@/img/',
          targets: [`${REPO}/assets/img`],
          wildcard: true,
          scope: REPO,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
        {
          prefix: '@/',
          targets: [`${REPO}/src`],
          wildcard: true,
          scope: REPO,
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };
    const graph = graphFor({
      assets: ['src/a/x.png', 'assets/img/x.png'],
      references: [
        { file: 'src/App.ts', rawPath: '@/a/x.png', target: 'src/a/x.png', via: 'serving-root' },
        {
          file: 'src/App.ts',
          rawPath: '@/img/x.png',
          target: 'assets/img/x.png',
          via: 'serving-root',
        },
      ],
    });

    const { plan } = replacementFor(
      graph,
      { from: 'src/a/x.png', to: 'src/img/x.png' },
      { aliases },
    );

    expect(plan.moves).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.refused.map((refusal) => [refusal.code, refusal.reason])).toEqual([
      [
        'rewrite-would-miss',
        '`@/a/x.png` in `src/App.ts` would become `@/img/x.png`, which reaches assets/img/x.png first, so the reference would load that file instead. Move it elsewhere, or change the reference by hand first.',
      ],
    ]);
  });

  it('refuses a move when the rewritten URL would be served from a nearer root', () => {
    // From `apps/web/src`, `/img/x.png` is looked for in `apps/web/public` first, where another
    // image already has that name.
    const graph = graphFor({
      assets: ['public/a.png', 'apps/web/public/img/x.png'],
      references: [
        {
          file: 'apps/web/src/App.tsx',
          rawPath: '/a.png',
          target: 'public/a.png',
          via: 'serving-root',
        },
      ],
    });

    const { plan } = replacementFor(
      graph,
      { from: 'public/a.png', to: 'public/img/x.png' },
      { servingRoots: { declared: true, dirs: ['public', 'apps/web/public'] } },
    );

    expect(plan.moves).toEqual([]);
    expect(plan.refused.map((refusal) => refusal.code)).toEqual(['rewrite-would-miss']);
    expect(plan.refused[0]?.reason).toContain('which reaches apps/web/public/img/x.png first');
  });

  it('refuses a move that would change what a reference it leaves as written loads', () => {
    // From `apps/web/src`, `/logo.png` loads public/logo.png today, and `/new.png` loads
    // nothing. A file moved to apps/web/public/logo.png or to public/new.png would be found
    // instead, and a page nobody asked to change would show another image.
    const graph = graphFor({
      assets: ['public/logo.png', 'apps/web/public/img/logo.png', 'public/img/new.png'],
      references: [
        {
          file: 'apps/web/src/App.tsx',
          rawPath: '/logo.png',
          target: 'public/logo.png',
          via: 'serving-root',
        },
        {
          file: 'apps/web/src/App.tsx',
          rawPath: '/img/logo.png',
          target: 'apps/web/public/img/logo.png',
          via: 'serving-root',
        },
      ],
    });
    const brokenToday: Reference = {
      ...graph.references[0],
      rawPath: '/new.png',
      resolution: 'broken',
      confidence: 'unsafe',
      resolvedPath: null,
    } as Reference;
    const withBroken = buildGraph({
      root: graph.root,
      assets: graph.assets.map((node) => node.asset),
      references: [...graph.references, brokenToday],
      unscannedFiles: [],
    });
    const roots = { servingRoots: { declared: true, dirs: ['public', 'apps/web/public'] } };

    const nearer = replacementFor(
      graph,
      { from: 'apps/web/public/img/logo.png', to: 'apps/web/public/logo.png' },
      roots,
    ).plan;
    const named = replacementFor(
      withBroken,
      { from: 'public/img/new.png', to: 'public/new.png' },
      roots,
    ).plan;

    expect(nearer.moves).toEqual([]);
    expect(nearer.refused.map((refusal) => refusal.code)).toEqual(['redirects-a-reference']);
    expect(nearer.refused[0]?.reason).toContain(
      '`/logo.png` in `apps/web/src/App.tsx` loads public/logo.png today',
    );
    expect(named.moves).toEqual([]);
    expect(named.refused[0]?.reason).toContain(
      '`/new.png` in `apps/web/src/App.tsx` loads nothing today',
    );
  });

  it('counts the files the walk left out, by listing folders, when it is given a way to', () => {
    // An ignore rule keeps public/img/x.png and apps/web/public/img/y.png out of the walk. A move
    // onto the first would destroy it; from apps/web/src, `/img/y.png` reaches the second first.
    const graph = graphFor({
      assets: ['public/a.png', 'public/b.png'],
      references: [
        {
          file: 'apps/web/src/App.tsx',
          rawPath: '/a.png',
          target: 'public/a.png',
          via: 'serving-root',
        },
        {
          file: 'apps/web/src/App.tsx',
          rawPath: '/b.png',
          target: 'public/b.png',
          via: 'serving-root',
        },
      ],
    });
    const listings = new Map<string, readonly string[]>([
      [REPO, ['apps', 'public']],
      [join(REPO, 'public'), ['a.png', 'b.png', 'img']],
      [join(REPO, 'public', 'img'), ['x.png']],
      [join(REPO, 'apps'), ['web']],
      [join(REPO, 'apps', 'web'), ['public', 'src']],
      [join(REPO, 'apps', 'web', 'public'), ['img']],
      [join(REPO, 'apps', 'web', 'public', 'img'), ['y.png']],
    ]);

    const plan = planRelocation({
      graph,
      moves: [
        { from: 'public/a.png', to: 'public/img/x.png' },
        { from: 'public/b.png', to: 'public/img/y.png' },
      ],
      servingRoots: { declared: true, dirs: ['public', 'apps/web/public'] },
      aliases: NO_ALIASES,
      listDirectory: (path) => listings.get(path) ?? [],
    });

    expect(plan.moves).toEqual([]);
    expect(plan.refused.map((refusal) => [refusal.from, refusal.code])).toEqual([
      ['public/a.png', 'destination-occupied'],
      ['public/b.png', 'rewrite-would-miss'],
    ]);
    expect(plan.refused[1]?.reason).toContain('which reaches apps/web/public/img/y.png first');
  });

  it('declines a reference it may not edit, rather than moving in silence', () => {
    // The move happens and this reference will break. Saying so is the difference
    // between a dangling reference Upfly found and one it caused.
    const graph = graphFor({
      assets: ['src/logo.png'],
      references: [
        {
          file: 'src/App.jsx',
          rawPath: './logo.png',
          target: 'src/logo.png',
          confidence: 'unsafe',
        },
      ],
    });

    const { plan, text } = replacementFor(graph, { from: 'src/logo.png', to: 'src/img/logo.png' });

    expect(text).toBeUndefined();
    expect(plan.moves).toHaveLength(1);
    expect(plan.declined[0]?.reason).toContain('no static path to replace');
  });

  it('refuses a second move of the same file, rather than quietly taking the last', () => {
    // `accepted` is keyed on the source, so without this refusal the second move would
    // silently replace the first, and the plan would report one move when asked for two.
    const graph = graphFor({ assets: ['src/a.png'], references: [] });
    const plan = planRelocation({
      graph,
      moves: [
        { from: 'src/a.png', to: 'src/one/a.png' },
        { from: 'src/a.png', to: 'src/two/a.png' },
      ],
      servingRoots: SERVING,
      aliases: NO_ALIASES,
    });

    expect(plan.moves).toEqual([{ from: 'src/a.png', to: 'src/one/a.png' }]);
    expect(plan.refused.map((refusal) => refusal.code)).toEqual(['source-claimed-twice']);
  });

  it('refuses two moves that both claim one destination', () => {
    const graph = graphFor({ assets: ['src/a.png', 'src/b.png'], references: [] });
    const plan = planRelocation({
      graph,
      moves: [
        { from: 'src/a.png', to: 'src/img/x.png' },
        { from: 'src/b.png', to: 'src/img/x.png' },
      ],
      servingRoots: SERVING,
      aliases: NO_ALIASES,
    });

    // One survives and one is refused, rather than both proceeding and the result
    // depending on which ran first. Destinations are compared with case folded, as
    // `prepare` compares them: two paths differing only in case are one file on Windows
    // and macOS.
    expect(plan.moves).toHaveLength(1);
    expect(plan.refused.map((refusal) => refusal.code)).toEqual(['destination-claimed-twice']);
  });

  it('refuses a destination that differs from a file already there only in case', () => {
    // Windows and macOS find `src/logo.png` at `src/Logo.png`, so the move would write over
    // it. Folded on every platform, as two claimed destinations are, so a plan does not
    // depend on where it runs.
    const graph = graphFor({ assets: ['src/a.png', 'src/logo.png'], references: [] });
    const plan = planRelocation({
      graph,
      moves: [{ from: 'src/a.png', to: 'src/Logo.png' }],
      servingRoots: SERVING,
      aliases: NO_ALIASES,
    });

    expect(plan.moves).toEqual([]);
    expect(plan.refused.map((refusal) => [refusal.code, refusal.reason])).toEqual([
      [
        'destination-occupied',
        'src/logo.png already exists, and is the same file as src/Logo.png on Windows and macOS. Moving src/a.png onto it would destroy a file Upfly can see.',
      ],
    ]);
  });

  it('moves a file to its own name in another case', () => {
    // The one file a folded destination may name is the file that moves.
    const graph = graphFor({ assets: ['src/logo.png'], references: [] });
    const plan = planRelocation({
      graph,
      moves: [{ from: 'src/logo.png', to: 'src/Logo.png' }],
      servingRoots: SERVING,
      aliases: NO_ALIASES,
    });

    expect(plan.refused).toEqual([]);
    expect(plan.moves).toEqual([{ from: 'src/logo.png', to: 'src/Logo.png' }]);
  });

  it('treats a project that serves from its own root as all one world', () => {
    // A serving directory of `''` is the project root: a hand-written static site with no
    // build step serves the repository it uploads, so there is only one side and nothing
    // can cross a boundary. Getting this backwards would refuse every move on the
    // simplest kind of site there is.
    const graph = graphFor({
      assets: ['images/logo.png'],
      references: [
        {
          file: 'index.html',
          rawPath: '/images/logo.png',
          target: 'images/logo.png',
          via: 'serving-root',
        },
      ],
    });
    const plan = planRelocation({
      graph,
      moves: [{ from: 'images/logo.png', to: 'assets/logo.png' }],
      servingRoots: { declared: true, dirs: [''] },
      aliases: NO_ALIASES,
    });

    expect(plan.refused).toEqual([]);
    expect(plan.rewrites[0]?.edits[0]?.replacement).toBe('/assets/logo.png');
  });

  describe('a project with two website folders', () => {
    const TWO_ROOTS = { declared: false, dirs: ['apps/a/public', 'apps/b/public'] };
    const graph = graphFor({
      assets: ['apps/b/public/logo.png'],
      references: [
        {
          file: 'apps/b/index.html',
          rawPath: '/logo.png',
          target: 'apps/b/public/logo.png',
          via: 'serving-root',
        },
      ],
    });

    it('refuses a move from one to the other, because the URL would stop finding it', () => {
      const plan = planRelocation({
        graph,
        moves: [{ from: 'apps/b/public/logo.png', to: 'apps/a/public/logo.png' }],
        servingRoots: TWO_ROOTS,
        aliases: NO_ALIASES,
      });

      expect(plan.refused.map((refusal) => [refusal.code, refusal.reason])).toEqual([
        [
          'crosses-serving-boundary',
          'apps/b/public/logo.png is served from apps/b/public/ and apps/a/public/logo.png would be served from apps/a/public/, so a URL that finds it today would not find it there. Move it within apps/b/public/, or change the references by hand first.',
        ],
      ]);
    });

    it('moves an image within the second folder, which is as served as the first', () => {
      const plan = planRelocation({
        graph,
        moves: [{ from: 'apps/b/public/logo.png', to: 'apps/b/public/img/logo.png' }],
        servingRoots: TWO_ROOTS,
        aliases: NO_ALIASES,
      });

      expect(plan.refused).toEqual([]);
      expect(plan.rewrites[0]?.edits[0]?.replacement).toBe('/img/logo.png');
    });
  });
});

/** Mulberry32, so a failing round can be replayed from its number alone. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A moved file's new name, written into a Markdown page, read back by the Markdown adapter and
 * the resolver as a later run would read it. The page is rewritten for real, so a name that
 * ends a destination early, or decodes to another name, is caught where a user would meet it.
 */
describe('relocate, and a new name read back by the syntax that holds it', () => {
  // The check after the plan reads a new text with the resolver, which never splits a srcset
  // or ends a url() early, so a name the syntax cannot hold has to be caught where it is written.
  const ROOT = REPO;
  const NAMES = ['new name.png', 'new (1).png', 'new,one.png', "o'clock.png", 'plain.png'];
  const OTHER: Asset = {
    path: `${ROOT}/public/img/other.png`,
    relative: 'public/img/other.png',
    extension: '.png',
    bytes: 1_000,
  };
  /**
   * Each page, and what its syntax cannot hold. Upfly's own readers are lenient where a browser
   * is not: CSS ends an unquoted url() at whitespace, a quote or a parenthesis, and a srcset URL
   * ends at whitespace or a comma.
   */
  const PAGES = [
    {
      what: 'a srcset candidate',
      file: `${ROOT}/index.html`,
      adapter: htmlAdapter,
      text: '<img srcset="/img/old.png 1x, /img/other.png 2x">\n',
      unheld: /[\s,]/,
      alsoLinks: [OTHER.path],
    },
    {
      what: 'an unquoted url()',
      file: `${ROOT}/site.css`,
      adapter: cssAdapter,
      text: '.hero { background: url(/img/old.png) no-repeat; }\n',
      unheld: /[\s()'"\\]/,
      alsoLinks: [],
    },
    {
      what: 'a quoted url(), which holds any of them',
      file: `${ROOT}/quoted.css`,
      adapter: cssAdapter,
      text: '.hero { background: url("/img/old.png"); }\n',
      unheld: null,
      alsoLinks: [],
    },
  ];
  type Page = (typeof PAGES)[number];

  const asset = (relative: string): Asset => ({
    path: `${ROOT}/${relative}`,
    relative,
    extension: '.png',
    bytes: 1_000,
  });
  const read = (page: Page, text: string, assets: readonly Asset[]) =>
    resolveReferences(page.adapter.findReferences({ file: page.file, text }), {
      root: ROOT,
      assets,
      servingRoots: SERVING,
      exists: () => false,
    });

  /** The page after `old.png` moves to `name`, or null when it reads back as the moved file. */
  function failureFor(page: Page, name: string): string | null {
    const to = `public/img/${name}`;
    const before = [asset('public/img/old.png'), OTHER];
    const graph = buildGraph({
      root: ROOT,
      assets: before,
      references: read(page, page.text, before),
      unscannedFiles: [],
    });
    const plan = planRelocation({
      graph,
      moves: [{ from: 'public/img/old.png', to }],
      servingRoots: SERVING,
      aliases: NO_ALIASES,
    });
    const edits = plan.rewrites[0]?.edits ?? [];
    const rewritten = page.adapter.rewrite({ text: page.text, edits });
    const found = read(page, rewritten, [asset(to), OTHER])
      .flatMap(linkedPaths)
      .sort();
    const expected = [`${ROOT}/${to}`, ...page.alsoLinks].sort();
    const held = page.unheld === null || !page.unheld.test(edits[0]?.replacement ?? '');
    return JSON.stringify(found) === JSON.stringify(expected) && held
      ? null
      : `${page.what}, moved to ${name}: ${rewritten.trim()}`;
  }

  it('writes each new name so that its own syntax reads it back as the moved file', () => {
    const failures = PAGES.flatMap((page) =>
      NAMES.map((name) => failureFor(page, name)).filter((failure) => failure !== null),
    );

    expect(failures).toEqual([]);
  });
});

describe('relocate, and a new name read back from a Markdown destination', () => {
  const ROOT = REPO;
  const PAGE = `${ROOT}/docs/guide.md`;
  const ROUNDS = 200;
  /** Spaces, parentheses, percent signs and ampersands, alone and as the escapes they form. */
  const PIECES = [
    'a',
    'b',
    '1',
    'f',
    '_',
    ';',
    ' ',
    '(',
    ')',
    '()',
    '%',
    '%20',
    '%4',
    '&',
    '&amp;',
    '&#38;',
  ];
  /** A file the page names, written in each spelling the resolver records. */
  const ORIGINS = [
    { file: 'public/img/old.png', written: '/img/old.png' },
    { file: 'public/img/old one.png', written: '/img/old%20one.png' },
    { file: 'public/img/old_one.png', written: '/img/old\\_one.png' },
    { file: 'public/img/old&one.png', written: '/img/old&amp;one.png' },
  ];
  /** The reference does not record which of the two a destination was written in. */
  const FORMS = [
    { form: 'bare', page: (written: string) => `![a](${written})\n` },
    { form: 'in angle brackets', page: (written: string) => `![a](<${written}>)\n` },
  ];

  const asset = (relative: string): Asset => ({
    path: `${ROOT}/${relative}`,
    relative,
    extension: '.png',
    bytes: 1_000,
  });
  const read = (text: string, assets: readonly Asset[]) =>
    resolveReferences(markdownAdapter.findReferences({ file: PAGE, text }), {
      root: ROOT,
      assets,
      servingRoots: SERVING,
      exists: () => false,
    });

  function nameFor(random: () => number): string {
    const count = 1 + Math.floor(random() * 6);
    return Array.from(
      { length: count },
      () => PIECES[Math.floor(random() * PIECES.length)] ?? 'a',
    ).join('');
  }

  it('reads every origin in both forms before any move', () => {
    for (const { file, written } of ORIGINS) {
      for (const { page } of FORMS) {
        const found = read(page(written), [asset(file)]).flatMap(linkedPaths);
        expect(found, page(written)).toEqual([`${ROOT}/${file}`]);
      }
    }
  });

  it('writes a name with spaces, parentheses, % and & so that it reads back as the moved file', () => {
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const to = `public/img/${nameFor(seeded(round))}.png`;
      for (const { file, written } of ORIGINS) {
        for (const { form, page } of FORMS) {
          const text = page(written);
          const before = asset(file);
          const graph = buildGraph({
            root: ROOT,
            assets: [before],
            references: read(text, [before]),
            unscannedFiles: [],
          });
          const plan = planRelocation({
            graph,
            moves: [{ from: file, to }],
            servingRoots: SERVING,
            aliases: NO_ALIASES,
          });
          const rewritten = markdownAdapter.rewrite({ text, edits: plan.rewrites[0]?.edits ?? [] });
          const found = read(rewritten, [asset(to)]).flatMap(linkedPaths);
          if (found.length !== 1 || found[0] !== `${ROOT}/${to}`) {
            failures.push(`round ${round}, ${to} from ${written}, ${form}: ${rewritten.trim()}`);
          }
        }
      }
    }

    expect(failures.slice(0, 8)).toEqual([]);
  });
});
