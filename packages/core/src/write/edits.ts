import { UpflyError } from '../errors.js';
import type { Edit } from '../types.js';

/**
 * Apply range replacements to a string. The edits may come in any order, and every
 * offset refers to `source` as given.
 *
 * This is the primitive every adapter's `rewrite` is built on, so it is strict: rewriting
 * a user's source file is the riskiest thing the engine does, and anything ambiguous
 * throws rather than guessing. See "Edits and `applyEdits`" in ARCHITECTURE.md.
 *
 * @throws {UpflyError} `INVALID_EDIT_RANGE` if a range is not a valid slice of `source`.
 * @throws {UpflyError} `OVERLAPPING_EDITS` if two edits cover overlapping text.
 * @throws {UpflyError} `AMBIGUOUS_EDITS` if two edits start at the same offset, where
 *         the result would depend on application order.
 * @throws {UpflyError} `EDIT_TEXT_MISMATCH` if an edit's range does not hold its
 *         `expected` text.
 */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  if (edits.length === 0) return source;

  const ordered = validateEdits(source, edits);

  let result = source;
  // Descending by start: later edits are applied first, leaving earlier offsets intact.
  for (let i = ordered.length - 1; i >= 0; i--) {
    // Safe: `ordered` is a dense array and i is within bounds.
    const edit = ordered[i] as Edit;
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

/**
 * Build the edits that turn `applyEdits(source, edits)` back into `source`, in offset order.
 *
 * This is how undo restores a file without keeping a copy of it: each reverse edit puts
 * one replaced range back, and what it stores is a path string rather than a whole file.
 * Each carries the text it replaces as `expected`, so undoing one change alone can never
 * land on other text, and the forward edit's `asset` and `inComment`.
 *
 * Check that the result applies before relying on it: two adjacent edits where the first
 * deletes text can invert to two edits sharing a start offset, which `applyEdits` refuses.
 * The transaction's `prepare` checks this before anything is written.
 */
export function invertEdits(source: string, edits: readonly Edit[]): Edit[] {
  const ordered = validateEdits(source, edits);
  const inverse: Edit[] = [];

  // Offsets in the new text drift from offsets in the old by the length change of
  // every edit before them, so the shift is accumulated left to right.
  let shift = 0;
  for (const edit of ordered) {
    const start = edit.start + shift;
    inverse.push({
      start,
      end: start + edit.replacement.length,
      replacement: source.slice(edit.start, edit.end),
      expected: edit.replacement,
      ...(edit.inComment === undefined ? {} : { inComment: edit.inComment }),
      ...(edit.asset === undefined ? {} : { asset: edit.asset }),
    });
    shift += edit.replacement.length - (edit.end - edit.start);
  }
  return inverse;
}

/** How many line feeds `text` holds in `[from, to)`. */
export function countLineBreaks(text: string, from: number, to: number): number {
  let found = 0;
  for (let at = text.indexOf('\n', from); at !== -1 && at < to; at = text.indexOf('\n', at + 1)) {
    found += 1;
  }
  return found;
}

/**
 * Check a set of edits against a source string and return them sorted ascending.
 *
 * It throws the same errors as `applyEdits` without applying anything, so a caller can
 * reject edits before a byte is written, which is far cheaper than failing halfway
 * through a rewrite.
 */
export function validateEdits(source: string, edits: readonly Edit[]): Edit[] {
  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)) {
      throw new UpflyError(
        'INVALID_EDIT_RANGE',
        `Edit offsets must be integers, received start=${edit.start} end=${edit.end}.`,
      );
    }
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
      throw new UpflyError(
        'INVALID_EDIT_RANGE',
        `Edit range [${edit.start}, ${edit.end}) is not within a source of length ${source.length}.`,
      );
    }
    const found = source.slice(edit.start, edit.end);
    if (edit.expected !== undefined && found !== edit.expected) {
      throw new UpflyError(
        'EDIT_TEXT_MISMATCH',
        `Edit range [${edit.start}, ${edit.end}) holds ${JSON.stringify(found)}, not the ${JSON.stringify(edit.expected)} it was worked out from.`,
      );
    }
  }

  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1] as Edit;
    const current = ordered[i] as Edit;

    if (current.start === previous.start) {
      throw new UpflyError(
        'AMBIGUOUS_EDITS',
        `Two edits start at offset ${current.start}; the result would depend on which is applied first.`,
      );
    }
    if (current.start < previous.end) {
      throw new UpflyError(
        'OVERLAPPING_EDITS',
        `Edit [${current.start}, ${current.end}) overlaps [${previous.start}, ${previous.end}).`,
      );
    }
  }

  return ordered;
}
