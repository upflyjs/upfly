/**
 * `upfly undo`: puts back every file the last applied run changed, from the record it left
 * in `.upfly/manifest.json`, whether that run finished or stopped part way.
 *
 * No configuration file is read. Undo has no settings: it follows the record, and checks
 * each file against it before changing any.
 */

import { resolve } from 'node:path';
import {
  type Manifest,
  type OperationState,
  UpflyError,
  createNodeFileStore,
  inspect,
  readManifest,
  revert,
} from 'upfly-core';
import type { UndoOptions } from './args.js';
import { isDirectory } from './audit.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { commitForRun } from './git.js';
import { headline, spaced } from './layout.js';
import { type Io, emit, stopWith, stylesFor } from './output.js';
import { count } from './plan-text.js';

/** The engine's refusals, each of which leaves every file as it was. */
const REFUSALS = new Set([
  'TRANSACTION_FOREIGN_CHANGE',
  'TRANSACTION_LOCKED',
  'MANIFEST_VERSION_UNSUPPORTED',
]);

/** What undo put back, by kind. */
export interface Undone {
  readonly id: string;
  readonly startedAt: string;
  /** Originals the run had removed, back in place. */
  readonly restored: string[];
  /** Files whose references point at the originals again. */
  readonly reverted: string[];
  /** Files the run had created, gone again. */
  readonly removed: string[];
  /** Images the run had moved, back at `from` again. */
  readonly moved: { readonly from: string; readonly to: string }[];
}

/**
 * Reverts the last applied run.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the files were put back or there was nothing to undo; 2 for a usage
 * error; 3 when a file changed since the run, or another run is in progress
 */
export async function runUndo(options: UndoOptions, io: Io): Promise<ExitCode> {
  const root = resolve(options.dir);
  if (!isDirectory(root)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `${options.dir} is not a directory`);
  }
  const store = createNodeFileStore(root);

  let manifest: Manifest | null;
  try {
    manifest = await readManifest(store);
  } catch (error) {
    if (error instanceof UpflyError) {
      return stopWith(io, options, EXIT_CODES.ABORTED, error.message, error.code);
    }
    return stopWith(
      io,
      options,
      EXIT_CODES.ABORTED,
      `.upfly/manifest.json cannot be read (${firstLine(error)}), so undo has no record to follow. Nothing was changed.`,
      'MANIFEST_UNREADABLE',
    );
  }
  if (manifest === null) {
    return nothingToUndo(
      options,
      io,
      'No Upfly run has written to this project, so there is nothing to undo.',
    );
  }
  if (manifest.state === 'reverted') {
    return nothingToUndo(
      options,
      io,
      `The last run (${manifest.runId}) was already undone, at ${manifest.revertedAt}. Nothing was changed.`,
    );
  }

  let states: readonly OperationState[];
  try {
    states = await inspect(manifest, store);
    await revert(manifest, store);
  } catch (error) {
    if (error instanceof UpflyError && REFUSALS.has(error.code)) {
      return stopWith(io, options, EXIT_CODES.ABORTED, error.message, error.code);
    }
    throw error;
  }

  write(options, io, undoneFrom(manifest, states), commitForRun(root, manifest.runId));
  return EXIT_CODES.OK;
}

/** What the revert changed, from the states it was decided on. */
function undoneFrom(manifest: Manifest, states: readonly OperationState[]): Undone {
  const undone: Undone = {
    id: manifest.runId,
    startedAt: manifest.startedAt,
    restored: [],
    reverted: [],
    removed: [],
    moved: [],
  };
  for (const { operation, status } of states) {
    if (status === 'not-applied') continue;
    if (operation.kind === 'delete') undone.restored.push(operation.path);
    else if (operation.kind === 'edit') undone.reverted.push(operation.path);
    else if (operation.kind === 'create') undone.removed.push(operation.path);
    else undone.moved.push({ from: operation.from, to: operation.to });
  }
  return undone;
}

function write(options: UndoOptions, io: Io, undone: Undone, commit: string | null): void {
  const notes = commit === null ? [] : [afterCommit(commit)];
  if (options.json) {
    emit(io, { type: 'result', command: 'undo', exitCode: EXIT_CODES.OK, undone, commit, notes });
    return;
  }
  const lines = [
    headline(stylesFor(io.stdout, io.env, options), 'undo'),
    '',
    `Undid run ${undone.id}, started ${undone.startedAt}: ${whatWasUndone(undone)}.`,
    'Every file that run changed is as it was before it.',
    ...notes,
  ];
  io.stdout.write(spaced(lines));
}

/**
 * What undo put back, by kind. A run that moved images restored no original and removed no
 * converted file, so those counts are said only when one of them is not zero.
 */
function whatWasUndone(undone: Undone): string {
  const moved = undone.moved.length;
  const said = (n: number) => moved === 0 || n > 0;
  return [
    ...(said(undone.restored.length)
      ? [`${count(undone.restored.length, 'original')} restored`]
      : []),
    `${count(undone.reverted.length, 'file')} with references put back`,
    ...(said(undone.removed.length)
      ? [`${count(undone.removed.length, 'converted file')} removed`]
      : []),
    ...(moved === 0
      ? []
      : [`${count(moved, 'image')} moved back where ${moved === 1 ? 'it was' : 'they were'}`]),
  ].join(', ');
}

/** What a user holds after undoing a run that `--commit` had committed. */
function afterCommit(commit: string): string {
  const short = commit.slice(0, 12);
  return `That run was committed as ${short}, which is still in the history, so the files undo put back now show as uncommitted changes. Commit them to record the undo; \`git revert ${short}\` would have done the same in one step.`;
}

function nothingToUndo(options: UndoOptions, io: Io, why: string): ExitCode {
  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'undo',
      exitCode: EXIT_CODES.OK,
      undone: null,
      commit: null,
      notes: [why],
    });
  } else {
    const styles = stylesFor(io.stdout, io.env, options);
    io.stdout.write(spaced([headline(styles, 'undo'), '', why]));
  }
  return EXIT_CODES.OK;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
