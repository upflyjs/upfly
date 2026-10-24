/**
 * Applying a plan to a working tree, and taking it back off again.
 *
 * The manifest is written before anything is touched, so an interrupted run always leaves
 * a record of what it was in the middle of. A plan holds the edits that go forward and
 * lives only in memory; the manifest holds the edits that come back and is the only thing
 * undo reads. Nothing redoes an interrupted run, so nothing stores what that would take.
 * See "The transaction" in ARCHITECTURE.md.
 */

import { UpflyError } from '../errors.js';
import type { NotText } from '../read-text.js';
import { hashText } from '../scan/text-hash.js';
import type { Edit } from '../types.js';
import { applyEdits, countLineBreaks, invertEdits, validateEdits } from './edits.js';
import { type ProcessLiveness, acquireLock } from './lock.js';
import {
  type CreateOperation,
  type Declined,
  type DeleteOperation,
  type EditOperation,
  MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type MoveOperation,
  NO_UNDO_MANIFEST_PATH,
  type Operation,
  UPFLY_DIRECTORY,
  type UndoEdit,
  parseManifest,
  placeUndoEdits,
  schemaVersionOf,
  serialiseManifest,
} from './manifest.js';

/**
 * The two facts about the outside world the lock needs, injectable only for tests. Both
 * default to the real process id and liveness check, so leaving them out cannot weaken
 * the lock.
 */
export interface LockPorts {
  /** This process. A test overrides it to act as a different one. */
  readonly pid?: number;
  readonly isAlive?: ProcessLiveness;
}

/**
 * Everything the transaction is allowed to do to a disk.
 *
 * A port, so that a test store can fail at any write, copy or removal: that is how the
 * crash tests interrupt a commit on the same path a real crash takes. Every path is
 * POSIX-relative to the project root, which keeps absolute paths out of the manifest.
 */
export interface FileStore {
  /**
   * Names the function `hash` uses. The manifest takes it from here, so it always names
   * the algorithm that made its hashes.
   */
  readonly hashAlgorithm: string;
  /** Content hash, or null when the path does not exist. */
  hash(path: string): Promise<string | null>;
  /** Decoded as UTF-8, the encoding `writeText` writes. */
  readText(path: string): Promise<string>;
  /**
   * As `readText`, or, for a file that is not text, its bytes to read a chunk at a time
   * (`readForSearch`): how a search of every file reads one, so a library or a database is never
   * held in memory whole and a path written in it is still found.
   */
  readForSearch(path: string): Promise<string | NotText>;
  writeText(path: string, text: string): Promise<void>;
  /**
   * Creates a file only if it does not exist, atomically, and returns `false` if it did.
   *
   * The lock is built on this. Checking with `hash` and then calling `writeText` is a race
   * in which two runs both see no file and both write it, so the atomicity has to come
   * from the filesystem (`O_EXCL`).
   */
  createExclusive(path: string, text: string): Promise<boolean>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** The names of a folder's entries; none for a folder that is not there. */
  listDirectory(path: string): Promise<readonly string[]>;
  /** Remove a folder and everything in it; nothing happens for one that is not there. */
  removeDirectory(path: string): Promise<void>;
}

/**
 * An edit as planned, in the direction that goes on to disk. The manifest stores only the
 * reverse, so the same change is never written down twice in two forms that could disagree.
 */
export interface PlannedEdit {
  readonly kind: 'edit';
  readonly path: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly edits: readonly Edit[];
}

export type PlannedOperation = CreateOperation | PlannedEdit | MoveOperation | DeleteOperation;

/** Identity and bookkeeping for one run. */
export interface RunContext {
  readonly runId: string;
  /** POSIX-relative to the project root, holding staged bytes and backups. */
  readonly runDir: string;
  /** Injected so a test can pin the timestamps a real run cannot. */
  readonly now: () => string;
  readonly declined: readonly Declined[];
}

/** What the disk says about one operation right now. */
export type OperationStatus =
  /** Done. Undo has work to do. */
  | 'applied'
  /** A move whose copy landed but whose source is still there. */
  | 'partial'
  /** Never happened. Undo has nothing to do. */
  | 'not-applied'
  /**
   * The file matches neither the before state nor the after state, so something other
   * than this run changed it. The transaction will not touch it and names it instead:
   * writing over somebody's work is worse than leaving a run half applied.
   */
  | 'foreign';

/**
 * One operation of a run, as `inspect` finds it before an undo: done, half done, never done,
 * or changed since by something other than the run, which `revert` then leaves alone.
 */
export interface OperationState {
  readonly operation: Operation;
  readonly status: OperationStatus;
  /** The path the status was decided on, so a foreign report can point at it. */
  readonly path: string;
  /**
   * For an applied edit some of whose changes were undone on their own: the indices of its
   * `inverse` the file has undone already. Absent when none are.
   */
  readonly undone?: readonly number[];
}

/**
 * Check a plan against the tree it is about to be applied to.
 *
 * Everything knowable before writing is checked here, because a failure here costs
 * nothing and the same failure during commit costs a half-changed tree.
 *
 * @throws {UpflyError} `TRANSACTION_PLAN_INVALID` naming the operation and the problem.
 * @throws {UpflyError} `INVALID_EDIT_RANGE`, `OVERLAPPING_EDITS` or `AMBIGUOUS_EDITS` when a
 *         planned edit does not fit the file it is for.
 */
export async function prepare(
  plan: readonly PlannedOperation[],
  store: FileStore,
  runDir: string,
): Promise<void> {
  // Keyed case-insensitively: two paths differing only in case are one file on Windows
  // and macOS, and while neither exists both pass the absent check. Folded on every
  // platform, so a plan is refused everywhere or nowhere.
  // See "Two paths are the same file more often than they look" in ARCHITECTURE.md.
  const claimed = new Map<string, { path: string; by: string }>();

  const claim = (path: string, by: string): void => {
    const key = path.toLowerCase();
    const existing = claimed.get(key);
    if (existing !== undefined) {
      const sameFile =
        existing.path === path
          ? ''
          : ` (${existing.path} and ${path} are the same file on Windows and macOS)`;
      throw new UpflyError(
        'TRANSACTION_PLAN_INVALID',
        `Two operations both target ${path}: ${existing.by} and ${by}. The result would depend on which ran first.${sameFile}`,
      );
    }
    claimed.set(key, { path, by });
  };

  for (const operation of plan) {
    switch (operation.kind) {
      case 'create': {
        claim(operation.path, 'create');
        await expectAbsent(store, operation.path, 'create');
        await expectStaged(store, runDir, operation.staged, 'create');
        break;
      }
      case 'edit': {
        claim(operation.path, 'edit');
        await expectHash(store, operation.path, operation.beforeHash, 'edit');
        const text = await store.readText(operation.path);
        expectUtf8(store, operation, text);
        checkUndoable(operation, text);
        break;
      }
      case 'move': {
        claim(operation.from, 'move source');
        claim(operation.to, 'move destination');
        await expectHash(store, operation.from, operation.hash, 'move');
        await expectAbsent(store, operation.to, 'move');
        break;
      }
      case 'delete': {
        claim(operation.path, 'delete');
        await expectHash(store, operation.path, operation.beforeHash, 'delete');
        // A delete's bytes can be rebuilt from nothing else in the manifest, and a backup
        // path can name a file nobody wrote, so the backup has to be there.
        await expectStaged(store, runDir, operation.backup, 'delete');
        break;
      }
      default: {
        const unhandled: never = operation;
        return unhandled;
      }
    }
  }
}

/**
 * Apply a prepared plan.
 *
 * Commit writes the manifest itself, pending before the first change and committed after
 * the last, so no caller can write it late. The phase order keeps an interrupted run
 * buildable: files appear before anything points at them, and originals go only once
 * nothing points at them any more.
 *
 * Every edit target is hashed again as it is read rather than trusting the check `prepare`
 * made, since a file saved after that check would leave offsets that no longer fit it.
 */
export async function commit(
  plan: readonly PlannedOperation[],
  store: FileStore,
  context: RunContext,
  lock: LockPorts = {},
): Promise<Manifest> {
  // Held for the whole commit, which writes the shared manifest twice. Another run writing
  // in between would replace one run's record, the only pointer to its backups. `optimize`
  // already holds the lock; taking it here as well covers a caller using `commit` directly.
  // See "One writer at a time" in ARCHITECTURE.md.
  const held = await acquireLock({ store, runId: context.runId, now: context.now, ...lock });
  try {
    const committed = await commitUnderLock(plan, store, context, MANIFEST_PATH);
    await pruneEarlierRuns(store, context.runDir);
    return committed;
  } finally {
    await held.release();
  }
}

/**
 * The body of `commit`, once the lock is held, writing the record at `record`. Split so the
 * lock cannot be skipped.
 */
export async function commitUnderLock(
  plan: readonly PlannedOperation[],
  store: FileStore,
  context: RunContext,
  record: string,
): Promise<Manifest> {
  await refuseOverInterruptedRun(store, context.runId);
  const operations = await manifestOperations(plan, store);
  const pending: Manifest = {
    schemaVersion: schemaVersionOf(operations),
    hashAlgorithm: store.hashAlgorithm,
    runId: context.runId,
    startedAt: context.now(),
    completedAt: null,
    revertedAt: null,
    state: 'pending',
    runDir: context.runDir,
    operations,
    declined: context.declined,
  };
  await store.writeText(record, serialiseManifest(pending));

  // Each phase takes the previous one's witness. See `PhaseComplete`.
  const created = await createPhase(plan, store, context.runDir);
  const edited = await editPhase(plan, store, created);
  await removePhase(plan, store, edited);

  const committed: Manifest = { ...pending, state: 'committed', completedAt: context.now() };
  await store.writeText(record, serialiseManifest(committed));
  return committed;
}

/** Where each run keeps its staged files and backups, one folder per run. */
const RUNS_DIRECTORY = `${UPFLY_DIRECTORY}/runs`;

/**
 * Remove the folder of every run but this one. `undo` restores only the run the manifest
 * names, and this run's committed manifest has just replaced the last one, so no earlier
 * folder can be restored from again; kept, they would grow with every run. Only after the
 * commit: a run that stops part way leaves every folder, its own included, for `undo`. A
 * folder that cannot be removed now stays, and the next committed run tries again, since
 * the run itself has already succeeded.
 */
async function pruneEarlierRuns(store: FileStore, runDir: string): Promise<void> {
  for (const name of await store.listDirectory(RUNS_DIRECTORY)) {
    const folder = `${RUNS_DIRECTORY}/${name}`;
    if (folder === runDir) continue;
    try {
      await store.removeDirectory(folder);
    } catch {
      // Left for the next committed run; see above.
    }
  }
}

/**
 * Refuse to start while the last run's manifest, or the record of a run made without undo, is
 * still `pending`.
 *
 * Under the lock no other run is writing, so a pending record of another run is one that
 * stopped part way. It is the only record of what that run wrote and where its backups are:
 * this run's would replace the last run's, and either run's changes could make the other's
 * files ones it can no longer put back. A record that cannot be parsed records nothing
 * recoverable, so it does not block.
 *
 * @throws {UpflyError} `TRANSACTION_INTERRUPTED` naming the run to put back first
 */
async function refuseOverInterruptedRun(store: FileStore, runId: string): Promise<void> {
  const last = await pendingRecord(store, MANIFEST_PATH, runId);
  if (last !== null) {
    throw new UpflyError(
      'TRANSACTION_INTERRUPTED',
      `The last run (${last.runId}, started ${last.startedAt}) stopped before it finished. Starting another would replace the only record of what it wrote, so nothing was changed. Undo that run first; that puts back every file it had written.`,
    );
  }
  const noUndo = await pendingRecord(store, NO_UNDO_MANIFEST_PATH, runId);
  if (noUndo !== null) {
    throw new UpflyError(
      'TRANSACTION_INTERRUPTED',
      `A run made without undo (${noUndo.runId}, started ${noUndo.startedAt}) stopped before it finished, and its record is the only one of what it wrote, so nothing was changed. Every Upfly command that writes puts such a run back before anything else: run this again.`,
    );
  }
}

/** The record at `path` when it is another run's and that run stopped part way, else null. */
async function pendingRecord(
  store: FileStore,
  path: string,
  runId: string,
): Promise<Manifest | null> {
  if ((await store.hash(path)) === null) return null;
  try {
    const record = parseManifest(await store.readText(path));
    return record.state === 'pending' && record.runId !== runId ? record : null;
  } catch {
    return null;
  }
}

/**
 * Decide, by hashing, what actually happened to each operation.
 *
 * Every operation records the hash on both sides, so the tree alone says whether it ran.
 * That is why commit keeps no journal of its own progress.
 */
export async function inspect(
  manifest: Manifest,
  store: FileStore,
): Promise<readonly OperationState[]> {
  requireSameHashFunction(manifest, store);
  const states: OperationState[] = [];

  for (const operation of manifest.operations) {
    switch (operation.kind) {
      case 'create': {
        const current = await store.hash(operation.path);
        states.push({
          operation,
          path: operation.path,
          status: presenceStatus(current, operation.afterHash),
        });
        break;
      }
      case 'edit': {
        states.push(editState(operation, await store.hash(operation.path)));
        break;
      }
      case 'move': {
        states.push({ operation, path: operation.to, status: await moveStatus(operation, store) });
        break;
      }
      case 'delete': {
        const current = await store.hash(operation.path);
        states.push({
          operation,
          path: operation.path,
          status: absenceStatus(current, operation.beforeHash),
        });
        break;
      }
      default: {
        const unhandled: never = operation;
        return unhandled;
      }
    }
  }
  return states;
}

/**
 * Put the tree back the way it was, whether the run finished or was interrupted.
 *
 * Both are the same job, reversing whatever the disk says actually happened, so there is
 * no separate recovery branch that is rarely run and could be wrong.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` naming every file changed by
 *         something other than this run, or every removed original whose backup is gone.
 *         Nothing is reverted in either case, so the tree is never left in a third state
 *         nobody planned.
 */
export async function revert(
  manifest: Manifest,
  store: FileStore,
  now: () => string = () => new Date().toISOString(),
  lock: LockPorts = {},
): Promise<Manifest> {
  // Undo writes the same shared manifest, so it takes the same lock. Re-entry lets a run
  // undo itself while it still holds the lock.
  const held = await acquireLock({ store, runId: manifest.runId, now, ...lock });
  try {
    return await revertUnderLock(manifest, store, now);
  } finally {
    await held.release();
  }
}

/** The body of `revert`, once the lock is held, writing the record at `record`. */
export async function revertUnderLock(
  manifest: Manifest,
  store: FileStore,
  now: () => string,
  record: string = MANIFEST_PATH,
): Promise<Manifest> {
  const states = await inspect(manifest, store);
  const foreign = states.filter((state) => state.status === 'foreign');

  if (foreign.length > 0) throw changedSince(foreign.map((state) => state.path));
  await refuseMissingBackups(states, manifest, store);

  // The mirror of commit's phases, and it has to be, for the same reason: originals
  // come back before anything points at them again, and what the run created goes
  // only once nothing points at it.
  await restoreOriginals(states, manifest, store);
  await undoEdits(states, store);
  await removeCreated(states, store);

  const reverted: Manifest = {
    ...manifest,
    state: 'reverted',
    // Keep the first undo's time. Running revert again on an already-reverted
    // manifest does nothing, and stamping a fresh time would claim otherwise.
    revertedAt: manifest.revertedAt ?? now(),
  };
  await store.writeText(record, serialiseManifest(reverted));
  return reverted;
}

/**
 * The refusal for files something other than the run changed since it, which an undo of the
 * whole run and of part of it give alike.
 *
 * @param paths each file, in the order to name them
 */
export function changedSince(paths: readonly string[]): UpflyError {
  return new UpflyError(
    'TRANSACTION_FOREIGN_CHANGE',
    `${paths.length === 1 ? '1 file' : `${paths.length} files`} changed since this run: ${paths.join(', ')}. Nothing was reverted, because undoing over somebody else's edit would lose it.`,
  );
}

/**
 * Refuse before the first write when a removed original's backup is gone, so that undo
 * never stops part way through putting originals back.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` naming each original whose backup is missing
 */
export async function refuseMissingBackups(
  states: readonly OperationState[],
  manifest: Manifest,
  store: FileStore,
): Promise<void> {
  const missing: string[] = [];
  for (const { operation, status } of states) {
    if (status === 'not-applied' || operation.kind !== 'delete') continue;
    if ((await store.hash(`${manifest.runDir}/${operation.backup}`)) === null) {
      missing.push(operation.path);
    }
  }
  if (missing.length === 0) return;
  throw new UpflyError(
    'TRANSACTION_FOREIGN_CHANGE',
    `${missing.length === 1 ? 'The backup of 1 removed original is' : `The backups of ${missing.length} removed originals are`} gone from ${manifest.runDir}: ${missing.join(', ')}. Nothing was reverted, because putting the rest back would leave ${missing.length === 1 ? 'it' : 'them'} still missing.`,
  );
}

/** Undo's first phase: put back what the run took away. */
async function restoreOriginals(
  states: readonly OperationState[],
  manifest: Manifest,
  store: FileStore,
): Promise<void> {
  for (const state of states) {
    if (state.status === 'not-applied') continue;
    if (state.operation.kind === 'delete') {
      await store.copy(`${manifest.runDir}/${state.operation.backup}`, state.operation.path);
    } else if (state.operation.kind === 'move' && state.status === 'applied') {
      // A `partial` move still has its source, so only a completed one needs the
      // bytes copied back from the destination.
      await store.copy(state.operation.to, state.operation.from);
    }
  }
}

/**
 * Undo's second phase: point the references back at the originals. A file part of which was
 * undone on its own takes only the edits it still holds, placed where they sit now.
 */
async function undoEdits(states: readonly OperationState[], store: FileStore): Promise<void> {
  for (const state of states) {
    if (state.status !== 'applied' || state.operation.kind !== 'edit') continue;
    const current = await store.readText(state.operation.path);
    const remaining = placeUndoEdits(state.operation.inverse, state.undone ?? [])
      .filter((placed) => !placed.undone)
      .map(({ start, end, edit }) => ({ ...edit, start, end }));
    await store.writeText(state.operation.path, applyEdits(current, remaining));
  }
}

/** Undo's third phase: take away what the run added, now that nothing names it. */
async function removeCreated(states: readonly OperationState[], store: FileStore): Promise<void> {
  for (const state of states) {
    if (state.status === 'not-applied') continue;
    if (state.operation.kind === 'create') await store.remove(state.operation.path);
    else if (state.operation.kind === 'move') await store.remove(state.operation.to);
  }
}

/** Read the manifest of the last run, or null when there has not been one. */
export async function readManifest(store: FileStore): Promise<Manifest | null> {
  if ((await store.hash(MANIFEST_PATH)) === null) return null;
  return checkedVersion(parseManifest(await store.readText(MANIFEST_PATH)));
}

/**
 * A record this build can follow, as it is.
 *
 * @throws {UpflyError} `MANIFEST_VERSION_UNSUPPORTED` for a version it does not know
 */
export function checkedVersion(manifest: Manifest): Manifest {
  const version = manifest.schemaVersion;
  if (Number.isInteger(version) && version >= 1 && version <= MANIFEST_SCHEMA_VERSION) {
    return manifest;
  }
  throw new UpflyError(
    'MANIFEST_VERSION_UNSUPPORTED',
    `Manifest is schema version ${version} and this build understands versions 1 to ${MANIFEST_SCHEMA_VERSION}. Undo it with the version that wrote it.`,
  );
}

/** Turn the forward plan into the reverse record the manifest keeps. */
async function manifestOperations(
  plan: readonly PlannedOperation[],
  store: FileStore,
): Promise<Operation[]> {
  const operations: Operation[] = [];

  for (const operation of plan) {
    if (operation.kind !== 'edit') {
      operations.push(operation);
      continue;
    }
    const before = await readVerified(store, operation.path, operation.beforeHash);
    operations.push({
      kind: 'edit',
      path: operation.path,
      beforeHash: operation.beforeHash,
      afterHash: operation.afterHash,
      inverse: withLines(applyEdits(before, operation.edits), invertEdits(before, operation.edits)),
    });
  }
  return operations;
}

/**
 * Each edit with the line it starts on in `text`, counted from 1.
 *
 * @param edits in offset order, as `invertEdits` returns them
 */
function withLines(text: string, edits: readonly Edit[]): UndoEdit[] {
  let line = 1;
  let counted = 0;
  return edits.map((edit) => {
    line += countLineBreaks(text, counted, edit.start);
    counted = edit.start;
    return { ...edit, line };
  });
}

/**
 * What the disk says of an edit: the run's text or the one before it, or a state the record
 * names because part of the file was undone on its own, or none of them.
 */
function editState(operation: EditOperation, current: string | null): OperationState {
  const status = betweenStatus(current, operation.beforeHash, operation.afterHash);
  if (status !== 'foreign') return { operation, path: operation.path, status };
  const part = operation.partlyUndone?.find((state) => state.hash === current);
  return part === undefined
    ? { operation, path: operation.path, status }
    : { operation, path: operation.path, status: 'applied', undone: part.undone };
}

/**
 * Refuse to compare hashes that were not made the same way. Hashes from two different
 * functions never match, so every file would be reported as changed by somebody else.
 */
function requireSameHashFunction(manifest: Manifest, store: FileStore): void {
  if (manifest.hashAlgorithm === store.hashAlgorithm) return;
  throw new UpflyError(
    'MANIFEST_VERSION_UNSUPPORTED',
    `The manifest's hashes were made with ${manifest.hashAlgorithm} and this build uses ${store.hashAlgorithm}, so none of them can be checked. Undo it with the version that wrote it.`,
  );
}

/** A file the run was to put there: absent means it never ran. */
function presenceStatus(current: string | null, afterHash: string): OperationStatus {
  if (current === null) return 'not-applied';
  return current === afterHash ? 'applied' : 'foreign';
}

/** A file the run was to rewrite: it should hold one of the two texts we know. */
function betweenStatus(
  current: string | null,
  beforeHash: string,
  afterHash: string,
): OperationStatus {
  if (current === afterHash) return 'applied';
  return current === beforeHash ? 'not-applied' : 'foreign';
}

/** A file the run was to remove: absent means it ran. */
function absenceStatus(current: string | null, beforeHash: string): OperationStatus {
  if (current === null) return 'applied';
  return current === beforeHash ? 'not-applied' : 'foreign';
}

async function moveStatus(operation: MoveOperation, store: FileStore): Promise<OperationStatus> {
  const from = await store.hash(operation.from);
  const to = await store.hash(operation.to);

  if (from === operation.hash && to === null) return 'not-applied';
  if (from === operation.hash && to === operation.hash) return 'partial';
  if (from === null && to === operation.hash) return 'applied';
  return 'foreign';
}

async function expectAbsent(store: FileStore, path: string, kind: string): Promise<void> {
  if ((await store.hash(path)) !== null) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `${kind} would write ${path}, which already exists. Overwriting a file nobody planned to overwrite is how a tool loses somebody's work.`,
    );
  }
}

async function expectHash(
  store: FileStore,
  path: string,
  expected: string,
  kind: string,
): Promise<void> {
  const current = await store.hash(path);
  if (current === null) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `${kind} names ${path}, which does not exist.`,
    );
  }
  if (current !== expected) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `${path} changed between planning and now. Re-run the audit rather than applying a plan built on stale content.`,
    );
  }
}

const phaseWitness = Symbol('the commit phase that produced this');

/**
 * Proof that one commit phase finished over the whole plan.
 *
 * Removing originals is safe only once every edit is written, and the crash tests cannot
 * tell whole phases from one loop that interleaves them per asset. A phase's witness comes
 * only from running it, so the phases cannot be reordered or merged by accident; slicing
 * the plan and running all three per asset would still compile. See "The transaction" in
 * ARCHITECTURE.md.
 */
interface PhaseComplete<Name extends string> {
  readonly [phaseWitness]: Name;
}

function completed<Name extends string>(name: Name): PhaseComplete<Name> {
  return { [phaseWitness]: name };
}

/** Step 2: staged encodes into place, and the destination half of every move. */
async function createPhase(
  plan: readonly PlannedOperation[],
  store: FileStore,
  runDir: string,
): Promise<PhaseComplete<'create'>> {
  for (const operation of plan) {
    if (operation.kind === 'create') {
      await store.copy(`${runDir}/${operation.staged}`, operation.path);
    } else if (operation.kind === 'move') {
      await store.copy(operation.from, operation.to);
    }
  }
  return completed('create');
}

/**
 * Step 3: the text rewrites, all of them.
 *
 * Takes the create witness because a reference must never point at a file that does
 * not exist yet.
 */
async function editPhase(
  plan: readonly PlannedOperation[],
  store: FileStore,
  _created: PhaseComplete<'create'>,
): Promise<PhaseComplete<'edit'>> {
  for (const operation of plan) {
    if (operation.kind !== 'edit') continue;
    const before = await readVerified(store, operation.path, operation.beforeHash);
    await store.writeText(operation.path, applyEdits(before, operation.edits));
  }
  return completed('edit');
}

/**
 * Step 4: the only destructive step.
 *
 * Takes the edit witness because an original must survive until nothing points at it,
 * and that is true of the whole plan or of none of it.
 */
async function removePhase(
  plan: readonly PlannedOperation[],
  store: FileStore,
  _edited: PhaseComplete<'edit'>,
): Promise<PhaseComplete<'remove'>> {
  for (const operation of plan) {
    if (operation.kind === 'delete') await store.remove(operation.path);
    else if (operation.kind === 'move') await store.remove(operation.from);
  }
  return completed('remove');
}

/**
 * Read an edit target, refusing it when the bytes are no longer the ones planned.
 *
 * `prepare` checks the same hash earlier, but an editor saving the file since then leaves
 * edit offsets that no longer describe the text. Applying them would write something
 * nobody planned, which `inspect` could only report afterwards as `foreign`.
 */
async function readVerified(store: FileStore, path: string, expected: string): Promise<string> {
  if ((await store.hash(path)) !== expected) {
    throw new UpflyError(
      'TRANSACTION_FOREIGN_CHANGE',
      `${path} changed after the plan was checked, so it was not rewritten. Re-run the audit rather than applying a plan built on text that has moved.`,
    );
  }
  return store.readText(path);
}

async function expectStaged(
  store: FileStore,
  runDir: string,
  staged: string,
  kind: string,
): Promise<void> {
  if ((await store.hash(`${runDir}/${staged}`)) === null) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `${kind} refers to ${staged} in the run directory, which was never written.`,
    );
  }
}

/**
 * Refuse an edit target that is not valid UTF-8.
 *
 * The store reads text as UTF-8 and writes it back the same way, which reproduces a valid
 * file's bytes and no other: each byte that is not UTF-8 would come back as U+FFFD. The
 * hash check before this one matched the file's bytes, so the text re-encoded differs from
 * them exactly when the file is not UTF-8.
 */
function expectUtf8(store: FileStore, operation: PlannedEdit, text: string): void {
  if (hashText(text, store.hashAlgorithm) === operation.beforeHash) return;
  throw new UpflyError(
    'TRANSACTION_PLAN_INVALID',
    `${operation.path} is not valid UTF-8, and writing it back as UTF-8 would change bytes its edits do not touch, so no file was changed. Save it as UTF-8, or leave it out of the plan.`,
  );
}

/**
 * Refuse a plan whose undo would not apply (see `invertEdits`). Undo is too late to find
 * that out: the tree has changed and somebody is asking for their work back.
 */
function checkUndoable(operation: PlannedEdit, before: string): void {
  const after = applyEdits(before, operation.edits);
  const inverse = invertEdits(before, operation.edits);

  try {
    validateEdits(after, inverse);
  } catch (cause) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `The undo for ${operation.path} could not be applied: ${(cause as Error).message}`,
    );
  }

  if (applyEdits(after, inverse) !== before) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `The undo for ${operation.path} does not restore the original text.`,
    );
  }
}
