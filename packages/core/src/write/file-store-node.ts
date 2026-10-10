/**
 * The real `FileStore`, backed by the filesystem, and one of the few modules that touch
 * a disk.
 *
 * The filesystem calls go through `FileOperations` so a test can make them fail with
 * EBUSY or EPERM. A real disk will not produce those on demand (on Windows, Node deletes a
 * read-only file and a file with an open handle cleanly), and without the seam the busy
 * retry could only be tested apart from the methods that use it.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type NotText, readForSearch } from '../read-text.js';
import type { FileStore } from './transaction.js';

/** Retries for a file another process is holding open. */
const BUSY_RETRIES = 5;
const BUSY_BACKOFF_MS = 20;

/**
 * The digest every hash in a manifest is made with, reported through `hashAlgorithm` so
 * the manifest records it. If it changes, a manifest naming the old one is refused rather
 * than compared against hashes that can never match.
 */
const HASH_ALGORITHM = 'sha256';

/**
 * The filesystem operations the store performs.
 *
 * Every path reaching an implementation is already absolute: the store resolves
 * against its root first. Not exported from the package index: code outside the package
 * gets this store from `createNodeFileStore(root)`.
 */
export interface FileOperations {
  /**
   * Raw bytes. Hashing reads bytes rather than decoded text, so a file that is not valid
   * UTF-8 still hashes to what is on disk, the same on every machine.
   */
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  readForSearch(path: string): Promise<string | NotText>;
  write(path: string, text: string): Promise<void>;
  /** Create only if absent, atomically (`O_EXCL`). `false` when the file was already there. */
  createExclusive(path: string, text: string): Promise<boolean>;
  ensureDirectory(path: string): Promise<void>;
  /** Fails rather than overwriting an existing destination. */
  copy(from: string, to: string): Promise<void>;
  /** Tolerates an absent path, so undo is safe to repeat. */
  remove(path: string): Promise<void>;
  /** A folder's entries by name; none for a folder that is not there. */
  list(path: string): Promise<string[]>;
  /** A folder and everything in it; tolerates an absent path. */
  removeTree(path: string): Promise<void>;
}

/** The operations a real run uses. */
export const nodeFileOperations: FileOperations = {
  read: (path) => readFile(path),
  readText: (path) => readFile(path, 'utf8'),
  readForSearch,
  write: (path, text) => writeFile(path, text, 'utf8'),
  // `wx`: the kernel creates the file or fails with EEXIST, with nothing in between.
  // EEXIST is the ordinary answer, so it alone becomes `false`; anything else (a read-only
  // directory, a bad path) is a real failure and still throws.
  createExclusive: async (path, text) => {
    try {
      await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  },
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  // A copy, never a rename: a rename across volumes fails on Windows, and staged bytes
  // may sit on a different volume from the project. `COPYFILE_EXCL` because the
  // transaction only copies to paths it has checked are absent, so a file already there
  // is a plan error, and overwriting it would lose somebody's file.
  copy: (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
  remove: (path) => rm(path, { force: true }),
  list: async (path) => {
    try {
      return await readdir(path);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  },
  removeTree: (path) => rm(path, { recursive: true, force: true }),
};

/**
 * Build a store rooted at a project directory.
 *
 * Every path handed to the returned store is POSIX-relative to `root`. Resolving them
 * here rather than at the call sites keeps absolute paths out of the manifest, so a
 * manifest still means the same thing after the project is moved.
 */
export function createNodeFileStore(root: string): FileStore {
  return createFileStoreOn(nodeFileOperations, root);
}

/**
 * The same store over whichever operations it is handed.
 *
 * Exported for the tests that inject an implementation failing with EBUSY, which is
 * the only way to reach the retry from outside.
 */
export function createFileStoreOn(operations: FileOperations, root: string): FileStore {
  const absolute = (path: string): string => resolve(root, path);

  return {
    hashAlgorithm: HASH_ALGORITHM,

    async hash(path: string): Promise<string | null> {
      try {
        const bytes = await operations.read(absolute(path));
        return createHash(HASH_ALGORITHM).update(bytes).digest('hex');
      } catch (cause) {
        if (isMissing(cause)) return null;
        throw cause;
      }
    },

    async readText(path: string): Promise<string> {
      return operations.readText(absolute(path));
    },

    async readForSearch(path: string): Promise<string | NotText> {
      return operations.readForSearch(absolute(path));
    },

    async writeText(path: string, text: string): Promise<void> {
      const target = absolute(path);
      await operations.ensureDirectory(dirname(target));
      await retryWhileBusy(() => operations.write(target, text));
    },

    async createExclusive(path: string, text: string): Promise<boolean> {
      const target = absolute(path);
      await operations.ensureDirectory(dirname(target));
      return operations.createExclusive(target, text);
    },

    async copy(from: string, to: string): Promise<void> {
      const target = absolute(to);
      await operations.ensureDirectory(dirname(target));
      await retryWhileBusy(() => operations.copy(absolute(from), target));
    },

    async remove(path: string): Promise<void> {
      await retryWhileBusy(() => operations.remove(absolute(path)));
    },
    listDirectory(path: string): Promise<readonly string[]> {
      return operations.list(absolute(path));
    },
    async removeDirectory(path: string): Promise<void> {
      await retryWhileBusy(() => operations.removeTree(absolute(path)));
    },
  };
}

function isMissing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Retry an operation while another process holds the file open.
 *
 * On Windows an editor, an antivirus scanner or a dev server holding a handle open
 * produces EBUSY or EPERM for a few milliseconds, and failing the whole run for that
 * would make the tool unusable there.
 */
async function retryWhileBusy(action: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await action();
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      const busy = code === 'EBUSY' || code === 'EPERM';
      if (!busy || attempt >= BUSY_RETRIES) throw cause;
      await new Promise((done) => setTimeout(done, BUSY_BACKOFF_MS * 2 ** attempt));
    }
  }
}
