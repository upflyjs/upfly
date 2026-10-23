/**
 * What went unread, grouped by what a reader can do about it. Shared by the report's
 * caveats and the move check (`move-check.ts`), so the list of binary extensions exists
 * once: a second copy would drift, and both would still look correct.
 */

import { compareStrings } from '../paths.js';
import type { UnscannedExtension, UnscannedFile } from '../types.js';

/**
 * Extensions whose contents are not text.
 *
 * A list rather than a heuristic, because calling a text format binary would tell a user
 * that no adapter could ever read it. Anything not named here is assumed to be text an
 * adapter could one day read.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mp3',
  '.wav',
  '.ogg',
  '.otf',
  '.ttf',
  '.woff',
  '.woff2',
  '.eot',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.wasm',
  '.node',
  '.bin',
  '.psd',
  '.sketch',
  '.ai',
  '.eps',
  '.indd',
  '.idml',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.swf',
  '.db',
  '.sqlite',
]);

/** Unscanned extensions, split three ways. */
export interface UnscannedGroups {
  /** Text we could read one day. An adapter closes this group. */
  readonly adapterCould: readonly UnscannedExtension[];
  /** Not text. Nothing closes this group, and nothing should try. */
  readonly binary: readonly UnscannedExtension[];
  /** SVG files, which are counted as image assets and also left unparsed. */
  readonly svg: number;
}

/**
 * Unscanned extensions, split by what a reader can do about each: an adapter could close
 * the first group, nothing closes the second, and SVG is counted apart because it is also
 * an image asset.
 */
export function groupUnscanned(extensions: readonly UnscannedExtension[]): UnscannedGroups {
  const adapterCould: UnscannedExtension[] = [];
  const binary: UnscannedExtension[] = [];
  let svg = 0;

  for (const entry of extensions) {
    if (entry.ext === '.svg') svg += entry.fileCount;
    else if (BINARY_EXTENSIONS.has(entry.ext)) binary.push(entry);
    else adapterCould.push(entry);
  }

  return { adapterCould, binary, svg };
}

/**
 * The unread file types a literal path could be hiding in: every type but those that hold no
 * path a page loads (`holdsNoPathAPageLoads`). The text types are among them, SVG, which can
 * carry an `<image href>` a move would fail to repoint, and a database or compiled code, whose
 * bytes can hold a path; a font holds no path text for a move to miss.
 */
export function couldHideAReference(
  extensions: readonly UnscannedExtension[],
): readonly UnscannedExtension[] {
  // Most files first, so a caller that names only the first few leaves out the smallest
  // types rather than whichever sort last alphabetically. Ties break on extension, so the
  // order is deterministic.
  return extensions
    .filter((entry) => !holdsNoPathAPageLoads(entry.ext))
    .sort((a, b) => b.fileCount - a.fileCount || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0));
}

/**
 * Binary formats whose bytes hold no path a page loads: media, fonts and icons, documents a
 * person opens, and archives, whose files are unpacked before anything reads them. Most are
 * compressed besides, so a path in one is no longer its plain bytes.
 *
 * The rest of the binary formats are not here: a database holds the pages a site renders from
 * it, and compiled code (`.wasm`, `.node`) and a file of unknown bytes (`.bin`) can hold a path
 * a page asks for, as plain bytes a search finds.
 */
const NO_PATH_A_PAGE_LOADS: ReadonlySet<string> = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mp3',
  '.wav',
  '.ogg',
  '.otf',
  '.ttf',
  '.woff',
  '.woff2',
  '.eot',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.psd',
  '.sketch',
  '.ai',
  '.eps',
  '.indd',
  '.idml',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
]);

/**
 * Whether a file of this extension holds no path a page loads, so a search for the lines
 * naming an image can leave it unread. Every such extension is a binary one.
 */
export function holdsNoPathAPageLoads(extension: string): boolean {
  return NO_PATH_A_PAGE_LOADS.has(extension);
}

/**
 * Unread files counted by extension, sorted by extension. The graph counts every unread
 * file, parse failures included; the move check counts a subset without them, since it
 * lists parse failures on their own and must not count the same files twice.
 */
export function countExtensions(files: readonly UnscannedFile[]): UnscannedExtension[] {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1);

  return [...counts]
    .map(([ext, fileCount]) => ({ ext, fileCount }))
    .sort((a, b) => compareStrings(a.ext, b.ext));
}
