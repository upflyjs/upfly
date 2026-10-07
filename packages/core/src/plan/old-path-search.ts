/**
 * Search each file's text for the old path of a moved or replaced asset, without reading
 * the graph.
 *
 * Independence is the point: a check built on the graph inherits the graph's blind spots.
 * It searches the path, not the basename: a move keeps the file name, so the basename would
 * also match the asset at its new place. That is why `sweepForMentions`, which matches the
 * basenames of assets the graph says nothing references, is not reused. A survivor is an
 * occurrence the move did not rewrite, which may be a reference or may be prose, so the
 * line is reported for a person to read.
 * See "Moving an asset" in ARCHITECTURE.md.
 */

import { plural } from '../format.js';
import { compareStrings } from '../paths.js';

/** One occurrence of an old path that survived the move. */
export interface Survivor {
  /** POSIX-relative path of the file it was found in. */
  readonly file: string;
  readonly line: number;
  /**
   * Offset of the match in the file's text, in UTF-16 code units like an edit's `start`.
   *
   * `optimize` searches before writing, when the old path still appears in the references
   * the plan is about to rewrite. Those are not survivors, and only the offset tells them
   * apart: a line number cannot say whether a planned edit covers this occurrence.
   */
  readonly offset: number;
  /**
   * The text that matched, as the file spells it, so a reader knows what to look for on that
   * line. It is one of the spellings searched for, in any letter case: Windows and macOS find
   * `img/hero.png` by `IMG/Hero.png`.
   */
  readonly spelling: string;
  /** The matching line, trimmed and capped. Evidence, so nobody has to open the file. */
  readonly text: string;
}

/** A file that could not be searched, and why. Never silently dropped. */
export interface Unsearchable {
  readonly file: string;
  readonly reason: string;
}

export interface OldPathSearchResult {
  readonly survivors: readonly Survivor[];
  readonly filesSearched: number;
  readonly unsearchable: readonly Unsearchable[];
  /** Every spelling looked for, so the search is reproducible by hand. */
  readonly spellings: readonly string[];
  /** The verdict and its limits. Both or neither, as in `move-check.ts`. */
  readonly lines: readonly string[];
}

export interface OldPathSearchInput {
  /** The moves to check. Each `from` is searched for; `to` only discounts matches inside it. */
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  /**
   * Every file to search, POSIX-relative to the project root. The caller chooses them:
   * discovery's source and unscanned files cover more than the graph parsed, but not the
   * directories an ignore rule pruned, which the rendered limits say.
   */
  readonly files: readonly string[];
  /** Reads one file by its POSIX-relative path. Rejecting is a reported `Unsearchable`. */
  readonly readFile: (relative: string) => Promise<string>;
  /**
   * Serving directories, so the URL spelling of a served asset can be derived. They come
   * from configuration or detection, not from the graph. Required: without them
   * `public/hero.png` is never searched for as `/hero.png`, the spelling markup uses. A
   * caller with none passes `[]`.
   */
  readonly servingDirs: readonly string[];
}

/** How much of a matching line is kept as evidence. */
const TEXT_CAP = 120;

/**
 * Every spelling of an asset's path that the old-path search looks for.
 *
 * A long needle (`public/img/hero.png`) misses the URL markup uses (`/img/hero.png`), and a
 * short one matches too much, so several are searched and each survivor names the one that
 * matched. The last directory and file name (`img/hero.png`) catch relative spellings such
 * as `../../img/hero.png`. The basename alone is not a spelling: after a move the asset
 * still has that name.
 *
 * @param from the asset's POSIX path, relative to the project root
 * @param servingDirs serving directories; a path under one is also spelled as its URL
 */
export function spellingsFor(from: string, servingDirs: readonly string[]): string[] {
  return [...new Set(spellingsByKind(from, servingDirs).values())].sort(compareStrings);
}

/**
 * The same spellings, each under the kind of place it is written in: the project-relative
 * path, the URL of a project that serves its own root, the URL under each serving directory
 * that holds it, the distinctive suffix, and the Windows form.
 *
 * The kind is what lets one path's spelling be exchanged for another's: a comment that writes
 * `/img/hero.png` wants the new path's URL, not its project path. Keyed per serving directory,
 * since two nested ones give a path two URLs.
 *
 * @param from the asset's POSIX path, relative to the project root
 * @param servingDirs serving directories; a path under one is also spelled as its URL
 */
export function spellingsByKind(
  from: string,
  servingDirs: readonly string[],
): ReadonlyMap<string, string> {
  // `/${from}` is the URL when the project serves its own root (the `''` serving
  // directory). It is added here, so the loop needs no case for `''`: there its condition
  // reads `from.startsWith('/')`, which a project-relative path never does.
  const spellings = new Map<string, string>([
    ['project', from],
    ['root-url', `/${from}`],
  ]);

  for (const dir of servingDirs) {
    if (from === dir || from.startsWith(`${dir}/`)) {
      const served = from.slice(dir.length).replace(/^\/+/, '');
      if (served !== '') spellings.set(`served:${dir}`, `/${served}`);
    }
  }

  // The suffix from the last directory separator but one: enough to be distinctive,
  // short enough to survive any relative prefix.
  const cut = from.lastIndexOf('/');
  if (cut > 0) {
    const parent = from.lastIndexOf('/', cut - 1);
    spellings.set('suffix', from.slice(parent + 1));
  }

  // Windows-style, which appears in generated manifests and in some config files.
  spellings.set('windows', from.split('/').join('\\'));

  return spellings;
}

/**
 * What text spells `to` the way `written` spells `from`, or null when nothing does.
 *
 * The letter case has to match: a mention written in another case names the file on Windows
 * and macOS, and replacing it would be Upfly deciding how the path should have been spelled.
 * Null where the spelling has no counterpart, as a served URL has none for a destination
 * outside every serving directory.
 *
 * @param written the text found, one of `from`'s spellings
 * @param from the asset's path now, POSIX-relative to the project root
 * @param to where it is going, POSIX-relative to the project root
 * @param servingDirs serving directories, as `spellingsFor` takes them
 */
export function respellAs(
  written: string,
  from: string,
  to: string,
  servingDirs: readonly string[],
): string | null {
  const before = spellingsByKind(from, servingDirs);
  const after = spellingsByKind(to, servingDirs);
  let replacement: string | null = null;
  let longest = 0;
  for (const [kind, spelling] of before) {
    const candidate = after.get(kind);
    if (spelling !== written || candidate === undefined || spelling.length <= longest) continue;
    longest = spelling.length;
    replacement = candidate;
  }
  return replacement;
}

/**
 * The text with every letter in lower case and each character where it was, so a match in
 * it is a match in the text in any letter case, at the same offset. A character whose lower
 * case is longer, which only `İ` (U+0130) is, stays as it is rather than move the offsets
 * after it.
 *
 * @param text any text
 * @returns text of the same length, letters folded to lower case
 */
export function foldCase(text: string): string {
  const lowered = text.toLowerCase();
  if (lowered.length === text.length) return lowered;
  let folded = '';
  for (const character of text) {
    const lower = character.toLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
}

/**
 * Search every file for the old paths, in any letter case, since Windows and macOS find a
 * file whatever the case of its name. Reads text; never looks at a graph.
 *
 * Longest spellings first, and one match per line per file: a line containing
 * `/img/hero.png` matches both that spelling and the `img/hero.png` suffix, and reporting
 * it twice would make the count say two occurrences where a reader can see one.
 *
 * Each file is searched for all the spellings in one sweep (see `occurrencesIn`), so the
 * cost follows the size of the text rather than the number of spellings, which reaches
 * tens of thousands on a site that serves thousands of images from its own root.
 */
export async function findSurvivingPaths(input: OldPathSearchInput): Promise<OldPathSearchResult> {
  const spellings = [
    ...new Set(input.moves.flatMap((move) => spellingsFor(move.from, input.servingDirs))),
  ].sort((a, b) => b.length - a.length || compareStrings(a, b));

  // Where the moves put things, so a rewrite that worked is not reported as a survivor.
  // An asset at a serving root has a URL that is its file name with a slash in front, so
  // the old URL (`/og.png`) is also the end of the new one (`/moved/og.png`).
  const destinations = [
    ...new Set(input.moves.flatMap((move) => spellingsFor(move.to, input.servingDirs))),
  ];
  const spellingIndex = indexNeedles(spellings.map(foldCase));
  const destinationIndex = indexNeedles(destinations.map(foldCase));

  const survivors: Survivor[] = [];
  const unsearchable: Unsearchable[] = [];
  let filesSearched = 0;

  for (const file of [...input.files].sort(compareStrings)) {
    let text: string;
    try {
      text = await input.readFile(file);
    } catch (cause) {
      // A file that could not be read is a hole in the search, and "nothing found" over a
      // hole reads as a guarantee, so it is listed.
      unsearchable.push({ file, reason: (cause as Error).message });
      continue;
    }
    filesSearched++;
    survivors.push(...survivorsIn(file, text, spellingIndex, destinationIndex));
  }

  survivors.sort(
    (a, b) =>
      compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.spelling, b.spelling),
  );

  return {
    survivors,
    filesSearched,
    unsearchable,
    spellings,
    lines: render(survivors, filesSearched, unsearchable, spellings),
  };
}

/** One place a spelling of a path occurs in a file's text. */
export interface PathOccurrence {
  /** POSIX-relative path of the file it was found in. */
  readonly file: string;
  readonly line: number;
  /** Offset of the match in the file's text, in UTF-16 code units. */
  readonly offset: number;
  /** The text that matched, as the file spells it. */
  readonly spelling: string;
}

export interface PathOccurrencesInput {
  /** The paths to look for, POSIX-relative to the project root. */
  readonly paths: readonly string[];
  /** Every file to search, as `OldPathSearchInput.files`. */
  readonly files: readonly string[];
  /** Reads one file by its POSIX-relative path. Rejecting is a reported `Unsearchable`. */
  readonly readFile: (relative: string) => Promise<string>;
  /** Serving directories, as `OldPathSearchInput.servingDirs`. */
  readonly servingDirs: readonly string[];
}

export interface PathOccurrencesResult {
  /**
   * Every match of every spelling, by file, then offset, then the longer spelling first.
   * Spellings overlap, since `img/hero.png` ends `/img/hero.png`, so one place in a file can
   * match several of them, each ending where the file name ends.
   */
  readonly occurrences: readonly PathOccurrence[];
  readonly filesSearched: number;
  readonly unsearchable: readonly Unsearchable[];
  /** Every spelling looked for. */
  readonly spellings: readonly string[];
  /** The text of each file that holds an occurrence, so a caller can read around one. */
  readonly texts: ReadonlyMap<string, string>;
}

/**
 * Every place the paths occur in the files, in any spelling and any letter case: the same
 * search as `findSurvivingPaths`, reporting every match rather than one per line, and
 * discounting nothing. What a match means is for the caller to work out, which is why the
 * texts that hold one come back with it.
 */
export async function findPathOccurrences(
  input: PathOccurrencesInput,
): Promise<PathOccurrencesResult> {
  const spellings = [
    ...new Set(input.paths.flatMap((path) => spellingsFor(path, input.servingDirs))),
  ].sort((a, b) => b.length - a.length || compareStrings(a, b));
  const index = indexNeedles(spellings.map(foldCase));

  const occurrences: PathOccurrence[] = [];
  const unsearchable: Unsearchable[] = [];
  const texts = new Map<string, string>();
  let filesSearched = 0;

  for (const file of [...input.files].sort(compareStrings)) {
    let text: string;
    try {
      text = await input.readFile(file);
    } catch (cause) {
      unsearchable.push({ file, reason: (cause as Error).message });
      continue;
    }
    filesSearched++;
    const found = occurrencesIn(foldCase(text), index);
    if (found.length === 0) continue;
    texts.set(file, text);
    const lineAt = lineIndex(text);
    for (const { needle, offsets } of found) {
      for (const at of offsets) {
        occurrences.push({
          file,
          line: lineAt(at),
          offset: at,
          spelling: text.slice(at, at + needle.length),
        });
      }
    }
  }

  occurrences.sort(
    (a, b) =>
      compareStrings(a.file, b.file) ||
      a.offset - b.offset ||
      b.spelling.length - a.spelling.length,
  );
  return { occurrences, filesSearched, unsearchable, spellings, texts };
}

/**
 * The survivors in one file: at most one per line, the match met first when the spellings
 * are taken in rank order, longest first, and each spelling's matches from the top. The
 * indexes hold folded needles and the folded text is searched, so a match is found in any
 * letter case and reported as the file spells it.
 */
function survivorsIn(
  file: string,
  text: string,
  spellings: NeedleIndex,
  destinations: NeedleIndex,
): Survivor[] {
  const folded = foldCase(text);
  const found = occurrencesIn(folded, spellings);
  if (found.length === 0) return [];

  const insideDestination = containedIn(occurrencesIn(folded, destinations));
  const lineAt = lineIndex(text);
  const firstOnLine = new Map<number, { rank: number; at: number; length: number }>();
  for (const { rank, needle, offsets } of found) {
    for (const at of offsets) {
      // Inside a destination path means the move wrote this text, so it is the rewrite
      // working rather than a reference left behind.
      if (insideDestination(at, at + needle.length)) continue;
      const line = lineAt(at);
      const held = firstOnLine.get(line);
      if (held === undefined || rank < held.rank || (rank === held.rank && at < held.at)) {
        firstOnLine.set(line, { rank, at, length: needle.length });
      }
    }
  }

  return [...firstOnLine].map(([line, { at, length }]) => ({
    file,
    line,
    offset: at,
    spelling: text.slice(at, at + length),
    text: lineTextAt(text, at),
  }));
}

/**
 * How many characters at the end of a needle it is filed under.
 *
 * Every spelling of a path ends with the file's name, so the needles of one search end
 * in very few ways. On railsgirls-com, a search for every image it serves holds 39,581
 * needles and 11 endings of four characters (`.png`, `.jpg`, `webp` and a few more).
 * Looking for those 11 and checking each place one occurs reads a file a dozen times,
 * where looking for each needle would read it 39,581 times.
 */
const ENDING_LENGTH = 4;

/** The needles of one search, filed by their last `ENDING_LENGTH` characters, then by length. */
type NeedleIndex = ReadonlyMap<string, ReadonlyMap<number, ReadonlyMap<string, number>>>;

/** Where one needle occurs in one text. */
interface Matches {
  /** The needle's position in the list the index was built from; lower is searched first. */
  readonly rank: number;
  readonly needle: string;
  /** Start offsets, ascending, none overlapping another match of the same needle. */
  readonly offsets: readonly number[];
}

function indexNeedles(needles: readonly string[]): NeedleIndex {
  const index = new Map<string, Map<number, Map<string, number>>>();
  needles.forEach((needle, rank) => {
    // An empty string names no path, and a search for one could never move past it.
    if (needle === '') return;
    const ending = needle.slice(-ENDING_LENGTH);
    const byLength = index.get(ending) ?? new Map<number, Map<string, number>>();
    index.set(ending, byLength);
    const sameLength = byLength.get(needle.length) ?? new Map<string, number>();
    byLength.set(needle.length, sameLength);
    // Two spellings can fold to one needle, and the first keeps its rank.
    if (!sameLength.has(needle)) sameLength.set(needle, rank);
  });
  return index;
}

/**
 * Every match of every indexed needle in `text`, exactly the ones that calling `indexOf`
 * for each needle, from the end of its previous match, would return.
 *
 * A needle can only occur where its own ending does, so the text is searched once per
 * distinct ending and each place an ending occurs is checked against the needles filed
 * under it, by exact lookup. That finds every occurrence, overlapping ones included, in
 * ascending order for each needle, because the endings are met in ascending order. Then,
 * for each needle, the first match is kept and after it the first that starts at or after
 * its end, which is what repeated `indexOf` keeps.
 */
function occurrencesIn(text: string, index: NeedleIndex): Matches[] {
  const found = new Map<number, { needle: string; offsets: number[] }>();
  for (const [ending, byLength] of index) {
    for (let at = text.indexOf(ending); at !== -1; at = text.indexOf(ending, at + 1)) {
      const end = at + ending.length;
      for (const [length, needles] of byLength) {
        if (length > end) continue;
        const candidate = text.slice(end - length, end);
        const rank = needles.get(candidate);
        if (rank === undefined) continue;
        const matches = found.get(rank);
        if (matches === undefined) found.set(rank, { needle: candidate, offsets: [end - length] });
        else matches.offsets.push(end - length);
      }
    }
  }

  return [...found].map(([rank, { needle, offsets }]) => {
    const kept: number[] = [];
    let free = 0;
    for (const offset of offsets) {
      if (offset < free) continue;
      kept.push(offset);
      free = offset + needle.length;
    }
    return { rank, needle, offsets: kept };
  });
}

/**
 * Whether `[start, end)` lies inside the span of one of the destination matches.
 *
 * Containment, not overlap. A match that merely touches a destination is still a
 * survivor: the question is whether the move wrote this text, and it wrote exactly the
 * destination path and nothing around it.
 *
 * Answered by a binary search rather than by trying every span. A span contains the
 * range exactly when it starts at or before `start` and ends at or after `end`, so the
 * furthest end among the spans that start by `start` decides it.
 */
function containedIn(destinations: readonly Matches[]): (start: number, end: number) => boolean {
  const spans = destinations
    .flatMap(({ needle, offsets }) => offsets.map((at) => [at, at + needle.length] as const))
    .sort((a, b) => a[0] - b[0]);
  const starts = spans.map(([from]) => from);
  const reach: number[] = [];
  let furthest = -1;
  for (const [, to] of spans) {
    furthest = Math.max(furthest, to);
    reach.push(furthest);
  }

  return (start, end) => {
    const last = countBelow(starts, start + 1) - 1;
    return last >= 0 && (reach[last] ?? -1) >= end;
  };
}

/** The one-based line of an offset, from a table of line breaks built once per file. */
export function lineIndex(text: string): (offset: number) => number {
  const breaks: number[] = [];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) breaks.push(at);
  return (offset) => 1 + countBelow(breaks, offset);
}

/** How many of the ascending `values` are less than `limit`. */
function countBelow(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? limit) < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The line an offset sits on, trimmed and capped so a report stays readable. */
function lineTextAt(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  const line = text.slice(start, end === -1 ? text.length : end).trim();
  return line.length <= TEXT_CAP ? line : `${line.slice(0, TEXT_CAP)}...`;
}

/**
 * The finding and what the search cannot see, printed whatever the finding, as in
 * `move-check.ts`: a clean result is where an unstated limit is read as a guarantee, and
 * this search finds only a path written down as text.
 */
function render(
  survivors: readonly Survivor[],
  filesSearched: number,
  unsearchable: readonly Unsearchable[],
  spellings: readonly string[],
): string[] {
  const lines = [
    survivors.length === 0
      ? `old paths: none of ${plural(spellings.length, 'spelling')} survives in ${plural(filesSearched, 'file')} searched`
      : `old paths: ${plural(survivors.length, 'occurrence')} to check, in ${plural(filesSearched, 'file')} searched`,
    '',
  ];

  for (const survivor of survivors.slice(0, 20)) {
    lines.push(
      `    ${survivor.file}:${survivor.line}  (${survivor.spelling})`,
      `      ${survivor.text}`,
    );
  }
  if (survivors.length > 20) lines.push(`    ... and ${survivors.length - 20} more`);
  if (survivors.length > 0) {
    lines.push(
      '',
      '    Each is an occurrence the move did not rewrite. Most will be references that',
      '    could not be repointed; some may be prose, a changelog or a coincidence. This',
      '    check reads text, so it cannot tell those apart; the line is printed so you can.',
      '',
    );
  }

  lines.push(
    '  What this search cannot see. It never consults the graph, which is the point, but',
    '  it can only find a path that is written down as text:',
    "    - a path a program assembles at runtime ('/img/' + name + '.png') is not written",
    '      down anywhere, so nothing matches it.',
    '    - a path spelled some other way: URL-encoded, behind a CDN prefix, or split across',
    `      a concatenation. ${plural(spellings.length, 'spelling was', 'spellings were')} searched, listed below.`,
    '    - a file nobody handed this search. Directories excluded by an ignore rule are not',
    '      in the list, so nothing inside them was read.',
  );

  if (unsearchable.length > 0) {
    lines.push(
      `    - ${plural(unsearchable.length, 'file')} could not be read at all:`,
      ...unsearchable.slice(0, 5).map((entry) => `        ${entry.file}: ${entry.reason}`),
    );
  }

  lines.push('', `  spellings searched, in any letter case: ${spellings.join('  ')}`);

  return lines;
}
