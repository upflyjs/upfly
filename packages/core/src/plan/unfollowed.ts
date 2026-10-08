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
import { htmlRegions } from '../adapters/html.js';
import { javaScriptCommentRanges } from '../adapters/javascript.js';
import { type MarkdownRegion, markdownRegionAt } from '../adapters/markdown.js';
import { TEMPLATE_HOLES, type TemplateHole } from '../adapters/reference-path.js';
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
  lineTextAt,
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
  /** It names a moved folder itself rather than an image in it. */
  | 'folder'
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
   * Whether a page can still load the image through this line, so a move breaks it unless
   * somebody changes it by hand. False only where Upfly read the place and found that nothing
   * loads it: a comment, a code example, or text a page shows.
   */
  readonly loads: boolean;
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
const IN_A_COMMENT = 'in a comment, which no page loads';
const IN_COMMENT = `${IN_A_COMMENT}: the path in it is rewritten with the references, and never decides on its own whether the image converts or moves`;
const IN_CODE_EXAMPLE = 'in a code example, which a page shows rather than loads';
const EXCLUDED_FILE =
  'in a file this run leaves out (.upflyignore, --exclude or the config file), read only to list it here';
const OTHER_CASE =
  'it names the image in other letter case, which Windows and macOS find and a Linux server does not; the check command reports it';
const UNPLACED_ROOT =
  "a path from the site's root, which Upfly cannot follow while it cannot tell the folder the site is served from";
const UNKNOWN_ALIAS = 'written through an alias that no configuration Upfly reads defines';
const IN_SHOWN_TEXT = 'in the text of a page, which shows the path rather than loads it';
const NOT_READ_HERE = 'in a value Upfly takes no path from, such as HTML written inside a string';
const FOLDER_ITSELF =
  'it names the folder itself rather than an image in it: a rule that copies it, a pattern that matches inside it, or a path built from it. Upfly never rewrites one, so what the folder holds after the move is yours to decide';
const INSIDE_THE_FOLDER =
  'it names a path inside the moved folder rather than one of the images moving, such as a file a build writes, so the move leaves it as written';

/** How much of a path as written is kept, as the old-path search caps a line. */
const TEXT_CAP = 120;

/**
 * The tags a template engine fills in before a page is served, `{% image "a.png" %}` among
 * them. The holes a resolver globs are a language's own interpolation instead, such as a
 * JavaScript template literal's, which a page's text does not hold.
 */
const ENGINE_TAGS: readonly TemplateHole[] = TEMPLATE_HOLES.filter((hole) => !hole.globbed);

/** The verdict on one place the search found. */
type Verdict =
  /** Inside a reference to this image: the line is one of its references. */
  | 'covered'
  /** It names another file, or no file this image could be. */
  | 'elsewhere'
  | Listed
  /** Outside every reference: what the resolver makes of the path decides. */
  | { readonly resolve: RawReference; readonly listed: Listed };

interface Listed extends Place {
  readonly text: string;
  readonly host?: string;
}

/** Why a line is not followed, and whether a page still loads the image through it. */
interface Place {
  readonly reason: UnfollowedReason;
  readonly why: string;
  readonly loads: boolean;
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
      held.push(candidateFor(image, file, occurrence, verdict));
      candidates.set(key, held);
    }
  }
  return candidates;
}

/** One place that may list its line, from the verdict on it. */
function candidateFor(
  image: string,
  file: string,
  occurrence: PathOccurrence,
  verdict: Listed | { readonly resolve: RawReference; readonly listed: Listed },
): Candidate {
  const listed = 'resolve' in verdict ? verdict.listed : verdict;
  const line = { image, file, line: occurrence.line, ...listed };
  const at = { offset: occurrence.offset, spelling: occurrence.spelling };
  return 'resolve' in verdict ? { line, raw: verdict.resolve, at } : { line, at };
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

/**
 * The graph's references by POSIX path: in each file `texts` holds, which are those holding an
 * occurrence, or in every file when it is null.
 */
function referencesByFile(
  graph: Graph,
  texts: ReadonlyMap<string, string> | null,
): Map<string, Reference[]> {
  const files = new Map<string, Reference[]>();
  for (const reference of graph.references) {
    const file = relativePath(graph.root, reference.file);
    if (texts !== null && !texts.has(file)) continue;
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
  regions: () => RegionAt,
  context: Context,
): Verdict {
  const start = occurrence.offset;
  const end = start + occurrence.spelling.length;
  const token = tokenAround(text, start, end);
  const written = shown(text.slice(token.start, token.end));
  const reference = innermost(references, start);
  if (reference !== undefined) {
    const read = readReference(
      reference,
      image,
      reference.unread === true ? written : capped(reference.rawPath),
      context,
    );
    // Upfly took the text for a path, so a page may load the image through it, followed or not.
    return typeof read === 'string' ? read : { ...read, loads: true };
  }

  // A name that carries on past the match, or a folder name the match begins inside, is
  // another file's: `logo.png.webp`, `old-img/logo.png`.
  if (!opensSegment(text, start, token.start) || namesCarryOn(text, end, token.end)) {
    return 'elsewhere';
  }
  const address = addressIn(text.slice(token.start, end));
  if (address !== null) {
    return addressOwners(address.path, context.addresses)?.has(image) === true
      ? {
          reason: 'full-address',
          why: FULL_ADDRESS,
          loads: true,
          text: written,
          host: address.host,
        }
      : 'elsewhere';
  }
  if (holeBefore(text, token.start, start)) {
    return { reason: 'built-at-runtime', why: BUILT_AT_RUNTIME, loads: true, text: written };
  }
  const place = whereItSits(occurrence.file, start, regions, context);
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
    listed: { ...place, text: written },
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
): 'covered' | 'elsewhere' | Omit<Listed, 'loads'> {
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

/** What a file holds at an offset, as the parser of the adapter that reads the file says. */
type RegionAt = (offset: number) => MarkdownRegion | null;

/**
 * Why a place outside every reference is not followed, from the file and what holds it, and
 * whether a page still loads the image through it. Only a place a parser read and found to
 * load nothing does not: a comment, a code example, or text a page shows. Everything else
 * counts as loading, a value no reader took a path from among them.
 */
function whereItSits(
  file: string,
  offset: number,
  regions: () => RegionAt,
  context: Pick<Context, 'excluded' | 'unscanned'>,
): Place {
  if (context.excluded.has(file)) return { reason: 'other', why: EXCLUDED_FILE, loads: true };
  const unscanned = context.unscanned.get(file);
  if (unscanned !== undefined) return { ...unreadFile(unscanned), loads: true };
  const region = regions()(offset);
  switch (region) {
    case 'comment':
      return { reason: 'comment', why: IN_COMMENT, loads: false };
    case 'code':
      return { reason: 'other', why: IN_CODE_EXAMPLE, loads: false };
    case 'frontmatter':
      return { reason: 'data-or-props', why: IN_FRONTMATTER, loads: true };
    case null:
      return { reason: 'other', why: NOT_READ_HERE, loads: true };
    default: {
      const tag = openTag(region.shown);
      return tag === null
        ? { reason: 'other', why: IN_SHOWN_TEXT, loads: false }
        : { reason: 'other', why: `in ${tag.name}, which Upfly does not read`, loads: true };
    }
  }
}

/** Why a place in a file the scan did not read is not followed. */
function unreadFile(unscanned: UnscannedFile): Omit<Place, 'loads'> {
  if (unscanned.reason === 'unclaimed-extension') {
    return {
      reason: 'unread-file-type',
      why:
        unscanned.extension === ''
          ? 'in a file with no extension, a type Upfly does not read'
          : `in a ${unscanned.extension} file, a type Upfly does not read`,
    };
  }
  return unscanned.reason === 'parse-failed'
    ? { reason: 'other', why: `in a file Upfly could not parse: ${firstLine(unscanned.detail)}` }
    : { reason: 'other', why: 'in a file Upfly could not read' };
}

/**
 * The template engine's tag still open at the end of a page's text, or null: its opener with
 * no closer after it, as in `{% image "/img/a.png"`. The engine reads what the tag holds, so
 * a path there can load an image as any value can.
 */
function openTag(shown: string): TemplateHole | null {
  let open: TemplateHole | null = null;
  let at = -1;
  for (const hole of ENGINE_TAGS) {
    const opened = shown.lastIndexOf(hole.opener);
    if (opened <= at || shown.includes(hole.closer, opened + hole.opener.length)) continue;
    open = hole;
    at = opened;
  }
  return open;
}

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);

/** Pages whose text between tags a visitor reads. Astro's holds expressions instead. */
const PAGES = new Set(['.html', '.htm']);

/**
 * Where a file holds comments, and for Markdown its code and frontmatter, and for a page the
 * text it shows, read by the parser of the adapter that reads the file. A file none of them
 * parses has none it can say.
 */
function regionsOf(file: string, text: string): RegionAt {
  const extension = extensionOf(file).toLowerCase();
  if (MARKDOWN.has(extension)) return markdownRegionAt(text, extension);
  if (PAGES.has(extension) || extension === '.astro') {
    const regions = htmlRegions(text);
    const runs = PAGES.has(extension) ? regions.text : [];
    return (offset) => {
      if (holds(regions.comments, offset)) return 'comment';
      const run = runs.find(([start, end]) => start <= offset && offset < end);
      return run === undefined ? null : { shown: text.slice(run[0], offset) };
    };
  }
  const ranges = cssCommentRanges(text, extension) ?? javaScriptCommentRanges(text, extension);
  if (ranges === null) return () => null;
  return (offset) => (holds(ranges, offset) ? 'comment' : null);
}

function holds(ranges: readonly (readonly [number, number])[], offset: number): boolean {
  return ranges.some(([start, end]) => start <= offset && offset < end);
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

/** What `linesNamingFolders` needs: the folders, the files, and what the plan already covers. */
export interface FolderLinesInput {
  /** The project as the scan read it, which says what holds each line the search finds. */
  readonly graph: Graph;
  /** The folders being moved, POSIX-relative to the project root. */
  readonly folders: readonly string[];
  /** Every file to search, as `UnfollowedInput.files`. */
  readonly files: readonly string[];
  /** The files in `files` that the run's ignore rules excluded. */
  readonly excludedFiles: readonly string[];
  /** Reads one file by its POSIX-relative path. Rejecting is a reported `Unsearchable`. */
  readonly readFile: (relative: string) => Promise<string>;
  readonly servingRoots: ServingRoots;
  /** `file:line` for every line the move already lists. */
  readonly listed: ReadonlySet<string>;
  /**
   * The offsets the move's edits sit at, by POSIX-relative file. Offsets rather than lines,
   * because the line an offset sits on needs the file's text, which this search reads.
   */
  readonly rewritten: ReadonlyMap<string, readonly number[]>;
}

/**
 * Every line that names a moved folder rather than an image in it: a build's rule that copies
 * the folder, a pattern that matches inside it, a path built from it at runtime, or a path to
 * a file inside it that is none of the images moving, such as one a build writes.
 *
 * A move rewrites references to images, and a line like this names no image, so nothing
 * rewrites it and after the move it points at a folder that is not there. Listing it is all
 * Upfly can do: what a copy rule or a glob should become is the project's decision. Whether a
 * page loads anything through the line is read from where it sits, as for an image's lines.
 *
 * The match has to be the whole of a path segment, or `src/img` would be found inside
 * `src/images`, and a URL counts only with something under it, since `/blogs` alone is the
 * page of that name. See "The independent check" in ARCHITECTURE.md.
 *
 * @param input the folders, the files to search, and what the plan already covers
 * @returns the lines, by file then line, and the files that could not be read
 */
export async function linesNamingFolders(input: FolderLinesInput): Promise<{
  readonly lines: readonly UnfollowedLine[];
  readonly unsearchable: readonly Unsearchable[];
}> {
  if (input.folders.length === 0) return { lines: [], unsearchable: [] };
  const found = await findPathOccurrences({
    paths: input.folders,
    files: input.files,
    readFile: input.readFile,
    servingDirs: input.servingRoots.dirs,
  });
  const byFolder = new Map(
    input.folders.map((folder) => [
      folder,
      new Set(spellingsFor(folder, input.servingRoots.dirs).map(foldCase)),
    ]),
  );
  const covered = coveredLines(input, found.texts);
  const sits = placeReader(input, found.texts);

  const lines: UnfollowedLine[] = [];
  const seen = new Set<string>();
  for (const place of found.occurrences) {
    const text = found.texts.get(place.file) ?? '';
    const end = place.offset + place.spelling.length;
    if (!wholeSegment(text, place.offset, end, place.spelling)) continue;
    const at = `${place.file}:${place.line}`;
    if (covered(place.file, place.line) || seen.has(at)) continue;
    const folder = [...byFolder].find(([, spellings]) => spellings.has(foldCase(place.spelling)));
    if (folder === undefined) continue;
    seen.add(at);
    lines.push({
      image: folder[0],
      file: place.file,
      line: place.line,
      text: shown(lineTextAt(text, place.offset)),
      reason: 'folder',
      ...folderVerdict(namesInside(text, end), sits(place.file, place.offset)),
    });
  }
  lines.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line);
  return { lines, unsearchable: found.unsearchable };
}

/** Whether the move already lists a line, or rewrites a reference on it. */
function coveredLines(
  input: FolderLinesInput,
  texts: ReadonlyMap<string, string>,
): (file: string, line: number) => boolean {
  const edited = new Map<string, ReadonlySet<number>>();
  for (const [file, offsets] of input.rewritten) {
    const text = texts.get(file);
    if (text === undefined) continue;
    const lineAt = lineIndex(text);
    edited.set(file, new Set(offsets.map(lineAt)));
  }
  return (file, line) =>
    input.listed.has(`${file}:${line}`) || edited.get(file)?.has(line) === true;
}

/**
 * What holds a place in a file the search read: a reference Upfly read, which counts as
 * loading, given as null, or the place `whereItSits` says.
 */
function placeReader(
  input: FolderLinesInput,
  texts: ReadonlyMap<string, string>,
): (file: string, offset: number) => Place | null {
  const references = referencesByFile(input.graph, texts);
  const context = {
    excluded: new Set(input.excludedFiles),
    unscanned: new Map(input.graph.unscannedFiles.map((file) => [file.relative, file])),
  };
  const readers = new Map<string, () => RegionAt>();
  return (file, offset) => {
    if (innermost(references.get(file) ?? [], offset) !== undefined) return null;
    let regions = readers.get(file);
    if (regions === undefined) {
      const text = texts.get(file) ?? '';
      regions = lazily(() => regionsOf(file, text));
      readers.set(file, regions);
    }
    return whereItSits(file, offset, regions, context);
  };
}

/**
 * Whether the text goes on past the folder into a path inside it, as `/img/favicon.png` does,
 * rather than ending at the folder or going on into a pattern or a template's hole.
 */
function namesInside(text: string, end: number): boolean {
  const separator = text.charAt(end);
  if (separator !== '/' && separator !== '\\') return false;
  if (TEMPLATE_HOLES.some((hole) => text.startsWith(hole.opener, end + 1))) return false;
  return NAME_CHARACTER.test(text.charAt(end + 1));
}

/**
 * The sentence for a line naming a moved folder, and whether a page loads anything through
 * it: as the place says, where a reference Upfly read, given as null, always loads.
 */
function folderVerdict(inside: boolean, place: Place | null): Pick<Place, 'why' | 'loads'> {
  if (place === null || place.loads) {
    return { why: inside ? INSIDE_THE_FOLDER : FOLDER_ITSELF, loads: true };
  }
  const what = inside ? 'a path inside the moved folder' : 'the moved folder';
  return { why: `it names ${what} ${placeAlone(place)}`, loads: false };
}

/**
 * Where a place sits, for a line nothing rewrites. The sentence for a comment on an image's
 * line says the path moves with the references, which is true of no other line.
 */
function placeAlone(place: Place): string {
  return place.reason === 'comment' ? IN_A_COMMENT : place.why;
}

/**
 * What one place says of an image nothing links to: how it names the image, and whether a
 * page could load the image through it.
 */
export interface MentionPlace {
  /** The words after the place, such as "names it in a comment, which no page loads". */
  readonly says: string;
  readonly loads: boolean;
}

/**
 * Reads what holds a mention of an image's file name, for an image nothing links to, in the
 * words the lines a move lists use. Inside a path Upfly read, the name is that path's own
 * file's, so the mention loads nothing of this image.
 *
 * @param graph the project as the scan read it
 * @returns a reader of one place: the file, its text, or null for a file the scan did not
 * read, and the offset of the name in it
 */
export function mentionReader(
  graph: Graph,
): (file: string, text: string | null, offset: number) => MentionPlace {
  const context = {
    excluded: new Set<string>(),
    unscanned: new Map(graph.unscannedFiles.map((file) => [file.relative, file])),
  };
  const references = lazily(() => referencesByFile(graph, null));
  const readers = new Map<string, () => RegionAt>();
  return (file, text, offset) => {
    const reference = text === null ? undefined : innermost(references().get(file) ?? [], offset);
    if (reference !== undefined) {
      const [target] = linkedPaths(reference);
      const to = target === undefined ? 'another file' : relativePath(graph.root, target);
      return {
        says: `names only its file name, in \`${capped(reference.rawPath)}\`, a path to ${to}`,
        loads: false,
      };
    }
    let regions = readers.get(file);
    if (regions === undefined) {
      regions = lazily(() => (text === null ? () => null : regionsOf(file, text)));
      readers.set(file, regions);
    }
    const place = whereItSits(file, offset, regions, context);
    return { says: `names it ${placeAlone(place)}`, loads: place.loads };
  };
}

/** The characters a file or folder name is made of, for deciding where a match ends. */
const NAME_CHARACTER = /[A-Za-z0-9_.@~$-]/;

/**
 * Whether the match is the whole of a path segment: `src/img` inside `src/images`, or inside
 * `vendor/src/img`, is another path. A URL spelling needs something under it.
 */
function wholeSegment(text: string, start: number, end: number, spelling: string): boolean {
  const before = start === 0 ? '' : text.charAt(start - 1);
  if (before !== '' && (NAME_CHARACTER.test(before) || before === '/' || before === '\\')) {
    return false;
  }
  const after = text.charAt(end);
  return spelling.startsWith('/') ? after === '/' : !NAME_CHARACTER.test(after);
}
