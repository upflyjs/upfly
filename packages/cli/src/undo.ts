/**
 * `upfly undo`: puts back every file the last applied run changed, from the record it left
 * in `.upfly/manifest.json`, whether that run finished or stopped part way. With `--file` it
 * puts back only what the run did to one file, and with `--line` one line of it; with
 * `--list` it shows what the run changed, and what of that is undone, changing nothing.
 *
 * No configuration file is read. Undo has no settings: it follows the record, and checks
 * each file against it before changing any.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type FileChanges,
  type FileStore,
  type Manifest,
  type OperationState,
  type PartUndone,
  type RunChanges,
  type RunOriginal,
  type RunPart,
  UpflyError,
  createNodeFileStore,
  describeRun,
  inspect,
  revert,
  undoPart,
} from 'upfly-core';
import { KEPT_RUNS, type KeptRun, keptRuns, refuseUnderLaterRun } from 'upfly-core/internal';
import type { UndoOptions } from './args.js';
import { isDirectory } from './audit.js';
import { EXIT_CODES, type ExitCode, type RefusalReason } from './exit-codes.js';
import { commitForRun } from './git.js';
import { type UpflyCommand, upflyCommand } from './invocation.js';
import { commandLine, headline, spaced } from './layout.js';
import { type Io, type Styles, emit, stopWith, stylesFor } from './output.js';
import { count } from './plan-text.js';

/** The engine's refusals, each of which leaves every file as it was. */
const REFUSALS: readonly RefusalReason[] = [
  'TRANSACTION_FOREIGN_CHANGE',
  'TRANSACTION_LOCKED',
  'TRANSACTION_INTERRUPTED',
  'MANIFEST_VERSION_UNSUPPORTED',
  'LATER_RUN_STANDS',
];

/** The refusal `error` is, if the engine threw one of `REFUSALS`. */
function refusalIn(error: unknown): { reason: RefusalReason; message: string } | null {
  if (!(error instanceof UpflyError)) return null;
  const reason = REFUSALS.find((candidate) => candidate === error.code);
  return reason === undefined ? null : { reason, message: error.message };
}

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
 * Reverts the last applied run, or part of it.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the files were put back, there was nothing to undo, or the run was listed;
 * 2 for a usage error, or a part of the run that is none of its changes; 3 when a file changed
 * since the run, or another run is in progress
 */
export async function runUndo(options: UndoOptions, io: Io): Promise<ExitCode> {
  const root = resolve(options.dir);
  if (!isDirectory(root)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `${options.dir} is not a directory`);
  }
  const upfly = upflyCommand(io.env, io.script);
  let part: RunPart | null = null;
  if (options.file !== null) {
    const file = projectPath(root, options.file);
    if (file === null) {
      return stopWith(
        io,
        options,
        EXIT_CODES.USAGE,
        `${options.file} is outside the project at ${root}. Name a file inside it, or name its project after the command: ${upfly} undo <folder> --file <path>.`,
      );
    }
    part = { file, line: options.line };
  }
  const store = createNodeFileStore(root);

  const runs = await readRuns(store, options, io);
  if (typeof runs === 'number') return runs;
  const target =
    options.run === null ? runs[0] : runs.find((run) => run.manifest.runId === options.run);
  if (options.run !== null && target === undefined) {
    return stopWith(
      io,
      options,
      EXIT_CODES.USAGE,
      `No run ${options.run} is kept in .upfly, which keeps the last ${KEPT_RUNS} runs. ${upfly} undo --list shows them.`,
      'RUN_NOT_FOUND',
    );
  }
  if (options.list) return list(options, io, target ?? null, runs, part, root, upfly);
  if (target === undefined) {
    return nothingToUndo(
      options,
      io,
      'No Upfly run has written to this project, so there is nothing to undo.',
      part,
    );
  }
  const manifest = target.manifest;
  try {
    await refuseUnderLaterRun(target, runs, store);
  } catch (error) {
    const refused = refusalIn(error);
    if (refused === null) throw error;
    return stopWith(io, options, EXIT_CODES.ABORTED, refused.message, refused.reason);
  }
  if (part !== null) return undoOnePart(options, io, target, part, root, upfly);
  if (manifest.state === 'reverted') {
    return nothingToUndo(options, io, alreadyUndone(manifest, target === runs[0]), null);
  }

  let states: readonly OperationState[];
  try {
    states = await inspect(manifest, store);
    await revert(manifest, store, undefined, undefined, target.at);
  } catch (error) {
    const refused = refusalIn(error);
    if (refused === null) throw error;
    return stopWith(io, options, EXIT_CODES.ABORTED, refused.message, refused.reason);
  }

  write(options, io, undoneFrom(manifest, states), commitForRun(root, manifest.runId));
  return EXIT_CODES.OK;
}

/** Every kept run, newest first, or the exit code of the stop when the records cannot be read. */
async function readRuns(
  store: FileStore,
  options: UndoOptions,
  io: Io,
): Promise<readonly KeptRun[] | ExitCode> {
  try {
    return await keptRuns(store);
  } catch (error) {
    const refused = refusalIn(error);
    if (refused !== null) {
      return stopWith(io, options, EXIT_CODES.ABORTED, refused.message, refused.reason);
    }
    return stopWith(
      io,
      options,
      EXIT_CODES.ABORTED,
      `.upfly/manifest.json cannot be read (${firstLine(error)}), so undo has no record to follow. Nothing was changed.`,
      'MANIFEST_UNREADABLE',
    );
  }
}

/** The path as the user wrote it, POSIX-relative to the project, or null when outside it. */
function projectPath(root: string, written: string): string | null {
  const within = relative(root, resolve(written));
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return null;
  }
  return within.split(sep).join('/');
}

function alreadyUndone(manifest: Manifest, last = true): string {
  return `${last ? 'The last run' : 'The run'} (${manifest.runId}) was already undone, at ${manifest.revertedAt}. Nothing was changed.`;
}

/** Undo what the run did to one file, or to one line of it. */
async function undoOnePart(
  options: UndoOptions,
  io: Io,
  target: KeptRun,
  part: RunPart,
  root: string,
  upfly: UpflyCommand,
): Promise<ExitCode> {
  const { manifest } = target;
  let done: PartUndone;
  try {
    done = await undoPart(manifest, part, createNodeFileStore(root), { at: target.at });
  } catch (error) {
    if (error instanceof UpflyError && error.code === 'NOT_IN_RUN') {
      return stopWith(io, options, EXIT_CODES.USAGE, error.message, 'NOT_IN_RUN');
    }
    const refused = refusalIn(error);
    if (refused === null) throw error;
    return stopWith(io, options, EXIT_CODES.ABORTED, refused.message, refused.reason);
  }
  const nothing =
    done.reverted === null && done.restored.length === 0 && done.copiedBack.length === 0;
  if (nothing) {
    return nothingToUndo(
      options,
      io,
      manifest.state === 'reverted' ? alreadyUndone(manifest) : partAlreadyUndone(manifest, part),
      part,
    );
  }

  const undone: Undone = {
    id: manifest.runId,
    startedAt: manifest.startedAt,
    restored: [...done.restored],
    reverted: done.reverted === null ? [] : [done.reverted],
    removed: [],
    moved: done.copiedBack.map((move) => ({ ...move })),
  };
  const commit = commitForRun(root, manifest.runId);
  const notes = commit === null ? [] : [afterCommit(commit)];
  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'undo',
      exitCode: EXIT_CODES.OK,
      undone,
      part,
      commit,
      notes,
    });
    return EXIT_CODES.OK;
  }
  io.stdout.write(
    spaced([
      headline(stylesFor(io.stdout, io.env, options), 'undo'),
      '',
      `Undid ${partName(manifest, part)}, from run ${undone.id}: ${whatPartPutBack(done)}.`,
      `The rest of that run stands; ${upfly} undo puts back all of it.`,
      ...notes,
    ]),
  );
  return EXIT_CODES.OK;
}

/** What the part names in a sentence: a line, a file's changes, or an image taken away. */
function partName(manifest: Manifest, part: RunPart): string {
  if (part.line !== null) return `line ${part.line} of ${part.file}`;
  const operation = manifest.operations.find(
    (each) =>
      (each.kind === 'edit' || each.kind === 'delete' ? each.path : null) === part.file ||
      (each.kind === 'move' && each.from === part.file),
  );
  if (operation?.kind === 'edit') return `the changes to ${part.file}`;
  return operation?.kind === 'move' ? `the move of ${part.file}` : `the removal of ${part.file}`;
}

function partAlreadyUndone(manifest: Manifest, part: RunPart): string {
  const rewritten = manifest.operations.some(
    (operation) => operation.kind === 'edit' && operation.path === part.file,
  );
  if (part.line !== null) {
    return `Line ${part.line} of ${part.file} is already undone, and the images it names are where they were. Nothing was changed.`;
  }
  return rewritten
    ? `The changes the run made to ${part.file} are already undone, and the images they name are where they were. Nothing was changed.`
    : `${part.file} is back already. Nothing was changed.`;
}

/** What undoing part of a run put back, by kind. */
function whatPartPutBack(done: PartUndone): string {
  const said: string[] = [];
  if (done.lines.length > 0) said.push(`${count(done.lines.length, 'line')} put back`);
  if (done.restored.length > 0) {
    said.push(`${count(done.restored.length, 'original')} restored`);
  }
  if (done.copiedBack.length > 0) {
    said.push(
      `${count(done.copiedBack.length, 'moved image')} copied back to where ${done.copiedBack.length === 1 ? 'it was' : 'they were'}, also staying at the new place`,
    );
  }
  return said.join(', ');
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
    emit(io, {
      type: 'result',
      command: 'undo',
      exitCode: EXIT_CODES.OK,
      undone,
      part: null,
      commit,
      notes,
    });
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

function nothingToUndo(options: UndoOptions, io: Io, why: string, part: RunPart | null): ExitCode {
  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'undo',
      exitCode: EXIT_CODES.OK,
      undone: null,
      part,
      commit: null,
      notes: [why],
    });
  } else {
    const styles = stylesFor(io.stdout, io.env, options);
    io.stdout.write(spaced([headline(styles, 'undo'), '', why]));
  }
  return EXIT_CODES.OK;
}

/** Show what the last run changed, and what of it is undone, writing nothing. */
async function list(
  options: UndoOptions,
  io: Io,
  target: KeptRun | null,
  runs: readonly KeptRun[],
  part: RunPart | null,
  root: string,
  upfly: UpflyCommand,
): Promise<ExitCode> {
  if (target === null) {
    const why = 'No Upfly run has written to this project, so there is nothing to undo.';
    if (options.json) {
      emit(io, {
        type: 'result',
        command: 'undo',
        exitCode: EXIT_CODES.OK,
        undone: null,
        part: null,
        commit: null,
        notes: [why],
        run: null,
        runs: [],
      });
    } else {
      io.stdout.write(
        spaced([headline(stylesFor(io.stdout, io.env, options), 'undo', 'list'), '', why]),
      );
    }
    return EXIT_CODES.OK;
  }

  const { manifest } = target;
  let described: RunChanges;
  try {
    described = await describeRun(manifest, createNodeFileStore(root));
  } catch (error) {
    const refused = refusalIn(error);
    if (refused === null) throw error;
    return stopWith(io, options, EXIT_CODES.ABORTED, refused.message, refused.reason);
  }
  const run =
    part === null
      ? described
      : { ...described, files: described.files.filter((file) => file.path === part.file) };
  const commit = commitForRun(root, manifest.runId);
  const kept = runs.map(({ manifest: each }) => ({
    id: each.runId,
    startedAt: each.startedAt,
    state: stateOf(each),
  }));
  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'undo',
      exitCode: EXIT_CODES.OK,
      undone: null,
      part: null,
      commit,
      notes: [],
      run,
      runs: kept,
    });
    return EXIT_CODES.OK;
  }
  const named = target === runs[0] ? null : manifest.runId;
  io.stdout.write(listed(run, kept, named, options, io, upfly));
  return EXIT_CODES.OK;
}

/** A run's state in the words `--list` uses. */
function stateOf(manifest: Manifest): RunChanges['state'] {
  if (manifest.state === 'pending') return 'interrupted';
  return manifest.state === 'reverted' ? 'undone' : 'applied';
}

const STATE_WORDS: Readonly<Record<RunChanges['state'], string>> = {
  applied: 'applied',
  undone: 'undone as a whole',
  interrupted: 'stopped before it finished, so it can be undone only as a whole',
};

/** The run's changes as text: each file's lines, the originals, the created files, the commands. */
function listed(
  run: RunChanges,
  kept: readonly { readonly id: string; readonly state: RunChanges['state'] }[],
  named: string | null,
  options: UndoOptions,
  io: Io,
  upfly: UpflyCommand,
): string {
  const styles = stylesFor(io.stdout, io.env, options);
  const lines = [
    headline(styles, 'undo', 'list'),
    '',
    `Run ${run.id}, started ${run.startedAt}: ${STATE_WORDS[run.state]}.`,
  ];
  if (kept.length > 1) {
    lines.push(
      `Kept runs, newest first: ${kept.map((each) => `${each.id} (${STATE_WORDS[each.state]})`).join(', ')}.`,
    );
  }
  for (const file of run.files) lines.push('', ...fileLines(file, styles));
  if (run.originals.length > 0) {
    lines.push('', 'Images it removed or moved away', ...originalLines(run.originals, styles));
  }
  if (run.created.length > 0) {
    lines.push('', 'Files it created, which only undoing the whole run removes');
    for (const path of run.created) lines.push(`  ${path}`);
  }
  if (run.state === 'applied') lines.push('', ...nextCommands(run, named, upfly));
  return spaced(lines);
}

/** One rewritten file: its path, then each changed line with its paths before and after. */
function fileLines(file: FileChanges, styles: Styles): string[] {
  const where = (line: number | null) => (line === null ? 'a line' : `line ${line}`);
  const width = Math.max(...file.changes.map((change) => where(change.line).length));
  return [
    file.changedSince ? `${file.path}, changed since the run` : file.path,
    ...file.changes.map((change) => {
      const paths = change.paths
        .map((path) => `${path.before} → ${path.after ?? 'a path the record does not hold'}`)
        .join(', ');
      const undone = change.undone === true ? styles.dim('  undone') : '';
      return `  ${where(change.line).padEnd(width)}  ${paths}${undone}`;
    }),
  ];
}

/** Each image the run took away, and where it is now. */
function originalLines(originals: readonly RunOriginal[], styles: Styles): string[] {
  const width = Math.max(...originals.map((original) => original.path.length));
  return originals.map((original) => {
    let state = original.movedTo === null ? 'removed' : `moved to ${original.movedTo}`;
    if (original.back) state = 'back';
    if (original.changedSince) state = 'another file is there now';
    return `  ${original.path.padEnd(width)}  ${styles.dim(state)}`;
  });
}

/** The commands that undo a line, a file and the whole run, for this run's first change. */
function nextCommands(run: RunChanges, named: string | null, upfly: UpflyCommand): string[] {
  const words = [...upfly.split(' '), 'undo', ...(named === null ? [] : ['--run', named])];
  const first = run.files.find((file) => !file.changedSince);
  const line = first?.changes.find((change) => change.undone === false && change.line !== null);
  const commands: [string, string | null][] = [];
  if (first !== undefined && line !== undefined) {
    commands.push([
      'Undo one line',
      commandLine([...words, '--file', first.path, '--line', String(line.line)]),
    ]);
  }
  if (first !== undefined) {
    commands.push(['Undo one file', commandLine([...words, '--file', first.path])]);
  }
  commands.push(['Undo the run', commandLine(words)]);
  return commands.flatMap(([label, command]) =>
    command === null ? [] : [`${label.padEnd(15)}${command}`],
  );
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
