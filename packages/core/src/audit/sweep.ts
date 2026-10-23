/**
 * Whether anything the engine could not read as a reference mentions an asset by name.
 *
 * This separates a confident `dead` finding from a hedged `possibly-dead` one. The hedge
 * is per asset and needs evidence: a global one ("some extension went unread") fires on
 * every real repository and so says nothing. Candidate names go into one set and each
 * text is scanned once, not once per asset. Excluded directories are not swept: an
 * ignore rule is an instruction, and the report names them in one caveat line.
 * See "`possibly-dead`, and why "zero references" is usually a lie" in ARCHITECTURE.md.
 */

import {
  type ReadingPosition,
  TEMPLATE_HOLES,
  TEMPLATE_HOLE_PATTERN,
  interpolationChunks,
  spellingsOf,
  splitPathSuffix,
} from '../adapters/reference-path.js';
import { formatBytes } from '../format.js';
import type { Graph } from '../graph/graph.js';
import { unreferencedAssets } from '../graph/graph.js';
import { holdsNoPathAPageLoads } from '../graph/unscanned.js';
import { compareStrings, imageFilenameCandidates } from '../paths.js';
import { provenPath } from '../resolve/reference.js';
import { contextCouldTake, globFromAnyRoot, servedFromAnyRoot } from '../resolve/resolve.js';
import { citationAt, lineOf, withSourceTexts } from '../scan/citation.js';
import type { ReadFilePort, ScannedMention } from '../scan/scan.js';
import type { Reference } from '../types.js';
import { patternsWithoutServingRoot, withheldReferences } from './resolution-health.js';

/** Where an asset's name turned up. */
export type MentionSource =
  /** In a file no adapter could read: an unclaimed extension, or a parse failure. */
  | 'unscanned-file'
  /**
   * In a path we read but could not resolve: `dynamic`, alias-shaped, speculative, a value
   * an adapter declined to read as a path, or root-relative in a run that could not find
   * its serving root.
   */
  | 'unresolved-reference'
  /**
   * In a file an adapter did read, in a form it did not understand: a spaced file name
   * with no slash, such as `{ file: 'My Logo.png' }`, parses fine and yields no reference,
   * because it has the shape of a UI label. The last resort, used
   * only for an asset the other two sources did not explain.
   */
  | 'scanned-file';

/** Evidence that an asset with no references may nonetheless be in use. */
export interface Mention {
  /** POSIX-relative path of the asset that was named. */
  readonly asset: string;
  readonly source: MentionSource;
  /**
   * Where to look, as the report prints it: `src/posts/first.md:7`, or only the file
   * when it could not be re-read for the line. A line makes the mention an instruction
   * rather than a hint.
   */
  readonly where: string;
  /**
   * The text that named it: the matched token, or the unresolved path, only the line of it
   * that names the asset when the path spans lines.
   */
  readonly quote: string;
}

/** Text the sweep could not look at, and why. Each one is listed in the report. */
export interface SweepSkip {
  /** POSIX-relative path of the file. */
  readonly relative: string;
  readonly reason: string;
}

export interface SweepResult {
  /** Mentions per asset, keyed by POSIX-relative path. Only assets that were named. */
  readonly mentions: ReadonlyMap<string, readonly Mention[]>;
  /** Files the sweep could not read, sorted by `relative`. */
  readonly skipped: readonly SweepSkip[];
}

export interface SweepOptions {
  readonly graph: Graph;
  /** Same port `scan` takes. The sweep reads only what it must. */
  readonly readFile: ReadFilePort;
  /**
   * Asset filenames `scan` saw in files it did read, from `ScanResult.mentions`.
   *
   * A scanned file can hold a reference in a form no adapter understands (a spaced file
   * name with no slash parses fine and yields no reference), and neither other
   * source covers it. Collected during the scan, which already holds the text, so the
   * check is cheap enough to stay always on: `dead` means the filename appears nowhere in
   * the codebase, and a claim that holds only behind a flag is not that claim.
   */
  readonly scannedMentions?: readonly ScannedMention[];
  /**
   * Serving roots, as the resolver was given them.
   *
   * A filename inside an absolute URL is evidence only for an asset under a serving root:
   * `https://docs.astro.build/assets/arc.webp` may be `public/assets/arc.webp` being
   * served, but it cannot be an asset outside every serving root.
   */
  readonly publicDirs?: readonly string[];
  /**
   * Largest file the sweep will search, in bytes. Defaults to 2 MiB.
   *
   * The unread set is mostly templates and config, but it can also hold databases and compiled
   * code, which are read, and video and archives, which are not. A larger file is skipped with
   * a reason, because a silent skip would turn a hedge back into a confident `dead`.
   */
  readonly maxBytes?: number;
  /**
   * A file's size in bytes, asked before its text is read, so a file past `maxBytes` is never
   * read at all. Without it, the text is read and its UTF-8 bytes counted.
   */
  readonly sizeOf?: (absolutePath: string) => Promise<number>;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Looks for the names of assets nothing references in the files no adapter could read,
 * the paths that did not resolve, and the filenames `scan` saw in the files it read.
 *
 * Does no IO when every asset is referenced, the common case on a healthy repository.
 */
export async function sweepForMentions(options: SweepOptions): Promise<SweepResult> {
  const { graph } = options;
  const candidates = candidateBasenames(graph);
  const mentions = new Map<string, Mention[]>();
  const skipped: SweepSkip[] = [];

  if (candidates.size === 0) return { mentions, skipped };

  await sweepFiles(
    options.graph.unscannedFiles,
    'unscanned-file',
    options,
    candidates,
    mentions,
    skipped,
  );
  await sweepUnresolvedReferences(options, candidates, mentions, skipped);

  // Only assets the other sources left unexplained. No IO: `scan` gathered these while
  // it had the text open.
  for (const mention of options.scannedMentions ?? []) {
    for (const asset of candidates.get(mention.basename) ?? []) {
      if (mentions.has(asset)) continue;
      record(mentions, {
        asset,
        source: 'scanned-file',
        where: `${mention.relative}:${mention.line}`,
        quote: mention.quote,
      });
    }
  }

  for (const list of mentions.values()) list.sort(byWhereThenQuote);
  return { mentions, skipped };
}

/**
 * Assets with zero references, indexed by lowercased basename.
 *
 * A basename rather than a path, because that is all an unread file gives: a `.vue`
 * template says `hero.png`, not where it lives. Two assets sharing a basename are both
 * hedged, since the evidence cannot tell them apart and hedging is the safe error.
 * Lowercased because Windows filesystems are case-insensitive, so `Hero.PNG` in a
 * template can name `hero.png`.
 */
function candidateBasenames(graph: Graph): ReadonlyMap<string, readonly string[]> {
  const byBasename = new Map<string, string[]>();

  for (const node of unreferencedAssets(graph)) {
    const relative = node.asset.relative;
    const basename = relative.slice(relative.lastIndexOf('/') + 1).toLowerCase();
    const existing = byBasename.get(basename);
    if (existing === undefined) byBasename.set(basename, [relative]);
    else existing.push(relative);
  }

  return byBasename;
}

/**
 * A file's text, or why the sweep does not search it: `null` for a type that holds no path a
 * page loads, as the search before a delete leaves it unread (`holdsNoPathAPageLoads`), and a
 * skip with its reason for a file past the limit or one that could not be read. A database or
 * compiled code is searched, since its bytes can hold a path. Bytes are compared with bytes,
 * asked of `sizeOf` before the read when there is one.
 */
async function textToSearch(
  file: { readonly path: string; readonly relative: string; readonly extension?: string },
  options: SweepOptions,
  maxBytes: number,
): Promise<string | SweepSkip | null> {
  if (file.extension !== undefined && holdsNoPathAPageLoads(file.extension)) return null;
  const tooLarge: SweepSkip = {
    relative: file.relative,
    // Human scale, since the report prints this verbatim. `formatBytes` rather than fixed
    // megabytes, which would print a small limit as `0 MB`.
    reason: `larger than the ${formatBytes(maxBytes)} limit for searching a file's text`,
  };
  try {
    if (options.sizeOf !== undefined && (await options.sizeOf(file.path)) > maxBytes) {
      return tooLarge;
    }
    const text = await options.readFile(file.path);
    const counted = options.sizeOf === undefined && Buffer.byteLength(text, 'utf8') > maxBytes;
    return counted ? tooLarge : text;
  } catch (error) {
    return { relative: file.relative, reason: describe(error) };
  }
}

/** Read a set of files and record every candidate basename they name. */
async function sweepFiles(
  files: readonly {
    readonly path: string;
    readonly relative: string;
    readonly extension?: string;
  }[],
  source: MentionSource,
  options: SweepOptions,
  candidates: ReadonlyMap<string, readonly string[]>,
  mentions: Map<string, Mention[]>,
  skipped: SweepSkip[],
): Promise<void> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  for (const file of files) {
    const text = await textToSearch(file, options, maxBytes);
    if (text === null) continue;
    if (typeof text !== 'string') {
      skipped.push(text);
      continue;
    }

    for (const [token, index] of tokens(text)) {
      const inUrl = isInsideAbsoluteUrl(text, index);
      for (const asset of candidates.get(token.toLowerCase()) ?? []) {
        if (inUrl && !isServed(asset, options.publicDirs)) continue;
        record(mentions, {
          asset,
          source,
          where: `${file.relative}:${lineOf(text, index)}`,
          quote: token,
        });
      }
    }
  }
}

/**
 * Paths the engine read but could not resolve.
 *
 * Searching them costs no IO, since the strings are in the graph, but each mention cites
 * its line and a line costs a re-read. `withSourceTexts` re-reads once per file, and only
 * for references that named a candidate.
 *
 * A pattern's holes leave no file name to find, so a pattern that linked nothing is tested
 * against every candidate from any base: a root-relative one the run had no serving root to
 * glob, a relative one or a bundler's glob that matched nothing, one written through an alias
 * no rule maps, one an adapter declined, and one holding another language's template holes. A
 * bundler's context is tested by what it could take from its directory, and a path holding
 * U+FFFD with each U+FFFD standing for one character.
 */
async function sweepUnresolvedReferences(
  options: SweepOptions,
  candidates: ReadonlyMap<string, readonly string[]>,
  mentions: Map<string, Mention[]>,
  skipped: SweepSkip[],
): Promise<void> {
  const hits = new Map<Reference, ReadonlySet<string>>();
  const unglobbed = new Map([
    ...patternsWithoutServingRoot(options.graph).map(
      (reference) => [reference, servedFromAnyRoot(provenPath(reference))] as const,
    ),
    ...unmappedAliasPatterns(options.graph).map(
      (reference) =>
        [reference, servedFromAnyRoot(afterAliasToken(provenPath(reference)))] as const,
    ),
    ...declinedPatterns(options.graph).map(
      (reference) => [reference, servedFromAnyRoot(openBased(provenPath(reference)))] as const,
    ),
    ...unmatchedRelativePatterns(options.graph).map(
      (reference) => [reference, servedFromAnyRoot(openBased(provenPath(reference)))] as const,
    ),
    ...unglobbedHolePatterns(options.graph).map(
      (reference) =>
        [reference, servedFromAnyRoot(openBased(asGlobbedHoles(provenPath(reference))))] as const,
    ),
    ...unknownTargetReferences(options.graph).flatMap((reference) =>
      provenPath(reference).includes(REPLACEMENT_CHARACTER)
        ? [[reference, spelledThroughReplacement(provenPath(reference))] as const]
        : [],
    ),
    // Last, so a glob is read in its own syntax, and a context by what it could take from its
    // directory, whichever list above also holds it.
    ...unknownTargetReferences(options.graph).flatMap((reference) =>
      reference.glob === undefined
        ? []
        : [[reference, globFromAnyRoot(provenPath(reference), reference.glob.dot)] as const],
    ),
    ...unknownTargetReferences(options.graph).flatMap((reference) =>
      reference.bundlerContext === undefined
        ? []
        : [[reference, contextCouldTake(reference, options.graph.root)] as const],
    ),
  ]);
  const assets = [...candidates.values()].flat();

  for (const reference of unknownTargetReferences(options.graph)) {
    const named = new Set<string>();
    for (const name of namesIn(reference)) {
      for (const asset of candidates.get(name) ?? []) named.add(asset);
    }
    const couldName = unglobbed.get(reference);
    if (couldName !== undefined) {
      for (const asset of assets.filter(couldName)) named.add(asset);
    }
    if (named.size > 0) hits.set(reference, named);
  }
  if (hits.size === 0) return;

  const unreadable = await withSourceTexts(
    { references: [...hits.keys()], root: options.graph.root, readFile: options.readFile },
    (file, text, references) => {
      for (const reference of references) {
        for (const asset of hits.get(reference) ?? []) {
          record(mentions, {
            asset,
            source: 'unresolved-reference',
            ...nameSite(file, text, reference, asset),
          });
        }
      }
    },
  );
  // A file that cannot be re-read loses the line, not the mention, and is listed as skipped.
  skipped.push(...unreadable);
}

/**
 * Where an asset's name sits inside the reference that named it, and the text to quote.
 *
 * A reference on one line is cited where it starts and quoted whole. One an adapter refused
 * whole, such as a `<style>` block whose CSS does not parse, can run for a hundred lines and
 * rarely names the file on its first, so it is cited at its first line that names the file,
 * read as `namesIn` reads the whole, and quoted by that line alone. A name no line holds,
 * such as one a pattern matched, is cited at the reference's first line of text.
 */
function nameSite(
  file: string,
  text: string | null,
  reference: Reference,
  asset: string,
): { where: string; quote: string } {
  // The source rather than `rawPath`, which a CSS-in-JS template flattens. A file that could
  // not be re-read leaves `rawPath`, and no line to cite.
  const written = text === null ? reference.rawPath : text.slice(reference.start, reference.end);
  if (!written.includes('\n')) {
    return { where: citationAt(file, text, reference.start).where, quote: reference.rawPath };
  }

  const name = asset.slice(asset.lastIndexOf('/') + 1).toLowerCase();
  const lines = written.split('\n');
  const naming = lines.findIndex((line) => namesInText(line, reference).has(name));
  const firstText = lines.findIndex((line) => line.trim() !== '');
  const cited = naming === -1 ? Math.max(0, firstText) : naming;
  const offset = lines.slice(0, cited).reduce((sum, line) => sum + line.length + 1, 0);
  return {
    where: citationAt(file, text, reference.start + offset).where,
    // `trim` also drops the carriage return that ends each line of a CRLF file.
    quote: (lines[cited] ?? '').trim(),
  };
}

/** The openers of the hole syntaxes the resolver never globs, such as Liquid's `{{`. */
const UNGLOBBED_OPENERS: readonly string[] = TEMPLATE_HOLES.filter((hole) => !hole.globbed).map(
  (hole) => hole.opener,
);

/**
 * A `dynamic` reference holding a hole the resolver never globs beside a fixed part, such as
 * Liquid's `/img/photo-{{ n }}.png`. It stays `dynamic` in every run, found serving root or
 * not, while the files it names sit on disk, so nothing else would hedge them. A path whose
 * only fixed text is slashes, `{{ page.image }}`, fixes no part of a name, and is left to the
 * mentions.
 */
function unglobbedHolePatterns(graph: Graph): readonly Reference[] {
  return graph.byResolution.dynamic.filter((reference) => {
    const path = provenPath(reference);
    return (
      UNGLOBBED_OPENERS.some((opener) => path.includes(opener)) &&
      interpolationChunks(asGlobbedHoles(path)).some((chunk) => chunk.replaceAll('/', '') !== '')
    );
  });
}

const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * A path holding U+FFFD as a test of the assets it could spell. Decoding puts one U+FFFD where
 * each byte of a page in a single-byte encoding such as Latin-1 is not UTF-8, so each stands
 * for one character; as for a declined pattern, the rest must end the asset's path in whole
 * segments, from any base, case ignored.
 */
function spelledThroughReplacement(path: string): (relative: string) => boolean {
  const fixed = openBased(splitPathSuffix(path).path).slice(1);
  const source = fixed
    .split(REPLACEMENT_CHARACTER)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]');
  const expression = new RegExp(`^(?:.*/)?${source}$`, 'i');
  return (relative) => expression.test(relative);
}

/** Every hole, in any syntax. */
const ANY_HOLE = new RegExp(TEMPLATE_HOLE_PATTERN, 'g');

/**
 * The path with every hole written in a syntax the glob reads (`#{x}`), since the glob and
 * the chunking read only the holes the resolver itself globs.
 */
function asGlobbedHoles(path: string): string {
  return path.replace(ANY_HOLE, '#{x}');
}

/**
 * The patterns an adapter declined. The resolver never globs one, so, like a pattern a run
 * had no serving root to glob, what it names is unknown rather than absent.
 */
function declinedPatterns(graph: Graph): readonly Reference[] {
  return graph.byResolution.discarded.filter(
    (reference) =>
      reference.declined === true && interpolationChunks(provenPath(reference)).length > 1,
  );
}

/**
 * The relative patterns that matched nothing. A script builds a path the browser reads from the
 * folder of the page that loads it, which the resolver does not know, so like a declined pattern
 * what it names is unknown rather than absent. A bare name in an import is a package, not a
 * relative path, and a glob or a context is read in its own way.
 */
function unmatchedRelativePatterns(graph: Graph): readonly Reference[] {
  return graph.byResolution.dynamic.filter((reference) => {
    if (reference.ceiling !== 'medium' || reference.glob !== undefined) return false;
    if (reference.bundlerContext !== undefined) return false;
    const path = provenPath(reference);
    if (path.startsWith('./') || path.startsWith('../')) return true;
    return reference.kind !== 'import' && !/^[/@~#$]/.test(path);
  });
}

/**
 * A declined pattern as `servedFromAnyRoot` reads it. Nothing resolved it, so a relative one
 * may be anchored at its file or at the project root; either way a file it names ends with
 * its segments after any leading `./` or `../`, and that ending is what an open base matches.
 */
function openBased(pattern: string): string {
  return `/${pattern.replace(/^(?:\.{1,2}\/)+/, '').replace(/^\/+/, '')}`;
}

/**
 * The patterns written through an alias no rule maps. The resolver could not expand one, so,
 * like a pattern a run had no serving root to glob, what it names is unknown rather than
 * absent. Only a pattern reaches the resolver with a `medium` ceiling.
 */
function unmappedAliasPatterns(graph: Graph): readonly Reference[] {
  return graph.byResolution['unresolved-alias'].filter(
    (reference) => reference.ceiling === 'medium',
  );
}

/**
 * A pattern through an unmapped alias as `servedFromAnyRoot` reads it: the alias, its first
 * segment, dropped, since only a rule could say which directory it stands for.
 */
function afterAliasToken(pattern: string): string {
  const slash = pattern.indexOf('/');
  return slash === -1 ? `/${pattern}` : pattern.slice(slash);
}

/**
 * The file names a path that did not resolve could stand for, lowercased as the candidates
 * are.
 *
 * It is read in every spelling the resolver would look it up in, so `/img/my%20photo.png`
 * names `my photo.png`, and as the path its text proves, so an escaped string names what its
 * escapes decode to. A spelling's last segment is taken whole, because a decoded name can
 * hold what no filename token can: `/img/a&amp;b.png` names `a&b.png`. Each spelling is also
 * searched for tokens, since a dynamic path can hold a name anywhere.
 */
function namesIn(reference: Reference): ReadonlySet<string> {
  const names = namesInText(reference.rawPath, reference);
  addNames(names, provenPath(reference));
  return names;
}

/** The file names a text could stand for, in every spelling the reference's position reads. */
function namesInText(text: string, read: ReadingPosition): Set<string> {
  const { path } = splitPathSuffix(text);
  const names = new Set<string>();
  for (const spelled of [text, ...spellingsOf(path, read).map((spelling) => spelling.path)]) {
    addNames(names, spelled);
  }
  return names;
}

/** Add a text's last segment and every filename token in it, lowercased. */
function addNames(names: Set<string>, text: string): void {
  names.add(text.slice(text.lastIndexOf('/') + 1).toLowerCase());
  for (const [token] of tokens(text)) names.add(token.toLowerCase());
}

/**
 * The references whose target is unknown, the only ones that can hint at a use.
 *
 * A known target is no such evidence. `broken` points at nothing and is its own finding:
 * `./wrong-dir/hero.png: broken` beside `hero.png: dead` tells a reader more than a hedge
 * would. The exception is a root-relative one that a run with no serving root withholds:
 * it has no finding of its own, and its target is unknown rather than missing.
 * `out-of-scope` is known not to be an indexed asset. `discarded` includes the values an
 * adapter declined, which are never looked up. A new resolution outcome belongs here only if
 * its target is unknown.
 */
function unknownTargetReferences(graph: Graph): readonly Reference[] {
  return [
    ...graph.byResolution.dynamic,
    ...graph.byResolution['unresolved-alias'],
    ...graph.byResolution.discarded,
    ...withheldReferences(graph),
  ];
}

/** Whether this token sits inside an `http://` or `https://` URL. */
function isInsideAbsoluteUrl(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  return /https?:\/\/\S*$/.test(text.slice(lineStart, index));
}

/** Whether an asset lives under a serving root, so a URL could genuinely serve it. */
function isServed(asset: string, publicDirs: readonly string[] | undefined): boolean {
  return (publicDirs ?? []).some(
    (publicDir) => publicDir === '' || asset === publicDir || asset.startsWith(`${publicDir}/`),
  );
}

/**
 * Every filename-shaped token in a string, with the offset it started at.
 *
 * Delegates to `imageFilenameCandidates`, which also yields names containing spaces
 * (`Firing Practice.webp`, not only `Practice.webp`). `scan.ts` uses the same generator,
 * so the two lookups cannot disagree.
 */
function* tokens(text: string): Generator<[string, number]> {
  yield* imageFilenameCandidates(text);
}

function record(mentions: Map<string, Mention[]>, mention: Mention): void {
  const list = mentions.get(mention.asset);
  if (list === undefined) mentions.set(mention.asset, [mention]);
  else if (!list.some((entry) => entry.where === mention.where && entry.quote === mention.quote)) {
    list.push(mention);
  }
}

function byWhereThenQuote(a: Mention, b: Mention): number {
  return compareStrings(a.where, b.where) || compareStrings(a.quote, b.quote);
}

function describe(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    const { code } = error as Error & { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
