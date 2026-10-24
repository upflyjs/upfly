/**
 * `upfly optimize`: the plan, and with `--apply` the run, and with `--commit` its commit.
 *
 * Before anything is written, git has to be able to show the run as the only change: the
 * project folder has no uncommitted changes, unless the user allows them. Only the project
 * folder is looked at, and committed, even when the repository around it is larger.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type Manifest,
  type OnlyImages,
  type OptimizationPlan,
  type OptimizeProjectResult,
  type PlannedConversion,
  type PublicPolicy,
  type ServingRoots,
  UpflyError,
  buildReport,
  createNodeFileStore,
  optimizeProject,
  readManifest,
  settleNoUndoRun,
} from 'upfly-core';
import {
  LOCK_PATH,
  NO_UNDO_DIRECTORY,
  UPFLY_DIRECTORY,
  formatBytes,
  pathsTouched,
  processIsAlive,
  readLockHolder,
  readNoUndoRecord,
  servingRootOf,
} from 'upfly-core/internal';
import type { OptimizeOptions } from './args.js';
import { isDirectory, scopeWords } from './audit.js';
import { type UpflyConfig, loadConfig } from './config.js';
import { EXIT_CODES, type ExitCode, type RefusalReason } from './exit-codes.js';
import {
  type GitState,
  RUN_TRAILER,
  commitPaths,
  gitState,
  identityProblem,
  ignoredFolders,
  ignoredPaths,
  insideRepository,
  operationInProgress,
  pathsInSubmodules,
} from './git.js';
import { type UpflyCommand, upflyCommand } from './invocation.js';
import { renderFile } from './layout.js';
import { type Io, emit, progressReporter, stopWith } from './output.js';
import { count, writtenByKind } from './plan-text.js';
import {
  type ReportFile,
  localTime,
  printRun,
  reportPath,
  typedOptions,
  writeReport,
} from './report-file.js';
import { type NextStep, nextAfterPlan, nextAfterRun, optimizeSummary } from './summary.js';

/** A reason to stop, with the exit code and, for a refusal, the name `--json` gives it. */
export interface Refusal {
  readonly code: ExitCode;
  readonly reason?: RefusalReason;
  readonly message: string;
  /** The one file the refusal is about, as a path inside the project, when there is one. */
  readonly file?: string;
}

/**
 * Plans the project's optimization and, with `--apply`, carries it out.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the run finished, even with nothing to do; 2 for a usage or configuration
 * error; 3 when it refused to write
 */
export async function runOptimize(options: OptimizeOptions, io: Io): Promise<ExitCode> {
  const started = new Date();
  const stop = (refusal: Refusal): ExitCode =>
    stopWith(io, options, refusal.code, refusal.message, refusal.reason, refusal.file);
  const project = await openProject(options);
  if ('code' in project) return stop(project);
  const { root, settings } = project;

  const upfly = upflyCommand(io.env, io.script);
  const start = await startRun(root, options, upfly);
  if ('code' in start) return stop(start);
  const { git, unfinished } = start;

  const policy = policyFor(options, settings);
  const only = onlyFor(options, root, upfly);
  if ('code' in only) return stop(only);
  const result = await carryOut(options, io, root, settings, policy, only.only);
  if ('code' in result) return stop(result);

  let commit: string | null = null;
  const { manifest, plan } = result.optimize;
  if (options.commit && manifest !== null) {
    const committed = commitRun(root, manifest, plan, upfly);
    if (typeof committed !== 'string') return stop(committed);
    commit = committed;
  }

  write(options, io, result, {
    policy,
    git,
    commit,
    unfinished: unfinished !== null,
    format: options.format ?? settings.format ?? 'webp',
    notes: [
      ...start.notes,
      ...notes(options, git, unfinished, upfly),
      ...onlyNotes(result, only.only),
    ],
    applyRefusals: applyRefusals(options, git, unfinished, upfly),
    started,
  });
  return EXIT_CODES.OK;
}

/**
 * What happens to each original: as a flag says, else as the config file says, else removed
 * once every reference to it has moved. Keeping two copies of every image is not what a user
 * asking to optimize expects, and a reference Upfly finds still naming an original keeps it.
 *
 * @param options the parsed command line
 * @param settings the project's configuration
 */
export function policyFor(
  options: Pick<OptimizeOptions, 'policy'>,
  settings: Pick<UpflyConfig, 'publicPolicy'>,
): PublicPolicy {
  return options.policy ?? settings.publicPolicy ?? 'replace';
}

/** A conversion as `--json` lists it: the plan's, and where its original sits. */
export interface ConversionAnswer extends PlannedConversion {
  /**
   * The original sits in a folder the site is served from, such as `public/`, where a link from
   * outside the project (an email, another site) can name it. One a build loads is published
   * under a new name with every build, so nothing outside links to it.
   */
  readonly inPublicDir: boolean;
}

/**
 * Each conversion with whether its original is in a folder the site is served from, by the
 * same test the dry run's count of such originals uses.
 *
 * @param conversions the plan's conversions
 * @param servingRoots the folders the run decided the site is served from
 */
export function withPublicDir(
  conversions: readonly PlannedConversion[],
  servingRoots: ServingRoots,
): ConversionAnswer[] {
  return conversions.map((conversion) => ({
    ...conversion,
    inPublicDir: servingRootOf(conversion.asset, servingRoots) !== null,
  }));
}

/**
 * How many images `--only` and `--image` left out, and each pattern or path that named none, on
 * every run.
 */
function onlyNotes(result: OptimizeProjectResult, only: OnlyImages | null): string[] {
  if (result.only === undefined || only === null) return [];
  const total = result.pipeline.graph.assets.length;
  const named = result.only.images.length;
  const left = total - named;
  const flags = [
    ...(only.patterns === undefined ? [] : ['--only']),
    ...(only.paths === undefined ? [] : ['--image']),
  ].join(' and ');
  const paths = new Set(only.paths ?? []);
  return [
    `${flags} named ${named} of ${count(total, 'image')}; the other ${left} ${left === 1 ? 'was' : 'were'} not measured, and none of them converts.`,
    ...result.only.unmatched.map((unmatched) =>
      paths.has(unmatched)
        ? `--image ${unmatched} is not an image in the project, so nothing was converted for it.`
        : `--only ${unmatched} named no image in the project.`,
    ),
  ];
}

/**
 * The images a run may convert, from `--only` and `--image`, or null when every image may. Each
 * `--image` path is read from the current folder, as a person or a program wrote it.
 */
function onlyFor(
  options: Pick<OptimizeOptions, 'only' | 'images'>,
  root: string,
  upfly: UpflyCommand,
): { readonly only: OnlyImages | null } | Refusal {
  if (options.only === null && options.images === null) return { only: null };
  const paths: string[] = [];
  for (const written of options.images ?? []) {
    const path = projectPath(root, written);
    if (path === null) {
      return {
        code: EXIT_CODES.USAGE,
        message: `${written} is outside the project at ${root}. Name an image inside it, or name its project after the command: ${upfly} optimize <folder> --image <path>.`,
      };
    }
    paths.push(path);
  }
  return {
    only: {
      ...(options.images === null ? {} : { paths }),
      ...(options.only === null ? {} : { patterns: options.only }),
    },
  };
}

/**
 * A path as a person or a program wrote it, read from the current folder, POSIX-relative to the
 * project, or null when it is outside the project.
 *
 * @param root the project directory
 * @param written the path as given
 */
export function projectPath(root: string, written: string): string | null {
  const within = relative(root, resolve(written));
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return null;
  }
  return within.split(sep).join('/');
}

/** The project directory and its settings, or why the command cannot use them. */
export async function openProject(
  options: Pick<OptimizeOptions, 'dir' | 'noCodeConfig'>,
): Promise<{ readonly root: string; readonly settings: UpflyConfig } | Refusal> {
  const root = resolve(options.dir);
  if (!isDirectory(root)) {
    return { code: EXIT_CODES.USAGE, message: `${options.dir} is not a directory` };
  }
  const config = await loadConfig(root, { runCode: !options.noCodeConfig });
  if (config.kind === 'refused') {
    return {
      code: EXIT_CODES.ABORTED,
      reason: config.reason,
      message: config.message,
      file: config.file,
    };
  }
  if (config.kind === 'invalid') {
    return { code: EXIT_CODES.USAGE, message: `${config.file} ${config.message}` };
  }
  return { root, settings: config.kind === 'loaded' ? config.config : {} };
}

/** Runs the engine, turning each of its refusals into one the command reports. */
async function carryOut(
  options: OptimizeOptions,
  io: Io,
  root: string,
  settings: UpflyConfig,
  policy: PublicPolicy,
  only: OnlyImages | null,
): Promise<OptimizeProjectResult | Refusal> {
  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;
  const progress = progressReporter(io, 'optimize', options.json, options.apply);
  let uncommitted: Refusal | null = null;

  let result: OptimizeProjectResult;
  try {
    result = await optimizeProject({
      root,
      ...(publicDirs === null ? {} : { declared: { dirs: publicDirs, declared: true } }),
      format: options.format ?? settings.format ?? 'webp',
      publicPolicy: policy,
      apply: options.apply,
      ...(options.noUndo ? { undoable: false } : {}),
      extraIgnores: [...(settings.exclude ?? []), ...options.exclude],
      ...(only === null ? {} : { only }),
      onProgress: (event) => progress.update(event),
      // Decided on the finished plan, so that a commit that could not hold every file the
      // run writes stops the run before it writes any.
      ...(options.commit
        ? {
            beforeWrite: (plan: OptimizationPlan) => {
              uncommitted = uncommittable(root, plannedPaths(plan));
              return uncommitted === null;
            },
          }
        : {}),
    });
  } catch (error) {
    progress.clear();
    const refusal = await engineRefusal(error, root, upflyCommand(io.env, io.script));
    if (refusal === null) throw error;
    return refusal;
  }
  progress.clear();

  const { refusal } = result.optimize;
  const upfly = upflyCommand(io.env, io.script);
  if (refusal !== null) {
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'SERVING_ROOT_UNKNOWN',
      // The command prints no report, so the refusal says where the set-aside references are.
      // A folder that was named is not asked for again: the reason says what resolved there.
      message:
        publicDirs === null
          ? `${refusal.reason} Name it with --public <dir>, or publicDirs in the config file; use . for the project root. \`${upfly} audit\` lists the ${count(refusal.checkable - refusal.linked, 'reference')} that did not resolve, with the file and line of each.`
          : `${refusal.reason} \`${upfly} check\` lists the ${count(refusal.checkable - refusal.linked, 'reference')} with the file and line of each.`,
    };
  }
  return uncommitted ?? result;
}

/**
 * Why a run git would partly ignore wrote nothing, and what to do about it. When git ignores
 * a folder holding those files, as it does a site's build output, the advice is to leave the
 * folder out: run without `--commit`, the project's own pages would be rewritten to name
 * files only that folder holds.
 *
 * @param root the project directory, inside a git work tree
 * @param ignored the files git ignores, POSIX-relative to `root`
 */
export function ignoredByGit(root: string, ignored: readonly string[]): string {
  const folders = ignoredFolders(root, ignored);
  const flags = folders.map((folder) => `--exclude ${folder}`).join(' ');
  const advice =
    folders.length === 0
      ? 'Run without --commit, or change what git ignores.'
      : `If ${folders.length === 1 ? "that is a build's output, leave it" : "those are a build's output, leave them"} out with ${flags} and run again; otherwise change what git ignores.`;
  return `Git ignores ${count(ignored.length, 'file')} this run would write: ${some(ignored)}. One commit could not hold the whole run, so nothing was written. ${advice}`;
}

/**
 * Why one commit could not hold every file a run would write, asked before it writes any:
 * files git ignores, or files inside a submodule, which a commit of this repository holds only
 * as the commit it points at. Null when one commit can hold them all.
 *
 * @param root the project directory, inside a git work tree
 * @param paths every file the run would write or remove, POSIX-relative to `root`
 */
export function uncommittable(root: string, paths: readonly string[]): Refusal | null {
  // Asked first: git refuses to check the ignore rules for a path inside a submodule at all.
  const inside = pathsInSubmodules(root, paths);
  if (inside.length > 0) {
    const submodules = [...new Set(inside.map((entry) => entry.submodule))];
    const which =
      submodules.length === 1
        ? `the submodule ${submodules[0]}`
        : `the submodules ${submodules.join(', ')}`;
    const flags = submodules.map((folder) => `--exclude ${folder}/`).join(' ');
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'IN_SUBMODULE',
      message: `This run would write ${count(inside.length, 'file')} inside ${which}: ${some(inside.map((entry) => entry.path))}. A commit of this repository holds a submodule only as the commit it points at, so nothing was written. Leave ${submodules.length === 1 ? 'it' : 'them'} out with ${flags} and run again, or run without --commit.`,
    };
  }
  const ignored = ignoredPaths(root, paths);
  if (ignored.length === 0) return null;
  return {
    code: EXIT_CODES.ABORTED,
    reason: 'IGNORED_BY_GIT',
    message: ignoredByGit(root, ignored),
  };
}

/** Commits exactly the files the run wrote, and returns the commit's hash. */
function commitRun(
  root: string,
  manifest: Manifest,
  plan: OptimizationPlan,
  upfly: UpflyCommand,
): string | Refusal {
  try {
    return commitPaths(root, pathsTouched(manifest), commitMessage(manifest, plan));
  } catch (error) {
    return {
      code: EXIT_CODES.INTERNAL,
      reason: 'GIT_COMMIT_FAILED',
      message: `The run was applied, but git did not commit it (${firstLine(error)}). Its files are written: commit them yourself, or run \`${upfly} undo\` to put every file back.`,
    };
  }
}

/**
 * How a command that may write starts, before it reads the project. One that applies first
 * puts back a run made with --no-undo that was cut off part way, which changes files, and only
 * then asks git about the folder and refuses what a write must wait for: a run in progress, the
 * last run stopped part way, or what git does not allow. A dry run names the cut-off run instead.
 *
 * @param root the project directory
 * @param options the parsed command line
 * @param upfly how to name Upfly in a message
 * @returns git's state, any unfinished run and the notes to give, or the refusal
 */
export async function startRun(
  root: string,
  options: Pick<OptimizeOptions, 'apply' | 'dir' | 'commit' | 'allowDirty'>,
  upfly: UpflyCommand,
): Promise<
  | { readonly git: GitState; readonly unfinished: Refusal | null; readonly notes: string[] }
  | Refusal
> {
  const settled = options.apply ? await putBackCutOffRun(root) : { notes: [] };
  if ('code' in settled) return settled;
  const git = gitState(root);
  const unfinished = await unfinishedRun(root, upfly);
  if (options.apply) {
    const refusal = unfinished ?? gitRefusal(git, options, root, upfly);
    return refusal ?? { git, unfinished, notes: settled.notes };
  }
  // A record still being written belongs to a run in progress, which the lock names.
  const cutOff = unfinished?.reason === 'TRANSACTION_LOCKED' ? null : await cutOffRun(root);
  const said =
    cutOff === null
      ? []
      : [
          `A run made with --no-undo (${cutOff.runId}, started ${cutOff.startedAt}) stopped before it finished; the next command that writes puts it back first.`,
        ];
  return { git, unfinished, notes: said };
}

/**
 * Puts back a run made with --no-undo that was cut off part way, and clears what a finished one
 * left, before a command writes anything. Its note says what was put back.
 *
 * @param root the project directory
 * @returns the notes to give, or the refusal when the run could not be put back
 */
export async function putBackCutOffRun(
  root: string,
): Promise<{ readonly notes: string[] } | Refusal> {
  const cutOff = await cutOffRun(root);
  let putBack: Manifest | null;
  try {
    putBack = await settleNoUndoRun(createNodeFileStore(root));
  } catch (error) {
    if (!(error instanceof UpflyError)) throw error;
    if (error.code === 'TRANSACTION_FOREIGN_CHANGE') {
      const which = cutOff === null ? '' : ` (${cutOff.runId})`;
      return {
        code: EXIT_CODES.ABORTED,
        reason: error.code,
        message: `A run made with --no-undo${which} stopped before it finished, and Upfly puts such a run back before it writes anything else, but this one cannot be: ${error.message} To keep every file as it is now, delete ${NO_UNDO_DIRECTORY} and the backups that run kept in it, then run this again.`,
      };
    }
    if (error.code === 'TRANSACTION_LOCKED' || error.code === 'MANIFEST_VERSION_UNSUPPORTED') {
      return { code: EXIT_CODES.ABORTED, reason: error.code, message: error.message };
    }
    throw error;
  }
  if (putBack === null) return { notes: [] };
  const files = pathsTouched(putBack).length;
  return {
    notes: [
      `A run made with --no-undo (${putBack.runId}, started ${putBack.startedAt}) had stopped before it finished, so it was put back first: ${count(files, 'file')} as ${files === 1 ? 'it was' : 'they were'} before it.`,
    ],
  };
}

/** The record of a run made with --no-undo that stopped part way, or null. */
async function cutOffRun(root: string): Promise<Manifest | null> {
  try {
    const record = await readNoUndoRecord(createNodeFileStore(root));
    return record?.state === 'pending' ? record : null;
  } catch {
    return null;
  }
}

/**
 * A run in progress, or one that stopped part way, either of which a new write must wait
 * for. The engine refuses both as well; asking first says so before the project is read.
 */
export async function unfinishedRun(root: string, upfly: UpflyCommand): Promise<Refusal | null> {
  const store = createNodeFileStore(root);
  const holder = await readLockHolder(store);
  if (holder !== null && processIsAlive(holder.pid)) {
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'TRANSACTION_LOCKED',
      message: `Another Upfly run is in progress (run ${holder.runId}, process ${holder.pid}, started ${holder.startedAt}). Wait for it to finish, then run this again.`,
    };
  }
  // A lock file naming no run may be one another run is writing now; the engine refuses it
  // too, but only after reading and measuring the whole project.
  if (holder === null && (await store.hash(LOCK_PATH)) !== null) {
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'TRANSACTION_LOCKED',
      message: `${LOCK_PATH} exists but does not yet name a run, so another run may be starting at this moment. If no Upfly run is going, delete ${LOCK_PATH} and run this again.`,
    };
  }
  let manifest: Manifest | null = null;
  try {
    manifest = await readManifest(store);
  } catch {
    // A record this build cannot read is left for the engine's own check at write time.
  }
  if (manifest?.state !== 'pending') return null;
  return {
    code: EXIT_CODES.ABORTED,
    reason: 'TRANSACTION_INTERRUPTED',
    message: `The last run (${manifest.runId}, started ${manifest.startedAt}) stopped before it finished. Run \`${upfly} undo\` to put back every file it wrote, then run this again.`,
  };
}

/** Whether git lets this run write, and commit, in `root`. */
export function gitRefusal(
  git: GitState,
  options: Pick<OptimizeOptions, 'dir' | 'commit' | 'allowDirty'>,
  root: string,
  upfly: UpflyCommand,
): Refusal | null {
  if (git.kind !== 'repository' || !git.tracked) {
    const why = unprotected(git, options.dir);
    if (options.commit) {
      return {
        code: EXIT_CODES.USAGE,
        reason: 'NO_REPOSITORY',
        message: `--commit needs a git repository that tracks this folder, and ${why}. Run without --commit.`,
      };
    }
    if (options.allowDirty) return null;
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'NO_REPOSITORY',
      message: `${capitalise(why)}, so git could not put these files back. \`${upfly} undo\` can: to write without git, add --allow-dirty.`,
    };
  }

  const changed = git.changed.filter((path) => !ownPath(path));
  if (changed.length > 0 && !options.allowDirty) {
    return {
      code: EXIT_CODES.ABORTED,
      reason: 'UNCOMMITTED_CHANGES',
      message: `Uncommitted changes in ${count(changed.length, 'file')} under this folder${inRepository(git)}: ${some(changed)}. Commit or stash them first, so that this run's changes are the only ones to review, or add --allow-dirty to write anyway.`,
    };
  }

  return options.commit ? commitRefusal(root) : null;
}

/**
 * Why git could not make the run's commit, asked before anything is written: no identity to
 * commit as, or a merge, a rebase, a cherry-pick or a revert the commit would become part of.
 * `commitPaths` refuses the second again when it commits, as the last guard.
 */
function commitRefusal(root: string): Refusal | null {
  const identity = identityProblem(root);
  if (identity !== null) {
    return {
      code: EXIT_CODES.USAGE,
      reason: 'NO_GIT_IDENTITY',
      message: `git has no name and email to commit with (${identity}). Set user.name and user.email with git config, or run without --commit.`,
    };
  }
  const started = operationInProgress(root);
  if (started === null) return null;
  return {
    code: EXIT_CODES.ABORTED,
    reason: 'GIT_OPERATION_IN_PROGRESS',
    message: `This repository is part way through a ${started}, and a commit made now would become part of it, so nothing was written. Finish it with \`git ${started} --continue\` or stop it with \`git ${started} --abort\`, then run this again, or run without --commit.`,
  };
}

/** Why git offers this folder no protection, as a clause. */
function unprotected(git: GitState, dir: string): string {
  switch (git.kind) {
    case 'no-git':
      return 'git was not found on this computer';
    case 'not-a-repository':
      return `${dir} is not in a git repository`;
    case 'repository':
      return `the git repository at ${git.top} tracks no file in this folder`;
  }
}

/** The engine's own refusals, as exit 3 with what to do; null for anything else. */
export async function engineRefusal(
  error: unknown,
  root: string,
  upfly: UpflyCommand,
): Promise<Refusal | null> {
  if (!(error instanceof UpflyError)) return null;
  switch (error.code) {
    case 'TRANSACTION_LOCKED':
      return { code: EXIT_CODES.ABORTED, reason: error.code, message: error.message };
    case 'TRANSACTION_INTERRUPTED': {
      // The last run's record is the one undo follows; a run made with --no-undo is put back
      // by the next command that writes, as its own message says.
      const last = (await unfinishedRun(root, upfly))?.reason === 'TRANSACTION_INTERRUPTED';
      return {
        code: EXIT_CODES.ABORTED,
        reason: error.code,
        message: last
          ? `${error.message} Run \`${upfly} undo\`, then run this again.`
          : error.message,
      };
    }
    case 'TRANSACTION_PLAN_INVALID':
    case 'TRANSACTION_FOREIGN_CHANGE': {
      // Either can happen before the first write or part way through; only part way
      // through is there a pending record for undo to follow.
      const stopped = (await unfinishedRun(root, upfly))?.reason === 'TRANSACTION_INTERRUPTED';
      return {
        code: EXIT_CODES.ABORTED,
        reason: error.code,
        message: stopped
          ? `${error.message} The run stopped part way: \`${upfly} undo\` puts back every file it wrote.`
          : error.message,
      };
    }
    default:
      return null;
  }
}

/** Every project path the plan would create, rewrite or remove. */
function plannedPaths(plan: OptimizationPlan): string[] {
  const paths = new Set<string>();
  for (const conversion of plan.conversions) {
    paths.add(conversion.target);
    if (conversion.replacesOriginal) paths.add(conversion.asset);
  }
  for (const rewrite of plan.rewrites) paths.add(rewrite.file);
  return [...paths].sort();
}

/** A path inside Upfly's own folder, which the run writes and git is told to ignore. */
function ownPath(path: string): boolean {
  return path === UPFLY_DIRECTORY || path.startsWith(`${UPFLY_DIRECTORY}/`);
}

function commitMessage(manifest: Manifest, plan: OptimizationPlan): string {
  const { created, changed, removed } = writtenByKind(manifest);
  const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
  const saved = plan.conversions.reduce((sum, conversion) => sum + conversion.savedBytes, 0);
  const lines = [
    'Optimize images with Upfly',
    '',
    `Converted ${count(created.length, 'image')}, ${formatBytes(saved)} smaller in total, and updated ${count(references, 'reference')} in ${count(changed.length, 'file')}.`,
  ];
  if (removed.length > 0) {
    lines.push(`Removed ${count(removed.length, 'original')} whose references all moved.`);
  }
  lines.push('', `${RUN_TRAILER}: ${manifest.runId}`);
  return `${lines.join('\n')}\n`;
}

interface Outcome {
  readonly policy: PublicPolicy;
  readonly git: GitState;
  readonly commit: string | null;
  /** Whether an earlier run stopped part way, which `undo` has to finish first. */
  readonly unfinished: boolean;
  readonly format: 'webp' | 'avif';
  readonly notes: readonly string[];
  /** The notes that say what `--apply` would refuse, with each reason. */
  readonly applyRefusals: readonly ApplyRefusal[];
  /** When the run started, for the report file's first lines. */
  readonly started: Date;
}

/** Things worth knowing before running with `--apply`, said on a dry run. */
export function notes(
  options: Pick<OptimizeOptions, 'apply' | 'dir'>,
  git: GitState,
  unfinished: Refusal | null,
  upfly: UpflyCommand,
): string[] {
  return codedNotes(options, git, unfinished, upfly).map((said) => said.note);
}

/** A dry run's note that says what `--apply` would refuse, and the reason it would give. */
export interface ApplyRefusal {
  readonly reason: RefusalReason;
  readonly note: string;
}

/**
 * Each of a dry run's notes that says what `--apply` would refuse, with the reason its error
 * line would give, so a program can tell those notes from the rest without reading them.
 */
export function applyRefusals(
  options: Pick<OptimizeOptions, 'apply' | 'dir'>,
  git: GitState,
  unfinished: Refusal | null,
  upfly: UpflyCommand,
): ApplyRefusal[] {
  return codedNotes(options, git, unfinished, upfly).flatMap(({ note, reason }) =>
    reason === null ? [] : [{ reason, note }],
  );
}

/** The dry run's notes in order, each with the reason `--apply` would refuse for, or null. */
function codedNotes(
  options: Pick<OptimizeOptions, 'apply' | 'dir'>,
  git: GitState,
  unfinished: Refusal | null,
  upfly: UpflyCommand,
): { readonly note: string; readonly reason: RefusalReason | null }[] {
  if (options.apply) return [];
  const said: { note: string; reason: RefusalReason | null }[] = [];
  if (unfinished !== null)
    said.push({ note: unfinished.message, reason: unfinished.reason ?? null });
  const inside = insideRepository(git);
  if (inside !== null) said.push({ note: inside, reason: null });
  if (git.kind === 'repository' && git.tracked) {
    const changed = git.changed.filter((path) => !ownPath(path));
    if (changed.length > 0) {
      said.push({
        note: `Uncommitted changes in ${count(changed.length, 'file')} under this folder: --apply refuses to write until they are committed, unless run with --allow-dirty.`,
        reason: 'UNCOMMITTED_CHANGES',
      });
    }
  } else {
    said.push({
      note: `${capitalise(unprotected(git, options.dir))}: --apply writes here only with --allow-dirty, and \`${upfly} undo\` is then the way back.`,
      reason: 'NO_REPOSITORY',
    });
  }
  return said;
}

function write(options: OptimizeOptions, io: Io, result: OptimizeProjectResult, outcome: Outcome) {
  const { pipeline, optimize: run } = result;
  const report = buildReport({
    aliases: pipeline.aliases,
    graph: pipeline.graph,
    audit: pipeline.audit,
    discovery: pipeline.discovery,
    sweep: pipeline.sweep,
    servingRoots: pipeline.servingRoots,
    ...(pipeline.probes === undefined ? {} : { probes: pipeline.probes }),
    declined: run.plan.declined,
    includeDeclined: options.includeDeclined,
    includeDiscarded: options.includeDiscarded,
    includeUnusedVectors: options.includeUnusedSvg,
  });
  const repository =
    outcome.git.kind === 'repository' ? { top: outcome.git.top, path: outcome.git.prefix } : null;

  if (options.json) {
    for (const diagnostic of pipeline.diagnostics) {
      emit(io, { type: 'diagnostic', command: 'optimize', source: 'image', ...diagnostic });
    }
    for (const diagnostic of pipeline.scanDiagnostics) {
      emit(io, { type: 'diagnostic', command: 'optimize', source: 'parser', ...diagnostic });
    }
    emit(io, {
      type: 'result',
      command: 'optimize',
      exitCode: EXIT_CODES.OK,
      apply: options.apply,
      plan: {
        ...run.plan,
        conversions: withPublicDir(run.plan.conversions, pipeline.servingRoots),
      },
      run:
        run.manifest === null
          ? null
          : {
              id: run.manifest.runId,
              ...writtenByKind(run.manifest),
              undoable: !options.noUndo,
            },
      commit: outcome.commit,
      repository,
      only: result.only ?? null,
      notes: outcome.notes,
      applyRefusals: outcome.applyRefusals,
      report,
    });
    return;
  }

  const nothingToDo = run.plan.conversions.length === 0 && run.plan.rewrites.length === 0;
  const upfly = upflyCommand(io.env, io.script);
  let next: NextStep | null = null;
  if (options.apply) {
    next = run.manifest === null ? null : nextAfterRun(outcome.commit, upfly, !options.noUndo);
  } else if (!nothingToDo) {
    next = nextAfterPlan(
      'optimize',
      options.dir,
      planFlags(options),
      outcome.git,
      outcome.unfinished,
      upfly,
    );
  }
  const summary = (file: ReportFile) =>
    optimizeSummary({
      plan: run.plan,
      graph: pipeline.graph,
      probes: pipeline.probes,
      only: result.only?.images ?? null,
      format: outcome.format,
      policy: outcome.policy,
      apply: options.apply,
      manifest: run.manifest,
      commit: outcome.commit,
      git: outcome.git,
      notes: outcome.notes,
      file,
      next,
      upfly,
      report,
      servingRoots: pipeline.servingRoots,
    });
  const text = renderFile(summary({ written: reportPath('optimize') }), {
    when: localTime(outcome.started),
    folder: pipeline.graph.root,
    options: typedOptions(options),
  });
  // A run made with --no-undo leaves no folder of its own to keep a copy in.
  const runDir = options.noUndo ? null : (run.manifest?.runDir ?? null);
  const file = writeReport(pipeline.graph.root, 'optimize', text, runDir);
  printRun(io, options, summary(file), text, file);
}

/** The flags that shaped the plan, so that `--apply` writes the same plan. */
function planFlags(options: OptimizeOptions): string[] {
  return [
    ...(options.policy === 'keep-original' ? ['--keep-originals'] : []),
    ...(options.policy === 'replace' ? ['--replace'] : []),
    ...(options.format === null ? [] : ['--format', options.format]),
    ...scopeWords({ ...options, dir: '.' }),
    ...(options.only ?? []).flatMap((pattern) => ['--only', pattern]),
    ...(options.images ?? []).flatMap((path) => ['--image', path]),
  ];
}

/** `, in the git repository at <top>` when the repository is larger than the project. */
function inRepository(git: GitState): string {
  return git.kind === 'repository' && git.prefix !== ''
    ? ` in the git repository at ${git.top}, where this folder is ${git.prefix}`
    : '';
}

/** Up to three of the paths, so the reader knows which, and how many more there are. */
export function some(paths: readonly string[]): string {
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : '';
  return `${paths.slice(0, 3).join(', ')}${more}`;
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
