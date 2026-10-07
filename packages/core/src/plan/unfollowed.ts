/**
 * The lines that name an image which Upfly does not follow, each with the reason.
 *
 * The graph's references to an image are what Upfly follows. This lists the rest of what a
 * text search for the image's path finds (`findPathOccurrences`), so the two together hold
 * every line that names it. Each place the search finds is read against the graph first:
 * inside a reference to this image the line is already a reference, and inside one that leads
 * elsewhere it names another file and is left out. Outside every reference it is read as text:
 * a full address names the image when its path ends with the image's address, and any other
 * path is resolved from the file that holds it, as a reference there would be. A place Upfly
 * cannot pin on another file is listed, since a coincidence costs a glance and a missed line a
 * broken image. See "Every line that names an image" in ARCHITECTURE.md.
 */

import { join } from 'node:path';
import { cssCommentRanges } from '../adapters/css.js';
import { htmlCommentRanges } from '../adapters/html.js';
import { javaScriptCommentRanges } from '../adapters/javascript.js';
import { type InactiveMarkdown, markdownRegionAt } from '../adapters/markdown.js';
import { withheldReferences } from '../audit/resolution-health.js';
import type { Graph } from '../graph/graph.js';
import { compareStrings, extensionOf, relativePath } from '../paths.js';
import type { AliasMap } from '../resolve/aliases.js';
import { isLinked, linkedPaths } from '../resolve/reference.js';
import { type ServingRoots, resolveReferences } from '../resolve/resolve.js';
import { hashText } from '../scan/text-hash.js';
import type { ExcludedRoot, RawReference, Reference, UnscannedFile } from '../types.js';
import {
  type PathOccurrence,
  type PathOccurrencesResult,
  type Unsearchable,
  findPathOccurrences,
  foldCase,
  lineIndex,
  spellingsFor,
} from './old-path-search.js';

/**
 * Why a line that names an image is not one of its references: a full address, a path built
 * at runtime, a value in data or props, a file type Upfly does not read, a comment, or
 * another reason, which `why` says.
 */
export type UnfollowedReason =
  | 'full-address'
  | 'built-at-runtime'
  | 'data-or-props'
  | 'unread-file-type'
  | 'comment'
  | 'other';

/** A line that names an image, which Upfly does not follow. */
export interface UnfollowedLine {
  /** The image it names, POSIX-relative to the project root. */
  readonly image: string;
  /** POSIX-relative path of the file that holds it. */
  readonly file: string;
  readonly line: number;
  /** The path as the line writes it: a whole address, or the path with what builds it. */
  readonly text: string;
  readonly reason: UnfollowedReason;
  /** Why Upfly does not follow it, as a sentence. */
  readonly why: string;
  /**
   * The host of a full address. Upfly cannot tell which host serves the site itself, so a
   * reader, or a setting naming the site's own address, has to.
   */
  readonly host?: string;
}

export interface UnfollowedInput {
  readonly graph: Graph;
  /** The images to list lines for, POSIX-relative to the project root. */
  readonly images: readonly string[];
  /**
   * Every file to search, POSIX-relative: what the walk found, read or not, and what the
   * run's ignore rules excluded, since a scope limits what a run changes, never what it reads.
   */
  readonly files: readonly string[];
  /** The files in `files` that the run's ignore rules excluded. */
  readonly excludedFiles: readonly string[];
  /** Reads one file by its POSIX-relative path. Rejecting is a reported `Unsearchable`. */
  readonly readFile: (relative: string) => Promise<string>;
  readonly servingRoots: ServingRoots;
  /** The aliases the resolver used, so a path written through one is read the same way. */
  readonly aliases: AliasMap;
  /** The folders the walk left out, so a path into one names a file there, not this image. */
  readonly excludedRoots?: readonly ExcludedRoot[];
}

export interface UnfollowedResult {
  /** By image, then file, then line; at most one per line for each image. */
  readonly lines: readonly UnfollowedLine[];
  /**
   * The places among them that sit inside a comment, with what an edit would replace there.
   * A conversion or a move rewrites the path in a comment as it rewrites a reference, and
   * these are the places it writes; the lines stay listed, since a comment is not a
   * reference and nothing loads it.
   */
  readonly comments: readonly CommentMention[];
  readonly filesSearched: number;
  /** Files that could not be read, so a line inside one cannot be ruled out. */
  readonly unsearchable: readonly Unsearchable[];
}

/** A place inside a comment that names an image: enough to rewrite the path there. */
export interface CommentMention {
  /** The image it names, POSIX-relative to the project root. */
  readonly image: string;
  /** POSIX-relative path of the file that holds it. */
  readonly file: string;
  readonly line: number;
  /** Offset of the path's spelling in the file's text, in UTF-16 code units. */
  readonly offset: number;
  /** The spelling the file holds there, which an edit replaces. */
  readonly spelling: string;
  /**
   * The hash of the file's text as this search read it, which is the text the offset was
   * measured in. The graph records a hash only for a file it found a reference in, and a
   * comment can be the only line in a file that names an image.
   */
  readonly textHash: string;
}

const FULL_ADDRESS =
  "a full address, which Upfly never rewrites: it cannot tell which host is the site's own";
const BUILT_AT_RUNTIME =
  'a path built when the code runs, so Upfly cannot tell which file it names';
const DATA_GUESS =
  'a path in data that names no file from where it is written, so the code that reads it decides which file it is';
const IN_FRONTMATTER = "in a Markdown file's frontmatter, which Upfly does not read";
const IN_COMMENT =
  'in a comment, which no page loads: the path in it is rewritten with the references, and never decides on its own whether the image converts or moves';
const IN_CODE_EXAMPLE = 'in a code example, which a page shows rather than loads';
const EXCLUDED_FILE =
  'in a file this run leaves out (.upflyignore, --exclude or the config file), read only to list it here';
const OTHER_CASE =
  'it names the image in other letter case, which Windows and macOS find and a Linux server does not; the check command reports it';
const UNPLACED_ROOT =
  "a path from the site's root, which Upfly cannot follow while it cannot tell the folder the site is served from";
const UNKNOWN_ALIAS = 'written through an alias that no configuration Upfly reads defines';
const NOT_A_PATH_HERE =
  'Upfly reads this file but takes no path from this text: prose, or a value no reader takes for a file';

/** How much of a path as written is kept, as the old-path search caps a line. */
const TEXT_CAP = 120;

/** The verdict on one place the search found. */
type Verdict =
  /** Inside a reference to this image: the line is one of its references. */
  | 'covered'
  /** It names another file, or no file this image could be. */
  | 'elsewhere'
  | Listed
  /** Outside every reference: what the resolver makes of the path decides. */
  | { readonly resolve: RawReference; readonly listed: Listed };

interface Listed {
  readonly reason: UnfollowedReason;
  readonly why: string;
  readonly text: string;
  readonly host?: string;
}

/** One place that may list its line: settled, or waiting on where `raw` leads. */
interface Candidate {
  readonly line: UnfollowedLine;
  readonly raw?: RawReference;
  /** Where the spelling sits in the file, so a comment's path can be rewritten. */
  readonly at: Pick<PathOccurrence, 'offset' | 'spelling'>;
}

/** What reading a place needs, the same for every file. */
interface Context {
  readonly input: UnfollowedInput;
  readonly root: string;
  readonly withheld: ReadonlySet<Reference>;
  readonly addresses: ReadonlyMap<string, ReadonlySet<string>>;
  readonly excluded: ReadonlySet<string>;
  readonly unscanned: ReadonlyMap<string, UnscannedFile>;
}

/**
 * Every line that names one of the images and is not one of its references, with the reason
 * Upfly does not follow it. A line naming another file of the same name is left out.
 *
 * @param input the graph, the images, and the files to search
 * @returns the lines, by image, file and line
 */
export async function findUnfollowedLines(input: UnfollowedInput): Promise<UnfollowedResult> {
  const { graph } = input;
  const found = await findPathOccurrences({
    paths: input.images,
    files: input.files,
    readFile: input.readFile,
    servingDirs: input.servingRoots.dirs,
  });

  const context: Context = {
    input,
    root: graph.root,
    withheld: new Set(withheldReferences(graph)),
    addresses: addressIndex(graph, input.servingRoots),
    excluded: new Set(input.excludedFiles),
    unscanned: new Map(graph.unscannedFiles.map((file) => [file.relative, file])),
  };
  const { lines, comments } = chosen(
    placesByLine(found, imagesBySpelling(input), context),
    context,
    new Map([...found.texts].map(([file, text]) => [file, hashText(text)])),
  );
  lines.sort(
    (a, b) => compareStrings(a.image, b.image) || compareStrings(a.file, b.file) || a.line - b.line,
  );
  comments.sort(
    (a, b) =>
      compareStrings(a.file, b.file) || a.offset - b.offset || compareStrings(a.image, b.image),
  );
  return { lines, comments, filesSearched: found.filesSearched, unsearchable: found.unsearchable };
}

/** Which images each spelling belongs to, folded to lower case. */
function imagesBySpelling(input: UnfollowedInput): Map<string, string[]> {
  const images = new Map<string, string[]>();
  for (const image of input.images) {
    for (const spelling of new Set(spellingsFor(image, input.servingRoots.dirs).map(foldCase))) {
      images.set(spelling, [...(images.get(spelling) ?? []), image]);
    }
  }
  return images;
}

/**
 * The places that may list each line, by image, file and line, in the order they sit. A line
 * with a reference to the image is one of its references, and a place that settles a line
 * stops the search of the rest.
 */
function placesByLine(
  found: PathOccurrencesResult,
  spellings: ReadonlyMap<string, readonly string[]>,
  context: Context,
): Map<string, Candidate[]> {
  const references = referencesByFile(context.input.graph, found.texts);
  const candidates = new Map<string, Candidate[]>();
  for (const [file, occurrences] of byFile(found.occurrences)) {
    const text = found.texts.get(file) ?? '';
    const inFile = references.get(file) ?? [];
    const referenced = referencedLines(inFile, context.root, lineIndex(text));
    const regions = lazily(() => regionsOf(file, text));

    for (const { image, occurrence } of longestPerImage(occurrences, spellings)) {
      if (referenced.has(`${image}\n${occurrence.line}`)) continue;
      const key = `${image}\n${file}\n${occurrence.line}`;
      const held = candidates.get(key) ?? [];
      if (held.some((candidate) => candidate.raw === undefined)) continue;
      const verdict = placeOf(image, occurrence, text, inFile, regions, context);
      if (verdict === 'covered' || verdict === 'elsewhere') continue;
      const line = { image, file, line: occurrence.line };
      const at = { offset: occurrence.offset, spelling: occurrence.spelling };
      held.push(
        'resolve' in verdict
          ? { line: { ...line, ...verdict.listed }, raw: verdict.resolve, at }
          : { line: { ...line, ...verdict }, at },
      );
      candidates.set(key, held);
    }
  }
  return candidates;
}

/**
 * Each line's entry: its first place that does not lead to another file. The paths that wait
 * on the resolver are resolved in one call for the whole search rather than once each.
 */
function chosen(
  candidates: ReadonlyMap<string, Candidate[]>,
  context: Context,
  hashes: ReadonlyMap<string, string>,
): { readonly lines: UnfollowedLine[]; readonly comments: CommentMention[] } {
  const pending = [...candidates.values()]
    .flat()
    .filter((candidate) => candidate.raw !== undefined);
  const lands = landings(pending, context);
  const leadsElsewhere = new Set(
    pending.filter((candidate, index) => {
      const target = lands[index];
      return target !== null && target !== undefined && target !== candidate.line.image;
    }),
  );
  const lines: UnfollowedLine[] = [];
  const comments: CommentMention[] = [];
  for (const held of candidates.values()) {
    const first = held.find((candidate) => !leadsElsewhere.has(candidate));
    if (first === undefined) continue;
    lines.push(first.line);
    const textHash = hashes.get(first.line.file);
    if (first.line.reason === 'comment' && textHash !== undefined) {
      comments.push({
        image: first.line.image,
        file: first.line.file,
        line: first.line.line,
        ...first.at,
        textHash,
      });
    }
  }
  return { lines, comments };
}

/** The occurrences grouped by file, in the search's order. */
function byFile(occurrences: readonly PathOccurrence[]): Map<string, PathOccurrence[]> {
  const files = new Map<string, PathOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = files.get(occurrence.file);
    if (list === undefined) files.set(occurrence.file, [occurrence]);
    else list.push(occurrence);
  }
  return files;
}

/**
 * For each image, the longest of its own spellings matched at each place, in file order. The
 * spellings of one path overlap (`/img/hero.png` ends with `img/hero.png`), so one place
 * matches several, and two images can share a short one.
 */
function longestPerImage(
  occurrences: readonly PathOccurrence[],
  imagesBySpelling: ReadonlyMap<string, readonly string[]>,
): { readonly image: string; readonly occurrence: PathOccurrence }[] {
  const longest = new Map<string, { image: string; occurrence: PathOccurrence }>();
  for (const occurrence of occurrences) {
    const end = occurrence.offset + occurrence.spelling.length;
    for (const image of imagesBySpelling.get(foldCase(occurrence.spelling)) ?? []) {
      const key = `${image}\n${end}`;
      const held = longest.get(key);
      if (held === undefined || occurrence.spelling.length > held.occurrence.spelling.length) {
        longest.set(key, { image, occurrence });
      }
    }
  }
  return [...longest.values()].sort((a, b) => a.occurrence.offset - b.occurrence.offset);
}

/** The graph's references in each file that holds an occurrence, keyed by POSIX path. */
function referencesByFile(
  graph: Graph,
  texts: ReadonlyMap<string, string>,
): Map<string, Reference[]> {
  const files = new Map<string, Reference[]>();
  for (const reference of graph.references) {
    const file = relativePath(graph.root, reference.file);
    if (!texts.has(file)) continue;
    const list = files.get(file);
    if (list === undefined) files.set(file, [reference]);
    else list.push(reference);
  }
  return files;
}

/** `image\nline` for each line where a reference in this file leads to that image. */
function referencedLines(
  references: readonly Reference[],
  root: string,
  lineAt: (offset: number) => number,
): ReadonlySet<string> {
  const lines = new Set<string>();
  for (const reference of references) {
    if (!isLinked(reference)) continue;
    for (const target of linkedPaths(reference)) {
      lines.add(`${relativePath(root, target)}\n${lineAt(reference.start)}`);
    }
  }
  return lines;
}

/** What one place the search found means for one image. */
function placeOf(
  image: string,
  occurrence: PathOccurrence,
  text: string,
  references: readonly Reference[],
  regions: () => (offset: number) => InactiveMarkdown | null,
  context: Context,
): Verdict {
  const start = occurrence.offset;
  const end = start + occurrence.spelling.length;
  const token = tokenAround(text, start, end);
  const written = shown(text.slice(token.start, token.end));
  const reference = innermost(references, start);
  if (reference !== undefined) {
    return readReference(
      reference,
      image,
      reference.unread === true ? written : capped(reference.rawPath),
      context,
    );
  }

  // A name that carries on past the match, or a folder name the match begins inside, is
  // another file's: `logo.png.webp`, `old-img/logo.png`.
  if (!opensSegment(text, start, token.start) || namesCarryOn(text, end, token.end)) {
    return 'elsewhere';
  }
  const address = addressIn(text.slice(token.start, end));
  if (address !== null) {
    return addressOwners(address.path, context.addresses)?.has(image) === true
      ? { reason: 'full-address', why: FULL_ADDRESS, text: written, host: address.host }
      : 'elsewhere';
  }
  if (holeBefore(text, token.start, start)) {
    return { reason: 'built-at-runtime', why: BUILT_AT_RUNTIME, text: written };
  }
  const [reason, why] = whereItSits(occurrence.file, start, regions, context);
  const from = token.start + afterPrefix(text.slice(token.start, start));
  return {
    // Unasserted, so a path that names no file beside its own is also read from the project
    // root, as prose and data often write one.
    resolve: {
      file: join(context.root, occurrence.file),
      start: from,
      end,
      rawPath: text.slice(from, end),
      kind: 'attr',
      shape: 'html.attribute.other',
      ceiling: 'high',
      asserted: false,
    },
    listed: { reason, why, text: written },
  };
}

/**
 * Where the path starts in the text before a match: after a protocol such as a lockfile's
 * `logo@file:`, which is not part of the path, but not after a Windows drive letter.
 */
function afterPrefix(before: string): number {
  const colon = before.lastIndexOf(':');
  if (colon === -1 || before.startsWith('//', colon + 1)) return 0;
  if (colon === 1 && /^[a-zA-Z]$/.test(before.charAt(0))) return 0;
  return colon + 1;
}

/** A place inside a reference Upfly read, judged by where the resolver says it leads. */
function readReference(
  reference: Reference,
  image: string,
  text: string,
  context: Context,
): Verdict {
  switch (reference.resolution) {
    case 'resolved':
    case 'resolved-pattern':
      return linkedPaths(reference).some((target) => relativePath(context.root, target) === image)
        ? 'covered'
        : 'elsewhere';
    case 'out-of-scope':
      return 'elsewhere';
    case 'broken':
      if (
        reference.namesIgnoringCase !== undefined &&
        relativePath(context.root, reference.namesIgnoringCase) === image
      ) {
        return { reason: 'other', why: OTHER_CASE, text };
      }
      return context.withheld.has(reference)
        ? { reason: 'other', why: UNPLACED_ROOT, text }
        : 'elsewhere';
    case 'dynamic':
      return reference.unread === true
        ? {
            reason: 'other',
            why: `Upfly could not read the code around it: ${reference.note ?? 'it does not parse'}`,
            text,
          }
        : { reason: 'built-at-runtime', why: BUILT_AT_RUNTIME, text };
    case 'discarded':
      if (reference.declined !== true) return { reason: 'data-or-props', why: DATA_GUESS, text };
      return {
        reason: isDataOrProps(reference) ? 'data-or-props' : 'other',
        why: reference.note ?? 'a value Upfly does not read as a path here',
        text,
      };
    case 'unresolved-alias':
      return { reason: 'other', why: UNKNOWN_ALIAS, text };
  }
}

/**
 * Whether a declined value sits in data or in an element's or component's attributes, as
 * opposed to a string Upfly declined for how it is written.
 */
function isDataOrProps(reference: Reference): boolean {
  return (
    reference.kind === 'json' ||
    reference.shape === 'html.attribute.other' ||
    reference.shape === 'js.jsx.attribute.other'
  );
}

/** The innermost reference whose range holds the offset. */
function innermost(references: readonly Reference[], offset: number): Reference | undefined {
  let best: Reference | undefined;
  for (const reference of references) {
    if (reference.start > offset || offset >= reference.end) continue;
    if (best === undefined || reference.end - reference.start < best.end - best.start) {
      best = reference;
    }
  }
  return best;
}

/** Why a place outside every reference is not followed, from the file and what holds it. */
function whereItSits(
  file: string,
  offset: number,
  regions: () => (offset: number) => InactiveMarkdown | null,
  context: Context,
): readonly [UnfollowedReason, string] {
  if (context.excluded.has(file)) return ['other', EXCLUDED_FILE];
  const unscanned = context.unscanned.get(file);
  if (unscanned !== undefined) {
    if (unscanned.reason === 'unclaimed-extension') {
      return [
        'unread-file-type',
        unscanned.extension === ''
          ? 'in a file with no extension, a type Upfly does not read'
          : `in a ${unscanned.extension} file, a type Upfly does not read`,
      ];
    }
    return unscanned.reason === 'parse-failed'
      ? ['other', `in a file Upfly could not parse: ${firstLine(unscanned.detail)}`]
      : ['other', 'in a file Upfly could not read'];
  }
  switch (regions()(offset)) {
    case 'comment':
      return ['comment', IN_COMMENT];
    case 'code':
      return ['other', IN_CODE_EXAMPLE];
    case 'frontmatter':
      return ['data-or-props', IN_FRONTMATTER];
    default:
      return ['other', NOT_A_PATH_HERE];
  }
}

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const HTML_COMMENTS = new Set(['.html', '.htm', '.astro']);

/**
 * Where a file holds comments, and for Markdown its code and frontmatter, read by the parser
 * of the adapter that reads the file. A file none of them parses has none it can say.
 */
function regionsOf(file: string, text: string): (offset: number) => InactiveMarkdown | null {
  const extension = extensionOf(file).toLowerCase();
  if (MARKDOWN.has(extension)) return markdownRegionAt(text, extension);
  const ranges = HTML_COMMENTS.has(extension)
    ? htmlCommentRanges(text)
    : (cssCommentRanges(text, extension) ?? javaScriptCommentRanges(text, extension));
  if (ranges === null) return () => null;
  return (offset) =>
    ranges.some(([start, end]) => start <= offset && offset < end) ? 'comment' : null;
}

/**
 * Which file each pending path leads to, resolved in one call as references there would be:
 * relative to the file, from a serving root or the project root, through an alias, with
 * letter case folded. A path into a folder the walk left out leads to a file there, which is
 * never one of the images. `null` where it leads to no file Upfly can see.
 */
function landings(pending: readonly Candidate[], context: Context): (string | null)[] {
  if (pending.length === 0) return [];
  const { graph } = context.input;
  const answers = resolveReferences(
    pending.flatMap((entry) => (entry.raw === undefined ? [] : [entry.raw])),
    {
      root: context.root,
      assets: graph.assets.map((node) => node.asset),
      servingRoots: context.input.servingRoots,
      aliases: context.input.aliases,
      excludedRoots: context.input.excludedRoots ?? [],
      foldCase: true,
      exists: () => false,
    },
  );
  const reached = new Map(
    answers.map((answer) => [
      `${answer.file}\n${answer.start}`,
      answer.resolution === 'out-of-scope'
        ? [answer.resolvedPath]
        : linkedPaths(answer).map((target) => relativePath(context.root, target)),
    ]),
  );
  return pending.map((entry) => {
    const targets =
      entry.raw === undefined ? [] : (reached.get(`${entry.raw.file}\n${entry.raw.start}`) ?? []);
    if (targets.length === 0) return null;
    return targets.includes(entry.line.image) ? entry.line.image : (targets[0] ?? null);
  });
}

/**
 * Every address the images can be reached at, folded to lower case: an image's path in the
 * repository, which a link to a file on a code host ends with, and its URL under each serving
 * root that holds it.
 */
function addressIndex(graph: Graph, servingRoots: ServingRoots): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (address: string, image: string) => {
    const key = foldCase(address);
    const owners = index.get(key) ?? new Set<string>();
    owners.add(image);
    index.set(key, owners);
  };
  for (const { asset } of graph.assets) {
    add(`/${asset.relative}`, asset.relative);
    for (const dir of servingRoots.dirs) {
      if (dir !== '' && asset.relative.startsWith(`${dir}/`)) {
        add(asset.relative.slice(dir.length), asset.relative);
      }
    }
  }
  return index;
}

/**
 * The images a full address's path can name: those whose address is the longest one the path
 * ends with, at a folder boundary, in any letter case. A path that ends with no image's
 * address names none of them.
 */
function addressOwners(
  path: string,
  addresses: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> | null {
  const folded = foldCase(decoded(path));
  for (let at = 0; at !== -1; at = folded.indexOf('/', at + 1)) {
    const owners = addresses.get(folded.slice(at));
    if (owners !== undefined) return owners;
  }
  return null;
}

/** The host and path of a full address, `https://host/path` or `//host/path`, or `null`. */
function addressIn(value: string): { readonly host: string; readonly path: string } | null {
  const at = value.indexOf('//');
  if (at === -1 || (at > 0 && value[at - 1] !== ':')) return null;
  const slash = value.indexOf('/', at + 2);
  if (slash === -1) return null;
  return { host: value.slice(at + 2, slash), path: value.slice(slash) };
}

/** A path with its percent-encoding read, or as written when it does not decode. */
function decoded(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * Characters that end a path written in text: whitespace, quotes and the punctuation markup,
 * code and prose put around a path. Braces and `$` stay inside, so a template's hole is part
 * of the path it builds.
 */
const PATH_END = /[\s"'`()<>[\],;|^=*!]/;

/** The run of path characters around a match. */
function tokenAround(text: string, start: number, end: number): { start: number; end: number } {
  let from = start;
  while (from > 0 && !PATH_END.test(text[from - 1] ?? ' ')) from -= 1;
  let to = end;
  while (to < text.length && !PATH_END.test(text[to] ?? ' ')) to += 1;
  return { start: from, end: to };
}

/**
 * Whether the match starts a folder or file name, rather than inside a longer one: at the
 * start of the path, after a separator, or after the colon of a prefix such as `file:`.
 */
function opensSegment(text: string, start: number, tokenStart: number): boolean {
  if (start === tokenStart) return true;
  const before = text[start - 1];
  const first = text[start];
  return before === '/' || before === '\\' || before === ':' || first === '/' || first === '\\';
}

/**
 * Whether the file name goes on past the match, so the text names a longer one: a letter,
 * digit or name character next, or an extension after a dot. A `?` or `#` starts a query or a
 * fragment, and a dot before a space or the end is the end of a sentence.
 */
function namesCarryOn(text: string, end: number, tokenEnd: number): boolean {
  if (end >= tokenEnd) return false;
  const next = text[end] ?? '';
  if (next === '?' || next === '#' || next === '{' || next === '}') return false;
  if (/[.,:]/.test(next)) return /[\w-]/.test(text[end + 1] ?? '') && end + 1 < tokenEnd;
  return true;
}

/**
 * Whether a template hole comes before the match, so a program builds the path: `${base}`,
 * `{{ site.url }}` or `#{$dir}` in the path's own text, or an ERB or EJS tag closing right
 * before it.
 */
function holeBefore(text: string, tokenStart: number, start: number): boolean {
  return (
    /[{}]|\$\(/.test(text.slice(tokenStart, start)) ||
    text.slice(tokenStart - 2, tokenStart) === '%>'
  );
}

/** A path as written, without the punctuation that ends a sentence, capped. */
function shown(value: string): string {
  return capped(value.replace(/[.,:;!?]+$/, ''));
}

function capped(value: string): string {
  return value.length <= TEXT_CAP ? value : `${value.slice(0, TEXT_CAP)}...`;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

/** A value worked out the first time it is asked for, and kept. */
function lazily<T>(make: () => T): () => T {
  let value: { readonly made: T } | undefined;
  return () => {
    value ??= { made: make() };
    return value.made;
  };
}
