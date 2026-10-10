import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LOCK_PATH, processIsAlive, readLockHolder } from './lock.js';
import { MANIFEST_PATH } from './manifest.js';
import { type FileStore, type RunContext, commit } from './transaction.js';

/**
 * Two writers, one manifest: the lock that keeps a second run out while the first writes.
 *
 * Everything goes through the real `commit` rather than the lock helper alone: the first
 * transaction is suspended mid-run, holding a lock file it created, while a second one
 * starts. A guard tested only on its own can pass while never firing where it matters.
 *
 * Two tests break the premise on purpose, as controls: with the held lock removed the
 * second run goes through, and with a live holder in place of a dead one it is refused.
 * Each shows that the outcome it mirrors comes from the lock, not from something else.
 */

/**
 * A pid that is dead because a real process used it and exited. A hardcoded pid could
 * belong to a live process on some machine.
 */
function deadPid(): number {
  // `spawnSync` returns after the child has exited, so this pid is free by the time
  // it is read. Node itself is used rather than a shell so the call means the same
  // thing on every platform.
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  if (pid === undefined) throw new Error('could not spawn a process to get a dead pid');

  // If the operating system has already recycled the pid, the premise is false, and
  // the test must fail saying so rather than pass for the wrong reason.
  if (processIsAlive(pid)) throw new Error(`pid ${pid} was recycled before the test could use it`);
  return pid;
}

function memoryStore(files = new Map<string, string>()) {
  const store: FileStore = {
    hashAlgorithm: 'sha256',
    async hash(path) {
      const text = files.get(path);
      return text === undefined ? null : `h:${text.length}`;
    },
    async readText(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    // Every file these tests hold is text.
    readForSearch: (path) => store.readText(path),
    async writeText(path, text) {
      files.set(path, text);
    },
    // Real exclusivity. A store that overwrote here would make every assertion below
    // pass against a lock that could never refuse.
    async createExclusive(path, text) {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    async copy(from, to) {
      const text = files.get(from);
      if (text === undefined) throw new Error(`no such file: ${from}`);
      files.set(to, text);
    },
    async remove(path) {
      files.delete(path);
    },
    async listDirectory(path) {
      const prefix = `${path}/`;
      const names = [...files.keys()].flatMap((file) =>
        file.startsWith(prefix) ? [file.slice(prefix.length).split('/')[0] ?? ''] : [],
      );
      return [...new Set(names)];
    },
    async removeDirectory(path) {
      for (const file of [...files.keys()]) {
        if (file.startsWith(`${path}/`)) files.delete(file);
      }
    },
  };
  return { files, store };
}

function contextFor(runId: string): RunContext {
  return {
    runId,
    runDir: `.upfly/runs/${runId}`,
    now: () => '2026-09-13T00:00:00.000Z',
    declined: [],
  };
}

/**
 * A store that suspends the first manifest write until the test lets it go.
 *
 * This keeps the first transaction in progress: it has taken the lock and not finished,
 * which is the state a second run has to meet. Stubbing the lock file instead would test
 * a file, not a transaction.
 */
function suspendable(store: FileStore) {
  let release = (): void => {};
  const suspended = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  let reached = (): void => {};
  const inside = new Promise<void>((resolve) => {
    reached = resolve;
  });

  const wrapped: FileStore = {
    ...store,
    async writeText(path, text) {
      if (armed && path === MANIFEST_PATH) {
        armed = false;
        reached();
        await suspended;
      }
      return store.writeText(path, text);
    },
  };

  return { store: wrapped, release, inside };
}

describe('two runs, one manifest', () => {
  it('refuses a second transaction while the first is still running', async () => {
    // Without the lock, the second run overwrites the first run's pending manifest, the
    // first then writes its committed manifest over that, and the second run's backups
    // are left in `.upfly/runs/<B>/` with nothing pointing at them. Its deletions could
    // not be undone, which is what the transaction exists to prevent.
    const { files, store } = memoryStore();
    const first = suspendable(store);

    const running = commit([], first.store, contextFor('run-a'));
    await first.inside;

    // The lock is a real file written by the real run, not a fixture the test placed.
    expect(files.has(LOCK_PATH)).toBe(true);

    await expect(commit([], store, contextFor('run-b'))).rejects.toThrow(
      expect.objectContaining({ code: 'TRANSACTION_LOCKED' }),
    );

    first.release();
    await running;
  });

  it('says which run holds it, so "try again" is something a user can check', async () => {
    const { store } = memoryStore();
    const first = suspendable(store);
    const running = commit([], first.store, contextFor('run-a'));
    await first.inside;

    // A bare "locked" leaves a user with no way to tell a live run from a stuck one.
    await expect(commit([], store, contextFor('run-b'))).rejects.toThrow(/run-a/);

    first.release();
    await running;
  });

  it('lets the second transaction through once the lock is gone', async () => {
    // A control: remove the held lock and the same second run succeeds. Without it, the
    // refusal above could be firing for another reason (a hash mismatch, a store quirk)
    // and would still read as proof of a lock that was doing nothing.
    const { files, store } = memoryStore();
    const first = suspendable(store);
    const running = commit([], first.store, contextFor('run-a'));
    await first.inside;

    files.delete(LOCK_PATH);

    await expect(commit([], store, contextFor('run-b'))).resolves.toMatchObject({
      state: 'committed',
    });

    first.release();
    await running;
  });

  it('releases the lock when the run finishes, so the next one may start', async () => {
    const { files, store } = memoryStore();

    await commit([], store, contextFor('run-a'));
    expect(files.has(LOCK_PATH)).toBe(false);

    await expect(commit([], store, contextFor('run-b'))).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('releases the lock even when the run fails, so a failure is not a brick', async () => {
    // A throw mid-commit must not leave the directory locked for the rest of the
    // process's life. `commit` releases the lock in a `finally`.
    const { files, store } = memoryStore();
    const exploding: FileStore = {
      ...store,
      async writeText(path, text) {
        if (path === MANIFEST_PATH) throw new Error('injected failure');
        return store.writeText(path, text);
      },
    };

    await expect(commit([], exploding, contextFor('run-a'))).rejects.toThrow('injected failure');
    expect(files.has(LOCK_PATH)).toBe(false);
  });
});

describe('a lock its holder did not survive', () => {
  /** A lock file exactly as a run would have written it, for a chosen holder. */
  function lockHeldBy(pid: number): string {
    return `${JSON.stringify({ pid, startedAt: '2026-09-13T00:00:00.000Z', runId: 'run-crashed' }, null, 2)}\n`;
  }

  it('clears a lock whose process is gone, rather than bricking the directory', async () => {
    // Without this, the first killed run would lock the project for good, and the only
    // fix would be deleting a file nobody told the user about.
    const { files, store } = memoryStore();
    files.set(LOCK_PATH, lockHeldBy(deadPid()));

    await expect(commit([], store, contextFor('run-b'))).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('still refuses when the holder is alive, which is the same test with one change', async () => {
    // The control for the test above: the same lock file and run, with only the holder's
    // liveness changed. It shows the recovery is caused by the process being gone, not by
    // the lock being readable, old or ours.
    const { files, store } = memoryStore();
    files.set(LOCK_PATH, lockHeldBy(process.pid));

    await expect(commit([], store, contextFor('run-b'))).rejects.toThrow(
      expect.objectContaining({ code: 'TRANSACTION_LOCKED' }),
    );
  });

  it('refuses a lock that cannot be read, and says which file to delete', async () => {
    // It may be one another run has created and not finished writing. Clearing it would
    // let two runs hold the lock; a lock cut short by a power cut costs one deletion.
    const { files, store } = memoryStore();
    files.set(LOCK_PATH, '{ this is not json');

    await expect(commit([], store, contextFor('run-b'))).rejects.toMatchObject({
      code: 'TRANSACTION_LOCKED',
      message: expect.stringContaining(`delete ${LOCK_PATH}`),
    });
    expect(files.get(LOCK_PATH)).toBe('{ this is not json');
  });

  it('does not treat a live holder as stale just because this process is the holder', async () => {
    // A lock held by this process still blocks a different run. Judging staleness by
    // whether the pid is ours, rather than by whether it is running, would pass in
    // production, where two runs are two processes, and switch the lock off here, where
    // they share one. An editor extension hosting several runs in one process is the same.
    const { files, store } = memoryStore();
    files.set(LOCK_PATH, lockHeldBy(process.pid));

    await expect(commit([], store, contextFor('run-b'))).rejects.toThrow(
      expect.objectContaining({ code: 'TRANSACTION_LOCKED' }),
    );
  });
});

describe('readLockHolder', () => {
  it('names the run holding the lock, and nothing when none does or the file is unreadable', async () => {
    const { files, store } = memoryStore();
    expect(await readLockHolder(store)).toBeNull();

    const first = suspendable(store);
    const running = commit([], first.store, contextFor('run-a'));
    await first.inside;
    expect(await readLockHolder(store)).toMatchObject({ runId: 'run-a', pid: process.pid });

    first.release();
    await running;
    expect(await readLockHolder(store)).toBeNull();

    files.set(LOCK_PATH, '{ this is not json');
    expect(await readLockHolder(store)).toBeNull();
  });
});

describe('a run may re-enter its own lock', () => {
  it('lets the same runId take the lock it already holds', async () => {
    // `optimize` holds the lock across `prepare` and `commit`, and `commit` takes it
    // again on its own behalf so a library consumer calling it directly is protected
    // too. Without re-entry every applied run would refuse itself.
    const { files, store } = memoryStore();
    files.set(
      LOCK_PATH,
      `${JSON.stringify({ pid: process.pid, startedAt: '2026-09-13T00:00:00.000Z', runId: 'run-a' }, null, 2)}\n`,
    );

    await expect(commit([], store, contextFor('run-a'))).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('does not let another process in under the same run id while that run is alive', async () => {
    // What an undo started from a second terminal meets: it reads the run id from the
    // manifest, and the run that wrote it is still going.
    const { files, store } = memoryStore();
    const held = `${JSON.stringify({ pid: process.pid, startedAt: '2026-09-13T00:00:00.000Z', runId: 'run-a' }, null, 2)}\n`;
    files.set(LOCK_PATH, held);

    await expect(
      commit([], store, contextFor('run-a'), { pid: process.pid + 1, isAlive: () => true }),
    ).rejects.toThrow(expect.objectContaining({ code: 'TRANSACTION_LOCKED' }));
    expect(files.get(LOCK_PATH)).toBe(held);
  });

  it('takes over a lock left under the same run id by a process that is gone', async () => {
    // The undo of a run that was killed part way: its lock names the same run, and nobody
    // is holding it any more.
    const { files, store } = memoryStore();
    files.set(
      LOCK_PATH,
      `${JSON.stringify({ pid: deadPid(), startedAt: '2026-09-13T00:00:00.000Z', runId: 'run-a' }, null, 2)}\n`,
    );

    await expect(commit([], store, contextFor('run-a'))).resolves.toMatchObject({
      state: 'committed',
    });
    expect(files.has(LOCK_PATH)).toBe(false);
  });

  it('leaves the outer hold in place when the inner one finishes', async () => {
    // Releasing a re-entrant hold must do nothing, or an inner `commit` finishing would
    // unlock a run that is still going, and the next run could start while it writes.
    const { files, store } = memoryStore();
    const outer = `${JSON.stringify({ pid: process.pid, startedAt: '2026-09-13T00:00:00.000Z', runId: 'run-a' }, null, 2)}\n`;
    files.set(LOCK_PATH, outer);

    await commit([], store, contextFor('run-a'));

    expect(files.get(LOCK_PATH)).toBe(outer);
  });
});
