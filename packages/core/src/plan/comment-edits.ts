/**
 * The edits that move a path written inside a comment to where its image is going.
 *
 * A comment is not a reference: no page loads one, so a path in a comment never makes an
 * image convert or move. But the path in it names the file it names, and leaving it behind
 * after the file has gone makes the comment a lie, which is why `optimize` used to refuse
 * the conversion instead. So it moves with the references, as one more edit in the same
 * transaction.
 *
 * Where a comment sits is read by the parser of the adapter that reads the file, through the
 * same reading that lists the lines a move cannot follow.
 */

import { compareStrings } from '../paths.js';
import type { Edit } from '../types.js';
import { respellAs } from './old-path-search.js';
import type { CommentMention } from './unfollowed.js';

/** One path inside a comment, and the edit that moves it. */
export interface CommentEdit {
  /** The image the path names, POSIX-relative to the project root. */
  readonly image: string;
  /** POSIX-relative path of the file that holds the comment. */
  readonly file: string;
  readonly line: number;
  readonly edit: Edit;
  /** The hash of the text the edit's offsets were measured in. */
  readonly textHash: string;
}

export interface CommentEditsInput {
  /** The places inside a comment that name one of the images. */
  readonly comments: readonly CommentMention[];
  /** Where each image is going, by its POSIX-relative path. */
  readonly destinations: ReadonlyMap<string, string>;
  /** Serving directories, so a URL in a comment is answered with a URL. */
  readonly servingDirs: readonly string[];
}

/**
 * The edit for each comment whose path can be moved, by file and offset.
 *
 * Left alone, and so still named in whatever list the caller keeps: a spelling the
 * destination has no counterpart for, such as the URL of an image moving out of the served
 * folder; and a place two images both claim, where which one the comment means is what
 * cannot be told.
 *
 * @param input the comments, where each image goes, and the serving directories
 * @returns the edits, by file then offset
 */
export function commentEditsFor(input: CommentEditsInput): CommentEdit[] {
  const claims = new Map<string, number>();
  for (const mention of input.comments) {
    const at = `${mention.file}\n${mention.offset}`;
    claims.set(at, (claims.get(at) ?? 0) + 1);
  }

  const edits: CommentEdit[] = [];
  for (const mention of input.comments) {
    const to = input.destinations.get(mention.image);
    if (to === undefined) continue;
    if ((claims.get(`${mention.file}\n${mention.offset}`) ?? 0) > 1) continue;
    const replacement = respellAs(mention.spelling, mention.image, to, input.servingDirs);
    if (replacement === null) continue;
    edits.push({
      image: mention.image,
      file: mention.file,
      line: mention.line,
      textHash: mention.textHash,
      edit: {
        start: mention.offset,
        end: mention.offset + mention.spelling.length,
        replacement,
        expected: mention.spelling,
        inComment: true,
      },
    });
  }
  return edits.sort((a, b) => compareStrings(a.file, b.file) || a.edit.start - b.edit.start);
}

/** The edits grouped by file, with the text each was measured in, as a plan's rewrites take them. */
export function editsByFile(
  edits: readonly CommentEdit[],
): ReadonlyMap<string, { readonly edits: readonly Edit[]; readonly textHash: string }> {
  const byFile = new Map<string, { edits: Edit[]; textHash: string }>();
  for (const entry of edits) {
    const held = byFile.get(entry.file) ?? { edits: [], textHash: entry.textHash };
    held.edits.push(entry.edit);
    byFile.set(entry.file, held);
  }
  return byFile;
}
