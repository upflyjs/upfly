import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toPosix } from '../paths.js';
import type { Asset, BundlerContext, RawReference, Reference } from '../types.js';
import { type AliasMap, loadAliases } from './aliases.js';
import { isLinked, linkedPaths } from './reference.js';
import {
  CONVENTIONAL_SERVING_ROOTS,
  contextCouldTake,
  resolveReferences,
  resolveReferencesInSlices,
  servedFromAnyRoot,
} from './resolve.js';

/**
 * Every rung of the resolver's ladder exists because some real syntax would otherwise be
 * reported as `broken`. Most suites are named for the rung they test, numbered as in
 * `resolveOne`, so a failure says which rung is wrong. See "The resolver's seven outcomes"
 * in ARCHITECTURE.md.
 */

// Resolved rather than written literally: on Windows `path.resolve` qualifies a
// drive-less absolute path with the current drive, so a bare '/project' would not
// match the paths the resolver computes. `discover` always returns a resolved root.
const ROOT = resolve('/project');

function asset(relative: string): Asset {
  return {
    path: join(ROOT, relative),
    relative,
    extension: relative.slice(relative.lastIndexOf('.')).toLowerCase(),
    bytes: 100,
  };
}

const ASSETS: readonly Asset[] = [
  asset('src/assets/logo.png'),
  asset('src/assets/hero.jpg'),
  asset('src/images/one.png'),
  asset('src/images/two.png'),
  asset('src/images/three.png'),
  asset('src/images/nested/deep.png'),
  asset('public/banner.png'),
  asset('at-root.png'),
];

/** The default `exists` port: nothing exists beyond the asset set. */
const NOTHING_EXISTS = (): boolean => false;

function raw(overrides: Partial<RawReference> & { rawPath: string }): RawReference {
  return {
    file: join(ROOT, 'src', 'App.jsx'),
    start: 0,
    end: overrides.rawPath.length,
    kind: 'import',
    shape: 'html.img.src',
    ceiling: 'certain',
    asserted: true,
    ...overrides,
  };
}

/**
 * Assert the outcome and narrow to it in one step.
 *
 * `Reference` is a union, so `reference?.exclusionReason` does not typecheck until it is
 * narrowed. Reading a field the returned branch lacks gives `undefined`, which some
 * assertions accept, so a test could pass whatever the resolver did. Throwing here names
 * the resolution that came back.
 */
function expectResolution<K extends Reference['resolution']>(
  reference: Reference | undefined,
  resolution: K,
): Extract<Reference, { resolution: K }> {
  if (reference?.resolution !== resolution) {
    throw new Error(
      `expected resolution '${resolution}', got '${reference?.resolution ?? 'none'}'`,
    );
  }
  return reference as Extract<Reference, { resolution: K }>;
}

function resolveOne(overrides: Partial<RawReference> & { rawPath: string }): Reference | undefined {
  return resolveReferences([raw(overrides)], {
    root: ROOT,
    assets: ASSETS,
    servingRoots: CONVENTIONAL_SERVING_ROOTS,
    exists: NOTHING_EXISTS,
  })[0];
}

describe('resolveReferences', () => {
  describe('rung 0: a value an adapter declined is never looked up', () => {
    const declined = {
      kind: 'string',
      asserted: false,
      declined: true,
      note: 'JSX attribute title, which Upfly does not read as a file path on this element',
    } as const;

    it('is discarded with its reason when it names an image, even one that exists', () => {
      const reference = resolveOne({ ...declined, rawPath: './assets/logo.png', ceiling: 'high' });
      expect(reference?.resolution).toBe('discarded');
      expect(reference?.note).toBe(declined.note);
      expect(reference?.confidence).toBe('unsafe');
    });

    it('is never globbed, whatever its ceiling, so a pattern it spells links nothing', () => {
      // Above the ceiling rungs: a declined template globbed would link every file it
      // matches, a link no code makes.
      const reference = resolveOne({
        ...declined,
        rawPath: './images/${n}.png',
        ceiling: 'medium',
      });
      expect(reference?.resolution).toBe('discarded');
    });

    it('reads the path its text proves, in every spelling, for the image extension', () => {
      expect(
        resolveOne({
          ...declined,
          rawPath: "./images/' + n + '.png",
          assembledPath: './images/${}.png',
          ceiling: 'unsafe',
        })?.resolution,
      ).toBe('discarded');
      expect(
        resolveOne({ ...declined, rawPath: './hero%2Epng', ceiling: 'high' })?.resolution,
      ).toBe('discarded');
    });

    it('is dropped, as rung 3 drops a font, when no spelling shows an image extension', () => {
      expect(resolveOne({ ...declined, rawPath: '/files/a.pdf', ceiling: 'high' })).toBeUndefined();
    });
  });

  describe('rung 1: an unsafe ceiling is dynamic, never broken', () => {
    it.each([
      ['a preprocessor variable', '$hero'],
      ['an interpolated path', '#{$dir}/hero.png'],
      ['a template expression', '{{ image }}'],
      ['a path that does not exist either', './nowhere.png'],
    ])('%s', (_name, rawPath) => {
      const reference = resolveOne({ rawPath, ceiling: 'unsafe' });

      // Nobody typed a path that points at nothing, so this is never `broken`.
      expect(reference?.resolution).toBe('dynamic');
      expect(reference?.confidence).toBe('unsafe');
    });

    it('is decided before the extension filter, so an extensionless one survives', () => {
      // Filtering first would drop `url($hero)` silently, losing a reference the
      // user is explicitly told about as "could not safely rewrite".
      expect(resolveOne({ rawPath: '$hero', ceiling: 'unsafe' })?.resolution).toBe('dynamic');
    });
  });

  describe('rung 2: a medium ceiling is a pattern', () => {
    it('links every asset the pattern matches, not just the first', () => {
      // Linking only one would leave the other two looking unreferenced, which is a
      // false `dead asset` finding.
      const reference = resolveOne({ rawPath: './images/${name}.png', ceiling: 'medium' });

      expect(reference?.resolution).toBe('resolved-pattern');
      expect(linkedPaths(reference as Reference)).toEqual([
        join(ROOT, 'src/images/one.png'),
        join(ROOT, 'src/images/three.png'),
        join(ROOT, 'src/images/two.png'),
      ]);
    });

    it('keeps confidence at medium', () => {
      const reference = resolveOne({ rawPath: './images/${name}.png', ceiling: 'medium' });
      expect(reference?.confidence).toBe('medium');
    });

    it('globs the path a + chain assembles, never its quote-and-plus source text', () => {
      // Globbing the source text would match nothing and fall back to `dynamic`: the
      // ceiling right and the answer silently wrong.
      const reference = resolveOne({
        rawPath: "./images/' + name + '.png",
        assembledPath: './images/${}.png',
        ceiling: 'medium',
      });
      expect(reference?.resolution).toBe('resolved-pattern');
      expect(linkedPaths(reference as Reference)).toHaveLength(3);
    });

    it('reads a static extension off the assembled path when there is one', () => {
      // `${EXT}` hides the extension in the source; a same-file constant shows `.json`.
      expect(
        resolveOne({
          rawPath: '${DIR}/data${EXT}',
          assembledPath: '${}/data.json',
          ceiling: 'unsafe',
        }),
      ).toBeUndefined();
      expect(resolveOne({ rawPath: '${DIR}/data${EXT}', ceiling: 'unsafe' })?.resolution).toBe(
        'dynamic',
      );
    });

    it('is dynamic when nothing matches, never broken', () => {
      const reference = resolveOne({ rawPath: './nothing/${name}.png', ceiling: 'medium' });
      expect(reference?.resolution).toBe('dynamic');
    });

    it('does not let a hole cross a directory boundary', () => {
      // `[^/]*` rather than `.*`: the author wrote one segment, so matching
      // `nested/deep.png` would pull in an asset they never referred to.
      const reference = resolveOne({ rawPath: './images/${name}.png', ceiling: 'medium' });
      expect(linkedPaths(reference as Reference)).not.toContain(
        join(ROOT, 'src/images/nested/deep.png'),
      );
    });

    it('matches a pattern with a hole in the middle of a segment', () => {
      const reference = resolveOne({ rawPath: './images/t${rest}.png', ceiling: 'medium' });
      expect(linkedPaths(reference as Reference)).toEqual([
        join(ROOT, 'src/images/three.png'),
        join(ROOT, 'src/images/two.png'),
      ]);
    });

    it('handles a root-relative pattern', () => {
      const reference = resolveOne({ rawPath: '/${name}.png', ceiling: 'medium' });
      expect(linkedPaths(reference as Reference)).toEqual([join(ROOT, 'public/banner.png')]);
    });

    it('treats regex metacharacters in the static part literally', () => {
      const reference = resolveOne({ rawPath: './images/o+e.${ext}', ceiling: 'medium' });
      expect(reference?.resolution).toBe('dynamic');
    });
  });

  describe('rung 3: files we do not track are dropped, not reported', () => {
    it.each([
      ['a font', './inter.woff2'],
      ['a stylesheet', './styles.css'],
      ['a sibling module', './App.jsx'],
      ['a package', 'react'],
      ['a subpath import', 'next/image'],
      ['a video', './clip.mp4'],
    ])('%s produces no reference at all', (_name, rawPath) => {
      // Not a silent skip: it was never a candidate asset reference, and counting every
      // font in a stylesheet would be noise.
      expect(
        resolveReferences([raw({ rawPath })], {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        }),
      ).toEqual([]);
    });

    it('drops them before the broken test, which is the point', () => {
      // Below the rungs that turn a miss into a finding, the filter would let every
      // `url(inter.woff2)` be reported `broken`.
      const references = resolveReferences(
        [raw({ rawPath: './inter.woff2', kind: 'css-url' }), raw({ rawPath: './assets/logo.png' })],
        {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        },
      );
      expect(references.map((reference) => reference.resolution)).toEqual(['resolved']);
    });
  });

  describe('rung 4: resolution against the asset set', () => {
    it('resolves a relative path against the referencing file', () => {
      const reference = resolveOne({ rawPath: './assets/logo.png' });
      expect(reference?.resolution).toBe('resolved');
      expect(linkedPaths(reference as Reference)).toEqual([join(ROOT, 'src/assets/logo.png')]);
    });

    it('resolves a parent-relative path', () => {
      const reference = resolveOne({
        rawPath: '../public/banner.png',
        file: join(ROOT, 'src', 'App.jsx'),
      });
      expect(reference?.resolution).toBe('resolved');
    });

    it('resolves a root-relative path against the public directory', () => {
      const reference = resolveOne({ rawPath: '/banner.png' });
      expect(linkedPaths(reference as Reference)).toEqual([join(ROOT, 'public/banner.png')]);
    });

    it('falls back to the project root for a root-relative path', () => {
      // A plain static site serves `/at-root.png` from the root itself. Trying both can
      // only turn a false `broken` into a correct link, since the file has to be there
      // to match.
      const reference = resolveOne({ rawPath: '/at-root.png' });
      expect(linkedPaths(reference as Reference)).toEqual([join(ROOT, 'at-root.png')]);
    });

    it('tries every serving root a monorepo has', () => {
      // shadcn-ui has twelve `public/` directories and none at its workspace root, so a
      // file under `apps/v4/` has to resolve against its own app's.
      const monorepo = [asset('apps/v4/public/images/hero.png')];

      const [resolved] = resolveReferences(
        [raw({ rawPath: '/images/hero.png', file: join(ROOT, 'apps/v4/app/page.tsx') })],
        {
          root: ROOT,
          assets: monorepo,
          servingRoots: { declared: true, dirs: ['apps/www/public', 'apps/v4/public'] },
          exists: NOTHING_EXISTS,
        },
      );

      expect(resolved?.resolution).toBe('resolved');
    });

    it('prefers the serving root nearest the referencing file', () => {
      // Both exist and both match by name. A bundler serves the app the file belongs
      // to, and picking the other would rewrite the wrong asset, which nothing
      // downstream could catch.
      const monorepo = [asset('apps/v4/public/logo.png'), asset('apps/www/public/logo.png')];

      const [resolved] = resolveReferences(
        [raw({ rawPath: '/logo.png', file: join(ROOT, 'apps/v4/app/page.tsx') })],
        {
          root: ROOT,
          assets: monorepo,
          // Listed with the wrong one first: proximity decides precedence, not order in
          // the list.
          servingRoots: { declared: true, dirs: ['apps/www/public', 'apps/v4/public'] },
          exists: NOTHING_EXISTS,
        },
      );

      expect(resolved?.resolution === 'resolved' && toPosix(resolved.resolvedPath)).toBe(
        toPosix(join(ROOT, 'apps/v4/public/logo.png')),
      );
    });

    it('never links to a serving root that is not an ancestor', () => {
      // Trying more roots only turns a false `broken` into a correct link when every root
      // serves the same URL space, and a monorepo's do not. Linking a fixture app's
      // `/next.svg` to `apps/v4/public/next.svg` would point it at a file that app does
      // not serve, and a rewrite would follow the link.
      const monorepo = [asset('apps/v4/public/next.svg')];

      const [resolved] = resolveReferences(
        [raw({ rawPath: '/next.svg', file: join(ROOT, 'packages/fixtures/next-app/page.tsx') })],
        {
          root: ROOT,
          assets: monorepo,
          servingRoots: { declared: true, dirs: ['apps/v4/public'] },
          exists: NOTHING_EXISTS,
        },
      );

      // Broken is the honest answer: that app does not serve this URL. A false
      // `broken` costs a user five minutes; a false link costs them a broken build.
      expect(resolved?.resolution).toBe('broken');
    });

    it('honours a configured public directory', () => {
      const references = resolveReferences([raw({ rawPath: '/assets/logo.png' })], {
        root: ROOT,
        assets: ASSETS,
        servingRoots: { declared: true, dirs: ['src'] },
        exists: NOTHING_EXISTS,
      });
      expect(references[0]?.resolution).toBe('resolved');
    });

    it('keeps the ceiling as the final confidence', () => {
      expect(resolveOne({ rawPath: './assets/logo.png', ceiling: 'certain' })?.confidence).toBe(
        'certain',
      );
      expect(
        resolveOne({ rawPath: './assets/logo.png', ceiling: 'high', kind: 'attr' })?.confidence,
      ).toBe('high');
    });

    it('resolves a path carrying a query suffix', () => {
      const reference = resolveOne({ rawPath: './assets/logo.png' });
      expect(reference?.resolution).toBe('resolved');
    });

    it('resolves a bare relative path in CSS, where it is not a package name', () => {
      const reference = resolveOne({
        rawPath: 'assets/logo.png',
        kind: 'css-url',
        shape: 'html.img.src',
        file: join(ROOT, 'src', 'app.css'),
      });
      expect(reference?.resolution).toBe('resolved');
    });
  });

  describe('a `./` path meant relative to the project root', () => {
    it('lets a speculative dot-path fall back to the project root', () => {
      // astro-docs: `path: './src/pages/.../docs-logo.png'` in an object, handed to
      // a filesystem read where the cwd is the project root. Resolved against the
      // file it lands on `src/pages/open-graph/src/pages/...`, which is nowhere.
      const [resolved] = resolveReferences(
        [
          raw({
            rawPath: './src/assets/logo.png',
            file: join(ROOT, 'src/pages/deep/handler.ts'),
            asserted: false,
            ceiling: 'high',
          }),
        ],
        {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        },
      );

      expect(resolved?.resolution).toBe('resolved');
      // Recorded rather than re-derived: the planner must know this link is evidence the
      // asset is alive and not licence to rewrite the string, because the code may join
      // it to a different base. It is the weaker of the two root fallbacks, a guess at
      // the base of a string that was already a guess.
      expect(resolved?.resolution === 'resolved' && resolved.resolvedVia).toBe('speculative-root');
    });

    it('refuses the same fallback for an asserted import', () => {
      // In a module system `./` means file-relative. Falling back here would link a
      // broken import to an unrelated file, and a false link costs a broken build where
      // a false `broken` costs five minutes.
      const [resolved] = resolveReferences(
        [
          raw({
            rawPath: './src/assets/logo.png',
            file: join(ROOT, 'src/pages/deep/handler.ts'),
          }),
        ],
        {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        },
      );

      expect(resolved?.resolution).toBe('broken');
    });

    it('records how an ordinary relative reference resolved', () => {
      const reference = resolveOne({ rawPath: './assets/logo.png' });

      expect(reference?.resolution === 'resolved' && reference.resolvedVia).toBe('file');
    });

    it('records a serving-root resolution as one', () => {
      const [resolved] = resolveReferences([raw({ rawPath: '/banner.png' })], {
        root: ROOT,
        assets: ASSETS,
        servingRoots: { declared: true, dirs: ['public'] },
        exists: NOTHING_EXISTS,
      });

      expect(resolved?.resolution === 'resolved' && resolved.resolvedVia).toBe('serving-root');
    });

    it('records the project-root fallback for a root-relative path as one', () => {
      // `at-root.png` is not under `public/`, so no configured serving root has it
      // and the engine is guessing at the base.
      const [resolved] = resolveReferences([raw({ rawPath: '/at-root.png' })], {
        root: ROOT,
        assets: ASSETS,
        servingRoots: { declared: true, dirs: ['public'] },
        exists: NOTHING_EXISTS,
      });

      expect(resolved?.resolution === 'resolved' && resolved.resolvedVia).toBe('project-root');
    });

    it('tells the two root fallbacks apart', () => {
      // The root-relative fallback is usually `<img src="/favicon.png">` in hand-written
      // HTML, a file the site really serves from its root, while the speculative retry
      // is a guess on a guess. One value for both would forgo rewrites a static site can
      // safely take.
      const [rootRelative] = resolveReferences([raw({ rawPath: '/at-root.png' })], {
        root: ROOT,
        assets: ASSETS,
        servingRoots: { declared: true, dirs: ['public'] },
        exists: NOTHING_EXISTS,
      });
      const [speculative] = resolveReferences(
        [raw({ rawPath: './at-root.png', asserted: false, ceiling: 'high' })],
        {
          root: ROOT,
          assets: ASSETS,
          servingRoots: { declared: true, dirs: ['public'] },
          exists: NOTHING_EXISTS,
        },
      );

      const viaOf = (reference: Reference | undefined): string | null =>
        reference?.resolution === 'resolved' ? reference.resolvedVia : null;

      expect(viaOf(rootRelative)).toBe('project-root');
      expect(viaOf(speculative)).toBe('speculative-root');
      // The requirement is that the two differ. Pinning each name alone would still pass
      // after a change that merged them and updated both expectations.
      expect(viaOf(rootRelative)).not.toBe(viaOf(speculative));
    });
  });

  describe('rung 6: alias-shaped paths are their own bucket', () => {
    it.each([
      ['a webpack-style alias', '@/assets/logo.png'],
      ['a tilde alias', '~/assets/logo.png'],
      ['a subpath import alias', '#assets/logo.png'],
    ])('%s', (_name, rawPath) => {
      const reference = resolveOne({ rawPath });

      // `import logo from '@/assets/logo.png'` is everywhere in Next and Vite, so calling
      // it `broken` would put a false finding in nearly every such project.
      expect(reference?.resolution).toBe('unresolved-alias');
      expect(reference?.confidence).toBe('unsafe');
    });

    it.each([
      ['a scoped package asset', '@scope/pkg/logo.png', 'attr'],
      ['a bare specifier in an import', 'some-pkg/logo.png', 'import'],
    ])('%s is out-of-scope, not unresolved-alias', (_name, rawPath, kind) => {
      // A package's files live in `node_modules`, which the walk prunes, so no alias
      // config will ever resolve them: `out-of-scope` means known, and known not to be an
      // indexed asset. Both carry a subpath after the package name, which is what makes
      // "names a file inside an npm package" true. `@missing/astro.png` has none and is
      // tested below.
      const reference = resolveOne({ rawPath, kind: kind as 'attr' | 'import' });

      expect(reference?.resolution).toBe('out-of-scope');
      expect(reference?.confidence).toBe('unsafe');
      expect(reference?.resolution === 'out-of-scope' ? reference.exclusionReason : null).toContain(
        'npm package',
      );
    });

    /**
     * `out-of-scope` would be a false claim here. Its reason says the path names a file
     * inside an npm package, and `@missing/astro.png` is a scope and a name with no
     * subpath for that to be about. `unresolved-alias` claims only what is known: the path
     * is alias-shaped and no declared alias maps it.
     */
    it.each([
      ['a scope and a name, no subpath', '@missing/astro.png', 'import'],
      ['the same as a plain string', '@missing/paths.png', 'string'],
    ])('%s is unresolved-alias, not a package', (_name, rawPath, kind) => {
      const reference = resolveOne({ rawPath, kind: kind as 'import' | 'string' });

      expect(reference?.resolution).toBe('unresolved-alias');
    });

    it.each([
      ['an import', 'js.import.static', '$lib/assets/logo.png'],
      ['a require()', 'js.require', '$lib/icons/x.png'],
    ] as const)(
      'reads a specifier that starts with $ as an alias, since no npm package name can: %s',
      (_name, shape, rawPath) => {
        // npm refuses a name that `encodeURIComponent` changes, and it changes `$`, so
        // SvelteKit's `$lib/…` names an alias, never a file inside a package.
        expect(resolveOne({ rawPath, kind: 'import', shape })?.resolution).toBe('unresolved-alias');
      },
    );

    it('an ordinary package import never reaches this question at all', () => {
      // `import x from '@scope/pkg'` produces no reference: rung 3 drops an extensionless
      // path long before the package-or-alias question. So requiring a subpath cannot
      // reclassify ordinary scoped imports; they never reach this bucket.
      expect(resolveOne({ rawPath: '@scope/pkg', kind: 'import' })).toBeUndefined();
    });

    it('still calls a scoped package with a subpath out-of-scope', () => {
      // The control, in the other direction. A rule that stopped claiming every
      // `@scope/…` would pass the cases above and silently give up the bucket entirely.
      const reference = resolveOne({
        rawPath: '@11ty/logo/img/logo-96x96.png',
        kind: 'import',
      });

      expect(reference?.resolution).toBe('out-of-scope');
    });

    it('keeps the alias conventions out of the package bucket (the control)', () => {
      // The converse of the test above, and the reason it is not enough on its own:
      // `@/…` and `@scope/…` differ by one character, and a test that only checked
      // the package side would pass with a rule that swallowed every `@` path.
      for (const rawPath of ['@/assets/logo.png', '~/assets/logo.png', '#assets/logo.png']) {
        expect(resolveOne({ rawPath, kind: 'import' })?.resolution).toBe('unresolved-alias');
      }
    });

    it('does not treat a bare path in CSS as alias-shaped', () => {
      // In a stylesheet this is an ordinary relative path that points at nothing.
      const reference = resolveOne({ rawPath: 'missing/logo.png', kind: 'css-url' });
      expect(reference?.resolution).toBe('broken');
    });
  });

  describe('rung 5: a path into an excluded directory is out-of-scope, not broken', () => {
    const EXCLUDED = [
      {
        path: join(ROOT, 'legacy'),
        relative: 'legacy',
        reason: "the ignore rule 'legacy/'",
        byRule: true,
      },
      {
        path: join(ROOT, 'old site'),
        relative: 'old site',
        reason: "the ignore rule 'old site/'",
        byRule: true,
      },
    ];

    function resolveWithExclusions(
      rawPath: string,
      exists: (path: string) => boolean = () => false,
      kind: RawReference['kind'] = 'css-url',
    ) {
      return resolveReferences([raw({ rawPath, kind })], {
        root: ROOT,
        assets: ASSETS,
        servingRoots: CONVENTIONAL_SERVING_ROOTS,
        excludedRoots: EXCLUDED,
        exists,
      })[0];
    }

    it('names the rule that excluded the target', () => {
      // The user ignored `legacy/` and still references it. The file is there, so a
      // `broken` finding would be false.
      const reference = resolveWithExclusions('../legacy/old.png');

      expect(expectResolution(reference, 'out-of-scope').exclusionReason).toBe(
        "the ignore rule 'legacy/'",
      );
    });

    it('knows exactly where it points', () => {
      const reference = resolveWithExclusions('../legacy/old.png');
      expect(expectResolution(reference, 'out-of-scope').resolvedPath).toBe(
        toPosix(join(ROOT, 'legacy/old.png')),
      );
    });

    it('is never linked, so it cannot be rewritten and cannot be a dead asset', () => {
      const reference = resolveWithExclusions('../legacy/old.png') as Reference;
      expect(isLinked(reference)).toBe(false);
      expect(linkedPaths(reference)).toEqual([]);
      expect(reference.confidence).toBe('unsafe');
    });

    it('falls back to the filesystem for a file-level ignore rule', () => {
      // `*.png` in .upflyignore excludes a file without pruning any directory, so
      // there is no excluded root to match. The file is still sitting right there.
      const target = toPosix(join(ROOT, 'src/hidden.png'));
      const reference = resolveWithExclusions('./hidden.png', (path) => path === target);

      expect(expectResolution(reference, 'out-of-scope').exclusionReason).toBe(
        'resolved outside the indexed asset set',
      );
    });

    it('is still broken when the file genuinely is not there', () => {
      expect(resolveWithExclusions('./nowhere.png')?.resolution).toBe('broken');
    });

    const cafe = `caf${String.fromCodePoint(0xe9)}.png`;
    it.each([
      ['percent-encoding', './hidden%20image.png', 'css-url', 'src/hidden image.png'],
      ['a character reference', './caf&eacute;.png', 'attr', `src/${cafe}`],
      // Only a Markdown destination reads a backslash escape, so this one also needs the kind.
      ['a Markdown escape', './hidden\\_x.png', 'md', 'src/hidden_x.png'],
    ] as const)('finds an ignored file spelled with %s', (_name, rawPath, kind, onDisk) => {
      const target = toPosix(join(ROOT, onDisk));
      const reference = resolveWithExclusions(rawPath, (path) => path === target, kind);

      const excluded = expectResolution(reference, 'out-of-scope');
      expect(excluded.resolvedPath).toBe(target);
      expect(excluded.exclusionReason).toBe('resolved outside the indexed asset set');
    });

    it('finds an excluded directory whose name the path writes percent-encoded', () => {
      const reference = resolveWithExclusions('../old%20site/logo.png');

      const excluded = expectResolution(reference, 'out-of-scope');
      expect(excluded.exclusionReason).toBe("the ignore rule 'old site/'");
      expect(excluded.resolvedPath).toBe(toPosix(join(ROOT, 'old site/logo.png')));
    });

    it('consults the filesystem only for a reference about to be called broken', () => {
      // The two references that resolve never reach the disk.
      const asked: string[] = [];
      resolveReferences(
        [
          raw({ rawPath: './assets/logo.png' }),
          raw({ rawPath: './assets/hero.jpg' }),
          raw({ rawPath: './missing.png' }),
        ],
        {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: (path) => {
            asked.push(path);
            return false;
          },
        },
      );

      expect(asked).toEqual([toPosix(join(ROOT, 'src/missing.png'))]);
    });

    it('asks once per spelling of an encoded path, the path as written first', () => {
      const asked: string[] = [];
      resolveReferences([raw({ rawPath: './missing%20photo.png' })], {
        root: ROOT,
        assets: ASSETS,
        servingRoots: CONVENTIONAL_SERVING_ROOTS,
        exists: (path) => {
          asked.push(path);
          return false;
        },
      });

      expect(asked).toEqual([
        toPosix(join(ROOT, 'src/missing%20photo.png')),
        toPosix(join(ROOT, 'src/missing photo.png')),
      ]);
    });

    it('takes precedence over the alias bucket', () => {
      // In a stylesheet, where the text is a path: an import's is a module name instead.
      const reference = resolveReferences(
        [
          raw({
            rawPath: '@/legacy/old.png',
            kind: 'css-url',
            file: join(ROOT, 'src', 'app.css'),
          }),
        ],
        {
          root: ROOT,
          assets: ASSETS,
          excludedRoots: EXCLUDED,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: (path) => path === toPosix(join(ROOT, 'src/@/legacy/old.png')),
        },
      )[0];

      expect(reference?.resolution).toBe('out-of-scope');
    });
  });

  /**
   * `C:/site/hero.png` names a file by where it sits on one machine's disk. Outside the
   * project it is out of scope, decided without asking this machine's disk, so the report
   * is the same on every machine; inside it, on Windows, it is looked up like any path.
   */
  describe('a Windows drive path', () => {
    const onWindows = process.platform === 'win32';
    // On Windows the project's own drive, so only the directories put the path outside it.
    const drive = onWindows ? ROOT.slice(0, 2) : 'C:';
    const outside = `${drive}/elsewhere/logo.png`;

    it.each([
      ['an attribute', 'attr'],
      ['an import, where it is not a package or an alias', 'import'],
      ['a guessed string', 'string'],
    ] as const)('is out of scope outside the project, in %s', (_name, kind) => {
      const reference = expectResolution(resolveOne({ rawPath: outside, kind }), 'out-of-scope');

      expect(reference.exclusionReason).toMatch(/outside the project/);
      expect(reference.resolvedPath).toBe(outside);
    });

    it('reads backslashes as separators', () => {
      const rawPath = `${drive}\\elsewhere\\logo.png`;
      const reference = expectResolution(resolveOne({ rawPath, kind: 'attr' }), 'out-of-scope');

      expect(reference.resolvedPath).toBe(outside);
    });

    it('asks the disk nothing about a file outside the project', () => {
      const asked: string[] = [];
      resolveReferences([raw({ rawPath: outside, kind: 'attr' })], {
        root: ROOT,
        assets: ASSETS,
        servingRoots: CONVENTIONAL_SERVING_ROOTS,
        exists: (path) => {
          asked.push(path);
          return true;
        },
      });

      expect(asked).toEqual([]);
    });

    it.skipIf(!onWindows)('resolves one inside the project to its asset, however spelled', () => {
      const lowercaseDrive = `${ROOT.charAt(0).toLowerCase()}${ROOT.slice(1)}`;
      for (const rawPath of [
        `${toPosix(ROOT)}/src/assets/logo.png`,
        join(ROOT, 'src', 'assets', 'logo.png'),
        `${toPosix(lowercaseDrive)}/src/assets/logo.png`,
      ]) {
        const reference = expectResolution(resolveOne({ rawPath, kind: 'attr' }), 'resolved');
        expect(reference.resolvedPath, rawPath).toBe(join(ROOT, 'src/assets/logo.png'));
      }
    });

    it.skipIf(!onWindows)('is broken inside the project when the file is not there', () => {
      const rawPath = `${toPosix(ROOT)}/src/assets/gone.png`;
      // In an import too, where a drive path is neither a package nor an alias.
      for (const kind of ['attr', 'import'] as const) {
        expect(resolveOne({ rawPath, kind })?.resolution, kind).toBe('broken');
      }
    });
  });

  describe('a Markdown destination with backslash escapes', () => {
    // CommonMark removes a backslash before ASCII punctuation in a destination. Read as
    // written on Windows, `logo\.png` would not even show its extension.
    it.each([
      ['an escaped hyphen', '../at\\-root.png', 'at-root.png'],
      ['an escaped dot', './assets/logo\\.png', 'src/assets/logo.png'],
    ])('is looked up as CommonMark reads %s', (_name, rawPath, target) => {
      const reference = expectResolution(
        resolveOne({ rawPath, kind: 'md', shape: 'md.image', ceiling: 'high' }),
        'resolved',
      );

      expect(reference.resolvedPath).toBe(join(ROOT, target));
      expect(reference.spelling).toBe('markdown-escapes');
      expect(reference.rawPath).toBe(rawPath);
    });

    it('reads no escape outside Markdown, where a backslash is not one', () => {
      const reference = resolveOne({ rawPath: '../at\\-root.png', kind: 'attr', ceiling: 'high' });
      expect(reference?.resolution).toBe('broken');
    });
  });

  describe('a numeric reference to a number that is no character', () => {
    // CommonMark and HTML both read these as U+FFFD, so the file's name holds that character.
    const replaced = asset(`src/images/a${String.fromCodePoint(0xfffd)}b.png`);

    it.each([
      ['zero', './images/a&#0;b.png'],
      ['a surrogate', './images/a&#xD800;b.png'],
    ])('finds the file named with U+FFFD for a reference to %s', (_name, rawPath) => {
      const [found] = resolveReferences(
        [raw({ rawPath, kind: 'md', shape: 'md.image', ceiling: 'high' })],
        {
          root: ROOT,
          assets: [...ASSETS, replaced],
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        },
      );
      const reference = expectResolution(found, 'resolved');

      expect(reference.resolvedPath).toBe(replaced.path);
      expect(reference.spelling).toBe('html-entities');
    });
  });

  describe('rung 7: an asserted literal path that points at nothing is broken', () => {
    it('reports a missing relative path', () => {
      const reference = resolveOne({ rawPath: './assets/missing.png' });
      expect(reference?.resolution).toBe('broken');
      expect(reference?.confidence).toBe('unsafe');
    });

    it('reports a missing root-relative path', () => {
      expect(resolveOne({ rawPath: '/missing.png' })?.resolution).toBe('broken');
    });

    it('catches a hallucinated path, which is the feature', () => {
      const reference = resolveOne({ rawPath: './assets/logo-final-v2.png' });
      expect(reference?.resolution).toBe('broken');
    });
  });

  describe('rung 8: an unresolved speculative candidate is discarded', () => {
    it('discards a path-shaped string from JSON', () => {
      const reference = resolveOne({
        rawPath: './icons/nope.png',
        kind: 'json',
        shape: 'html.img.src',
        asserted: false,
        file: join(ROOT, 'package.json'),
      });

      expect(reference?.resolution).toBe('discarded');
    });

    it('resolves a speculative candidate that does point at an asset', () => {
      const reference = resolveOne({
        rawPath: './assets/logo.png',
        kind: 'json',
        shape: 'html.img.src',
        asserted: false,
      });
      expect(reference?.resolution).toBe('resolved');
    });

    it('never turns a speculative candidate into a broken finding', () => {
      const references = resolveReferences(
        [
          raw({ rawPath: './a.png', asserted: false, kind: 'json' }),
          raw({ rawPath: './b.png', asserted: false, kind: 'json' }),
        ],
        {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        },
      );
      expect(references.every((reference) => reference.resolution === 'discarded')).toBe(true);
    });
  });

  describe('isLinked and linkedPaths', () => {
    it('treats both linked outcomes as linked', () => {
      const single = resolveOne({ rawPath: './assets/logo.png' }) as Reference;
      const pattern = resolveOne({
        rawPath: './images/${name}.png',
        ceiling: 'medium',
      }) as Reference;

      expect(isLinked(single)).toBe(true);
      expect(isLinked(pattern)).toBe(true);
    });

    it('treats every unresolved outcome as unlinked', () => {
      for (const reference of [
        resolveOne({ rawPath: './missing.png' }),
        resolveOne({ rawPath: '$x', ceiling: 'unsafe' }),
        resolveOne({ rawPath: '@/x.png' }),
        resolveOne({ rawPath: './missing.png', asserted: false }),
      ]) {
        expect(isLinked(reference as Reference)).toBe(false);
        expect(linkedPaths(reference as Reference)).toEqual([]);
      }
    });

    it('would have hidden every pattern reference from a hand-written check', () => {
      // The reason isLinked exists: this comparison compiles, runs, and is wrong.
      const pattern = resolveOne({
        rawPath: './images/${name}.png',
        ceiling: 'medium',
      }) as Reference;

      expect(pattern.resolution === 'resolved').toBe(false);
      expect(isLinked(pattern)).toBe(true);
    });
  });

  describe('is pure and deterministic', () => {
    it('returns the same result for the same input', () => {
      const input = [raw({ rawPath: './assets/logo.png' }), raw({ rawPath: './missing.png' })];
      expect(
        resolveReferences(input, {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        }),
      ).toEqual(
        resolveReferences(input, {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        }),
      );
    });

    it('preserves input order', () => {
      const references = resolveReferences(
        [
          raw({ rawPath: './assets/logo.png' }),
          raw({ rawPath: './missing.png' }),
          raw({ rawPath: './assets/hero.jpg' }),
        ],
        {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        },
      );
      expect(references.map((reference) => reference.rawPath)).toEqual([
        './assets/logo.png',
        './missing.png',
        './assets/hero.jpg',
      ]);
    });

    it('orders pattern matches deterministically', () => {
      const shuffled = [...ASSETS].reverse();
      const a = resolveReferences([raw({ rawPath: './images/${n}.png', ceiling: 'medium' })], {
        root: ROOT,
        assets: ASSETS,
        servingRoots: CONVENTIONAL_SERVING_ROOTS,
        exists: NOTHING_EXISTS,
      });
      const b = resolveReferences([raw({ rawPath: './images/${n}.png', ceiling: 'medium' })], {
        root: ROOT,
        assets: shuffled,
        servingRoots: CONVENTIONAL_SERVING_ROOTS,
        exists: NOTHING_EXISTS,
      });
      expect(linkedPaths(a[0] as Reference)).toEqual(linkedPaths(b[0] as Reference));
    });

    it('carries the raw reference through unchanged', () => {
      const reference = resolveOne({ rawPath: './assets/logo.png', note: 'static import' });
      expect(reference?.note).toBe('static import');
      expect(reference?.kind).toBe('import');
      expect(reference?.asserted).toBe(true);
    });

    it('handles an empty input', () => {
      expect(
        resolveReferences([], {
          root: ROOT,
          assets: ASSETS,
          servingRoots: CONVENTIONAL_SERVING_ROOTS,
          exists: NOTHING_EXISTS,
        }),
      ).toEqual([]);
    });

    it('handles a project with no assets', () => {
      const references = resolveReferences([raw({ rawPath: './assets/logo.png' })], {
        root: ROOT,
        assets: [],
        servingRoots: CONVENTIONAL_SERVING_ROOTS,
        exists: NOTHING_EXISTS,
      });
      expect(references[0]?.resolution).toBe('broken');
    });
  });

  describe('a dynamic path whose static suffix rules out an image', () => {
    /**
     * A dynamic path whose visible extension is not an image needs no resolution to rule
     * out. It is dropped as rung 3 drops `url(inter.woff2)`: it was never a candidate
     * asset, so dropping it is not a silent skip, and listing it would fill the report's
     * "could not safely rewrite" list with source files.
     */

    it.each([
      'components/ui/${name}.tsx',
      'registry/${style}/${name}.json',
      '${siteConfig.url}/rss.xml',
      'src/${dir}/notes.md',
      'backup/${name}.bak',
    ])('drops %s', (rawPath) => {
      expect(resolveOne({ rawPath, ceiling: 'medium' })).toBeUndefined();
    });

    it.each(['images/${name}.png', '{{ site.url }}/img/hero.jpg', './assets/${slug}.svg'])(
      'keeps %s, which could still be an asset',
      (rawPath) => {
        // Not asserted as `dynamic`: `images/${name}.png` matches three of `ASSETS` and
        // comes back `resolved-pattern`, a better outcome. What matters is that each
        // survives.
        expect(resolveOne({ rawPath, ceiling: 'medium' })).toBeDefined();
      },
    );

    it('keeps a path with no static extension at all: unknown is not ruled out', () => {
      // `/view/${style}/${name}` shows nothing, so nothing can be concluded. It is
      // counted rather than listed by the report, but it must survive resolution.
      expect(resolveOne({ rawPath: '/view/${style}/${name}', ceiling: 'medium' })?.resolution).toBe(
        'dynamic',
      );
    });

    it('keeps a hole that is the extension', () => {
      // `hero.${ext}` could be `hero.png`. Ruling it out on the strength of `.*`
      // would be the over-fix, and it is the one this rule is closest to.
      expect(resolveOne({ rawPath: 'hero.${ext}', ceiling: 'medium' })?.resolution).toBe('dynamic');
    });

    // The hole's own text is not the extension, whichever syntax wrote it: read that way,
    // `.@{ext}` and `.<%= ext %>` rule out an image and the reference vanishes.
    it.each([
      ['{{ ext }}', 'unsafe'],
      ['{% ext %}', 'unsafe'],
      ['<%= ext %>', 'unsafe'],
      ['${ext}', 'medium'],
      ['#{$ext}', 'medium'],
      ['@{ext}', 'medium'],
    ] as const)(
      'keeps the reference when %s fills the extension, with the ceiling %s',
      (hole, ceiling) => {
        expect(resolveOne({ rawPath: `/img/masthead.${hole}`, ceiling })?.resolution).toBe(
          'dynamic',
        );
      },
    );

    it('keeps a path that is one hole with a dot inside it', () => {
      expect(resolveOne({ rawPath: '<%= user.avatar %>', ceiling: 'unsafe' })?.resolution).toBe(
        'dynamic',
      );
    });

    it('does not swallow url($hero), which is what pins rung 3 in place', () => {
      // Why this is a separate check rather than rung 3 moved up the ladder: `$hero` has
      // no static extension, so it is unknown rather than ruled out, and must still be
      // reported as `dynamic`.
      expect(resolveOne({ rawPath: '$hero', ceiling: 'unsafe' })?.resolution).toBe('dynamic');
    });
  });
});

describe('serving roots carry where they came from', () => {
  it('marks the convention guess as undeclared', () => {
    // If this ever flips to true, every policy keyed on whether the project declared
    // a serving root silently changes meaning, and nothing else would notice.
    expect(CONVENTIONAL_SERVING_ROOTS.declared).toBe(false);
    expect([...CONVENTIONAL_SERVING_ROOTS.dirs]).toEqual(['public']);
  });

  it('resolves against the guess exactly as it would against a declaration', () => {
    // The provenance changes what a consumer may conclude, never where a path lands.
    const guessed = resolveReferences([raw({ rawPath: '/logo.png' })], {
      root: ROOT,
      assets: ASSETS,
      servingRoots: CONVENTIONAL_SERVING_ROOTS,
      exists: NOTHING_EXISTS,
    });
    const declared = resolveReferences([raw({ rawPath: '/logo.png' })], {
      root: ROOT,
      assets: ASSETS,
      servingRoots: { dirs: ['public'], declared: true },
      exists: NOTHING_EXISTS,
    });

    expect(guessed).toEqual(declared);
  });
});

describe('files outside the assets, for a caller that can find them', () => {
  // The planner asks where a path would lead among every file on disk. A file the walk did
  // not index is found where the index misses, in the order the resolver looks.
  const roots = { dirs: ['public', 'apps/web/public'], declared: true };
  const page = { file: join(ROOT, 'apps/web/src/App.jsx'), kind: 'attr' } as const;
  const nearer = join(ROOT, 'apps/web/public/logo.png');

  it('finds one in a nearer serving root before an asset further away', () => {
    const [reference] = resolveReferences([raw({ rawPath: '/logo.png', ...page })], {
      root: ROOT,
      assets: [asset('public/logo.png')],
      servingRoots: roots,
      exists: NOTHING_EXISTS,
      unindexed: (path) => (path === toPosix(nearer) ? nearer : null),
    });

    expect(expectResolution(reference, 'resolved').resolvedPath).toBe(nearer);
  });

  it('is asked only where the index misses, so an asset in the same place wins', () => {
    const asked: string[] = [];
    const [reference] = resolveReferences([raw({ rawPath: '/logo.png', ...page })], {
      root: ROOT,
      assets: [asset('apps/web/public/logo.png')],
      servingRoots: roots,
      exists: NOTHING_EXISTS,
      unindexed: (path) => {
        asked.push(path);
        return path;
      },
    });

    expect(expectResolution(reference, 'resolved').resolvedPath).toBe(nearer);
    expect(asked).toEqual([]);
  });
});

describe('an index that folds case, for a caller asking what Windows and macOS would find', () => {
  const options = {
    root: ROOT,
    assets: [asset('public/IMG/Logo.png'), asset('public/icons/Star.png')],
    servingRoots: { dirs: ['public'], declared: true },
    exists: NOTHING_EXISTS,
  };

  it('finds a file whose name and folder differ from the path only in case', () => {
    const [folded] = resolveReferences([raw({ rawPath: '/img/logo.png', kind: 'attr' })], {
      ...options,
      foldCase: true,
    });
    const [exact] = resolveReferences([raw({ rawPath: '/img/logo.png', kind: 'attr' })], options);

    expect(expectResolution(folded, 'resolved').resolvedPath).toBe(
      join(ROOT, 'public/IMG/Logo.png'),
    );
    expect(exact?.resolution).toBe('broken');
  });

  it('matches a pattern whatever the case', () => {
    const pattern = raw({ rawPath: '/ICONS/${name}.png', kind: 'attr', ceiling: 'medium' });
    const [folded] = resolveReferences([pattern], { ...options, foldCase: true });
    const [exact] = resolveReferences([pattern], options);

    expect(linkedPaths(expectResolution(folded, 'resolved-pattern'))).toEqual([
      join(ROOT, 'public/icons/Star.png'),
    ]);
    expect(exact?.resolution).toBe('dynamic');
  });
});

/**
 * A `medium` ceiling on a SCSS or Less path helps only if the glob treats `#{…}` and
 * `@{…}` as holes, as it does `${…}`. Otherwise the path is matched literally, finds
 * nothing and falls back to `dynamic`, and the ceiling has no effect.
 */
describe('the glob understands all three interpolation syntaxes', () => {
  it.each([
    ['JavaScript', './images/${name}.png'],
    ['SCSS', './images/#{$name}.png'],
    ['Less', './images/@{name}.png'],
  ])('%s', (_name, rawPath) => {
    const reference = resolveOne({ rawPath, ceiling: 'medium' });

    // one.png, two.png and three.png, all three. Linking only the first would leave the
    // rest looking unreferenced, which is a false `dead asset` finding.
    expect(reference?.resolution).toBe('resolved-pattern');
    expect(reference?.resolution === 'resolved-pattern' ? reference.resolvedPaths.length : 0).toBe(
      3,
    );
  });

  it('falls back to dynamic when the pattern names nothing, never broken', () => {
    // A `medium` reference can only gain links or stay `dynamic`. It never becomes a
    // `broken` finding about a path the author did not write.
    const reference = resolveOne({ rawPath: './nothing/#{$x}.png', ceiling: 'medium' });

    expect(reference?.resolution).toBe('dynamic');
  });
});

describe('servedFromAnyRoot: the glob, from a serving root the run did not find', () => {
  it('matches from any directory, the project root included, without the query', () => {
    const couldName = servedFromAnyRoot('/img/pattern-${n}.png?v=2');

    expect(
      ['img/pattern-1.png', 'src/img/pattern-2.png', 'a/b/img/pattern-3.png'].map(couldName),
    ).toEqual([true, true, true]);
  });

  it('keeps every directory the pattern fixes, in whole segments', () => {
    const couldName = servedFromAnyRoot('/img/pattern-${n}.png');

    // Outside `img/`, a level too deep for the hole, and a directory that only ends in `img`.
    expect(
      ['src/pattern-1.png', 'src/img/deep/pattern-1.png', 'src/svgimg/pattern-1.png'].map(
        couldName,
      ),
    ).toEqual([false, false, false]);
  });

  it('reads every interpolation syntax the resolver globs, and ignores case', () => {
    expect(servedFromAnyRoot('/img/tile-#{$n}.png')('src/img/tile-1.png')).toBe(true);
    expect(servedFromAnyRoot('/IMG/Tile-@{n}.PNG')('src/img/tile-1.png')).toBe(true);
  });
});

describe('rung 2 through a declared alias', () => {
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
  const assets = [
    asset('src/img/alias-1.png'),
    asset('src/img/alias-2.png'),
    asset('src/icons/alias-1.png'),
    asset('other/img/alias-3.png'),
  ];

  function throughAlias(
    overrides: Partial<RawReference> & { rawPath: string },
    options: { readonly extra?: readonly Asset[]; readonly map?: AliasMap } = {},
  ): Reference | undefined {
    return resolveReferences([raw({ ceiling: 'medium', ...overrides })], {
      root: ROOT,
      assets: [...assets, ...(options.extra ?? [])],
      servingRoots: CONVENTIONAL_SERVING_ROOTS,
      aliases: options.map ?? aliases,
      exists: NOTHING_EXISTS,
    })[0];
  }

  it('globs a pattern through a declared alias, as a literal path through it resolves', () => {
    const found = expectResolution(
      throughAlias({ rawPath: '@/img/alias-${n}.png' }),
      'resolved-pattern',
    );

    // Anchored at the expansion: `src/icons/` fixes another directory, and `other/img/`
    // ends in the same segments under another base.
    expect(linkedPaths(found)).toEqual([
      join(ROOT, 'src/img/alias-1.png'),
      join(ROOT, 'src/img/alias-2.png'),
    ]);
    expect(found.resolvedVia).toBe('serving-root');
    expect(found.confidence).toBe('medium');
  });

  it('globs the path a + chain proves through the alias', () => {
    const found = throughAlias({
      rawPath: "@/img/alias-' + n + '.png",
      assembledPath: '@/img/alias-${}.png',
      kind: 'string',
      asserted: false,
    });

    expect(found && isLinked(found) ? linkedPaths(found) : []).toEqual([
      join(ROOT, 'src/img/alias-1.png'),
      join(ROOT, 'src/img/alias-2.png'),
    ]);
  });

  it('prefers a file at the written path to the alias, where the text is a path', () => {
    // A folder named `@` beside the file is what the text names first, as rung 4 prefers
    // a file at the written path to any mapping.
    const extra = [asset('src/@/img/alias-9.png')];
    const found = expectResolution(
      throughAlias({ rawPath: '@/img/alias-${n}.png', kind: 'attr' }, { extra }),
      'resolved-pattern',
    );

    expect(linkedPaths(found)).toEqual([join(ROOT, 'src/@/img/alias-9.png')]);
    expect(found.resolvedVia).toBe('file');
    // In an import the text is a module name, which is never looked for beside the module.
    const imported = expectResolution(
      throughAlias({ rawPath: '@/img/alias-${n}.png' }, { extra }),
      'resolved-pattern',
    );
    expect(linkedPaths(imported)).toEqual([
      join(ROOT, 'src/img/alias-1.png'),
      join(ROOT, 'src/img/alias-2.png'),
    ]);
  });

  it('does not glob through an alias whose scope does not cover the file', () => {
    const [rule] = aliases.rules;
    if (rule === undefined) throw new Error('the alias map lost its rule');
    const elsewhere: AliasMap = {
      rules: [{ ...rule, scope: toPosix(join(ROOT, 'other')) }],
      skipped: [],
    };

    // For this file no rule maps `@/`, so the pattern is unresolved, as a literal path is.
    expect(throughAlias({ rawPath: '@/img/alias-${n}.png' }, { map: elsewhere })?.resolution).toBe(
      'unresolved-alias',
    );
  });

  it('leaves a pattern that starts with a hole to the ladder', () => {
    // An alias prefix is fixed text, and the text a hole stands for is unknown.
    expect(throughAlias({ rawPath: '${base}/img/alias-${n}.png' })?.resolution).toBe('dynamic');
  });

  it('calls a pattern through an alias no rule covers unresolved-alias', () => {
    // As rung 6 calls a literal path through it: a config Upfly did not read may map it.
    expect(throughAlias({ rawPath: '~/img/alias-${n}.png' })?.resolution).toBe('unresolved-alias');
    expect(
      throughAlias({
        rawPath: "~/img/alias-' + n + '.png",
        assembledPath: '~/img/alias-${}.png',
        kind: 'string',
        asserted: false,
      })?.resolution,
    ).toBe('unresolved-alias');
  });

  it('calls a $ pattern no rule covers unresolved-alias, as it does a $ path', () => {
    // Read from the fixed text: `$lib` is written there, while `${base}` is a hole.
    expect(throughAlias({ rawPath: '$lib/img/alias-${n}.png' })?.resolution).toBe(
      'unresolved-alias',
    );
  });

  it('keeps a pattern dynamic when a rule covers its alias and the glob names nothing', () => {
    expect(throughAlias({ rawPath: '@/img/missing-${n}.png' })?.resolution).toBe('dynamic');
  });

  it('keeps a package-shaped pattern dynamic', () => {
    expect(throughAlias({ rawPath: '@scope/pkg/img/icon-${n}.png' })?.resolution).toBe('dynamic');
    expect(throughAlias({ rawPath: 'some-pkg/img/icon-${n}.png' })?.resolution).toBe('dynamic');
  });

  it('reads no alias into a leading hole, even through a rule for every bare path', () => {
    // A `"*"` key maps every bare specifier, and a pattern that starts with a hole has no
    // fixed start for it to map.
    const everyPath: AliasMap = {
      rules: [
        {
          prefix: '',
          targets: [join(ROOT, 'types')],
          wildcard: true,
          scope: toPosix(ROOT),
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      skipped: [],
    };

    expect(
      throughAlias(
        { rawPath: '${base}/img/alias-${n}.png' },
        { map: everyPath, extra: [asset('types/lib/img/alias-5.png')] },
      )?.resolution,
    ).toBe('dynamic');
  });

  it('globs through a key with text after its *, which the target keeps', async () => {
    const map = await loadAliases({
      root: ROOT,
      files: [{ path: toPosix(join(ROOT, 'tsconfig.json')), relative: 'tsconfig.json' }],
      readFile: async () =>
        '{ "compilerOptions": { "paths": { "@icons/*.svg": ["./src/icons/*.svg"] } } }',
      isFile: () => false,
    });
    const extra = [
      asset('src/icons/star.svg'),
      asset('src/icons/moon.svg'),
      asset('src/icons/star.png'),
    ];

    const found = expectResolution(
      throughAlias({ rawPath: '@icons/${name}.svg' }, { map, extra }),
      'resolved-pattern',
    );
    expect(found.resolvedPaths).toEqual([
      join(ROOT, 'src/icons/moon.svg'),
      join(ROOT, 'src/icons/star.svg'),
    ]);
  });
});

describe('a bare module name, read as module resolution reads it', () => {
  const MODULE = join(ROOT, 'lib', 'main.ts');

  async function tsconfig(compilerOptions: object): Promise<AliasMap> {
    return loadAliases({
      root: ROOT,
      files: [{ path: toPosix(join(ROOT, 'tsconfig.json')), relative: 'tsconfig.json' }],
      readFile: async () => JSON.stringify({ compilerOptions }),
      isFile: () => false,
    });
  }

  function bare(
    rawPath: string,
    options: {
      readonly aliases?: AliasMap;
      readonly extra?: readonly Asset[];
      readonly exists?: (path: string) => boolean;
    } = {},
  ): Reference | undefined {
    return resolveReferences([raw({ rawPath, kind: 'import', file: MODULE })], {
      root: ROOT,
      assets: [...ASSETS, ...(options.extra ?? [])],
      servingRoots: CONVENTIONAL_SERVING_ROOTS,
      ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
      exists: options.exists ?? NOTHING_EXISTS,
    })[0];
  }

  it('calls a bare name that nothing finds broken, since it names no file inside a package', () => {
    expect(bare('missing.png')?.resolution).toBe('broken');
  });

  it('never looks for a bare name beside the importing file', () => {
    const beside = asset('lib/logo.png');

    expect(bare('logo.png', { extra: [beside] })?.resolution).toBe('broken');
    // Nor does a file there that an ignore rule excluded put the import out of scope.
    const excluded = (path: string) => toPosix(path) === toPosix(beside.path);
    expect(bare('logo.png', { exists: excluded })?.resolution).toBe('broken');
  });

  it("finds a bare name under the tsconfig's baseUrl when no key maps it", async () => {
    const found = expectResolution(
      bare('assets/logo.png', { aliases: await tsconfig({ baseUrl: './src' }) }),
      'resolved',
    );

    expect(found.resolvedPath).toBe(join(ROOT, 'src/assets/logo.png'));
  });

  it('calls a bare name that a key maps and misses unresolved-alias, as any alias miss is', async () => {
    const aliases = await tsconfig({ paths: { '*': ['./types/*'] } });

    expect(bare('missing.png', { aliases })?.resolution).toBe('unresolved-alias');
  });
});

describe('a name given to new URL(name, import.meta.url), read as Vite reads it', () => {
  const MODULE = join(ROOT, 'src', 'main.ts');
  const vite: AliasMap = {
    rules: [
      {
        prefix: 'assets/',
        targets: [join(ROOT, 'lib', 'assets')],
        wildcard: true,
        scope: toPosix(ROOT),
        source: 'vite.config.ts',
        tool: 'vite',
      },
    ],
    skipped: [],
  };

  function url(
    rawPath: string,
    options: {
      readonly aliases?: AliasMap;
      readonly extra?: readonly Asset[];
      readonly exists?: (path: string) => boolean;
    } = {},
  ): Reference | undefined {
    return resolveReferences([raw({ rawPath, kind: 'attr', shape: 'js.new-url', file: MODULE })], {
      root: ROOT,
      assets: [...ASSETS, ...(options.extra ?? [])],
      servingRoots: CONVENTIONAL_SERVING_ROOTS,
      ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
      exists: options.exists ?? NOTHING_EXISTS,
    })[0];
  }

  it('calls a bare name that misses beside the module out of scope when a package holds it', () => {
    // In the `node_modules` of the module's folder or of any folder above it.
    const installed = toPosix(join(ROOT, 'node_modules/some-pkg/flag.png'));
    const found = expectResolution(
      url('some-pkg/flag.png', { exists: (path) => toPosix(path) === installed }),
      'out-of-scope',
    );

    expect(found.exclusionReason).toBe(
      'names a file inside an npm package, which is not an indexed asset',
    );
    expect(url('some-pkg/flag.png')?.resolution).toBe('broken');
  });

  it("reads a name through Vite's aliases before looking beside the module", () => {
    const found = expectResolution(
      url('assets/logo.png', { aliases: vite, extra: [asset('lib/assets/logo.png')] }),
      'resolved',
    );

    expect(found.resolvedPath).toBe(join(ROOT, 'lib/assets/logo.png'));
    // An alias that matches is Vite's only answer, so the hero.jpg beside the module is not it.
    expect(url('assets/hero.jpg', { aliases: vite })?.resolution).toBe('unresolved-alias');
  });

  it('never reads a name through a tsconfig key, which does not reach the asset plugin', () => {
    // Vite reads the name with its own alias and resolve plugins only, so `~/assets/logo.png`
    // is looked for beside the module, as `src/~/assets/logo.png`, and a tsconfig `paths`
    // entry, which only a plugin could add, never maps it.
    const tsconfig: AliasMap = {
      rules: [
        {
          prefix: '~/',
          targets: [join(ROOT, 'src')],
          wildcard: true,
          scope: toPosix(ROOT),
          source: 'tsconfig.json',
          tool: 'typescript',
        },
      ],
      tsconfigs: [{ scope: toPosix(ROOT), baseUrl: toPosix(ROOT) }],
      skipped: [],
    };

    expect(url('~/assets/logo.png', { aliases: tsconfig })?.resolution).toBe('unresolved-alias');
    // With the baseUrl no key takes part either: `src/assets/logo.png` is not beside the module.
    expect(url('src/assets/logo.png', { aliases: tsconfig })?.resolution).toBe('broken');
  });
});

describe('rung 4b: a declared alias, in every spelling the path could be read in', () => {
  const aliases: AliasMap = {
    rules: [
      {
        prefix: '~/',
        targets: [join(ROOT, 'src')],
        wildcard: true,
        scope: toPosix(ROOT),
        source: 'tsconfig.json',
        tool: 'typescript',
      },
    ],
    skipped: [],
  };
  const assets = [
    asset('src/assets/logo.png'),
    asset('src/assets/hero image.png'),
    asset('src/assets/my_photo.png'),
    asset('src/assets/enc%20name.png'),
    asset('src/assets/enc name.png'),
  ];

  function throughAlias(rawPath: string, kind: RawReference['kind']): Reference | undefined {
    return resolveReferences([raw({ rawPath, kind })], {
      root: ROOT,
      assets,
      servingRoots: CONVENTIONAL_SERVING_ROOTS,
      aliases,
      exists: NOTHING_EXISTS,
    })[0];
  }

  it('resolves the path as written', () => {
    const found = throughAlias('~/assets/logo.png', 'import');
    expect(found?.resolution).toBe('resolved');
    expect(found && 'spelling' in found ? found.spelling : undefined).toBeUndefined();
  });

  it('resolves a percent-encoded name, and records the spelling that matched', () => {
    const found = throughAlias('~/assets/hero%20image.png', 'css-url');
    expect(found?.resolution).toBe('resolved');
    expect(found && isLinked(found) ? linkedPaths(found) : []).toEqual([
      join(ROOT, 'src/assets/hero image.png'),
    ]);
    expect(found && 'spelling' in found ? found.spelling : undefined).toBe('percent-encoded');
  });

  it.each([
    ['percent-encoded', '%7E/assets/logo.png', 'css-url'],
    ['escaped in Markdown', '\\~/assets/logo.png', 'md'],
  ] as const)('reads an alias whose first character is %s', (_how, rawPath, kind) => {
    // `%7E/…` decodes, and Markdown's `\~/…` reads, as `~/…`: the alias question is asked of
    // each spelling, not only of the text as written.
    const found = throughAlias(rawPath, kind);
    expect(found?.resolution).toBe('resolved');
    expect(found && isLinked(found) ? linkedPaths(found) : []).toEqual([
      join(ROOT, 'src/assets/logo.png'),
    ]);
  });

  it('reads a Markdown escape through the alias, which only a Markdown kind allows', () => {
    const found = throughAlias('~/assets/my\\_photo.png', 'md');
    expect(found?.resolution).toBe('resolved');
    expect(found && 'spelling' in found ? found.spelling : undefined).toBe('markdown-escapes');
  });

  it('prefers the file named as written over a decoded spelling', () => {
    const found = throughAlias('~/assets/enc%20name.png', 'import');
    expect(found && isLinked(found) ? linkedPaths(found) : []).toEqual([
      join(ROOT, 'src/assets/enc%20name.png'),
    ]);
    expect(found && 'spelling' in found ? found.spelling : undefined).toBeUndefined();
  });
});

describe('rung 5 through a declared alias', () => {
  const aliases: AliasMap = {
    rules: [
      {
        prefix: '~/',
        targets: [ROOT],
        wildcard: true,
        scope: toPosix(ROOT),
        source: 'tsconfig.json',
        tool: 'typescript',
      },
    ],
    skipped: [],
  };
  const excludedRoots = [
    {
      path: join(ROOT, 'legacy'),
      relative: 'legacy',
      reason: "the ignore rule 'legacy/'",
      byRule: true,
    },
    {
      path: join(ROOT, 'old site'),
      relative: 'old site',
      reason: "the ignore rule 'old site/'",
      byRule: true,
    },
  ];

  function throughAlias(rawPath: string, exists: (path: string) => boolean = NOTHING_EXISTS) {
    return resolveReferences([raw({ rawPath })], {
      root: ROOT,
      assets: ASSETS,
      servingRoots: CONVENTIONAL_SERVING_ROOTS,
      aliases,
      excludedRoots,
      exists,
    })[0];
  }

  it('names the rule that excluded the folder an alias points into', () => {
    const found = throughAlias('~/legacy/old.png');
    expect(found?.resolution).toBe('out-of-scope');
    expect(found && 'exclusionReason' in found ? found.exclusionReason : '').toBe(
      "the ignore rule 'legacy/'",
    );
  });

  it('does so when only the decoded spelling reaches the folder', () => {
    const found = throughAlias('~/old%20site/logo.png');
    expect(found && 'exclusionReason' in found ? found.exclusionReason : '').toBe(
      "the ignore rule 'old site/'",
    );
  });

  it('finds a file on disk that nothing indexes, through the alias', () => {
    const hidden = toPosix(join(ROOT, 'hidden.png'));
    const found = throughAlias('~/hidden.png', (candidate) => candidate === hidden);
    expect(found && 'exclusionReason' in found ? found.exclusionReason : '').toBe(
      'resolved outside the indexed asset set',
    );
  });
});

describe('rung 3: a likely typo where a position asserts an image', () => {
  // One keystroke from an image extension, where the page asserts an image: it points at
  // nothing, so it gets a line of its own rather than vanishing as a font does.
  it.each([
    ['attr', 'html.img.src', '/img/typo.pn'],
    ['attr', 'html.meta.content.image', '/img/share.jpgg'],
    ['md', 'md.image', './img/diagram.wepb'],
  ] as const)('files %s %s holding %s as broken, a likely typo', (kind, shape, rawPath) => {
    const reference = resolveOne({ rawPath, kind, shape, ceiling: 'high' });
    expect([reference?.resolution, reference?.note]).toEqual([
      'broken',
      expect.stringMatching(/a likely typo/),
    ]);
  });

  it('still drops an extension no keystroke from an image, and any where no image is asserted', () => {
    // A script can serve an image at `/avatar.php`; a Markdown link names a page or a file.
    for (const [kind, shape, rawPath] of [
      ['attr', 'html.img.src', '/avatar.php'],
      ['md', 'md.link', '/docs/guide.pn'],
    ] as const) {
      expect(resolveOne({ rawPath, kind, shape, ceiling: 'high' }), rawPath).toBeUndefined();
    }
  });
});

describe('a character reference, decoded only where a reader decodes it', () => {
  const cafe = `src/img/caf${String.fromCodePoint(0xe9)}.png`;
  const resolveBesideCafe = (overrides: Partial<RawReference> & { rawPath: string }) =>
    resolveReferences([raw(overrides)], {
      root: ROOT,
      assets: [asset(cafe)],
      servingRoots: CONVENTIONAL_SERVING_ROOTS,
      exists: NOTHING_EXISTS,
    })[0];

  it.each([
    ['a .css file', 'css-url', 'css.url.bare', 'site.css'],
    ['a <style> body', 'css-url', 'html.style.element', 'index.html'],
    ['a JavaScript import', 'import', 'js.import.static', 'main.js'],
    ['a new URL name', 'attr', 'js.new-url', 'main.js'],
  ] as const)(
    'takes the name in %s as written, as the browser asks for it',
    (_name, kind, shape, file) => {
      const reference = resolveBesideCafe({
        rawPath: './img/caf&eacute;.png',
        kind,
        shape,
        ceiling: 'high',
        file: join(ROOT, 'src', file),
      });
      expect(reference?.resolution).not.toBe('resolved');
    },
  );

  it.each([
    ['an HTML attribute', 'attr', 'html.img.src'],
    ['CSS in a style attribute', 'css-url', 'html.style.attribute'],
  ] as const)('decodes the name in %s, as an HTML parser does', (_name, kind, shape) => {
    const reference = resolveBesideCafe({
      rawPath: './img/caf&eacute;.png',
      kind,
      shape,
      ceiling: 'high',
      file: join(ROOT, 'src', 'index.html'),
    });
    expect(expectResolution(reference, 'resolved').resolvedPath).toBe(join(ROOT, cafe));
  });
});

describe('a backslash in an HTML attribute', () => {
  // The URL parser reads it as a slash, so a page loads the same file on every platform:
  // `\banner.png` is served from the root, never looked for at the root of this disk.
  it.each([
    ['attr', 'html.img.src', 'index.html', '\\banner.png', 'public/banner.png'],
    ['attr', 'html.img.src', 'index.html', 'assets\\logo.png', 'src/assets/logo.png'],
  ] as const)('%s: %s in %s reads %s as %s', (kind, shape, file, rawPath, target) => {
    const reference = resolveOne({
      rawPath,
      kind,
      shape,
      ceiling: 'high',
      file: join(ROOT, 'src', file),
    });
    expect(expectResolution(reference, 'resolved').resolvedPath).toBe(join(ROOT, target));
  });
});

describe('a backslash left in a spelling', () => {
  // Windows path rules read it as a folder separator and every other platform's as part of a
  // name, so a lookup would link a file on one machine and not on another. Where it is a
  // separator, in an attribute's URL, it is a slash before any lookup; nowhere else is it one.
  it.each([
    ['an import holding an encoded backslash', 'import', 'js.import.static', './assets%5Clogo.png'],
    ['a Markdown destination holding one', 'md', 'md.image', 'assets\\logo.png'],
    ['a Markdown destination escaping one', 'md', 'md.image', 'assets\\\\logo.png'],
  ] as const)('is looked up on no platform: %s', (_name, kind, shape, rawPath) => {
    const reference = resolveOne({ rawPath, kind, shape, ceiling: 'high' });

    expect(reference?.resolution).toBe('broken');
  });

  it('still reads a Windows drive path with Windows rules, on every platform', () => {
    const reference = resolveOne({ rawPath: 'C:\\elsewhere\\logo.png', kind: 'md' });

    expect(reference?.resolution).toBe('out-of-scope');
  });
});

describe("rung 2: a glob that starts with `/`, read from Vite's root", () => {
  // In a monorepo Vite runs from the app's folder, so `/src/img/*.png` written in `apps/web`
  // names `apps/web/src/img/one.png`, not a `src/img` at the project root.
  const assets = [asset('apps/web/src/img/one.png'), asset('apps/web/site/img/two.png')];

  function fromApp(pattern: string, root: string): readonly string[] | string {
    const app = toPosix(join(ROOT, 'apps/web'));
    const [reference] = resolveReferences(
      [
        raw({
          rawPath: pattern,
          file: join(ROOT, 'apps/web/src/gallery.ts'),
          shape: 'js.import.meta.glob',
          ceiling: 'medium',
          glob: { exclude: [], dot: false },
        }),
      ],
      {
        root: ROOT,
        assets,
        servingRoots: CONVENTIONAL_SERVING_ROOTS,
        aliases: { rules: [], viteConfigs: [{ scope: app, root: `${app}${root}` }], skipped: [] },
        exists: NOTHING_EXISTS,
      },
    );
    if (reference === undefined) return 'dropped';
    return isLinked(reference) ? linkedPaths(reference) : reference.resolution;
  }

  it('matches from the folder of the Vite config that builds the file', () => {
    expect(fromApp('/src/img/*.png', '')).toEqual([join(ROOT, 'apps/web/src/img/one.png')]);
  });

  it('matches from the root that config names, when it names one', () => {
    expect(fromApp('/img/*.png', '/site')).toEqual([join(ROOT, 'apps/web/site/img/two.png')]);
  });
});

describe("rung 2: a bundler's glob, read as Vite globs it", () => {
  const assets = [
    'src/img/one.png',
    'src/img/two.png',
    'src/img/three.jpg',
    'src/img/.hidden.png',
    'src/img/draft/sketch.png',
    'src/img/.cache/stale.png',
    'src/[draft]/img/wip.png',
    'banner.png',
  ].map(asset);

  /** The project-relative paths a glob written in `src/gallery.ts` links, or its outcome. */
  function globbed(
    pattern: string,
    options: { exclude?: readonly string[]; dot?: boolean; file?: string } = {},
  ): readonly string[] | string {
    const [reference] = resolveReferences(
      [
        raw({
          rawPath: pattern,
          file: join(ROOT, options.file ?? 'src/gallery.ts'),
          shape: 'js.import.meta.glob',
          ceiling: 'medium',
          glob: { exclude: options.exclude ?? [], dot: options.dot ?? false },
        }),
      ],
      { root: ROOT, assets, servingRoots: CONVENTIONAL_SERVING_ROOTS, exists: NOTHING_EXISTS },
    );
    if (reference === undefined) return 'dropped';
    if (!isLinked(reference)) return reference.resolution;
    return linkedPaths(reference).map((path) => toPosix(path).slice(toPosix(ROOT).length + 1));
  }

  it.each([
    ['./img/*.png', ['src/img/one.png', 'src/img/two.png']],
    ['./img/**/*.png', ['src/img/draft/sketch.png', 'src/img/one.png', 'src/img/two.png']],
    ['./img/*.{png,jpg}', ['src/img/one.png', 'src/img/three.jpg', 'src/img/two.png']],
    ['./img/*{.png,.jpg}', ['src/img/one.png', 'src/img/three.jpg', 'src/img/two.png']],
    ['./img/t??.png', ['src/img/two.png']],
    // A class has no dot guard, and picomatch negates one with `^` alone: `[!o]` holds `!`.
    ['./img/[^o]*.*', ['src/img/.hidden.png', 'src/img/three.jpg', 'src/img/two.png']],
    ['./img/[!o]*.png', ['src/img/one.png']],
    ['../*.png', ['banner.png']],
    ['**/sketch.png', ['src/img/draft/sketch.png']],
  ])('links every asset %s matches', (pattern, matched) => {
    expect(globbed(pattern)).toEqual(matched);
  });

  it('takes out what a negation of the call matches', () => {
    expect(globbed('./img/*.png', { exclude: ['./img/t*.png'] })).toEqual(['src/img/one.png']);
    expect(globbed('./img/**/*.png', { exclude: ['**/one.png', '**/sketch.png'] })).toEqual([
      'src/img/two.png',
    ]);
  });

  it('matches a name that starts with a dot only when the call asks for every file', () => {
    expect(globbed('./img/**/*.png', { dot: true })).toEqual([
      'src/img/.cache/stale.png',
      'src/img/.hidden.png',
      'src/img/draft/sketch.png',
      'src/img/one.png',
      'src/img/two.png',
    ]);
  });

  it("reads the module's own folder literally, whatever glob syntax its name holds", () => {
    expect(globbed('./img/*.png', { file: 'src/[draft]/gallery.ts' })).toEqual([
      'src/[draft]/img/wip.png',
    ]);
  });

  it('is dynamic when it matches nothing, and dropped when it can name no image', () => {
    expect(globbed('./photos/*.png')).toBe('dynamic');
    expect(globbed('./photos/*')).toBe('dynamic');
    expect(globbed('./pages/*.vue')).toBe('dropped');
    expect(globbed('./pages/**/*.{ts,tsx}')).toBe('dropped');
  });

  it('refuses syntax it does not read rather than misreading it', () => {
    expect(globbed('./img/@(one|two).png')).toBe('dynamic');
    expect(globbed('./img/{1..3}.png')).toBe('dynamic');
  });
});

describe("rung 2: a bundler's context, listed as webpack lists it", () => {
  const assets = [
    'src/icons/one.png',
    'src/icons/two.jpg',
    'src/icons/Three.PNG',
    'src/icons/.hidden.png',
    'src/icons/old/four.png',
    'src/icons/.cache/stale.png',
    'src/other/five.png',
  ].map(asset);

  /** The project-relative paths a context written in `src/app.js` links, or its outcome. */
  function listed(
    directory: string,
    bundlerContext: BundlerContext,
    options: { ceiling?: 'medium' | 'unsafe'; foldCase?: boolean } = {},
  ): readonly string[] | string {
    const [reference] = resolveReferences(
      [
        raw({
          rawPath: directory,
          file: join(ROOT, 'src/app.js'),
          shape: 'js.require.context',
          ceiling: options.ceiling ?? 'medium',
          bundlerContext,
        }),
      ],
      {
        root: ROOT,
        assets,
        servingRoots: CONVENTIONAL_SERVING_ROOTS,
        exists: NOTHING_EXISTS,
        foldCase: options.foldCase ?? false,
      },
    );
    if (reference === undefined) return 'dropped';
    if (!isLinked(reference)) return reference.resolution;
    return linkedPaths(reference).map((path) => toPosix(path).slice(toPosix(ROOT).length + 1));
  }

  const png = { source: '\\.png$', flags: '' };

  it.each([
    [
      'the folder alone when the call does not recurse',
      './icons',
      { recursive: false },
      ['src/icons/Three.PNG', 'src/icons/one.png', 'src/icons/two.jpg'],
    ],
    [
      'every folder below when it does',
      './icons',
      { recursive: true },
      ['src/icons/Three.PNG', 'src/icons/old/four.png', 'src/icons/one.png', 'src/icons/two.jpg'],
    ],
    [
      'only the files the expression matches',
      './icons/',
      { recursive: false, filter: png },
      ['src/icons/one.png'],
    ],
    [
      'a match in any case under the i flag',
      './icons',
      { recursive: true, filter: { source: '\\.png$', flags: 'i' } },
      ['src/icons/Three.PNG', 'src/icons/old/four.png', 'src/icons/one.png'],
    ],
    [
      'a path the expression reads from ./, the folder below included',
      '../src/icons',
      { recursive: true, filter: { source: '^\\./old/', flags: '' } },
      ['src/icons/old/four.png'],
    ],
    [
      "the module's own folder",
      '.',
      { recursive: true, filter: { source: '^\\./other/', flags: '' } },
      ['src/other/five.png'],
    ],
  ])('links %s', (_, directory, bundlerContext, matched) => {
    expect(listed(directory, bundlerContext)).toEqual(matched);
  });

  it('reads a filter with the g flag as if each file were the first it tested', () => {
    // The flag makes `test` resume where the last match ended, which would skip `one.png`.
    expect(
      listed('./icons', { recursive: true, filter: { source: '\\.png$', flags: 'g' } }),
    ).toEqual(['src/icons/old/four.png', 'src/icons/one.png']);
  });

  it('reads the directory as webpack reads the request, without inline loaders or a query', () => {
    expect(listed('./icons?inline', { recursive: false, filter: png })).toEqual([
      'src/icons/one.png',
    ]);
    expect(listed('!!raw-loader!./icons', { recursive: false, filter: png })).toEqual([
      'src/icons/one.png',
    ]);
  });

  it('never lists a file or folder whose name starts with a dot, as webpack does not', () => {
    expect(
      listed('./icons', { recursive: true, filter: { source: 'hidden|stale', flags: '' } }),
    ).toBe('dynamic');
  });

  it('is dynamic when it takes nothing, or when its expression cannot be built', () => {
    expect(listed('./photos', { recursive: true })).toBe('dynamic');
    expect(listed('./icons', { recursive: true, filter: { source: '\\.gif$', flags: '' } })).toBe(
      'dynamic',
    );
    expect(listed('./icons', { recursive: true, filter: { source: '(', flags: '' } })).toBe(
      'dynamic',
    );
  });

  it("leaves a directory not written from the module's folder unresolved, as an unmapped alias is", () => {
    expect(listed('@/icons', { recursive: true })).toBe('unresolved-alias');
    expect(listed('icons', { recursive: true })).toBe('dynamic');
    expect(listed('/src/icons', { recursive: true })).toBe('dynamic');
  });

  it('keeps a call it could not read whole dynamic, whatever its directory is named', () => {
    expect(listed('./icons', { recursive: true }, { ceiling: 'unsafe' })).toBe('dynamic');
    expect(listed('./sprites.v2', { recursive: true }, { ceiling: 'unsafe' })).toBe('dynamic');
  });

  it('finds the folder in any case where the file system ignores case, and filters the name on disk', () => {
    expect(
      listed(
        './ICONS',
        { recursive: false, filter: { source: 'Three', flags: '' } },
        { foldCase: true },
      ),
    ).toEqual(['src/icons/Three.PNG']);
  });
});

describe("what a bundler's context could take, for the name search", () => {
  const call = (directory: string, bundlerContext: BundlerContext): RawReference =>
    raw({
      rawPath: directory,
      file: join(ROOT, 'src/app.js'),
      shape: 'js.require.context',
      ceiling: 'unsafe',
      bundlerContext,
    });

  it("reads a directory written from the module's folder from there, in any case", () => {
    const couldTake = contextCouldTake(call('./icons', { recursive: false }), ROOT);

    expect(couldTake('src/icons/one.png')).toBe(true);
    expect(couldTake('src/Icons/one.png')).toBe(true);
    expect(couldTake('src/icons/old/two.png')).toBe(false);
    expect(couldTake('lib/icons/one.png')).toBe(false);
  });

  it('reads any other directory as a folder anywhere on the path, after its alias token', () => {
    const couldTake = contextCouldTake(
      call('@/assets/icons', { recursive: true, filter: { source: '\\.png$', flags: '' } }),
      ROOT,
    );

    expect(couldTake('src/assets/icons/one.png')).toBe(true);
    expect(couldTake('src/assets/icons/old/two.png')).toBe(true);
    expect(couldTake('src/assets/icons/two.jpg')).toBe(false);
    expect(couldTake('src/icons/one.png')).toBe(false);
  });

  it('takes every file under the directory when its expression cannot be built', () => {
    const couldTake = contextCouldTake(
      call('./icons', { recursive: true, filter: { source: '(', flags: '' } }),
      ROOT,
    );

    expect(couldTake('src/icons/old/a.gif')).toBe(true);
  });
});

describe('resolving in slices, with a turn of the event loop before each', () => {
  const STYLES = join(ROOT, 'src', 'styles.css');
  // Two files, each holding references of several outcomes, so a slice can end inside one
  // file's references or between the two files.
  const references: readonly RawReference[] = [
    raw({ rawPath: './assets/logo.png' }),
    raw({ rawPath: './missing.png' }),
    raw({ rawPath: './images/${n}.png', ceiling: 'medium' }),
    raw({ rawPath: './fonts/inter.woff2' }),
    raw({ rawPath: '/banner.png', file: STYLES }),
    raw({ rawPath: './assets/hero.jpg', file: STYLES }),
    raw({ rawPath: '../at-root.png', file: STYLES }),
  ];
  const options = {
    root: ROOT,
    assets: ASSETS,
    servingRoots: CONVENTIONAL_SERVING_ROOTS,
    exists: NOTHING_EXISTS,
  };

  it.each([1, 2, 3, 4, 7, 1_000])(
    'resolves every reference as in one stretch, in the same order, in slices of %i',
    async (size) => {
      expect(await resolveReferencesInSlices(references, options, size)).toEqual(
        resolveReferences(references, options),
      );
    },
  );

  it('lets a timer that fell due during one slice run before the next slice', async () => {
    const order: string[] = [];
    let timerSet = false;
    await resolveReferencesInSlices(
      ['a', 'b', 'c', 'd'].map((name) => raw({ rawPath: `./missing-${name}.png` })),
      {
        ...options,
        // Asked about each reference that did not resolve, while it is resolved.
        exists: (path) => {
          const name = path.slice(path.lastIndexOf('/') + 1);
          if (order.at(-1) !== name) order.push(name);
          if (!timerSet) {
            timerSet = true;
            setTimeout(() => order.push('timer'), 0);
            // Holds the thread past the timer's due time, as a long slice of work would.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
          return false;
        },
      },
      2,
    );

    expect(order).toEqual([
      'missing-a.png',
      'missing-b.png',
      'timer',
      'missing-c.png',
      'missing-d.png',
    ]);
  });
});
