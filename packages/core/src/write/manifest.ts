/**
 * The record of what a run intends to do, and the only thing `undo` reads.
 *
 * See ARCHITECTURE.md, "The transaction", for why the manifest is written before
 * the first file is touched rather than after the last.
 */

import { compareStrings } from '../paths.js';
import type { Edit } from '../types.js';

/**
 * The newest record format this build reads and writes, bumped on any change a reader could
 * trip over. Snapshot-tested as public API. A record is stamped with the oldest version that
 * describes it (`schemaVersionOf`), so a build that reads only version 1 can still undo a
 * run of which nothing was undone part by part, and refuses, by its version, one it would
 * misread.
 */
export const MANIFEST_SCHEMA_VERSION = 2;

/**
 * The version a record of these operations needs: 2 once part of a file has been undone on
 * its own, which a version 1 reader would take for somebody else's edit, else 1.
 */
export function schemaVersionOf(operations: readonly Operation[]): 1 | 2 {
  return operations.some(
    (operation) => operation.kind === 'edit' && operation.partlyUndone !== undefined,
  )
    ? 2
    : 1;
}

/**
 * Upfly's own folder in a project, relative to the project root. The manifest, the lock
 * and every run's staged files and backups live here, and discovery never reads it.
 */
export const UPFLY_DIRECTORY = '.upfly';

/** Where the manifest lives, relative to the project root. */
export const MANIFEST_PATH = `${UPFLY_DIRECTORY}/manifest.json`;

/**
 * Where a run made without undo keeps its record and its folder while it writes, apart from
 * the manifest and the folder of the last run `undo` follows, which it never touches. Nothing
 * stays here once such a run finishes.
 */
export const NO_UNDO_DIRECTORY = `${UPFLY_DIRECTORY}/no-undo`;

/** The record of a run made without undo, while it writes. */
export const NO_UNDO_MANIFEST_PATH = `${NO_UNDO_DIRECTORY}/manifest.json`;

/**
 * Put a file at a path that does not exist yet.
 *
 * The bytes are already on disk under the run directory, so committing this is a
 * rename rather than an encode. Nothing is computed during commit that could fail
 * in a way we had not already seen during prepare.
 */
export interface CreateOperation {
  readonly kind: 'create';
  /** POSIX-relative to the project root. */
  readonly path: string;
  /** POSIX-relative to the run directory. */
  readonly staged: string;
  readonly afterHash: string;
}

/**
 * Replace the text of a file that already exists.
 *
 * `inverse` is the set of edits that turns the new text back into the old text, in offset
 * order. Storing it rather than a copy of the whole file keeps the manifest self-contained:
 * one JSON file is the complete undo record, and the replaced text is a path string,
 * so the cost is bytes rather than kilobytes.
 */
export interface EditOperation {
  readonly kind: 'edit';
  readonly path: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly inverse: readonly UndoEdit[];
  /**
   * Each state undoing part of the file has put it in, or was about to. Each is written
   * before the file is, so whatever an interrupted undo left, the file's hash is one the
   * record names. Absent until part of the file is undone on its own.
   */
  readonly partlyUndone?: readonly PartlyUndone[];
}

/**
 * One edit of an `EditOperation`'s `inverse`: it puts back the path one change replaced. Its
 * `expected` is the path the run wrote, its `asset` the image the old path names. A record
 * written before these fields were kept has only the range and the old path.
 */
export interface UndoEdit extends Edit {
  /**
   * The line the change is on in the file as the run left it, counted from 1. Absent from an
   * older record, whose lines are worked out from the file.
   */
  readonly line?: number;
}

/**
 * A state of a file with some of its changes undone and the rest in place: which edits of
 * `inverse` are undone, by index, and the hash of the file's bytes in that state.
 */
export interface PartlyUndone {
  readonly undone: readonly number[];
  readonly hash: string;
}

/** One edit of an `inverse`, placed in the file's text as it is with some edits undone. */
export interface PlacedUndoEdit {
  /** Its index in `inverse`. */
  readonly index: number;
  /** Whether the text has it undone already. */
  readonly undone: boolean;
  /**
   * Its range in that text: the path the run wrote, or for an undone edit the old path, which
   * is what that range holds now.
   */
  readonly start: number;
  readonly end: number;
  readonly edit: UndoEdit;
}

/**
 * Where each edit of `inverse` sits in the file's text with the edits in `undone` put back:
 * each undone edit moves the ones after it by the length it changed.
 *
 * @param inverse an edit operation's `inverse`, in offset order
 * @param undone the indices already undone in the text
 */
export function placeUndoEdits(
  inverse: readonly UndoEdit[],
  undone: readonly number[],
): PlacedUndoEdit[] {
  const done = new Set(undone);
  let shift = 0;
  return inverse.map((edit, index) => {
    const start = edit.start + shift;
    if (!done.has(index)) return { index, undone: false, start, end: edit.end + shift, edit };
    shift += edit.replacement.length - (edit.end - edit.start);
    return { index, undone: true, start, end: start + edit.replacement.length, edit };
  });
}

/**
 * An asset's path changed.
 *
 * Committed as a copy in the create phase and a removal in the delete phase, so that
 * between the two both paths exist and any references pointing either way still
 * resolve. That is what lets an interrupted run leave a tree that still builds.
 * Undo needs no stored bytes because the bytes are still at the destination.
 */
export interface MoveOperation {
  readonly kind: 'move';
  readonly from: string;
  readonly to: string;
  /** The same on both sides; a move never rewrites content. */
  readonly hash: string;
}

/**
 * Remove a file.
 *
 * `backup` is mandatory in the type because a delete is the only operation whose
 * bytes cannot be reconstructed from anything else in the manifest. Prepare also
 * checks the backup file is really there, since a field can be filled in with a path
 * that was never written.
 */
export interface DeleteOperation {
  readonly kind: 'delete';
  readonly path: string;
  readonly beforeHash: string;
  /** POSIX-relative to the run directory. */
  readonly backup: string;
}

export type Operation = CreateOperation | EditOperation | MoveOperation | DeleteOperation;

/**
 * Something the run chose not to do, and why. Never an empty explanation.
 *
 * `path` and `line` are kept apart rather than joined into the `file:line` string
 * the report uses, because every other path in this schema is a bare path that can
 * be handed straight to a file store, and one field that cannot would be the only
 * exception a reader has to remember.
 */
export interface Declined {
  readonly path: string;
  /** 1-based, or null when the decline is about a whole file rather than one line. */
  readonly line: number | null;
  readonly reason: string;
}

/**
 * `pending` is written before anything is touched and means these operations may or
 * may not have happened, so a manifest found in that state is an interrupted run to
 * recover from. `committed` means every operation finished. `reverted` means an undo
 * has since put everything back.
 *
 * The third state is not bookkeeping. Without it a finished undo has to either leave
 * the manifest saying `committed`, which tells the next reader the changes are live
 * when they are not, or delete it, which throws away the only record that a tool
 * edited somebody's files.
 */
export type ManifestState = 'pending' | 'committed' | 'reverted';

/**
 * The record of a run that wrote files, kept in `.upfly/manifest.json`: every file it created,
 * changed or removed, which `revert` follows to put each back.
 */
export interface Manifest {
  readonly schemaVersion: number;
  /**
   * The function every hash in this file was made with.
   *
   * Recorded because the integrity of the whole record rests on those hashes, and
   * without naming the function nothing but the exact build that wrote the manifest
   * can check one. It also means the algorithm can change without a schema bump: a
   * reader compares this field rather than assuming.
   */
  readonly hashAlgorithm: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  /** When an undo put the tree back, or null while the run still stands. */
  readonly revertedAt: string | null;
  readonly state: ManifestState;
  /**
   * Run directory, POSIX-relative to the project root.
   *
   * Relative rather than absolute so a manifest means the same thing after the
   * project is moved or checked out elsewhere. No absolute path appears anywhere in
   * this schema for the same reason.
   */
  readonly runDir: string;
  readonly operations: readonly Operation[];
  readonly declined: readonly Declined[];
}

/**
 * Fields that legitimately differ between two runs over identical inputs.
 *
 * Everything not named here must be byte-identical across runs, and
 * `compareIgnoringVolatile` is what enforces it. The point of naming them rather
 * than normalising ad hoc in each test is that a new field which happens to vary
 * will fail the comparison instead of being quietly added to a normaliser.
 */
export const MANIFEST_VOLATILE_FIELDS = [
  'runId',
  'startedAt',
  'completedAt',
  'revertedAt',
  'runDir',
] as const;

export type ManifestVolatileField = (typeof MANIFEST_VOLATILE_FIELDS)[number];

/**
 * Replace every volatile field with a fixed placeholder, leaving the rest untouched.
 *
 * Throws when a named field is missing from the manifest, because an allow-list
 * entry that covers nothing is worse than no entry: it reads as though a field is
 * being accounted for when the field it names has been renamed away.
 */
export function withoutVolatileFields(manifest: Manifest): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...manifest };

  for (const field of MANIFEST_VOLATILE_FIELDS) {
    if (!(field in copy)) {
      throw new Error(
        `Manifest has no field "${field}", but it is listed as volatile. Either the field was renamed and the list was not updated, or the list names something that never existed.`,
      );
    }
    copy[field] = `<${field}>`;
  }
  return copy;
}

/**
 * Every project path the run's operations create, rewrite or remove, sorted. For a
 * committed run this is exactly the set of files it changed.
 *
 * @param manifest the record of one run
 */
export function pathsTouched(manifest: Manifest): readonly string[] {
  const paths = new Set<string>();
  for (const operation of manifest.operations) {
    if (operation.kind === 'move') {
      paths.add(operation.from);
      paths.add(operation.to);
    } else {
      paths.add(operation.path);
    }
  }
  return [...paths].sort(compareStrings);
}

/** Serialise deterministically: two runs over identical inputs produce identical bytes. */
export function serialiseManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseManifest(text: string): Manifest {
  return JSON.parse(text) as Manifest;
}
