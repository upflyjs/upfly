/**
 * Decide what every raw reference points at, and assign its final confidence.
 *
 * Resolution is against the asset set `discover` returned, not the filesystem: the adapter
 * knows syntax, the resolver knows what exists. Every rung of the ladder in `resolveOne`
 * exists because some real syntax would otherwise be reported as `broken` when it is not.
 * See "The resolver's seven outcomes" in ARCHITECTURE.md.
 */

import { dirname, posix, resolve as resolvePath, win32 } from 'node:path';
import {
  INTERPOLATIONS,
  type PathSpelling,
  isDrivePath,
  spellingsOf,
  splitPathSuffix,
  staticExtensionOf,
} from '../adapters/reference-path.js';
import { assertsAnImage } from '../adapters/shapes.js';
import {
  IMAGE_EXTENSIONS,
  compareStrings,
  extensionOf,
  isImageExtension,
  relativePath,
  toPosix,
} from '../paths.js';
import type {
  Asset,
  BundlerContext,
  BundlerGlob,
  ExcludedRoot,
  RawReference,
  Reference,
  ResolvedVia,
} from '../types.js';
import type { AliasMap } from './aliases.js';
import { expandAlias, matchingRule, viteRootOf } from './aliases.js';
import { provenPath } from './reference.js';

/**
 * The directories root-relative paths are served from, and whether the project declared
 * them or the engine guessed them.
 *
 * One value holds both, so a caller cannot pass the directories without saying where they
 * came from. A root-relative path that misses a declared root but exists at the project root
 * is suspicious; missing a guessed root says nothing, because the project never claimed to
 * serve from there. A monorepo has one root per app, and the nearest ancestor of the
 * referencing file wins, as it does for a bundler, whatever the order of `dirs`.
 */
export interface ServingRoots {
  /** Relative to the project root. A plain static site serves from the root: `['']`. */
  readonly dirs: readonly string[];
  /** True when the project declared these; false when they are a convention guess. */
  readonly declared: boolean;
}

/**
 * What to assume when the project has told us nothing.
 *
 * Right for a single-app Vite, Next or Astro project and wrong for a hand-written
 * static site, which is why it is marked as undeclared rather than passed off as a
 * statement.
 */
export const CONVENTIONAL_SERVING_ROOTS: ServingRoots = Object.freeze({
  dirs: Object.freeze(['public']) as readonly string[],
  declared: false,
});

export interface ResolveOptions {
  /** Absolute project root, as returned by `discover`. */
  readonly root: string;
  /** Every image found on disk. Resolution is against this set, not the filesystem. */
  readonly assets: readonly Asset[];
  /**
   * Where a root-relative `/hero.png` may be served from, and whether the project said so.
   * See {@link ServingRoots}.
   */
  readonly servingRoots: ServingRoots;
  /**
   * Directories the walk excluded, from `DiscoveryResult.excludedRoots`. A reference into
   * one points at a file that is really there, so it is `out-of-scope` rather than `broken`.
   * The usual case is a user who ignores `legacy/` while it is still referenced.
   */
  readonly excludedRoots?: readonly ExcludedRoot[];
  /**
   * Path aliases the project declares, from `loadAliases`. Passed in because reading a
   * config is filesystem work and this module is pure. Absent means none were loaded.
   */
  readonly aliases?: AliasMap;
  /**
   * Whether a path exists on disk: the resolver's only contact with a filesystem, injected
   * so it can be tested against a fake. It is consulted only for references that did not
   * resolve, so that an asset excluded by a file-level ignore rule such as `*.png` is
   * `out-of-scope` rather than `broken`. Required, because a default would let a call site
   * keep that false `broken` silently.
   */
  readonly exists: (absolutePath: string) => boolean;
  /**
   * The file at a path that exists but is not among `assets`, or null. A caller asking where
   * a path would lead among every file on disk, rather than among the indexed ones, passes
   * it. It is asked wherever the index misses, in the order the resolver looks, so a nearer
   * file the walk excluded is found before an asset further away. A pattern is matched
   * against `assets` only. Absent, only `assets` are found.
   */
  readonly unindexed?: (absolutePath: string) => string | null;
  /**
   * Whether an asset is found by a path that differs from its own only in case, as Windows
   * and macOS find a file. Absent, case counts, as it does on Linux. `unindexed` is asked
   * with the path as the reference spells it, and folds case itself if it has to.
   */
  readonly foldCase?: boolean;
}

/**
 * Resolve raw references against the assets that exist, giving each its outcome and final
 * confidence.
 *
 * References to files the engine does not track, such as a `.woff2` font or a `.css`
 * import, are left out of the result rather than reported. They were never candidate
 * assets, so this is not a silent skip, and counting every font in a stylesheet would be
 * noise. A value an adapter declined (`RawReference.declined`) is never looked up: it is
 * `discarded` when it names an image and left out on the same terms otherwise.
 */
export function resolveReferences(
  rawReferences: readonly RawReference[],
  options: ResolveOptions,
): Reference[] {
  const context: ResolveContext = {
    index: new AssetIndex(options.assets, options.unindexed, options.foldCase ?? false),
    root: options.root,
    publicDirs: options.servingRoots.dirs,
    excludedRoots: options.excludedRoots ?? [],
    exists: options.exists,
    aliases: options.aliases ?? { rules: [], skipped: [] },
  };
  // Vite's asset plugin reads a `new URL` name with Vite's own aliases alone: a tsconfig key,
  // which only a plugin could add, never reaches it.
  const assetUrlContext: ResolveContext = {
    ...context,
    aliases: {
      rules: context.aliases.rules.filter((rule) => rule.tool === 'vite'),
      tsconfigs: [],
      skipped: context.aliases.skipped,
    },
  };
  const resolved: Reference[] = [];

  for (const raw of rawReferences) {
    const reference = resolveOne(raw, raw.shape === 'js.new-url' ? assetUrlContext : context);
    if (reference !== null) resolved.push(reference);
  }

  return resolved;
}

interface ResolveContext {
  readonly index: AssetIndex;
  readonly root: string;
  readonly publicDirs: readonly string[];
  readonly excludedRoots: readonly ExcludedRoot[];
  readonly exists: (absolutePath: string) => boolean;
  readonly aliases: AliasMap;
}

/**
 * The resolution ladder, whose order is load-bearing. A declined value is settled before
 * anything is looked up. The ceiling tests come next because without a static path no later
 * question means anything, and the extension filter comes straight after them. Above them
 * it would drop `url($hero)` and `` `/img/${file}` ``, which have no extension to test; below
 * the rungs that turn a miss into a finding it would let every `url(inter.woff2)` be
 * reported. See "The resolver's seven outcomes" in ARCHITECTURE.md.
 */
function resolveOne(raw: RawReference, context: ResolveContext): Reference | null {
  const { index, root, publicDirs } = context;
  // 0. A value an adapter declined to read as a path. Never looked up, whatever exists on
  //    disk, so it comes before the ceiling rungs: a declined template must not glob.
  if (raw.declined === true) return namesAnImage(raw) ? unlinked(raw, 'discarded') : null;

  // 1. No static path at all. A construct the adapter could not read is text rather than a
  //    path, so what follows its last dot is no extension that could rule it out.
  if (raw.unread === true) return unlinked(raw, 'dynamic');
  if (raw.ceiling === 'unsafe') {
    // A context's directory is no file, so what follows its last dot rules nothing out.
    if (raw.bundlerContext !== undefined) return unlinked(raw, 'dynamic');
    // A glob's extension can be a brace, `*.{png,jpg}`, which only the glob reading sees.
    const notAnAsset =
      raw.glob === undefined ? provablyNotAnAsset(raw) : globNamesNoImage(provenPath(raw));
    return notAnAsset ? null : unlinked(raw, 'dynamic');
  }

  // 2. A pattern. Glob it, and never let it fall through to `broken`. Glob the path the
  //    text proves (`provenPath`): the text of a `+` chain, or of a template with a
  //    same-file constant written in, is not the path it builds.
  if (raw.ceiling === 'medium') {
    // A bundler's glob is written in glob syntax, and a context names a directory: the
    // holes below read neither.
    if (raw.glob !== undefined) return resolveGlob(raw, raw.glob, context);
    if (raw.bundlerContext !== undefined) {
      return resolveBundlerContext(raw, raw.bundlerContext, context);
    }
    const pattern = provenPath(raw);
    const written = index.matchPattern(pattern, raw, root, publicDirs);
    // Then through a declared alias, as rung 4b reads a literal path, so a file at the
    // written path still wins.
    const { matches, via } =
      written.matches.length > 0
        ? written
        : { matches: matchThroughAlias(pattern, raw, context), via: 'serving-root' as const };
    const [first, ...rest] = matches;
    if (first === undefined) {
      if (provablyNotAnAsset(raw)) return null;
      // Through an alias no rule covers, a pattern is unresolved, as rung 6 calls a literal one.
      return unlinked(
        raw,
        throughUnmappedAlias(pattern, raw, context) ? 'unresolved-alias' : 'dynamic',
      );
    }
    return {
      ...raw,
      resolution: 'resolved-pattern',
      confidence: 'medium',
      resolvedPaths: [first, ...rest],
      resolvedVia: via,
    };
  }

  const { path } = splitPathSuffix(raw.rawPath);
  // Every spelling the reference's position reads, since its shape picks the decoder. Rung 3
  // and the alias-shape tests of rungs 4b and 6 read them all.
  const spellings = spellingsOf(path, raw);
  // Rungs 4 and 5 look up only these. Windows path rules read a backslash as a folder separator
  // and every other platform's as part of a name, so a spelling that still holds one would link
  // a file on one machine and not on another. Where a browser reads it as a slash,
  // `spellingsOf` already has; a drive path is read with Windows rules on every platform.
  const lookedUp = spellings.filter(
    ({ path: spelled }) => isDrivePath(spelled) || !spelled.includes('\\'),
  );

  // 3. Not a file we track. Dropped entirely, with no report line. Every spelling is asked,
  //    not only the written one: `hero%2Epng` shows its extension only once decoded.
  //    Except a likely typo where the element shows an image: `/img/typo.pn` goes on down the
  //    ladder, to be reported as a path to nothing, rather than vanish as a font does.
  const typo = spellings.some(({ path: candidate }) => isImageExtension(extensionOf(candidate)))
    ? undefined
    : likelyTypo(spellings, raw);
  if (typo === null) return null;

  // 4a. A name given to `new URL(name, import.meta.url)` goes through the nearest Vite
  //     config's aliases before anything else, as Vite's asset plugin reads it.
  if (raw.shape === 'js.new-url') {
    const viaVite = throughViteAlias(lookedUp, raw, context);
    if (viaVite !== null) return viaVite;
  }

  // 4. Points at an asset we found. Every spelling, literal first: `enc%20name.png` can be a
  //    file with a percent sign in its name, while `hero%20image.png` can name
  //    `hero image.png`. Only literal-then-decoded gets both right, and the accuracy suite
  //    holds the pair so the order is tested.
  for (const { spelling, path: candidate } of lookedUp) {
    const found = index.lookup(candidate, raw, root, publicDirs);
    if (found === null) continue;
    return {
      ...raw,
      resolution: 'resolved',
      confidence: raw.ceiling,
      resolvedPath: found.path,
      resolvedVia: found.via,
      ...(spelling === 'literal' ? {} : { spelling }),
    };
  }

  // 4b. An alias the project declares. Tried after the literal lookup, so a real file
  //     at the written path always wins over a mapping that happens to match. Whether the
  //     path is alias-shaped is asked of every spelling, since an encoding or an escape can
  //     hide an alias's first character.
  const viaAlias = aliasShapedIn(spellings, raw.kind)
    ? resolveThroughAlias(lookedUp, raw, context)
    : null;
  if (viaAlias !== null) return viaAlias;

  // 5. Points at a real file we deliberately do not index, in any spelling.
  const excluded = outOfScope(path, lookedUp, raw, context);
  if (excluded !== null) return excluded;

  // 5b. A `new URL` name that missed beside the module is looked for as a package next, as
  //     Vite looks: out of scope where one holds it, and otherwise on down the ladder.
  const packaged = raw.shape === 'js.new-url' ? inPackage(path, raw, context) : null;
  if (packaged !== null) return packaged;

  // 6. Alias-shaped and no declared alias matched. `unresolved-alias` is a final outcome,
  //    not pending work: it means no rule maps this path.
  if (aliasShapedIn(spellings, raw.kind)) {
    // 6b. A package specifier is not an alias. It names a file inside `node_modules`,
    //     which the walk prunes, so it is known and known not to be an indexed asset.
    if (isPackageSpecifier(path, raw.kind)) {
      return {
        ...raw,
        resolution: 'out-of-scope',
        confidence: 'unsafe',
        resolvedPath: path,
        exclusionReason: PACKAGE_FILE,
      };
    }
    // 6c. A bare name with no path after it, which no alias maps, could only name a package
    //     itself, never a file inside one: it falls to rung 7, as any path to nothing does.
    const mapped = spellings.some(
      ({ path: spelled }) => matchingRule(context.aliases, spelled, raw.file) !== null,
    );
    if (!isBareSpecifier(path, raw.kind) || mapped) return unlinked(raw, 'unresolved-alias');
  }

  // 7. The author said this was an asset and it points at nothing, letter case counted as a
  //    Linux server counts it. An asset it names in another case is recorded, because Windows
  //    and macOS load that file through it.
  const namedIgnoringCase = (): string | null => {
    for (const { path: candidate } of lookedUp) {
      const named = index.lookupIgnoringCase(candidate, raw, root, publicDirs);
      if (named !== null) return named;
    }
    return null;
  };
  if (raw.asserted) {
    if (typo !== undefined) return { ...unlinked(raw, 'broken'), note: typo };
    const named = namedIgnoringCase();
    if (named === null) return unlinked(raw, 'broken');
    return {
      ...raw,
      resolution: 'broken',
      confidence: 'unsafe',
      resolvedPath: null,
      namesIgnoringCase: named,
    };
  }

  // 8. A path-shaped string that turned out not to be a path. Counted, not a finding; an asset
  //    it names in another case is recorded as rung 7 records one.
  const named = namedIgnoringCase();
  if (named === null) return unlinked(raw, 'discarded');
  return {
    ...raw,
    resolution: 'discarded',
    confidence: 'unsafe',
    resolvedPath: null,
    namesIgnoringCase: named,
  };
}

/**
 * Whether this path, in any of its spellings, lands on a file the engine chose not to index:
 * under a directory the walk pruned, reported with the rule responsible, or failing that on
 * a file that exists anyway because a file-level ignore rule such as `*.png` excluded it. The
 * spellings are the ones rung 4 looked up, in its order, so `unindexed%20photo.png` finds an
 * ignored `unindexed photo.png`. An alias-shaped path is also asked about through each
 * expansion of each spelling, after the plain candidates, so an alias into a pruned folder is
 * out of scope with its rule. The fallback costs a `stat` per candidate path of each spelling
 * of a reference that did not resolve, which is cheap against a false `broken`. A
 * Windows drive path outside the project is out of scope with no `stat`: whether one machine
 * holds that file says nothing about the project.
 */
function outOfScope(
  path: string,
  spellings: ReturnType<typeof spellingsOf>,
  raw: RawReference,
  context: ResolveContext,
): Reference | null {
  if (isDrivePath(path) && drivePathInProject(path, context.root) === null) {
    return {
      ...raw,
      resolution: 'out-of-scope',
      confidence: 'unsafe',
      resolvedPath: posixDrivePath(path),
      exclusionReason:
        'names a file on a Windows drive outside the project, which is not an indexed asset',
    };
  }

  const candidates = [
    ...spellings.flatMap(({ path: spelled }) =>
      candidatePaths(spelled, raw, context.root, context.publicDirs).map(({ path: at }) => at),
    ),
    ...(aliasShapedIn(spellings, raw.kind)
      ? spellings.flatMap(({ path: spelled }) => throughDeclared(spelled, raw, context))
      : []),
  ];
  return firstOutOfScope(candidates, raw, context);
}

/** The first candidate under a directory the walk pruned, or on disk though not indexed. */
function firstOutOfScope(
  candidates: readonly string[],
  raw: RawReference,
  context: ResolveContext,
): Reference | null {
  for (const candidate of candidates) {
    for (const excluded of context.excludedRoots) {
      const prefix = `${toPosix(excluded.path)}/`;
      if (!candidate.startsWith(prefix)) continue;
      return {
        ...raw,
        resolution: 'out-of-scope',
        confidence: 'unsafe',
        resolvedPath: candidate,
        exclusionReason: excluded.reason,
      };
    }

    if (context.exists(candidate)) {
      return {
        ...raw,
        resolution: 'out-of-scope',
        confidence: 'unsafe',
        resolvedPath: candidate,
        exclusionReason: 'resolved outside the indexed asset set',
      };
    }
  }

  return null;
}

/**
 * Whether a reference's statically visible extension rules out an image.
 *
 * `components/ui/${name}.tsx` needs no resolution: its extension is visible and not one we
 * track, so it is dropped as rung 3 drops `url(inter.woff2)`. This is not rung 3 moved
 * earlier, which would also drop `url($hero)`: `$hero` shows no extension, and an unknown
 * extension is not a ruled-out one.
 */
function provablyNotAnAsset(raw: RawReference): boolean {
  // The assembled path when there is one: `'/locales/' + lang + '.json'` shows its `.json`
  // in the path it assembles, not in the quote-and-plus text of the chain.
  const extension = staticExtensionOf(provenPath(raw));
  return extension !== '' && !isImageExtension(extension);
}

/**
 * Whether a spelling of the path a reference's text proves shows an image extension: rung 3's
 * test, asked of a value that is never looked up. A declined `/files/report.pdf` is dropped as
 * `url(inter.woff2)` is, while one naming an image is counted.
 */
function namesAnImage(raw: RawReference): boolean {
  const { path } = splitPathSuffix(provenPath(raw));
  return spellingsOf(path, raw).some(({ path: spelled }) =>
    isImageExtension(staticExtensionOf(spelled)),
  );
}

function unlinked(
  raw: RawReference,
  resolution: 'dynamic' | 'broken' | 'discarded' | 'unresolved-alias',
): Reference {
  return { ...raw, resolution, confidence: 'unsafe', resolvedPath: null };
}

/**
 * Why a reference is likely a typo of an image's name, such as `/img/logo.pn`, or `null` when
 * it is not one. The resolver reports such a path as broken rather than drop it, and the audit
 * gives its finding this note.
 *
 * @param raw a reference as its adapter emitted it
 * @returns the note, or `null` when a spelling of the path shows an image extension or none is
 * one keystroke from one
 */
export function likelyTypoOf(raw: RawReference): string | null {
  const spellings = spellingsOf(splitPathSuffix(raw.rawPath).path, raw);
  if (spellings.some(({ path }) => isImageExtension(extensionOf(path)))) return null;
  return likelyTypo(spellings, raw);
}

/**
 * The note for a likely typo, or `null` when the path is none: an asserted reference where its
 * element shows an image, whose extension is one keystroke (a letter added, dropped, changed
 * or swapped with its neighbour) from an image extension, as `.pn` is from `.png`. Anything
 * further, such as `/avatar.php`, a script that serves an image, is not called a typo.
 */
function likelyTypo(spellings: ReturnType<typeof spellingsOf>, raw: RawReference): string | null {
  if (!raw.asserted || !assertsAnImage(raw.shape)) return null;
  for (const { path } of spellings) {
    const written = extensionOf(path);
    if (written === '') continue;
    const meant = IMAGE_EXTENSIONS.find((image) => oneKeystrokeApart(written, image));
    if (meant !== undefined) {
      return `ends in ${written}, one keystroke from ${meant}: a likely typo, so no image shows here`;
    }
  }
  return null;
}

/** Whether two different texts are one added, dropped, changed or swapped letter apart. */
function oneKeystrokeApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length !== b.length) {
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
    for (let index = 0; index < longer.length; index += 1) {
      if (longer.slice(0, index) + longer.slice(index + 1) === shorter) return true;
    }
    return false;
  }
  const differ = [...a].flatMap((character, index) => (character === b[index] ? [] : [index]));
  const [first, second] = differ;
  if (differ.length === 1) return true;
  return (
    differ.length === 2 &&
    first !== undefined &&
    second === first + 1 &&
    a[first] === b[second] &&
    a[second] === b[first]
  );
}

/**
 * Rung 4b: expand a declared alias and look the result up, in every spelling given, literal
 * first, recording the spelling that matched as rung 4 does. Separate from `resolveOne`
 * because an alias can expand to several candidates, a loop the ladder's sequence of single
 * tests should not carry.
 */
function resolveThroughAlias(
  spellings: readonly { readonly spelling: PathSpelling; readonly path: string }[],
  raw: RawReference,
  context: ResolveContext,
): Reference | null {
  for (const { spelling, path: spelled } of spellings) {
    for (const candidate of throughDeclared(spelled, raw, context)) {
      const target = context.index.lookupExact(candidate);
      if (target === null) continue;
      return {
        ...raw,
        resolution: 'resolved',
        confidence: raw.ceiling,
        resolvedPath: target,
        // An alias is a base the project configured, as strong as a serving root, so it
        // reuses `serving-root` rather than adding a `resolvedVia` value every consumer
        // would handle the same way.
        resolvedVia: 'serving-root',
        ...(spelling === 'literal' ? {} : { spelling }),
      };
    }
  }
  return null;
}

/**
 * Rung 4a: the spellings of a `new URL` name that the nearest Vite config's aliases map,
 * looked up through them. Vite's asset plugin resolves the name with Vite's own alias and
 * resolve plugins only, so a tsconfig key does not apply, and an alias that matches is its
 * only answer: a miss through it is out of scope when the file is on disk, else unresolved.
 */
function throughViteAlias(
  spellings: readonly { readonly spelling: PathSpelling; readonly path: string }[],
  raw: RawReference,
  context: ResolveContext,
): Reference | null {
  const mapped = spellings.filter(
    ({ path }) => matchingRule(context.aliases, path, raw.file)?.tool === 'vite',
  );
  if (mapped.length === 0) return null;
  const expanded = mapped.flatMap(({ path }) => expandAlias(context.aliases, path, raw.file));
  return (
    resolveThroughAlias(mapped, raw, context) ??
    firstOutOfScope(expanded, raw, context) ??
    unlinked(raw, 'unresolved-alias')
  );
}

/**
 * Rung 5b: a `new URL` name found in a package, as Vite's asset plugin looks for one once the
 * module's folder misses it: a name that starts with a letter, digit, `_` or `@`, under the
 * `node_modules` of the module's folder or of any folder above it. The file is looked for
 * where it would sit; a package's `exports` map is not read.
 */
function inPackage(path: string, raw: RawReference, context: ResolveContext): Reference | null {
  if (!/^[A-Za-z0-9_@]/.test(path) || isDrivePath(path) || path.includes('://')) return null;
  for (let folder = dirname(raw.file); ; folder = dirname(folder)) {
    const candidate = toPosix(resolvePath(folder, 'node_modules', path));
    if (context.exists(candidate)) {
      return {
        ...raw,
        resolution: 'out-of-scope',
        confidence: 'unsafe',
        resolvedPath: candidate,
        exclusionReason: PACKAGE_FILE,
      };
    }
    if (dirname(folder) === folder) return null;
  }
}

const PACKAGE_FILE = 'names a file inside an npm package, which is not an indexed asset';

/**
 * Rung 2 through a declared alias: each expansion of the pattern, in the order rung 4b tries
 * them, globbed as `matchPattern` globs a candidate, and the first that names an asset wins.
 * The holes are marked before the alias is expanded, so a key's prefix, and any text after
 * its `*`, has to lie wholly in the text the author fixed. A link through an alias is
 * recorded as `serving-root`, as rung 4b records one.
 */
function matchThroughAlias(
  pattern: string,
  raw: RawReference,
  context: ResolveContext,
): readonly string[] {
  if (!isAliasShapedPattern(pattern, raw.kind)) return [];
  for (const candidate of throughDeclared(withHoles(pattern), raw, context)) {
    const matches = context.index.matchGlob(candidate);
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * Rung 2 for a bundler's glob: every asset the pattern matches, less any that an `exclude`
 * pattern matches, as Vite globs. Nothing left is `dynamic`, or `unresolved-alias` through an
 * alias no rule maps, and never `broken`, unless the pattern can name only files that are not
 * images, which drops it as rung 3 drops `inter.woff2`.
 */
function resolveGlob(
  raw: RawReference,
  glob: BundlerGlob,
  context: ResolveContext,
): Reference | null {
  const { matches, via } = globMatches(raw.rawPath, raw, glob.dot, context);
  const excluded = new Set(
    glob.exclude.flatMap((pattern) => globMatches(pattern, raw, glob.dot, context).matches),
  );
  const [first, ...rest] = matches.filter((match) => !excluded.has(match));
  if (first === undefined) {
    if (globNamesNoImage(raw.rawPath)) return null;
    return unlinked(
      raw,
      throughUnmappedAlias(raw.rawPath, raw, context) ? 'unresolved-alias' : 'dynamic',
    );
  }
  return {
    ...raw,
    resolution: 'resolved-pattern',
    confidence: 'medium',
    resolvedPaths: [first, ...rest],
    resolvedVia: via,
  };
}

/**
 * The assets one glob pattern matches, from the first base that holds any. The bases are
 * Vite's: `./` and `../` start at the module's folder, anything else not rooted goes through a
 * declared alias, and `/` starts at the root the nearest Vite config serves the file from, the
 * app's folder in a monorepo. A `/` pattern is then tried against the serving roots and the
 * project root, as any root-relative pattern is, since a glob keeps what it links and a link
 * missed would call a loaded image unused. One that starts with `**` matches at any depth,
 * which inside the project is the same as from its root.
 */
function globMatches(
  pattern: string,
  raw: RawReference,
  dot: boolean,
  context: ResolveContext,
): { matches: readonly string[]; via: ResolvedVia } {
  const candidates: readonly Candidate[] = pattern.startsWith('**')
    ? [{ path: posix.join(toPosix(resolvePath(context.root)), pattern), via: 'project-root' }]
    : [
        ...fromViteRoot(pattern, raw, context),
        ...candidatePaths(pattern, raw, context.root, context.publicDirs),
        ...(isAliasShaped(pattern, raw.kind)
          ? throughDeclared(pattern, raw, context).map((path) => ({
              path,
              via: 'serving-root' as const,
            }))
          : []),
      ];
  for (const candidate of candidates) {
    const matches = context.index.matchBundlerGlob(candidate.path, pattern, dot);
    if (matches.length > 0) return { matches, via: candidate.via };
  }
  return { matches: [], via: 'file' };
}

/**
 * Rung 2 for a bundler's context: every asset under the directory that the call takes, as
 * webpack lists `require.context` (see `contextTakes`). Only a directory written from the
 * module's folder is listed. Any other goes through webpack's own resolution, which Upfly does
 * not read, so it is left unresolved as a pattern through an unmapped alias is. Nothing taken,
 * or an expression that cannot be built, is `dynamic`, never `broken`.
 */
function resolveBundlerContext(
  raw: RawReference,
  bundlerContext: BundlerContext,
  context: ResolveContext,
): Reference {
  const directory = contextDirectory(raw);
  if (!isRelativeRequest(directory)) {
    return unlinked(
      raw,
      throughUnmappedAlias(directory, raw, context) ? 'unresolved-alias' : 'dynamic',
    );
  }
  const filter = contextFilter(bundlerContext);
  if (filter === undefined) return unlinked(raw, 'dynamic');
  const base = toPosix(resolvePath(dirname(raw.file), directory));
  const [first, ...rest] = context.index.under(base, (fromDirectory) =>
    contextTakes(bundlerContext.recursive, filter, fromDirectory),
  );
  if (first === undefined) return unlinked(raw, 'dynamic');
  return {
    ...raw,
    resolution: 'resolved-pattern',
    confidence: 'medium',
    resolvedPaths: [first, ...rest],
    resolvedVia: 'file',
  };
}

/**
 * The directory a context's request names, as webpack reads the request: any inline loaders,
 * up to the last `!`, and any query or fragment are not part of it.
 */
function contextDirectory(reference: RawReference): string {
  const request = provenPath(reference);
  return splitPathSuffix(request.slice(request.lastIndexOf('!') + 1)).path;
}

/** Whether a request is relative as webpack's resolver reads one: `.`, `..`, `./…`, `../…`. */
function isRelativeRequest(request: string): boolean {
  return /^\.\.?(?:\/|$)/.test(request);
}

/**
 * A context's regular expression: `null` when the call gives none, which takes every file, and
 * `undefined` when it cannot be built here, such as one that uses a flag this Node does not know.
 */
function contextFilter(bundlerContext: BundlerContext): RegExp | null | undefined {
  const { filter } = bundlerContext;
  if (filter === undefined) return null;
  try {
    return new RegExp(filter.source, filter.flags);
  } catch {
    return undefined;
  }
}

/**
 * Whether a context takes a file, given its path from the context's directory, as webpack lists
 * one: never a file or folder whose name starts with a dot, a file below the directory's own
 * folder only when the call recurses, and only a path the expression matches once written with
 * a leading `./`, such as `./sub/a.png`.
 */
function contextTakes(recursive: boolean, filter: RegExp | null, fromDirectory: string): boolean {
  const segments = fromDirectory.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  if (!recursive && segments.length > 1) return false;
  if (filter === null) return true;
  // A `g` or `y` flag would start each test where the last match ended.
  filter.lastIndex = 0;
  return filter.test(`./${fromDirectory}`);
}

/**
 * Whether a bundler's context could take an asset, for the audit's sweep to hedge by when the
 * resolver linked nothing. A directory written from the module's folder is read from there.
 * Any other could stand for a folder anywhere, so its segments after any leading `/` and alias
 * token have to name some folder on the asset's path. Case is ignored, as the sweep ignores
 * it, and an expression that cannot be built leaves every file one the call could take.
 *
 * @param reference A reference whose `bundlerContext` is set, its `rawPath` the directory.
 * @param root The project root.
 * @returns A test of an asset's POSIX path relative to the project root.
 * @example
 * // `require.context('./icons', false, filter)` in `src/app.js`
 * const couldTake = contextCouldTake(reference, root);
 * couldTake('src/icons/one.png'); // true
 * couldTake('src/icons/old/two.png'); // false: the call does not recurse
 */
export function contextCouldTake(
  reference: RawReference,
  root: string,
): (relative: string) => boolean {
  const bundlerContext = reference.bundlerContext ?? { recursive: true };
  const filter = contextFilter(bundlerContext) ?? null;
  const takes = (fromDirectory: string): boolean =>
    contextTakes(bundlerContext.recursive, filter, fromDirectory);
  const directory = contextDirectory(reference);
  if (isRelativeRequest(directory)) {
    const base = relativePath(root, resolvePath(dirname(reference.file), directory)).toLowerCase();
    return (asset) =>
      base === ''
        ? takes(asset)
        : asset.toLowerCase().startsWith(`${base}/`) && takes(asset.slice(base.length + 1));
  }
  const fixed = directory.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = fixed === '' ? [] : fixed.split('/');
  const folder = (/^[@~#$]/.test(fixed) ? segments.slice(1) : segments).join('/').toLowerCase();
  return (asset) => {
    const lower = asset.toLowerCase();
    // Each folder on the asset's path could be the one the directory stands for.
    for (let start = 0; ; ) {
      if (folder === '') {
        if (takes(asset.slice(start))) return true;
      } else if (lower.startsWith(`${folder}/`, start)) {
        if (takes(asset.slice(start + folder.length + 1))) return true;
      }
      const slash = lower.indexOf('/', start);
      if (slash === -1) return false;
      start = slash + 1;
    }
  };
}

/** A `/` pattern read from the root the nearest Vite config serves the file from, if any. */
function fromViteRoot(pattern: string, raw: RawReference, context: ResolveContext): Candidate[] {
  const root = pattern.startsWith('/') ? viteRootOf(context.aliases, raw.file) : null;
  return root === null ? [] : [{ path: posix.join(root, pattern), via: 'serving-root' }];
}

/**
 * Whether every name a glob could match shows an extension that is not an image's, read from
 * its last segment: `*.vue` and `*.{ts,tsx}` can name no image, while `*` and `*.{png,md}` can.
 */
function globNamesNoImage(pattern: string): boolean {
  const last = pattern.slice(pattern.lastIndexOf('/') + 1);
  return withFinalBraceExpanded(last).every((name) => {
    const extension = /\.[A-Za-z0-9]+$/.exec(name)?.[0].toLowerCase();
    return extension !== undefined && !isImageExtension(extension);
  });
}

/** `*.{ts,tsx}` as `*.ts` and `*.tsx`; a name that does not end in a brace, alone. */
function withFinalBraceExpanded(name: string): readonly string[] {
  if (!name.endsWith('}')) return [name];
  const open = matchingOpenBrace(name, name.length - 1);
  if (open === -1) return [name];
  const prefix = name.slice(0, open);
  return topLevelAlternatives(name.slice(open + 1, -1)).map((choice) => `${prefix}${choice}`);
}

/**
 * Whether a pattern is written through an alias no declared rule covers. A package-shaped
 * pattern is not an alias: it names files inside `node_modules`, and stays `dynamic`, as does
 * any bare module name.
 */
function throughUnmappedAlias(
  pattern: string,
  raw: RawReference,
  context: ResolveContext,
): boolean {
  const fixed = withHoles(pattern);
  return (
    isAliasShapedPattern(pattern, raw.kind) &&
    !isBareSpecifier(fixed, raw.kind) &&
    !isPackageSpecifier(fixed, raw.kind) &&
    expandAlias(context.aliases, fixed, raw.file).length === 0
  );
}

/**
 * The paths an alias-shaped path leads to through what the project declares. An import's is a
 * module name, so a name no alias maps is also looked for under the tsconfig's `baseUrl`.
 */
function throughDeclared(
  path: string,
  raw: RawReference,
  context: ResolveContext,
): readonly string[] {
  return expandAlias(context.aliases, path, raw.file, { baseUrl: raw.kind === 'import' });
}

/**
 * Whether a pattern is written against an alias, read from its fixed text. One that starts
 * with a hole, such as `${base}/img/${n}.png`, has no fixed start for an alias to be.
 */
function isAliasShapedPattern(pattern: string, kind: RawReference['kind']): boolean {
  const fixed = withHoles(pattern);
  return !fixed.startsWith(HOLE) && isAliasShaped(fixed, kind);
}

/**
 * Whether an alias-shaped path is really a package specifier.
 *
 * The two look alike and mean different things. `@/assets/logo.png` is the Next and Vite
 * alias convention, an empty scope no package registry permits, while
 * `@11ty/logo/img/logo.png` is a scoped package and a bare `lodash/x.png` in an `import` an
 * unscoped one. A package's files live in `node_modules`, which the walk prunes, so the
 * asset set never holds them.
 */
function isPackageSpecifier(path: string, kind: RawReference['kind']): boolean {
  // `@scope/name/subpath`, and the subpath is required: the `out-of-scope` reason claims a
  // file inside a package, and `@missing/astro.png` is only a scope and a name. `@/…` has
  // an empty scope and fails `[^/]+`.
  if (/^@[^/]+\/[^/]+\//.test(path)) return true;
  // An unscoped name needs a path after it for the same reason: `lodash/x.png`, never `x.png`.
  return isBareSpecifier(path, kind) && path.includes('/');
}

/**
 * Whether a path is a bare module name: in an import, neither relative nor rooted, and not
 * written with an alias's first character. An `@` path is a scope or an alias, which
 * `isPackageSpecifier` tells apart, and no npm package name starts with `$`, so `$lib/…` is an
 * alias, as SvelteKit writes one.
 */
function isBareSpecifier(path: string, kind: RawReference['kind']): boolean {
  return kind === 'import' && isAliasShaped(path, kind) && !/^[@~#$]/.test(path);
}

/**
 * Whether a path is written against an alias rather than the filesystem.
 *
 * `@/…`, `~/…` and `#…` are the conventional alias prefixes. A bare specifier is
 * alias-shaped too, but only in an `import`: in CSS or HTML, `images/logo.png` is an
 * ordinary relative path, while in JavaScript it is a package name.
 */
function isAliasShaped(path: string, kind: RawReference['kind']): boolean {
  if (path.startsWith('@') || path.startsWith('~') || path.startsWith('#')) return true;
  if (kind !== 'import') return false;
  return !path.startsWith('.') && !path.startsWith('/') && !isDrivePath(path);
}

/**
 * Whether any spelling of a path is written against an alias: `%7E/…` decodes, and
 * Markdown's `\~/…` reads, as `~/…`.
 */
function aliasShapedIn(
  spellings: readonly { readonly path: string }[],
  kind: RawReference['kind'],
): boolean {
  return spellings.some(({ path }) => isAliasShaped(path, kind));
}

/** Stands in for an interpolation (`${…}`, `#{…}` or `@{…}`) while a template is globbed. */
const HOLE = String.fromCharCode(0xe000);

/**
 * Assets, indexed for the resolver's lookups.
 *
 * Paths are compared POSIX-normalised so that a reference resolved on Windows and
 * the same one resolved on Linux agree, and lower-cased as well when case is folded.
 */
class AssetIndex {
  private readonly byPath: ReadonlyMap<string, string>;
  /** Every asset by its path in lower case, the first in sorted order where two fold alike. */
  private readonly byFoldedPath: ReadonlyMap<string, string>;
  private readonly ordered: readonly string[];
  private readonly unindexed: (path: string) => string | null;
  private readonly foldCase: boolean;

  /**
   * @param unindexed see `ResolveOptions.unindexed`
   * @param foldCase see `ResolveOptions.foldCase`
   */
  constructor(
    assets: readonly Asset[],
    unindexed: ((path: string) => string | null) | undefined,
    foldCase: boolean,
  ) {
    this.foldCase = foldCase;
    const byPath = new Map<string, string>();
    for (const asset of assets) byPath.set(this.keyOf(toPosix(asset.path)), asset.path);
    this.byPath = byPath;
    this.ordered = [...byPath.keys()].sort(compareStrings);
    const byFoldedPath = new Map<string, string>();
    for (const key of this.ordered) {
      const folded = key.toLowerCase();
      const native = byPath.get(key);
      if (native !== undefined && !byFoldedPath.has(folded)) byFoldedPath.set(folded, native);
    }
    this.byFoldedPath = byFoldedPath;
    this.unindexed = unindexed ?? (() => null);
  }

  private keyOf(path: string): string {
    return this.foldCase ? path.toLowerCase() : path;
  }

  /** The file a literal path names, or `null`. */
  lookup(
    path: string,
    raw: RawReference,
    root: string,
    publicDirs: readonly string[],
  ): Candidate | null {
    for (const candidate of candidatePaths(path, raw, root, publicDirs)) {
      const match = this.lookupExact(candidate.path);
      if (match !== null) return { path: match, via: candidate.via };
    }
    return null;
  }

  /**
   * The asset, or else the unindexed file, at an already-absolute POSIX path, or `null`. An
   * expanded alias is already complete, its base taken from the config, so it skips the
   * candidates `lookup` builds.
   */
  lookupExact(path: string): string | null {
    return this.byPath.get(this.keyOf(path)) ?? this.unindexed(path);
  }

  /**
   * The asset a literal path names when letter case is ignored, or `null`: the file Windows
   * and macOS load where a Linux server finds nothing. Tried in `lookup`'s order.
   */
  lookupIgnoringCase(
    path: string,
    raw: RawReference,
    root: string,
    publicDirs: readonly string[],
  ): string | null {
    for (const candidate of candidatePaths(path, raw, root, publicDirs)) {
      const match = this.byFoldedPath.get(candidate.path.toLowerCase());
      if (match !== undefined) return match;
    }
    return null;
  }

  /**
   * Every asset a template pattern names. All of them: linking only the first would leave
   * the rest looking unreferenced, a false `dead` finding.
   */
  matchPattern(
    rawPath: string,
    raw: RawReference,
    root: string,
    publicDirs: readonly string[],
  ): { matches: readonly string[]; via: ResolvedVia } {
    for (const candidate of candidatePaths(withHoles(rawPath), raw, root, publicDirs)) {
      const matches = this.matchGlob(candidate.path);
      // The provenance has to be the candidate that actually matched, so the
      // matches and the `via` cannot disagree about which base was used.
      if (matches.length > 0) return { matches, via: candidate.via };
    }

    return { matches: [], via: 'file' };
  }

  /** Every asset an absolute POSIX path with holes names, anchored at both ends. */
  matchGlob(pathWithHoles: string): readonly string[] {
    return this.matchRegExp(globRegex(pathWithHoles, false, this.foldCase));
  }

  /**
   * Every asset a bundler's glob names once resolved against a base, `candidate` being the
   * pattern with its base written in. See `bundlerGlobRegExp`.
   */
  matchBundlerGlob(candidate: string, pattern: string, dot: boolean): readonly string[] {
    const expression = bundlerGlobRegExp(candidate, pattern, dot, this.foldCase);
    return expression === null ? [] : this.matchRegExp(expression);
  }

  /**
   * Every asset under an absolute POSIX directory whose path from it `takes` accepts, for a
   * bundler's context. The path is read from the asset's own spelling, so an index that folds
   * case still hands `takes` the name as it is on disk.
   */
  under(directory: string, takes: (fromDirectory: string) => boolean): readonly string[] {
    const prefix = this.keyOf(`${directory.replace(/\/+$/, '')}/`);
    const depth = prefix.split('/').length - 1;
    const matches: string[] = [];
    for (const key of this.ordered) {
      if (!key.startsWith(prefix)) continue;
      const native = this.byPath.get(key);
      if (native === undefined) continue;
      if (takes(toPosix(native).split('/').slice(depth).join('/'))) matches.push(native);
    }
    return matches;
  }

  private matchRegExp(expression: RegExp): readonly string[] {
    const matches: string[] = [];
    for (const assetPath of this.ordered) {
      if (!expression.test(assetPath)) continue;
      const native = this.byPath.get(assetPath);
      if (native !== undefined && !matches.includes(native)) matches.push(native);
    }
    return matches;
  }
}

/** One place a path might live, and how the engine got there. */
interface Candidate {
  readonly path: string;
  readonly via: ResolvedVia;
}

/**
 * Where a path might live, in the order the candidates are tried.
 *
 * A relative path resolves against the referencing file, except a module name in an import,
 * which has no candidate here. A root-relative one is tried against each serving root whose
 * app directory is an ancestor of the file, nearest first (see `servingRootsFor`), then
 * against the project root, where a plain static site serves `/hero.png` from. A Windows
 * drive path is absolute, and has a candidate only inside the project. See "The resolver's
 * seven outcomes" in ARCHITECTURE.md.
 */
function candidatePaths(
  path: string,
  raw: RawReference,
  root: string,
  publicDirs: readonly string[],
): readonly Candidate[] {
  // Module resolution never looks for a name that is not relative beside the importing file:
  // it reads it through aliases and `baseUrl`, then as a package.
  if (raw.kind === 'import' && isAliasShaped(path, raw.kind)) return [];
  if (isDrivePath(path)) {
    const inside = drivePathInProject(path, root);
    return inside === null ? [] : [{ path: inside, via: 'file' }];
  }

  if (!path.startsWith('/')) {
    const relative: Candidate[] = [
      { path: toPosix(resolvePath(dirname(raw.file), path)), via: 'file' },
    ];

    // Speculative references only. In every module system `./` means file-relative, so a
    // project-root fallback on an asserted `import './missing.png'` could link a broken
    // import to an unrelated file. A path-shaped string in a data object is already a
    // guess, and the code may well join it to the project root, as astro-docs does. The
    // match is recorded as `speculative-root`: it keeps the asset alive, and its text is
    // never rewritten.
    if (!raw.asserted) {
      relative.push({
        path: toPosix(resolvePath(root, stripDotSlash(path))),
        via: 'speculative-root',
      });
    }
    return relative;
  }

  const withoutLeadingSlash = path.slice(1);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate): void => {
    if (seen.has(candidate.path)) return;
    seen.add(candidate.path);
    candidates.push(candidate);
  };

  for (const publicDir of servingRootsFor(publicDirs, raw.file, root)) {
    add({ path: toPosix(resolvePath(root, publicDir, withoutLeadingSlash)), via: 'serving-root' });
  }

  // The project root, tried last. A plain static site really does serve `/hero.png`
  // from here, but when serving roots were named and none held the path this is a
  // fallback rather than a statement, which is why it is recorded as `project-root`.
  add({ path: toPosix(resolvePath(root, withoutLeadingSlash)), via: 'project-root' });
  return candidates;
}

/**
 * A drive path read by Windows rules (`..` collapsed, either slash a separator) and written
 * with `/`, as the asset index spells paths. The same on every platform, so a report made
 * on Linux says what one made on Windows does.
 */
function posixDrivePath(path: string): string {
  return win32.resolve(path).replaceAll('\\', '/');
}

/**
 * How the asset index spells a drive path that lies inside the project, or `null` when it
 * lies outside. Windows compares paths without regard to case, so the project root's part
 * is matched that way and then spelled as the root spells it; the rest keeps its case, as
 * a relative path's does.
 */
function drivePathInProject(path: string, root: string): string | null {
  const absolute = posixDrivePath(path);
  const projectRoot = toPosix(resolvePath(root)).replace(/\/$/, '');
  if (!absolute.toLowerCase().startsWith(`${projectRoot.toLowerCase()}/`)) return null;
  return `${projectRoot}${absolute.slice(projectRoot.length)}`;
}

/** `./a/b.png` -> `a/b.png`, leaving `../` alone: that really is file-relative. */
function stripDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * The serving roots that could serve this file, nearest first.
 *
 * Only ancestors: a serving root's app directory is its parent (`apps/v4/public` belongs to
 * `apps/v4`), and a file outside that app is not served by it. A monorepo's roots serve
 * different URL spaces, so trying them all would link one app's reference to another app's
 * asset, and a rewrite would then point it at a file its app does not serve. A top-level
 * root such as `public` belongs to the project root, so it applies to every file.
 */
function servingRootsFor(
  publicDirs: readonly string[],
  fromFile: string,
  root: string,
): readonly string[] {
  const file = toPosix(fromFile);
  const projectRoot = toPosix(resolvePath(root));

  const ancestors = publicDirs.flatMap((publicDir) => {
    const served = toPosix(resolvePath(root, publicDir));
    // `publicDir: ''` means the project root itself serves the URL space; its app
    // directory is the root, not the root's parent.
    const appDirectory = served === projectRoot ? projectRoot : toPosix(resolvePath(served, '..'));
    if (file !== appDirectory && !file.startsWith(`${appDirectory}/`)) return [];
    return [{ publicDir, depth: appDirectory.length }];
  });

  return ancestors
    .sort((a, b) => b.depth - a.depth || compareStrings(a.publicDir, b.publicDir))
    .map((entry) => entry.publicDir);
}

/**
 * A pattern's path as the resolver globs it: every interpolation a hole, and any query or
 * fragment removed.
 */
function withHoles(rawPath: string): string {
  // Every interpolation syntax becomes a hole, not only JavaScript's `${…}`: a SCSS
  // `#{$mode}` left in place would be globbed literally and match nothing.
  let marked = rawPath;
  for (const interpolation of INTERPOLATIONS) marked = marked.replace(interpolation, HOLE);
  return splitPathSuffix(marked).path;
}

/**
 * Whether a root-relative pattern could name an asset from a serving root the run did not
 * find.
 *
 * `matchPattern` anchors its glob at each serving root it was given and then at the project
 * root. A run that could not find its serving root globs against the wrong directories, so
 * the pattern ends `dynamic` while the files it names sit on disk. This is the same glob
 * with the serving root left open: the pattern has to match the end of an asset's path, in
 * whole segments, so every directory it fixes must be there. Case is ignored, as the
 * audit's sweep ignores it everywhere, because Windows does.
 *
 * @param pattern A root-relative path with holes, as the reference's text proves it.
 * @returns A test of an asset's POSIX path relative to the project root.
 * @example
 * const couldName = servedFromAnyRoot('/img/pattern-${n}.png');
 * couldName('src/img/pattern-1.png'); // true
 * couldName('src/pattern-1.png'); // false: the pattern fixes `img/`
 */
export function servedFromAnyRoot(pattern: string): (relative: string) => boolean {
  const path = posix.normalize(withHoles(pattern));
  const glob = globRegex(path.startsWith('/') ? path.slice(1) : path, true);
  return (relative) => glob.test(relative);
}

/**
 * Turn a resolved path containing holes into an anchored regular expression.
 *
 * A hole becomes `[^/]*`: it matches within one path segment, so
 * `` `/img/${name}.png` `` cannot reach into a subdirectory and pull in assets the
 * author never meant. Everything else is escaped literally. With `openBase`, any
 * directories may come before the path and case is ignored, for `servedFromAnyRoot`.
 * `ignoreCase` ignores it with a fixed base too, for an index that folds case.
 */
function globRegex(pathWithHoles: string, openBase = false, ignoreCase = openBase): RegExp {
  const escaped = pathWithHoles
    .split(HOLE)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  const flags = ignoreCase ? 'i' : '';
  return new RegExp(openBase ? `^(?:.*/)?${escaped}$` : `^${escaped}$`, flags);
}

/**
 * Whether a bundler's glob could name an asset from a base the run did not find, as
 * `servedFromAnyRoot` asks it of a pattern with holes. The pattern, less its leading `./`,
 * `../` and `/` and any alias token, has to match the end of the asset's path in whole
 * segments. Case is ignored, as the audit's sweep ignores it.
 *
 * @param pattern A glob as written, such as `@/assets/*.{png,jpg}`.
 * @param dot Whether its wildcards match a leading dot.
 * @returns A test of an asset's POSIX path relative to the project root.
 * @example
 * const couldName = globFromAnyRoot('/src/img/*.png', false);
 * couldName('apps/web/src/img/one.png'); // true
 * couldName('apps/web/src/one.png'); // false: the pattern fixes `img/`
 */
export function globFromAnyRoot(pattern: string, dot: boolean): (relative: string) => boolean {
  const fixed = pattern.replace(/^(?:\.{1,2}\/)+/, '').replace(/^\/+/, '');
  const rest = /^[@~#$]/.test(fixed) ? fixed.slice(fixed.indexOf('/') + 1) : fixed;
  const source = globSource(rest, dot);
  if (source === null) return () => false;
  const expression = new RegExp(`^(?:.*/)?${source}$`, 'i');
  return (relative) => expression.test(relative);
}

/**
 * A bundler's glob pattern resolved against a base, as an anchored regular expression. The
 * text `candidate` shares with the end of `pattern` is the pattern's own and is read as glob
 * syntax; what comes before it is the base, matched literally, as Vite escapes a base, so a
 * folder named `[draft]` is no character class. `null` when `globSource` cannot read it.
 */
function bundlerGlobRegExp(
  candidate: string,
  pattern: string,
  dot: boolean,
  ignoreCase: boolean,
): RegExp | null {
  let shared = 0;
  const most = Math.min(candidate.length, pattern.length);
  while (
    shared < most &&
    candidate.charAt(candidate.length - 1 - shared) === pattern.charAt(pattern.length - 1 - shared)
  ) {
    shared += 1;
  }
  const base = candidate.slice(0, candidate.length - shared);
  const source = globSource(candidate.slice(base.length), dot, base.endsWith('/'));
  if (source === null) return null;
  return new RegExp(`^${escapeRegExp(base)}${source}$`, ignoreCase ? 'i' : '');
}

/**
 * A glob as the source of a regular expression, read as picomatch reads it, the matcher behind
 * Vite's globbing. `*` and `?` stay inside one folder, a `**` segment crosses any number of
 * folders, none included, `[...]` is a class (negated by `^` alone, as picomatch reads it) and
 * `{a,b}` offers alternatives. With `dot` false a wildcard never matches a name's leading dot.
 * A `**` that is not a whole segment may cross folders too, which picomatch allows in some
 * positions: reading more than the bundler loads keeps an image, never loses one. `null` for
 * what this does not read, such as an extglob (`@(a|b)`) or a range (`{1..3}`).
 */
function globSource(glob: string, dot: boolean, startsSegment = true): string | null {
  let source = '';
  // One entry for each brace still open: whether it offers alternatives.
  const braces: boolean[] = [];
  for (let index = 0; index < glob.length; index += 1) {
    const segmentStart = index === 0 ? startsSegment : glob.charAt(index - 1) === '/';
    const token = globToken(glob, index, { dot, segmentStart, braces });
    if (token === null) return null;
    source += token.source;
    index = token.end;
  }
  return source;
}

interface GlobState {
  readonly dot: boolean;
  /** Whether the token starts a path segment, where a wildcard may not match a dot. */
  readonly segmentStart: boolean;
  readonly braces: boolean[];
}

/** One token's regular expression source, and the index of its last character. */
interface GlobToken {
  readonly source: string;
  readonly end: number;
}

function globToken(glob: string, index: number, state: GlobState): GlobToken | null {
  const char = glob.charAt(index);
  switch (char) {
    case '\\':
      return index + 1 < glob.length
        ? { source: escapeRegExp(glob.charAt(index + 1)), end: index + 1 }
        : null;
    case '(':
    case ')':
    case '|':
      return null;
    case '*':
      return starToken(glob, index, state);
    case '?':
      return { source: `${noLeadingDot(state)}[^/]`, end: index };
    case '[':
      return classToken(glob, index);
    case '{':
      return braceToken(glob, index, state.braces);
    case ',':
      return { source: state.braces.at(-1) === true ? '|' : ',', end: index };
    case '}':
      return { source: state.braces.pop() === true ? ')' : '\\}', end: index };
    default:
      return { source: escapeRegExp(char), end: index };
  }
}

function noLeadingDot(state: GlobState): string {
  return state.dot || !state.segmentStart ? '' : '(?!\\.)';
}

function starToken(glob: string, index: number, state: GlobState): GlobToken {
  let end = index;
  while (glob.charAt(end + 1) === '*') end += 1;
  if (end === index || !state.segmentStart) {
    return { source: `${noLeadingDot(state)}[^/]*`, end };
  }
  const name = state.dot ? '[^/]*' : '(?!\\.)[^/]*';
  const next = glob.charAt(end + 1);
  if (next === '/') return { source: `(?:${name}/)*`, end: end + 1 };
  if (next === '') return { source: `(?:${name}(?:/${name})*)?`, end };
  return { source: `(?:${name}/)*${name}`, end };
}

function classToken(glob: string, index: number): GlobToken {
  const close = glob.indexOf(']', index + 2);
  if (close === -1) return { source: '\\[', end: index };
  const body = glob.slice(index + 1, close);
  const inClass = (text: string): string => text.replace(/[\\\]^[]/g, '\\$&');
  if (body.startsWith('^')) return { source: `[^${inClass(body.slice(1))}/]`, end: close };
  if (body.includes('-')) return { source: `[${inClass(body)}]`, end: close };
  // picomatch also matches the bracket text itself, as a name may hold it.
  return { source: `(?:${escapeRegExp(`[${body}]`)}|[${inClass(body)}])`, end: close };
}

function braceToken(glob: string, index: number, braces: boolean[]): GlobToken | null {
  const close = matchingCloseBrace(glob, index);
  if (close === -1) return { source: '\\{', end: index };
  const body = glob.slice(index + 1, close);
  if (/^(?:-?\d+|[A-Za-z])\.\.(?:-?\d+|[A-Za-z])(?:\.\.-?\d+)?$/.test(body)) return null;
  const alternates = topLevelAlternatives(body).length > 1;
  braces.push(alternates);
  return { source: alternates ? '(?:' : '\\{', end: index };
}

/** The index of the `}` that closes the brace at `open`, or -1. */
function matchingCloseBrace(glob: string, open: number): number {
  let depth = 0;
  for (let index = open; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === '\\') index += 1;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The index of the `{` whose brace `close` closes, or -1. */
function matchingOpenBrace(glob: string, close: number): number {
  for (let index = 0; index < close; index += 1) {
    if (glob.charAt(index) === '{' && matchingCloseBrace(glob, index) === close) return index;
  }
  return -1;
}

/** A brace's body split at its commas, leaving any nested brace whole. */
function topLevelAlternatives(body: string): readonly string[] {
  const choices: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === '\\') index += 1;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      choices.push(body.slice(start, index));
      start = index + 1;
    }
  }
  choices.push(body.slice(start));
  return choices;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
