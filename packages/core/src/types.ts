/**
 * The public data contracts of the engine.
 *
 * These types are the API. Apart from the modules that read or write the disk, core is
 * pure functions over them, which keeps the engine testable without a filesystem.
 *
 * Offsets (`start`, `end`) are UTF-16 code-unit indices, the units JavaScript parsers and
 * `String.prototype.slice` use, not byte offsets: with an emoji or a non-ASCII path in a
 * file, byte offsets would put every later rewrite in the wrong place.
 */

import type { PathSpelling } from './adapters/reference-path.js';
import type { ShapeId } from './adapters/shapes.js';

/** How certain we are that rewriting a reference is safe. */
export type Confidence =
  /** Static import/require that resolved to a file on disk. */
  | 'certain'
  /** String literal in a known attribute or function, resolved on disk. */
  | 'high'
  /**
   * A path with a static prefix and unknown parts (a template literal, a `+` chain),
   * glob-matched against the assets. Never rewritten: the text is assembled at run time.
   */
  | 'medium'
  /** Dynamic or unresolvable. Never rewritten, always reported. */
  | 'unsafe';

/** The syntactic construct a reference was found in. */
export type ReferenceKind =
  | 'import'
  | 'attr'
  | 'css-url'
  | 'md'
  | 'json'
  | 'template'
  /**
   * A path-shaped string literal in JavaScript or TypeScript, guessed rather than
   * asserted, like a string in a JSON file.
   */
  | 'string';

/**
 * What an adapter emits: everything that can be known from syntax alone.
 *
 * Confidence is assigned in two steps, and this is the first. An adapter can see that a
 * path came from a static `import` but not whether it points at a file, because adapters
 * never touch the filesystem. So it reports a `ceiling` and the resolver decides the rest.
 */
export interface RawReference {
  /** Absolute path of the source file containing the reference. */
  readonly file: string;
  /** Start offset of the path text only, excluding surrounding quotes. */
  readonly start: number;
  /** End offset (exclusive) of the path text. */
  readonly end: number;
  /** The path exactly as written in the source. */
  readonly rawPath: string;
  /**
   * The path the source text proves, when that is not `rawPath` itself; absent otherwise.
   *
   * Two cases. A `+` chain such as `'/srcset/' + 'card-' + String(width) + '.jpg'` has no
   * single run of source that is its path, so `rawPath` is the chain's text and this is
   * `/srcset/card-${}.jpg`. A template with a same-file constant written in: given
   * `const ASSET_BASE = '/gallery'`, `` `${ASSET_BASE}/${name}.png` `` is `/gallery/${}.png`.
   * Each unknown part is written `${}`.
   *
   * Read this, not `rawPath`, for what the path is (the glob, the extension test, the
   * report's classification). Keep `rawPath` for where the text is (the range, a
   * citation, a sweep for a filename).
   */
  readonly assembledPath?: string;
  readonly kind: ReferenceKind;
  /**
   * The exact construct the reference was written in, such as `html.img.srcset.w` or
   * `css.image-set`.
   *
   * `kind` is the coarse bucket the resolver reasons with. `shape` is the fine one the
   * suite's matrix (`SHAPES`) is keyed on, and only it can be crossed with a real
   * repository to say what share of its references the tests cover. Required rather than
   * defaulted, so a new emission site cannot join the wrong row unnoticed.
   */
  readonly shape: ShapeId;
  /**
   * The shape of the markup construct whose CSS holds the reference, when the reference's own
   * shape is one CSS owns: `html.style.attribute` for `image-set(url(a.png) 1x)` in a style
   * attribute. The host decides how the text is decoded, since an HTML parser decodes a whole
   * style attribute before CSS reads it. Absent where the shape is the host's own.
   */
  readonly host?: ShapeId;
  /**
   * The best confidence this syntax could ever justify. The resolver assigns the
   * ceiling if the path resolves, and demotes to `unsafe` if it does not.
   */
  readonly ceiling: Confidence;
  /**
   * Whether the syntax asserts this is an asset reference.
   *
   * `true` for an `import`, an `<img src>` or a `url()`: the author said so, and an
   * unresolved one is a broken reference worth reporting. `false` for a path-shaped
   * string that is only a guess, such as one in a JSON file: an unresolved one is dropped
   * from the graph rather than reported as broken, or every `package.json` would produce
   * false findings.
   */
  readonly asserted: boolean;
  /** Why this ceiling was assigned. Surfaced verbatim in the report. */
  readonly note?: string;
  /**
   * Set on a path-shaped value an adapter examined and declined to read as a path, such as
   * a tooltip that names an image; `note` then says why. The resolver never looks one up, so
   * it never links or rewrites anything: it is `discarded` when a spelling of its path shows
   * an image extension, and dropped otherwise. The report counts such values apart from the
   * references, by reason.
   */
  readonly declined?: true;
  /**
   * Set when the range is a whole construct the adapter could not read rather than a path,
   * such as a style attribute or `<style>` block whose CSS does not parse, or a CSS-in-JS
   * template; `rawPath` is the construct's text and `note` says why. No path is read from
   * it, so it resolves `dynamic` whatever its text holds.
   */
  readonly unread?: true;
  /**
   * Set on a pattern a bundler expands into files when it builds, such as each pattern given
   * to `import.meta.glob` other than a `!` one. `rawPath` is then written in glob syntax (`*`,
   * `**`, `?`, `[...]`, `{a,b}`) rather than as a path with holes. With a `medium` ceiling the
   * resolver links every asset it matches, less those an `exclude` pattern matches, and nothing
   * ever rewrites it; an `unsafe` one is a pattern written with escape sequences, which is never
   * linked, and what it could name is hedged.
   */
  readonly glob?: BundlerGlob;
  /**
   * Set on a directory a bundler loads files from when it builds, such as the one given to
   * webpack's `require.context` or `import.meta.webpackContext`. `rawPath` is then the
   * directory. With a `medium` ceiling the resolver links every asset under it that the call
   * takes, and nothing ever rewrites it; an `unsafe` one is a call that could not be read
   * whole, and what it could take is hedged.
   */
  readonly bundlerContext?: BundlerContext;
}

/** What a bundler's glob call says about which files a pattern takes. */
export interface BundlerGlob {
  /**
   * The call's `!` patterns, without the `!`. A file one of them matches is taken by no
   * pattern in the call.
   */
  readonly exclude: readonly string[];
  /** Whether a wildcard also matches a name that starts with a dot. */
  readonly dot: boolean;
}

/**
 * What a bundler's context call says about which files under its directory it takes, as
 * webpack reads `require.context(directory, recursive, filter)`, or the `recursive` and
 * `regExp` options of `import.meta.webpackContext(directory, options)`.
 */
export interface BundlerContext {
  /**
   * Whether files in the folders below the directory are taken too: webpack's default, and
   * the reading of an argument or option the adapter could not read.
   */
  readonly recursive: boolean;
  /**
   * The regular expression a file's path from the directory, written with a leading `./`
   * such as `./sub/a.png`, has to match, as its `source` and `flags`. Absent when the call
   * gives none, or gives one the adapter could not read: every file is then one it takes.
   */
  readonly filter?: { readonly source: string; readonly flags: string };
}

/**
 * The outcome the resolver reached for a reference.
 *
 * Recorded where it is decided, rather than leaving `resolvedPath: null` to stand for
 * several outcomes that the audit, the report and the planner would each have to tell
 * apart again. See "The resolver's seven outcomes" in ARCHITECTURE.md.
 */
export type Resolution =
  /** Points at exactly one asset. */
  | 'resolved'
  /**
   * A `medium` pattern that glob-matched one or more assets, and links all of them.
   * Separate from `resolved` because it carries several paths, and a pattern is never
   * rewritten.
   */
  | 'resolved-pattern'
  /**
   * No static path to resolve: the ceiling was `unsafe`, or a pattern matched no asset (one
   * through an alias no rule maps is `unresolved-alias`). Not `broken`, because nobody typed
   * a wrong path: `url($hero)` is not knowable until the preprocessor runs.
   */
  | 'dynamic'
  /**
   * Points at a file the engine does not index, such as one under an ignored directory
   * or inside an npm package. Not `resolved`, because the target is never converted, so
   * rewriting the reference would break one that works today.
   */
  | 'out-of-scope'
  /** An asserted, literal path that points at nothing: a finding. */
  | 'broken'
  /**
   * A path-shaped guess that did not resolve, or a value an adapter declined to read as a
   * path (`RawReference.declined`), which is never looked up. Counted, never a finding.
   */
  | 'discarded'
  /**
   * Alias-shaped (`@/…`, `~/…`, `#…`, `$lib/…`), as a path or a pattern, and no alias Upfly
   * reads maps it. Upfly reads tsconfig and jsconfig `paths` and a Vite config's
   * `resolve.alias`, so the project may still declare the alias elsewhere, such as in a
   * webpack config or SvelteKit's `kit.alias`.
   */
  | 'unresolved-alias';

/**
 * How a reference reached the asset it points at, which decides whether its text may be
 * rewritten: `file` and `serving-root` may be, `speculative-root` never is, and
 * `project-root` depends on the planner's `RootLinkPolicy`.
 * See "A link says the asset is alive; `resolvedVia` says whether the text may be edited"
 * in ARCHITECTURE.md.
 */
export type ResolvedVia =
  /**
   * Relative to the directory of the referencing file, the ordinary case. A Windows drive
   * path inside the project is resolved this way too.
   */
  | 'file'
  /** A root-relative path against a serving root, or a path through a declared alias. */
  | 'serving-root'
  /**
   * A root-relative path resolved against the project root, because no serving root held
   * it. On a static site with no build step the project root is the serving root, so this
   * is the ordinary case there. When a serving root is declared, a path that missed it
   * and exists at the project root may be coincidence rather than a link.
   */
  | 'project-root'
  /**
   * A speculative `./` path that failed file-relative and was retried against the project
   * root: a guess at the base of a string that was already a guess. It shows the asset is
   * alive and nothing more.
   */
  | 'speculative-root';

/**
 * What the resolver produces: a raw reference plus what it points at.
 *
 * A union on `resolution`, so checking it narrows the other fields. Ask `isLinked()`
 * rather than comparing `resolution` by hand: two outcomes are linked, and a test for
 * only one of them compiles and misses the other.
 */
export type Reference =
  | (RawReference & {
      readonly resolution: 'resolved';
      /** Equal to the raw reference's `ceiling`: it resolved, so the ceiling stands. */
      readonly confidence: Confidence;
      readonly resolvedPath: string;
      readonly resolvedVia: ResolvedVia;
      /**
       * Which spelling of `rawPath` the lookup answered on. Absent means `literal`.
       *
       * Recorded because the text cannot tell: `enc%20name.png` may be a file with a
       * percent sign in its name, and `hero%20image.png` one called `hero image.png`.
       * Only the lookup knows which answered, and a rewrite that guessed from `rawPath`
       * could put a raw space into a URL. See `spell()` in `adapters/reference-path.ts`.
       */
      readonly spelling?: PathSpelling;
    })
  | (RawReference & {
      readonly resolution: 'resolved-pattern';
      /** Only a `medium` ceiling can reach the glob branch, so the type says so. */
      readonly confidence: 'medium';
      /** Every asset the pattern matched. Non-empty by construction. */
      readonly resolvedPaths: readonly [string, ...string[]];
      readonly resolvedVia: ResolvedVia;
    })
  | (RawReference & {
      readonly resolution: 'out-of-scope';
      /** The target is known, but it is never rewritten. */
      readonly confidence: 'unsafe';
      /** Where it points, or the specifier itself for a file inside an npm package. */
      readonly resolvedPath: string;
      /** Which rule excluded the target, rendered verbatim in the report. */
      readonly exclusionReason: string;
    })
  | (RawReference & {
      readonly resolution: 'broken';
      /** Nothing unresolved is ever rewritten, whatever its syntax promised. */
      readonly confidence: 'unsafe';
      readonly resolvedPath: null;
      /**
       * The asset the path names when letter case is ignored, when one does: Windows and
       * macOS load it through this reference, and a Linux server does not.
       */
      readonly namesIgnoringCase?: string;
    })
  | (RawReference & {
      readonly resolution: Exclude<
        Resolution,
        'resolved' | 'resolved-pattern' | 'out-of-scope' | 'broken'
      >;
      /** Nothing unresolved is ever rewritten, whatever its syntax promised. */
      readonly confidence: 'unsafe';
      readonly resolvedPath: null;
    });

/** A range replacement in a single file. */
export interface Edit {
  /** Start offset, inclusive. */
  readonly start: number;
  /** End offset, exclusive. Equal to `start` for a pure insertion. */
  readonly end: number;
  /** Text to put in place of `[start, end)`. */
  readonly replacement: string;
  /**
   * The text `[start, end)` held when the edit was worked out. When present, `applyEdits`
   * refuses a source whose range holds anything else, so an edit counted in one text is
   * never applied to another.
   */
  readonly expected?: string;
  /**
   * The text is inside a comment, which no page loads: the path in it moves with the
   * references, and is never counted as one.
   */
  readonly inComment?: true;
}

/**
 * Reads one file format and finds asset references in it.
 *
 * Contract:
 * - An adapter never touches the filesystem.
 * - An adapter never resolves paths; it reports `rawPath` and the resolver decides.
 * - `findReferences` and `rewrite` are pure functions of their input.
 */
export interface Adapter {
  /** Stable id, e.g. 'javascript', 'html', 'css'. Used in config and reports. */
  readonly id: string;
  /** File extensions this adapter claims, lowercase and dot-prefixed: ['.html']. */
  readonly extensions: readonly string[];
  findReferences(input: { readonly file: string; readonly text: string }): RawReference[];
  rewrite(input: { readonly text: string; readonly edits: readonly Edit[] }): string;
}

/** An image file found on disk. */
export interface Asset {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. The report key. */
  readonly relative: string;
  /** Lowercase extension including the dot. */
  readonly extension: string;
  /** Size on disk, from the `stat` taken during discovery. */
  readonly bytes: number;
}

/** A file some adapter claims and will be parsed for references. */
export interface SourceFile {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. */
  readonly relative: string;
  /** Lowercase extension including the dot. */
  readonly extension: string;
  /** `Adapter.id` of the adapter that claimed this extension. */
  readonly adapterId: string;
}

/** Why discovery declined to look at something. */
export type SkipReason =
  /** A symlink or Windows junction. Not followed, to avoid cycles. */
  | 'symlink'
  /** A directory that could not be read (permissions, a vanished path). */
  | 'unreadable-directory'
  /** A file that could not be stat'ed or read. */
  | 'unreadable-file'
  /** A socket, FIFO, device, or Windows reparse point that is neither file nor directory. */
  | 'not-a-regular-file';

/**
 * One thing discovery could not process, with the reason. Everything the walk declines
 * ends up here and in the report, because a silent skip is a bug.
 */
export interface SkippedEntry {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. */
  readonly relative: string;
  readonly reason: SkipReason;
  /** Human-readable specifics, typically an errno code such as `EACCES`. */
  readonly detail: string;
}

/**
 * Why a file the walk enumerated was never read for references.
 *
 * All three tell the audit the same thing, that the engine did not learn what the file
 * references, so they share one list. The audit needs it: an asset mentioned only in
 * such a file would otherwise be reported as confidently dead.
 */
export type UnscannedReason =
  /** No adapter claims this extension: a `.vue`, a `.yaml`, an `.svg`. */
  | 'unclaimed-extension'
  /** An adapter claimed it and could not parse it. */
  | 'parse-failed'
  /** It could not be read at all, typically because it vanished mid-run. */
  | 'unreadable';

/**
 * A file the engine saw but did not scan.
 *
 * Carries the path, not just the extension, because the audit sweeps these files for
 * the filenames of zero-reference assets: an asset named in one is `possibly-dead`, and
 * the report says which file.
 * See "`possibly-dead`, and why "zero references" is usually a lie" in ARCHITECTURE.md.
 */
export interface UnscannedFile {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. */
  readonly relative: string;
  /** Lowercase extension including the dot, or `''` if there is none. */
  readonly extension: string;
  readonly reason: UnscannedReason;
  /** Parser message or errno code. `''` when the reason needs no detail. */
  readonly detail: string;
}

/** How many files of one extension went unscanned. The report's coverage statement. */
export interface UnscannedExtension {
  /** Lowercase extension including the dot, or `''` for files without one. */
  readonly ext: string;
  readonly fileCount: number;
}

/**
 * A directory the walk refused to descend into, and the rule that stopped it.
 *
 * Recorded because the resolver needs it: a reference into an excluded directory
 * points at a file that really is there, so calling it `broken` is a false positive.
 * The likeliest case is not `node_modules` but a user who puts `legacy/` in
 * `.upflyignore` while `legacy/` is still referenced.
 */
export interface ExcludedRoot {
  /** Absolute path with native separators. */
  readonly path: string;
  /** Path relative to the project root, POSIX-separated. */
  readonly relative: string;
  /** The rule that excluded it, phrased for a report. */
  readonly reason: string;
  /**
   * Whether one of the project's own ignore rules excluded it, rather than the walk pruning
   * it as a dependency, cache, build-output or version-control directory.
   */
  readonly byRule: boolean;
}

/** Everything a single filesystem walk found. */
export interface DiscoveryResult {
  /** Absolute, resolved project root. */
  readonly root: string;
  /** Image files, sorted by `relative`. */
  readonly assets: readonly Asset[];
  /** Adapter-claimed files, sorted by `relative`. */
  readonly sourceFiles: readonly SourceFile[];
  /**
   * How many entries an ignore rule excluded. An ignored directory counts once, not once
   * per file inside it: the walk never looks inside.
   */
  readonly ignoredCount: number;
  /**
   * Every file an ignore rule excluded by name, POSIX-relative and sorted, raster images
   * left out: the walk saw these and did not read them. Files inside an excluded directory
   * are not here, since the walk never looks inside one; `listExcludedFiles` finds them.
   */
  readonly excludedFiles: readonly string[];
  /**
   * Every image an ignore rule excluded by name, POSIX-relative and sorted. A reference to
   * one points into a file the run was told to leave out, which the report says apart from
   * the references with no answer. Images inside an excluded directory are not here, since
   * the walk never looks inside one; `excludedRoots` covers them.
   */
  readonly excludedImages: readonly string[];
  /** Everything skipped with a reason, sorted by `relative`. */
  readonly skipped: readonly SkippedEntry[];
  /**
   * Every directory the walk descended into, POSIX-relative to `root` and sorted, without
   * the root itself. Serving-root detection reads it.
   *
   * Recorded rather than derived from `assets` and `sourceFiles`, because a directory
   * holding only files nothing tracks leaves no trace in either list. Excluded
   * directories are absent, so detection cannot contradict an ignore rule.
   * See "Serving roots" in ARCHITECTURE.md.
   */
  readonly directories: readonly string[];
  /**
   * Files no adapter claimed, sorted by `relative`.
   *
   * Excluded and ignored entries are absent: an ignore rule is an instruction, not a gap
   * in coverage, and those are reported once, as `excludedRoots`. `.svg` appears here and
   * in `assets`: it is both an asset and a container, since `<image href>`, `<use href>`
   * and a `<style>` block inside one are real references that no adapter reads.
   */
  readonly unscannedFiles: readonly UnscannedFile[];
  /**
   * Directories the walk did not descend into, with the rule that excluded each.
   *
   * The resolver prefix-tests references against these so that a path into an
   * excluded directory is reported as `out-of-scope` rather than `broken`.
   */
  readonly excludedRoots: readonly ExcludedRoot[];
}
