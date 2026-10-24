/**
 * Runs made without undo, such as an editor converting a new image as it arrives: applied
 * through the same steps as every run, with their record kept apart from the last run `undo`
 * follows, and nothing of them left once they finish. A run cut off part way is put back by
 * the next command that writes, before anything else.
 *
 * See "Runs made without undo" in ARCHITECTURE.md.
 */

import { randomUUID } from 'node:crypto';
import { acquireLock } from './lock.js';
import {
  type Manifest,
  NO_UNDO_DIRECTORY,
  NO_UNDO_MANIFEST_PATH,
  parseManifest,
} from './manifest.js';
import {
  type FileStore,
  type LockPorts,
  type PlannedOperation,
  type RunContext,
  checkedVersion,
  commitUnderLock,
  revertUnderLock,
} from './transaction.js';

/**
 * The folder of a run made without undo, POSIX-relative to the project root: inside
 * `NO_UNDO_DIRECTORY`, apart from the folder of the last run `undo` follows.
 *
 * @param runId the run's id
 */
export function noUndoRunDir(runId: string): string {
  return `${NO_UNDO_DIRECTORY}/${runId}`;
}

/**
 * Apply a prepared plan as a run made without undo. The steps are `commit`'s, under the same
 * lock: the record, written pending before the first change and committed after the last, the
 * staged files and the backups, then the changes. The record is kept at
 * `NO_UNDO_MANIFEST_PATH`, so `.upfly/manifest.json` and the last run's folder are never
 * touched, and once the run finishes its record and its folder are removed.
 *
 * Stopped part way while its process lives, the run puts back what it wrote before it throws.
 * Cut off with its process, it leaves its record pending, and `settleNoUndoRun` puts it back.
 *
 * @param plan the operations, checked by `prepare`
 * @param store the project's files
 * @param context the run, whose `runDir` is `noUndoRunDir(runId)`
 * @param lock test seams for the project lock
 * @returns the record as it stood when the run finished
 * @throws {UpflyError} as `commit` does
 */
export async function commitWithoutUndo(
  plan: readonly PlannedOperation[],
  store: FileStore,
  context: RunContext,
  lock: LockPorts = {},
): Promise<Manifest> {
  const runDir = noUndoRunDir(context.runId);
  if (context.runDir !== runDir) {
    throw new Error(`a run made without undo keeps its files in ${runDir}, not ${context.runDir}`);
  }
  const held = await acquireLock({ store, runId: context.runId, now: context.now, ...lock });
  try {
    let committed: Manifest;
    try {
      committed = await commitUnderLock(plan, store, context, NO_UNDO_MANIFEST_PATH);
    } catch (error) {
      await putBackOwnRun(store, context);
      throw error;
    }
    try {
      await store.removeDirectory(NO_UNDO_DIRECTORY);
    } catch {
      // The run has finished; the next command that writes clears what is left.
    }
    return committed;
  } finally {
    await held.release();
  }
}

/**
 * Put back what this run wrote, by its own record, once it stopped part way, and clear its
 * folder. A record that is not this run's is left for `settleNoUndoRun`. When this fails, the
 * record stays pending for the next command that writes; the error that stopped the run is
 * the one its caller sees.
 */
async function putBackOwnRun(store: FileStore, context: RunContext): Promise<void> {
  try {
    const record = await readNoUndoRecord(store);
    if (record?.runId !== context.runId) {
      await store.removeDirectory(context.runDir);
      return;
    }
    if (record.state === 'pending') {
      await revertUnderLock(record, store, context.now, NO_UNDO_MANIFEST_PATH);
    }
    await store.removeDirectory(NO_UNDO_DIRECTORY);
  } catch {
    // Left for the next command that writes, which puts it back first.
  }
}

/** What `settleNoUndoRun` takes besides the store. */
export interface SettleOptions {
  readonly now?: () => string;
  /** Test seams for the project lock. */
  readonly lock?: LockPorts;
}

/**
 * Put back a run made without undo that was cut off part way, and clear what any such run
 * left: every command that writes calls this before it reads the project. A record is written
 * only while the project is whole (before the run's first change, after its last, and once it
 * is put back), so a record cut off mid-write names nothing to put back and is cleared too.
 *
 * @param store the project's files
 * @param options the clock and the lock's test seams
 * @returns the record of the run put back, or null when none had been cut off part way
 * @throws {UpflyError} `TRANSACTION_LOCKED` while another run holds the project;
 *   `TRANSACTION_FOREIGN_CHANGE` naming each file the run wrote that changed since, in which
 *   case nothing is put back; `MANIFEST_VERSION_UNSUPPORTED` for a record another version of
 *   Upfly wrote
 */
export async function settleNoUndoRun(
  store: FileStore,
  options: SettleOptions = {},
): Promise<Manifest | null> {
  if ((await store.listDirectory(NO_UNDO_DIRECTORY)).length === 0) return null;
  const now = options.now ?? (() => new Date().toISOString());
  // An id of its own, so a run in this process that never released the lock is not taken for
  // this one.
  const runId = `settle-${randomUUID()}`;
  const held = await acquireLock({ store, runId, now, ...options.lock });
  try {
    const record = await readNoUndoRecord(store);
    const cutOff = record?.state === 'pending' ? record : null;
    if (cutOff !== null) await revertUnderLock(cutOff, store, now, NO_UNDO_MANIFEST_PATH);
    await store.removeDirectory(NO_UNDO_DIRECTORY);
    return cutOff;
  } finally {
    await held.release();
  }
}

/**
 * The record of a run made without undo, or null when there is none, or none that can be read
 * because it was cut off mid-write.
 *
 * @param store the project's files
 * @throws {UpflyError} `MANIFEST_VERSION_UNSUPPORTED` for a version this build does not know
 */
export async function readNoUndoRecord(store: FileStore): Promise<Manifest | null> {
  if ((await store.hash(NO_UNDO_MANIFEST_PATH)) === null) return null;
  let record: Manifest;
  try {
    record = parseManifest(await store.readText(NO_UNDO_MANIFEST_PATH));
  } catch {
    return null;
  }
  return checkedVersion(record);
}
