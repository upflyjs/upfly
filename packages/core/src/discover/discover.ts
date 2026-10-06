/**
 * Walk a project and find its images and its adapter-claimed source files.
 *
 * One of the few modules that touch the disk: the stages after it are pure functions of
 * what it returns or of an injected port. It also records every file no adapter claims,
 * which the audit sweeps for the names of unreferenced assets before calling one dead.
 *
 * A hand-written walker rather than a glob library, because the speed comes from never
 * entering directories such as `node_modules`, not from faster matching. See "Discovery"
 * in ARCHITECTURE.md.
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { UpflyError } from '../errors.js';
import { mapInOrder } from '../map-in-order.js';
import { compareStrings, extensionOf, isImageExtension, relativePath } from '../paths.js';
import type {
  Adapter,
  Asset,
  DiscoveryResult,
  ExcludedRoot,
  SkippedEntry,
  SourceFile,
  UnscannedFile,
} from '../types.js';

/**
 * What each directory pruned by name holds, which is the reason a report gives for it. A
 * `Map`, so a directory named `constructor` matches nothing.
 *
 * Each is a name a tool writes and people do not: `_site` is the output of Eleventy and
 * Jekyll, `.docusaurus` Docusaurus's generated files, `storybook-static` what `storybook
 * build` writes, `.vercel` and `.netlify` what those platforms' command-line tools write, and
 * `.angular` the Angular CLI's cache. A folder a person may name, such as Hugo's `public`,
 * is not here: the settings beside it decide, in `SITE_GENERATOR_SETTINGS`.
 */
const PRUNED_DIRECTORIES: ReadonlyMap<string, string> = new Map([
  ['.angular', 'a cache directory'],
  ['.astro', 'a cache directory'],
  ['.cache', 'a cache directory'],
  ['.docusaurus', 'a build-output directory'],
  ['.git', 'a version-control directory'],
  ['.netlify', 'a build-output directory'],
  ['.next', 'a build-output directory'],
  ['.nuxt', 'a build-output directory'],
  ['.output', 'a build-output directory'],
  ['.parcel-cache', 'a cache directory'],
  ['.svelte-kit', 'a build-output directory'],
  ['.turbo', 'a cache directory'],
  ['.upfly', "Upfly's own directory"],
  ['.vercel', 'a build-output directory'],
  ['_site', 'a build-output directory'],
  ['build', 'a build-output directory'],
  ['coverage', 'a test-coverage directory'],
  ['dist', 'a build-output directory'],
  ['node_modules', 'a dependency directory'],
  ['out', 'a build-output directory'],
  ['storybook-static', 'a build-output directory'],
]);

/**
 * Directory names never descended into, matched by name at any depth.
 *
 * A name lookup rather than an ignore pattern, because it runs for every directory in the
 * repository. Only dependency, cache, build-output, test-coverage and version-control
 * directories, and Upfly's own `.upfly`: nothing a user keeps a source image in.
 */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = Object.freeze([
  ...PRUNED_DIRECTORIES.keys(),
]);

const DEFAULT_IGNORED_DIRECTORY_SET = new Set(DEFAULT_IGNORED_DIRECTORIES);

/** The folder Hugo, Gatsby and Hexo build a site into, a name Vite and Next.js serve as written. */
const SITE_OUTPUT = 'public';

/**
 * Settings files of the site generators that build into `public`, with the generator each
 * names. Beside one, `public` is that generator's output and is pruned; beside none, it may
 * be a folder served as written. Each list is the generator's own: Hugo reads `hugo` as
 * `.toml`, `.yaml`, `.yml` or `.json` (its older `config.*` names are other tools' too), and
 * Gatsby reads `gatsby-config` as `.js`, `.mjs` or `.ts`. Looked up in this order, so the
 * reason is the same on every run.
 */
const SITE_GENERATOR_SETTINGS: ReadonlyMap<string, string> = new Map([
  ['hugo.toml', 'Hugo'],
  ['hugo.yaml', 'Hugo'],
  ['hugo.yml', 'Hugo'],
  ['hugo.json', 'Hugo'],
  ['gatsby-config.js', 'Gatsby'],
  ['gatsby-config.mjs', 'Gatsby'],
  ['gatsby-config.ts', 'Gatsby'],
]);

/** Default name of the per-project ignore file, read from the root only. */
export const IGNORE_FILE_NAME = '.upflyignore';

/**
 * How many directory reads, or image `stat` calls, run at once by default.
 *
 * The work is IO-bound, so the limit is there to avoid exhausting file descriptors, not
 * to match the number of cores.
 */
const DEFAULT_CONCURRENCY = 16;

export interface DiscoverOptions {
  /** Project root. A relative path is resolved against `process.cwd()`. */
  readonly root: string;
  /** Adapters whose extensions define what counts as a source file. */
  readonly adapters: readonly Adapter[];
  /** Ignore-file name, relative to the root. Defaults to `.upflyignore`. */
  readonly ignoreFile?: string;
  /** Extra gitignore-syntax patterns, applied as if appended to the ignore file. */
  readonly extraIgnores?: readonly string[];
  /** Directories read, and images sized, at once, the next as any finishes. Defaults to 16. */
  readonly concurrency?: number;
}

/** An image file found during the walk, before its size is known. */
interface AssetCandidate {
  readonly path: string;
  readonly relative: string;
  readonly extension: string;
}

/** Everything the walk accumulates. Mutable by design; it never escapes this module. */
interface WalkState {
  readonly assetCandidates: AssetCandidate[];
  readonly sourceFiles: SourceFile[];
  readonly directories: string[];
  readonly skipped: SkippedEntry[];
  readonly excludedRoots: ExcludedRoot[];
  readonly unscannedFiles: UnscannedFile[];
  ignoredCount: number;
  readonly excludedFiles: string[];
  readonly excludedImages: string[];
}

/**
 * Find every image and every adapter-claimed source file under `root`.
 *
 * @throws {UpflyError} `ROOT_NOT_A_DIRECTORY` if the root is missing or is a file.
 * @throws {UpflyError} `ADAPTER_EXTENSION_CONFLICT` if two adapters claim one extension.
 */
export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const root = resolvePath(options.root);
  await assertDirectory(root);

  const claimedExtensions = mapExtensionsToAdapters(options.adapters);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const state: WalkState = {
    assetCandidates: [],
    sourceFiles: [],
    directories: [],
    skipped: [],
    excludedRoots: [],
    unscannedFiles: [],
    ignoredCount: 0,
    excludedFiles: [],
    excludedImages: [],
  };
  const ignoreFileName = options.ignoreFile ?? IGNORE_FILE_NAME;
  const ignoreFilePath = join(root, ignoreFileName);
  const rules = await loadIgnoreRules(ignoreFilePath, ignoreFileName, options, state);

  await walk({ root, rules, claimedExtensions, concurrency, ignoreFilePath, state });
  const assets = await sizeAssets(state.assetCandidates, concurrency, root, state);

  return {
    root,
    assets: assets.sort(byRelativePath),
    sourceFiles: state.sourceFiles.sort(byRelativePath),
    directories: state.directories.sort(compareStrings),
    ignoredCount: state.ignoredCount,
    excludedFiles: state.excludedFiles.sort(compareStrings),
    excludedImages: state.excludedImages.sort(compareStrings),
    skipped: state.skipped.sort(byRelativePath),
    excludedRoots: state.excludedRoots.sort(byRelativePath),
    unscannedFiles: state.unscannedFiles.sort(byRelativePath),
  };
}

/** The files a run's rules kept it from reading, for the search a delete makes first. */
export interface ExcludedFiles {
  /** POSIX-relative and sorted, raster images left out. */
  readonly files: readonly string[];
  /** Each directory inside an excluded one that could not be listed, with the error code. */
  readonly unread: readonly { readonly file: string; readonly reason: string }[];
}

/**
 * Every file an ignore rule kept out of the walk: those it excluded by name, and everything
 * under a directory it excluded.
 *
 * Only the search before `replace` deletes an original reads these. An exclusion limits
 * what a run changes, not what it checks before removing a file that a page it left out
 * may still show. Directories the walk pruned stay unread here, and those pruned by name stay
 * unread at any depth: dependencies, caches, build output, version control and Upfly's own
 * records hold no page the project serves from its sources, and build output is made again
 * from the sources the run reads. Symbolic links are not followed, as in the walk.
 */
export async function listExcludedFiles(discovery: DiscoveryResult): Promise<ExcludedFiles> {
  const files = [...discovery.excludedFiles];
  const unread: { file: string; reason: string }[] = [];
  const pending = discovery.excludedRoots.filter((root) => root.byRule).map((root) => root.path);

  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      unread.push({ file: relativePath(discovery.root, directory), reason: errnoCode(error) });
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRECTORY_SET.has(entry.name)) pending.push(path);
        continue;
      }
      const extension = extensionOf(entry.name);
      if (entry.isFile() && (!isImageExtension(extension) || extension === SVG_EXTENSION)) {
        files.push(relativePath(discovery.root, path));
      }
    }
  }

  return {
    files: files.sort(compareStrings),
    unread: unread.sort((a, b) => compareStrings(a.file, b.file)),
  };
}

async function assertDirectory(root: string): Promise<void> {
  try {
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      throw new UpflyError('ROOT_NOT_A_DIRECTORY', `Not a directory: ${root}`);
    }
  } catch (error) {
    if (error instanceof UpflyError) throw error;
    throw new UpflyError(
      'ROOT_NOT_A_DIRECTORY',
      `Cannot read directory ${root} (${errnoCode(error)}).`,
    );
  }
}

/**
 * Build the extension to adapter lookup, rejecting overlaps.
 *
 * Two adapters claiming `.md` would make the winner depend on array order, so an overlap
 * is an error a contributor sees at once rather than a silent choice.
 */
function mapExtensionsToAdapters(adapters: readonly Adapter[]): ReadonlyMap<string, string> {
  const claimed = new Map<string, string>();
  for (const adapter of adapters) {
    for (const extension of adapter.extensions) {
      const existing = claimed.get(extension);
      if (existing !== undefined) {
        throw new UpflyError(
          'ADAPTER_EXTENSION_CONFLICT',
          `Adapters ${existing} and ${adapter.id} both claim ${extension}.`,
        );
      }
      claimed.set(extension, adapter.id);
    }
  }
  return claimed;
}

/**
 * The compiled ignore matcher, plus the patterns it was built from.
 *
 * `ignore` reports whether a path matches but not which pattern did, so the patterns are
 * kept to let the report say "excluded by `legacy/`" rather than "excluded by a rule".
 */
interface IgnoreRules {
  readonly matcher: Ignore;
  readonly patterns: readonly string[];
}

async function loadIgnoreRules(
  filePath: string,
  fileName: string,
  options: DiscoverOptions,
  state: WalkState,
): Promise<IgnoreRules> {
  const patterns: string[] = [];
  const rules = ignore();
  if (options.extraIgnores !== undefined) {
    rules.add([...options.extraIgnores]);
    patterns.push(...options.extraIgnores);
  }

  try {
    const contents = await readFile(filePath, 'utf8');
    rules.add(contents);
    patterns.push(...usablePatterns(contents));
  } catch (error) {
    // Having no ignore file is the normal case, not something to report.
    const code = errnoCode(error);
    if (code !== 'ENOENT') {
      state.skipped.push({
        path: filePath,
        relative: fileName,
        reason: 'unreadable-file',
        detail: code,
      });
    }
  }
  return { matcher: rules, patterns };
}

/** Why a directory is excluded, and whether one of the project's rules did it. */
type Exclusion = Pick<ExcludedRoot, 'reason' | 'byRule'>;

/**
 * Why this directory is excluded, or `null` if it is not. `builtSite` is why a `public`
 * directory in the same folder is a site generator's output, or `null`.
 *
 * `ignore` matches a `build/`-style pattern only when the path it is given ends in a
 * slash; testing 'build' returns false and we would descend into it.
 */
function exclusionFor(
  name: string,
  relative: string,
  rules: IgnoreRules,
  builtSite: string | null,
): Exclusion | null {
  const pruned = PRUNED_DIRECTORIES.get(name);
  if (pruned !== undefined) return { reason: `${pruned} named '${name}'`, byRule: false };
  if (name === SITE_OUTPUT && builtSite !== null) return { reason: builtSite, byRule: false };
  if (!rules.matcher.ignores(`${relative}/`)) return null;

  const pattern = excludingPattern(rules, `${relative}/`);
  return {
    reason: pattern === null ? 'an ignore rule' : `the ignore rule '${pattern}'`,
    byRule: true,
  };
}

/**
 * Why the `public` directory among these entries is a site generator's build output, or
 * `null` when it is not, or there is none.
 *
 * Hexo's settings file, `_config.yml`, is also Jekyll's, so a Hexo site is known the way
 * Hexo's own command finds one: by a `package.json` whose `hexo` field is an object.
 */
async function builtSiteReason(
  directory: string,
  entries: readonly Dirent[],
): Promise<string | null> {
  if (!entries.some((entry) => entry.name === SITE_OUTPUT && entry.isDirectory())) return null;

  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const output = `a build-output directory named '${SITE_OUTPUT}'`;
  for (const [settings, generator] of SITE_GENERATOR_SETTINGS) {
    if (files.has(settings)) return `${output}, beside ${generator}'s settings file '${settings}'`;
  }
  if (files.has('package.json') && (await marksHexoSite(join(directory, 'package.json')))) {
    return `${output}, beside a package.json whose hexo field marks a Hexo site`;
  }
  return null;
}

/** Whether a `package.json` holds the object `hexo` field that `hexo init` writes. */
async function marksHexoSite(path: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
    return (
      typeof manifest === 'object' &&
      manifest !== null &&
      'hexo' in manifest &&
      typeof manifest.hexo === 'object' &&
      manifest.hexo !== null
    );
  } catch {
    // A package.json that cannot be read or parsed marks no site, so `public` is walked.
    return false;
  }
}

/** Pattern lines from an ignore file, minus blanks and comments. */
function usablePatterns(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Which pattern excluded this path.
 *
 * Gitignore semantics are last-match-wins, so the last matching pattern is the one
 * that decided. Only ever called for a path already known to be excluded, and only
 * for directories, so the cost is a handful of matches per run.
 */
function excludingPattern(rules: IgnoreRules, relative: string): string | null {
  let matched: string | null = null;
  for (const pattern of rules.patterns) {
    if (ignore().add(pattern).ignores(relative)) matched = pattern;
  }
  return matched;
}

interface WalkInput {
  readonly root: string;
  readonly rules: IgnoreRules;
  readonly claimedExtensions: ReadonlyMap<string, string>;
  readonly concurrency: number;
  /** The ignore file we already read. Not a file we failed to scan. */
  readonly ignoreFilePath: string;
  readonly state: WalkState;
}

/**
 * Breadth-first, one level at a time, reading up to `concurrency` directories at once and
 * starting the next as soon as any finishes.
 *
 * A shared work queue across levels would parallelise slightly better near the top of the
 * tree, but needs bookkeeping so that no worker exits while another is still producing
 * work. Levels keep it simple: the directories found become the next level.
 */
async function walk(input: WalkInput): Promise<void> {
  let level = [input.root];

  while (level.length > 0) {
    const nextLevel: string[] = [];
    const reads = await mapInOrder(level, input.concurrency, (directory) =>
      readDirectory(directory, input),
    );

    for (const read of reads) {
      for (const entry of read.entries) {
        classifyEntry(entry, read, input, nextLevel);
      }
    }

    level = nextLevel;
  }
}

interface DirectoryRead {
  readonly directory: string;
  readonly entries: readonly Dirent[];
  /** Why its `public` directory is a site generator's output, or `null`. */
  readonly builtSite: string | null;
}

async function readDirectory(directory: string, input: WalkInput): Promise<DirectoryRead> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    input.state.skipped.push({
      path: directory,
      relative: relativePath(input.root, directory),
      reason: 'unreadable-directory',
      detail: errnoCode(error),
    });
    return { directory, entries: [], builtSite: null };
  }
  return { directory, entries, builtSite: await builtSiteReason(directory, entries) };
}

/**
 * Decide what one directory entry is: ignored, skipped, an asset, a source file, a
 * directory to descend into, or nothing we care about.
 */
function classifyEntry(
  entry: Dirent,
  read: DirectoryRead,
  input: WalkInput,
  nextLevel: string[],
): void {
  const path = join(read.directory, entry.name);
  const relative = relativePath(input.root, path);

  // Checked before isDirectory/isFile: on Windows a junction reports as a symlink
  // here, and following one can put the walk into a cycle or outside the root.
  if (entry.isSymbolicLink()) {
    input.state.skipped.push({ path, relative, reason: 'symlink', detail: 'not followed' });
    return;
  }

  if (entry.isDirectory()) {
    const exclusion = exclusionFor(entry.name, relative, input.rules, read.builtSite);
    if (exclusion !== null) {
      input.state.ignoredCount += 1;
      // Recorded, not merely counted: the resolver prefix-tests references against
      // these, so a path into an excluded directory is reported as `out-of-scope`
      // rather than `broken`.
      input.state.excludedRoots.push({ path, relative, ...exclusion });
      return;
    }
    nextLevel.push(path);
    // Recorded here rather than derived later from the file paths: a directory
    // holding only files nothing tracks leaves no trace in the asset or source
    // lists, and serving-root detection needs the directory itself.
    input.state.directories.push(relative);
    return;
  }

  if (!entry.isFile()) {
    input.state.skipped.push({
      path,
      relative,
      reason: 'not-a-regular-file',
      detail: 'neither a file nor a directory',
    });
    return;
  }

  const extension = extensionOf(entry.name);
  if (input.rules.matcher.ignores(relative)) {
    input.state.ignoredCount += 1;
    // Kept by path for the search a delete makes first. A raster image names nothing.
    if (!isImageExtension(extension) || extension === SVG_EXTENSION) {
      input.state.excludedFiles.push(relative);
    }
    // Kept so that a reference to it reads as pointing where the run was told not to go.
    if (isImageExtension(extension)) input.state.excludedImages.push(relative);
    return;
  }

  if (isImageExtension(extension)) {
    input.state.assetCandidates.push({ path, relative, extension });
    // An SVG is an asset and a container. `<image href>`, `<use href>` and a `<style>`
    // block inside one are real references that no adapter reads, so it is also a file
    // we did not scan. Recording it stops an asset mentioned only inside an icon sprite
    // from being called dead.
    if (extension === SVG_EXTENSION) {
      input.state.unscannedFiles.push(unclaimed(path, relative, extension));
    }
    return;
  }

  const adapterId = input.claimedExtensions.get(extension);
  if (adapterId !== undefined) {
    input.state.sourceFiles.push({ path, relative, extension, adapterId });
    return;
  }

  // Our own ignore file is the one unclaimed file we did read. Listing it under
  // "files Upfly could not read" would make the tool look confused about itself.
  if (path === input.ignoreFilePath) return;

  // Everything else was claimed by nobody and never read. The path is kept, not only a
  // count per extension, because the audit's sweep reads these files.
  input.state.unscannedFiles.push(unclaimed(path, relative, extension));
}

/** The one image format that can itself reference other assets. */
const SVG_EXTENSION = '.svg';

function unclaimed(path: string, relative: string, extension: string): UnscannedFile {
  return { path, relative, extension, reason: 'unclaimed-extension', detail: '' };
}

/**
 * Attach a size to every image found.
 *
 * Kept out of the walk so that traversal stays about traversal. The cost is the
 * same either way: one `stat` per image, at most `concurrency` at once.
 */
async function sizeAssets(
  candidates: readonly AssetCandidate[],
  concurrency: number,
  root: string,
  state: WalkState,
): Promise<Asset[]> {
  const assets: Asset[] = [];

  for (const result of await mapInOrder(candidates, concurrency, sizeAsset)) {
    if (result.asset !== null) {
      assets.push(result.asset);
    } else {
      state.skipped.push({
        path: result.candidate.path,
        relative: relativePath(root, result.candidate.path),
        reason: 'unreadable-file',
        detail: result.detail,
      });
    }
  }

  return assets;
}

interface SizedAsset {
  readonly candidate: AssetCandidate;
  readonly asset: Asset | null;
  readonly detail: string;
}

async function sizeAsset(candidate: AssetCandidate): Promise<SizedAsset> {
  try {
    const stats = await stat(candidate.path);
    return {
      candidate,
      asset: {
        path: candidate.path,
        relative: candidate.relative,
        extension: candidate.extension,
        bytes: stats.size,
      },
      detail: '',
    };
  } catch (error) {
    return { candidate, asset: null, detail: errnoCode(error) };
  }
}

function byRelativePath(a: { relative: string }, b: { relative: string }): number {
  return compareStrings(a.relative, b.relative);
}

/** Pull the errno string off a filesystem rejection without asserting its shape. */
function errnoCode(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    const { code } = error as Error & { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}
