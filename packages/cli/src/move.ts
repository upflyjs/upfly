/**
 * `upfly move <from> <to>`: move an image, or every image in a folder, and point every
 * reference Upfly can rewrite at the new place. The plan unless `--apply`, and with
 * `--commit` one commit, under the same git rules as `optimize`. Every other line that still
 * names an old path is listed, never left silent. No image is deleted.
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Manifest } from 'upfly-core';
import {
  type MovePlan,
  type MoveProjectResult,
  type UnfollowedLine,
  moveProject,
  pathsTouched,
} from 'upfly-core/internal';
import type { MoveOptions } from './args.js';
import { isDirectory, scopeWords } from './audit.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { type GitState, RUN_TRAILER, commitPaths, gitState, ignoredPaths } from './git.js';
import { type UpflyCommand, upflyCommand } from './invocation.js';
import { renderFile } from './layout.js';
import {
  type Refusal,
  engineRefusal,
  gitRefusal,
  ignoredByGit,
  notes,
  openProject,
  some,
  unfinishedRun,
} from './optimize.js';
import { type Io, emit, progressReporter, stopWith } from './output.js';
import { count } from './plan-text.js';
import {
  type ReportFile,
  localTime,
  printRun,
  reportPath,
  typedOptions,
  writeReport,
} from './report-file.js';
import { type NextStep, moveSummary, nextAfterPlan, nextAfterRun } from './summary.js';

/** A line still naming an old path, as the JSON gives it: `from` is the image it names. */
export type UnfollowedOldPath = Omit<UnfollowedLine, 'image'> & { readonly from: string };

/** What an applied run wrote: each image moved, and each file whose references changed. */
export interface MoveRun {
  readonly id: string;
  readonly moved: readonly { readonly from: string; readonly to: string }[];
  readonly changed: readonly string[];
}

/** What to move and where, as POSIX paths relative to the project. */
interface Paths {
  readonly from: string;
  readonly to: string;
}

/**
 * Plans moving an image or a folder of images and, with `--apply`, moves them.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the run finished; 2 for a usage or configuration error, such as a path
 * outside the project or one that names no image; 3 when Upfly refused to write, or refused
 * every move it was asked for
 */
export async function runMove(options: MoveOptions, io: Io): Promise<ExitCode> {
  const started = new Date();
  const stop = (refusal: Refusal): ExitCode =>
    stopWith(io, options, refusal.code, refusal.message, refusal.reason);
  const project = await openProject(options);
  if ('code' in project) return stop(project);
  const { root, settings } = project;
  const upfly = upflyCommand(io.env, io.script);
  const paths = pathsOf(options, root, upfly);
  if ('code' in paths) return stop(paths);

  const git = gitState(root);
  const unfinished = await unfinishedRun(root, upfly);
  if (options.apply) {
    const refusal = unfinished ?? gitRefusal(git, options, root, upfly);
    if (refusal !== null) return stop(refusal);
  }

  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;
  const progress = progressReporter(io, 'move', options.json);
  // Decided on the finished plan, so a commit that could not hold every file the run writes
  // stops the run before it writes any.
  const guard: { refusal: Refusal | null } = { refusal: null };
  let result: MoveProjectResult;
  try {
    result = await moveProject({
      root,
      ...(publicDirs === null ? {} : { declared: { dirs: publicDirs, declared: true } }),
      apply: options.apply,
      moves: [paths],
      extraIgnores: [...(settings.exclude ?? []), ...options.exclude],
      onProgress: (event) => progress.update(event),
      beforeWrite: (plan) => {
        guard.refusal = options.commit ? ignoredRefusal(root, plan) : null;
        return guard.refusal === null;
      },
    });
  } catch (error) {
    progress.clear();
    const refusal = await engineRefusal(error, root, upfly);
    if (refusal === null) throw error;
    return stop(refusal);
  }
  progress.clear();
  const problem = guard.refusal ?? nothingMoves(result.plan, paths);
  if (problem !== null) return stop(problem);

  let commit: string | null = null;
  if (options.commit && result.manifest !== null) {
    try {
      commit = commitPaths(
        root,
        pathsTouched(result.manifest),
        commitMessage(result.manifest, result.plan),
        runOf(result.manifest).moved,
      );
    } catch (error) {
      return stop({
        code: EXIT_CODES.INTERNAL,
        reason: 'GIT_COMMIT_FAILED',
        message: `The run was applied, but git did not commit it (${firstLine(error)}). Its files are written: commit them yourself, or run \`${upfly} undo\` to put every file back.`,
      });
    }
  }

  write(options, io, result, {
    git,
    commit,
    unfinished: unfinished !== null,
    notes: notes(options, git, unfinished, upfly),
    started,
    upfly,
  });
  return EXIT_CODES.OK;
}

/**
 * The two paths, relative to the project, or why they cannot be used. Each is read from the
 * current folder, as a shell would. A destination that is a folder, or ends in a slash, takes
 * the image or folder in under its own name, as `mv` does.
 */
function pathsOf(options: MoveOptions, root: string, upfly: UpflyCommand): Paths | Refusal {
  const usage = (message: string): Refusal => ({ code: EXIT_CODES.USAGE, message });
  const from = resolve(options.from);
  if (!existsSync(from)) return usage(`there is no file or folder at ${options.from}.`);
  const into = /[\\/]$/.test(options.to) || isDirectory(resolve(options.to));
  const to = into ? join(resolve(options.to), basename(from)) : resolve(options.to);
  for (const [path, given] of [
    [from, options.from],
    [to, options.to],
  ] as const) {
    if (insideOf(root, path) === null) {
      return usage(
        `${given} is outside the project at ${root}. Name paths inside it, or name its project after them: ${upfly} move <from> <to> <folder>.`,
      );
    }
  }
  const fromPath = insideOf(root, from) ?? '';
  const toPath = insideOf(root, to) ?? '';
  if (fromPath === toPath) return usage(`${options.from} is already at ${options.to}.`);
  return { from: fromPath, to: toPath };
}

/** `path` as a POSIX path relative to `root`, or `null` when it is not inside it. */
function insideOf(root: string, path: string): string | null {
  const within = relative(root, path);
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return null;
  }
  return within.split(sep).join('/');
}

/**
 * Why nothing moves, when every move asked for was refused: a usage error when the path names
 * no image, else a refusal naming what is in the way.
 */
function nothingMoves(plan: MovePlan, paths: Paths): Refusal | null {
  if (plan.moves.length > 0 || plan.refused.length === 0) return null;
  if (plan.refused.every((refusal) => refusal.code === 'not-an-asset')) {
    return {
      code: EXIT_CODES.USAGE,
      message: `${paths.from} is not an image Upfly found in the project, nor a folder holding one: its extension is not an image's, or the walk leaves it out (.upflyignore, --exclude, or a folder Upfly always skips, such as node_modules).`,
    };
  }
  const [first] = plan.refused;
  const more =
    plan.refused.length === 1 ? '' : ` ${count(plan.refused.length - 1, 'other move')} too.`;
  return {
    code: EXIT_CODES.ABORTED,
    reason: 'MOVE_REFUSED',
    message: `Nothing was moved. ${first?.reason ?? ''}${more}`,
  };
}

/** Why `--commit` cannot hold the run, when git ignores a file it would write. */
function ignoredRefusal(root: string, plan: MovePlan): Refusal | null {
  const ignored = ignoredPaths(root, [
    ...plan.moves.flatMap((move) => [move.from, move.to]),
    ...plan.rewrites.map((rewrite) => rewrite.file),
  ]);
  if (ignored.length === 0) return null;
  return {
    code: EXIT_CODES.ABORTED,
    reason: 'IGNORED_BY_GIT',
    message: ignoredByGit(root, ignored),
  };
}

function commitMessage(manifest: Manifest, plan: MovePlan): string {
  const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
  const [only] = plan.moves;
  const moved =
    plan.moves.length === 1 && only !== undefined
      ? `Moved ${only.from} to ${only.to}`
      : `Moved ${count(plan.moves.length, 'image')}`;
  return [
    'Move images with Upfly',
    '',
    `${moved} and updated ${count(references, 'reference')} in ${count(plan.rewrites.length, 'file')} to name the new place. No image was deleted.`,
    '',
    `${RUN_TRAILER}: ${manifest.runId}`,
    '',
  ].join('\n');
}

interface Outcome {
  readonly git: GitState;
  readonly commit: string | null;
  /** Whether an earlier run stopped part way, which `undo` has to finish first. */
  readonly unfinished: boolean;
  readonly notes: readonly string[];
  /** When the run started, for the report file's first lines. */
  readonly started: Date;
  /** How the commands it prints are typed. */
  readonly upfly: UpflyCommand;
}

function write(options: MoveOptions, io: Io, result: MoveProjectResult, outcome: Outcome): void {
  const { plan, manifest } = result;
  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'move',
      exitCode: EXIT_CODES.OK,
      apply: options.apply,
      plan: { ...plan, unfollowed: plan.unfollowed.map(unfollowedEntry) },
      ...(result.unsearchable.length === 0 ? {} : { unsearchable: result.unsearchable }),
      run: manifest === null ? null : runOf(manifest),
      commit: outcome.commit,
      repository:
        outcome.git.kind === 'repository'
          ? { top: outcome.git.top, path: outcome.git.prefix }
          : null,
      notes: outcome.notes,
    });
    return;
  }
  let next: NextStep | null = null;
  if (options.apply) next = manifest === null ? null : nextAfterRun(outcome.commit, outcome.upfly);
  else if (plan.moves.length > 0) {
    next = nextAfterPlan(
      'move',
      options.dir,
      scopeWords({ ...options, dir: '.' }),
      outcome.git,
      outcome.unfinished,
      outcome.upfly,
      [options.from, options.to],
    );
  }
  const summary = (file: ReportFile) =>
    moveSummary({
      plan,
      apply: options.apply,
      manifest,
      commit: outcome.commit,
      git: outcome.git,
      notes: [...outcome.notes, ...unsearchableNotes(result)],
      file,
      next,
    });
  const root = result.pipeline.graph.root;
  const text = renderFile(summary({ written: reportPath('move') }), {
    when: localTime(outcome.started),
    folder: root,
    options: typedOptions(options),
  });
  const file = writeReport(root, 'move', text, manifest?.runDir ?? null);
  printRun(io, options, summary(file), text, file);
}

/** What an applied run wrote, as the JSON gives it. */
function runOf(manifest: Manifest): MoveRun {
  return {
    id: manifest.runId,
    moved: manifest.operations.flatMap((operation) =>
      operation.kind === 'move' ? [{ from: operation.from, to: operation.to }] : [],
    ),
    changed: manifest.operations.flatMap((operation) =>
      operation.kind === 'edit' ? [operation.path] : [],
    ),
  };
}

/** A line still naming an old path, as the JSON gives it: the image it names is `from`. */
function unfollowedEntry(line: UnfollowedLine): UnfollowedOldPath {
  const { image, ...rest } = line;
  return { from: image, ...rest };
}

/** What the search for the old paths could not read, so a line there cannot be ruled out. */
function unsearchableNotes(result: MoveProjectResult): string[] {
  const unread = result.unsearchable.map((entry) => entry.file);
  if (unread.length === 0) return [];
  return [
    `Upfly could not read ${count(unread.length, 'file')} (${some(unread)}), so a line there naming an old path cannot be ruled out.`,
  ];
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
