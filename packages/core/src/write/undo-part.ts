/**
 * Undoing part of a run while the rest of it stands: the changes it made to one file, or the
 * ones on one line of a file. And the run's changes listed for a reader, each with whether it
 * is undone, which is what a review of the run is drawn from.
 *
 * See "Undoing part of a run" in ARCHITECTURE.md.
 */

import { UpflyError } from '../errors.js';
import { compareStrings } from '../paths.js';
import { hashText } from '../scan/text-hash.js';
import { applyEdits, countLineBreaks } from './edits.js';
import { acquireLock } from './lock.js';
import {
  type DeleteOperation,
  type EditOperation,
  MANIFEST_PATH,
  type Manifest,
  type MoveOperation,
  type Operation,
  type PlacedUndoEdit,
  type UndoEdit,
  placeUndoEdits,
  schemaVersionOf,
  serialiseManifest,
} from './manifest.js';
import {
  type FileStore,
  type LockPorts,
  type OperationState,
  changedSince,
  inspect,
  refuseMissingBackups,
} from './transaction.js';

/** The part of a run to undo on its own. */
export interface RunPart {
  /** A file the run rewrote, or an image it removed or moved away, POSIX-relative to the project root. */
  readonly file: string;
  /** One line of a rewritten file, counted from 1, or null for all of the file's changes. */
  readonly line: number | null;
}

/** What undoing part of a run put back. Every list is empty when all of it was undone already. */
export interface PartUndone {
  /** The file whose changes were put back, or null when none was. */
  readonly reverted: string | null;
  /** The lines of that file put back, counted from 1. */
  readonly lines: readonly number[];
  /** Originals the run had removed, back from its backup. */
  readonly restored: readonly string[];
  /** Images the run had moved, copied back to where they were; the moved file stays as well. */
  readonly copiedBack: readonly { readonly from: string; readonly to: string }[];
}

/** Where the record is kept and what the lock needs, for `undoPart`. */
export interface UndoPartOptions {
  /** The record's path, relative to the project root; `.upfly/manifest.json` unless given. */
  readonly at?: string;
  readonly now?: () => string;
  readonly lock?: LockPorts;
}

/**
 * Undo part of a run: the changes it made to one file, or those on one line of it, leaving
 * the rest of the run as it is. An image that a line put back names again comes back too,
 * when the run removed or moved it. What the run created stays, since other lines may still
 * name it: only an undo of the whole run removes it.
 *
 * The file is checked first, as an undo of the whole run checks every file, and nothing is
 * written when it changed since the run or since its last partial undo. The record is
 * written before the file, naming the state the file is about to be in, so an undo cut off
 * part way leaves a record the whole run's undo still follows.
 *
 * @param manifest the run's record, as read from `options.at`
 * @param part the file, and the line or null
 * @param store the project's files
 * @returns what was put back
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when a file it would write changed since,
 *   or a backup it needs is gone; `TRANSACTION_INTERRUPTED` for a run that stopped part way;
 *   `NOT_IN_RUN` when the run changed nothing there that can be undone on its own;
 *   `TRANSACTION_LOCKED` while another run holds the project
 */
export async function undoPart(
  manifest: Manifest,
  part: RunPart,
  store: FileStore,
  options: UndoPartOptions = {},
): Promise<PartUndone> {
  const now = options.now ?? (() => new Date().toISOString());
  const held = await acquireLock({ store, runId: manifest.runId, now, ...options.lock });
  try {
    return await undoPartUnderLock(manifest, part, store, options.at ?? MANIFEST_PATH);
  } finally {
    await held.release();
  }
}

const NOTHING: PartUndone = { reverted: null, lines: [], restored: [], copiedBack: [] };

async function undoPartUnderLock(
  manifest: Manifest,
  part: RunPart,
  store: FileStore,
  at: string,
): Promise<PartUndone> {
  if (manifest.state === 'pending') {
    throw new UpflyError(
      'TRANSACTION_INTERRUPTED',
      `The run ${manifest.runId} stopped before it finished, so part of it cannot be undone on its own. Undo the whole run first; that puts back every file it had written.`,
    );
  }
  const edit = manifest.operations.find(
    (operation): operation is EditOperation =>
      operation.kind === 'edit' && operation.path === part.file,
  );
  if (edit !== undefined) return undoEditPart(manifest, edit, part, store, at);
  if (part.line !== null) {
    throw new UpflyError(
      'NOT_IN_RUN',
      `The run ${manifest.runId} rewrote no line of ${part.file}, so there is no line of it to undo.`,
    );
  }
  const away = manifest.operations.find(
    (operation): operation is DeleteOperation | MoveOperation =>
      (operation.kind === 'delete' && operation.path === part.file) ||
      (operation.kind === 'move' && operation.from === part.file),
  );
  if (away !== undefined) return bringBack(manifest, [away], store);
  throw notInRun(manifest, part.file);
}

/** Why a file outside the run's changes cannot be undone on its own. */
function notInRun(manifest: Manifest, file: string): UpflyError {
  const created = manifest.operations.some(
    (operation) =>
      (operation.kind === 'create' && operation.path === file) ||
      (operation.kind === 'move' && operation.to === file),
  );
  return new UpflyError(
    'NOT_IN_RUN',
    created
      ? `${file} is a file the run ${manifest.runId} created. Undoing part of a run puts back what it rewrote, removed or moved; what it created goes only with the whole run, since other lines may still name it.`
      : `The run ${manifest.runId} did not change ${file}.`,
  );
}

async function undoEditPart(
  manifest: Manifest,
  operation: EditOperation,
  part: RunPart,
  store: FileStore,
  at: string,
): Promise<PartUndone> {
  const [state] = await inspect({ ...manifest, operations: [operation] }, store);
  if (state === undefined || state.status === 'foreign') throw changedSince([operation.path]);

  const undone = undoneIn(operation, state);
  const text = await store.readText(operation.path);
  const placed = placeUndoEdits(operation.inverse, undone);
  const lines = placed.map((each) => each.edit.line ?? lineAt(text, each.start));
  const chosen = placed.filter((each) => part.line === null || lines[each.index] === part.line);
  if (chosen.length === 0) throw noChangeOn(manifest, operation, part, lines);

  const away = awayOperations(
    manifest,
    chosen.map((each) => each.edit),
  );
  const toUndo = chosen.filter((each) => !each.undone);
  if (toUndo.length === 0) return bringBack(manifest, away, store);

  const nowUndone = [...undone, ...toUndo.map((each) => each.index)].sort((a, b) => a - b);
  const after = applyEdits(
    text,
    toUndo.map(({ start, end, edit }) => ({ ...edit, start, end })),
  );
  const hash = hashText(after, store.hashAlgorithm);
  const everything = nowUndone.length === operation.inverse.length;
  if (everything && hash !== operation.beforeHash) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `Undoing every change of ${operation.path} would not give back the text it had before the run, so nothing was undone.`,
    );
  }

  // Checked before the record is written, so a refusal there leaves the record as it was.
  const restores = await restoresFor(manifest, away, store);
  const recorded = withState(manifest, operation, completed(placed, text, lines), {
    undone: nowUndone,
    hash,
    everything,
  });
  await store.writeText(at, serialiseManifest(recorded));
  const back = await runRestores(restores, store);
  await store.writeText(operation.path, after);
  return {
    reverted: operation.path,
    lines: [...new Set(toUndo.map((each) => lines[each.index] as number))],
    ...back,
  };
}

/** Which of an applied edit's changes the file has undone already. */
function undoneOf(state: OperationState): readonly number[] {
  return state.undone ?? [];
}

/** Why a line names none of the changes the run made to a file. */
function noChangeOn(
  manifest: Manifest,
  operation: EditOperation,
  part: RunPart,
  lines: readonly number[],
): UpflyError {
  const where = [...new Set(lines)];
  const listed =
    where.length === 1
      ? `line ${where[0]}`
      : `lines ${where.slice(0, -1).join(', ')} and ${where.at(-1)}`;
  return new UpflyError(
    'NOT_IN_RUN',
    `The run ${manifest.runId} changed nothing on line ${part.line} of ${operation.path}. Its changes there are on ${listed}.`,
  );
}

/** The line `offset` is on in `text`, counted from 1. */
function lineAt(text: string, offset: number): number {
  return 1 + countLineBreaks(text, 0, offset);
}

/**
 * The operations that took away an image these edits name before the run: the delete of an
 * original, or the move of an image. A record that does not say which image an edit names
 * is matched by file name, so every original of that name the run took away comes back.
 */
function awayOperations(
  manifest: Manifest,
  edits: readonly UndoEdit[],
): (DeleteOperation | MoveOperation)[] {
  const away = new Set<DeleteOperation | MoveOperation>();
  for (const edit of edits) {
    for (const operation of manifest.operations) {
      if (operation.kind !== 'delete' && operation.kind !== 'move') continue;
      const path = operation.kind === 'delete' ? operation.path : operation.from;
      const names =
        edit.asset === undefined
          ? fileNameOf(edit.replacement) === fileNameOf(path)
          : edit.asset === path;
      if (names) away.add(operation);
    }
  }
  const pathOf = (operation: DeleteOperation | MoveOperation) =>
    operation.kind === 'delete' ? operation.path : operation.from;
  return [...away].sort((a, b) => compareStrings(pathOf(a), pathOf(b)));
}

/** The file name a path as written ends in, without a query or fragment, decoded and folded. */
function fileNameOf(written: string): string {
  const path = written.split(/[?#]/, 1)[0] ?? written;
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  try {
    return decodeURIComponent(name).toLowerCase();
  } catch {
    return name.toLowerCase();
  }
}

/** One image to bring back: an original from the backup, or a moved image copied back. */
interface Restore {
  readonly from: string;
  readonly to: string;
  readonly kind: 'original' | 'moved';
  /** For a moved image, where the run put it. */
  readonly movedTo?: string;
}

/**
 * What it takes to bring these images back, each checked against the disk first.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when something else is at an image's path,
 *   or the backup of a removed original is gone
 */
async function restoresFor(
  manifest: Manifest,
  away: readonly (DeleteOperation | MoveOperation)[],
  store: FileStore,
): Promise<Restore[]> {
  if (away.length === 0) return [];
  const states = await inspect({ ...manifest, operations: away }, store);
  const foreign = states.filter((state) => state.status === 'foreign');
  if (foreign.length > 0) throw changedSince(foreign.map((state) => state.path));
  await refuseMissingBackups(states, manifest, store);

  const restores: Restore[] = [];
  for (const { operation, status } of states) {
    if (status !== 'applied') continue;
    if (operation.kind === 'delete') {
      restores.push({
        kind: 'original',
        from: `${manifest.runDir}/${operation.backup}`,
        to: operation.path,
      });
    } else if (operation.kind === 'move') {
      restores.push({
        kind: 'moved',
        from: operation.to,
        to: operation.from,
        movedTo: operation.to,
      });
    }
  }
  return restores;
}

async function runRestores(
  restores: readonly Restore[],
  store: FileStore,
): Promise<Pick<PartUndone, 'restored' | 'copiedBack'>> {
  const restored: string[] = [];
  const copiedBack: { from: string; to: string }[] = [];
  for (const restore of restores) {
    await store.copy(restore.from, restore.to);
    if (restore.kind === 'original') restored.push(restore.to);
    else copiedBack.push({ from: restore.to, to: restore.movedTo ?? restore.from });
  }
  return { restored, copiedBack };
}

/** Bring back the images these operations took away, writing no line. */
async function bringBack(
  manifest: Manifest,
  away: readonly (DeleteOperation | MoveOperation)[],
  store: FileStore,
): Promise<PartUndone> {
  const restores = await restoresFor(manifest, away, store);
  if (restores.length === 0) return NOTHING;
  return { ...NOTHING, ...(await runRestores(restores, store)) };
}

/**
 * The edits of `inverse` with what an older record left out filled in from the file: the
 * path the run wrote, read from the text where the change still stands, and the line.
 */
function completed(
  placed: readonly PlacedUndoEdit[],
  text: string,
  lines: readonly number[],
): UndoEdit[] {
  return placed.map(({ index, undone, start, end, edit }) => ({
    ...edit,
    ...(edit.expected === undefined && !undone ? { expected: text.slice(start, end) } : {}),
    line: edit.line ?? (lines[index] as number),
  }));
}

/**
 * The record with one file's new state: every change undone, which the hash before the run
 * already names, or a state of some undone, added to those the record names.
 */
function withState(
  manifest: Manifest,
  operation: EditOperation,
  inverse: readonly UndoEdit[],
  next: { readonly undone: readonly number[]; readonly hash: string; readonly everything: boolean },
): Manifest {
  const known = operation.partlyUndone ?? [];
  const partlyUndone = next.everything
    ? operation.partlyUndone
    : [
        ...known.filter((state) => state.hash !== next.hash),
        { undone: next.undone, hash: next.hash },
      ];
  const operations: Operation[] = manifest.operations.map((each) =>
    each === operation
      ? { ...operation, inverse, ...(partlyUndone === undefined ? {} : { partlyUndone }) }
      : each,
  );
  return { ...manifest, schemaVersion: schemaVersionOf(operations), operations };
}

/** One change of a run, as a reader sees it: one path the run rewrote, and what it was. */
export interface ChangedPath {
  /** The path as it was before the run. */
  readonly before: string;
  /** The path the run wrote, or null when an older record does not hold it and the file no longer does. */
  readonly after: string | null;
  /** The image `before` names, POSIX-relative to the project root, or null when the record does not say. */
  readonly image: string | null;
  /** The path is inside a comment. */
  readonly inComment: boolean;
}

/** The changes a run made on one line of a file. */
export interface LineChanges {
  /**
   * Counted from 1, in the file as the run left it. Null when an older record does not hold
   * it and the file changed since.
   */
  readonly line: number | null;
  /** Whether the line is undone; null when the file changed since, so the disk cannot say. */
  readonly undone: boolean | null;
  readonly paths: readonly ChangedPath[];
}

/** A file a run rewrote, and its changes line by line. */
export interface FileChanges {
  readonly path: string;
  /**
   * Something other than the run, or an undo of it, changed the file since, so none of its
   * changes can be undone on its own until it holds a text the record knows again.
   */
  readonly changedSince: boolean;
  readonly changes: readonly LineChanges[];
}

/** An image a run removed or moved away, and whether it is back. */
export interface RunOriginal {
  /** Where it was before the run. */
  readonly path: string;
  /** For a moved image, where the run put it; null for a removed original. */
  readonly movedTo: string | null;
  /** Whether it is at `path` again, as it was. */
  readonly back: boolean;
  /** Something other than the run put a different file at `path`, or changed the moved file. */
  readonly changedSince: boolean;
}

/** A run's changes as they stand now, for a reader. */
export interface RunChanges {
  readonly id: string;
  readonly startedAt: string;
  /**
   * `applied` while the run stands, even when parts of it were undone on their own;
   * `undone` once the whole run is; `interrupted` for a run that stopped part way.
   */
  readonly state: 'applied' | 'undone' | 'interrupted';
  /** The files it rewrote, in path order. */
  readonly files: readonly FileChanges[];
  /** The images it removed or moved away, in path order. */
  readonly originals: readonly RunOriginal[];
  /** The files it created, in path order: converted images, and moved images at their new place. */
  readonly created: readonly string[];
}

/**
 * A run's changes as they stand now: each file's changes line by line, with whether each is
 * undone, and each image it took away, with whether it is back. Reads the files the record
 * names and writes nothing.
 *
 * @param manifest the run's record
 * @param store the project's files
 */
export async function describeRun(manifest: Manifest, store: FileStore): Promise<RunChanges> {
  const states = await inspect(manifest, store);
  const files: FileChanges[] = [];
  const originals: RunOriginal[] = [];
  const created: string[] = [];

  for (const state of states) {
    const { operation } = state;
    if (operation.kind === 'edit') files.push(await fileChanges(operation, state, store));
    else if (operation.kind === 'create') created.push(operation.path);
    else if (operation.kind === 'delete') {
      originals.push({
        path: operation.path,
        movedTo: null,
        back: state.status === 'not-applied',
        changedSince: state.status === 'foreign',
      });
    } else {
      created.push(operation.to);
      originals.push({
        path: operation.from,
        movedTo: operation.to,
        back: state.status === 'partial' || state.status === 'not-applied',
        changedSince: state.status === 'foreign',
      });
    }
  }
  return {
    id: manifest.runId,
    startedAt: manifest.startedAt,
    state:
      manifest.state === 'pending'
        ? 'interrupted'
        : manifest.state === 'reverted'
          ? 'undone'
          : 'applied',
    files: files.sort((a, b) => compareStrings(a.path, b.path)),
    originals: originals.sort((a, b) => compareStrings(a.path, b.path)),
    created: created.sort(compareStrings),
  };
}

async function fileChanges(
  operation: EditOperation,
  state: OperationState,
  store: FileStore,
): Promise<FileChanges> {
  const changedSince = state.status === 'foreign';
  const placed = placeUndoEdits(operation.inverse, changedSince ? [] : undoneIn(operation, state));
  const needsText =
    !changedSince &&
    placed.some((each) => each.edit.line === undefined || each.edit.expected === undefined);
  const text = needsText ? await store.readText(operation.path) : null;

  const changes: LineChanges[] = [];
  for (const each of placed) {
    const line = each.edit.line ?? (text === null ? null : lineAt(text, each.start));
    const path = changedPath(each, text);
    const last = changes.at(-1);
    if (last !== undefined && last.line === line && line !== null) {
      changes[changes.length - 1] = { ...last, paths: [...last.paths, path] };
    } else {
      changes.push({ line, undone: changedSince ? null : each.undone, paths: [path] });
    }
  }
  return { path: operation.path, changedSince, changes };
}

/** Which of an edit's changes the file has undone: all of them once it is back as it was. */
function undoneIn(operation: EditOperation, state: OperationState): readonly number[] {
  return state.status === 'not-applied'
    ? operation.inverse.map((_, index) => index)
    : undoneOf(state);
}

/** One path a change rewrote, its text after read from the file when an older record lacks it. */
function changedPath(placed: PlacedUndoEdit, text: string | null): ChangedPath {
  const { edit } = placed;
  const read = text === null || placed.undone ? null : text.slice(placed.start, placed.end);
  return {
    before: edit.replacement,
    after: edit.expected ?? read,
    image: edit.asset ?? null,
    inComment: edit.inComment === true,
  };
}
