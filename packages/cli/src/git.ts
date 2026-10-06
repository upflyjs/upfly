/**
 * The git operations `optimize` and `undo` need. Every call passes an argument array to
 * `spawnSync`, never a command string, so no path or message is ever read by a shell.
 * Paths travel on stdin, which also keeps a run with thousands of files under Windows'
 * limit on the length of a command line, and git reads them literally, so a name holding
 * `*` or `[` never matches a second file.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export type GitState =
  | { readonly kind: 'no-git' }
  | { readonly kind: 'not-a-repository' }
  | {
      readonly kind: 'repository';
      /** The repository's top folder, as an absolute path in the platform's spelling. */
      readonly top: string;
      /** Where the project sits inside the repository: POSIX, ending in `/`, or empty. */
      readonly prefix: string;
      /** Whether the repository tracks any file under the project. */
      readonly tracked: boolean;
      /** Paths under the project with changes, untracked files included, relative to it. */
      readonly changed: readonly string[];
    };

/** The commit message line that names the run a commit holds, so `undo` can find it. */
export const RUN_TRAILER = 'Upfly-Run';

/**
 * What a run without `--apply` says when the project is a folder of a larger repository,
 * since `--commit` commits in that repository; null when it is not.
 *
 * @param git the project's git state
 */
export function insideRepository(git: GitState): string | null {
  return git.kind === 'repository' && git.prefix !== ''
    ? `This folder is ${git.prefix} in the git repository at ${git.top}. --apply checks, and --commit commits, only the files under it.`
    : null;
}

/**
 * Whether `root` is inside a git work tree and, if so, what git says about the part of it
 * under `root`. Changes elsewhere in the repository are not looked at.
 *
 * @param root the project directory
 * @throws when git fails in a way other than finding no repository
 */
export function gitState(root: string): GitState {
  const where = git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (where.missing) return { kind: 'no-git' };
  if (where.status !== 0) return { kind: 'not-a-repository' };
  const [top = '', prefix = ''] = where.stdout.split('\n');

  const status = must(
    git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      '.',
    ]),
    'status',
  );
  // Porcelain paths are relative to the repository's top, wherever git runs.
  const changed = status.stdout
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
    .sort(compare);
  const tracked = must(git(root, ['ls-files', '-z', '--', '.']), 'ls-files').stdout.length > 0;

  return { kind: 'repository', top: resolve(top), prefix, tracked, changed };
}

export type Changes =
  | { readonly kind: 'no-git' }
  | { readonly kind: 'not-a-repository' }
  /** Git could not find a commit shared by the ref and the current one; its own first line. */
  | { readonly kind: 'unknown-ref'; readonly detail: string }
  | {
      readonly kind: 'changes';
      /** Every path under the project the change added, modified or deleted, relative to it. */
      readonly paths: readonly string[];
      /** The paths among them that the change deleted. */
      readonly deleted: readonly string[];
    };

/**
 * The files under `root` a change touched: since the last commit when `against` is null, and
 * otherwise since the commit `against` and the current one last shared, working tree
 * included, so a branch is measured by its own commits and not by what its base gained since.
 * Untracked files count as added.
 *
 * @param root the project directory
 * @param against a branch, tag or commit, or null for the uncommitted changes
 * @throws when git fails in a way other than finding no repository or no such ref
 */
export function changedFiles(root: string, against: string | null): Changes {
  const where = git(root, ['rev-parse', '--show-prefix']);
  if (where.missing) return { kind: 'no-git' };
  if (where.status !== 0) return { kind: 'not-a-repository' };
  const prefix = where.stdout.split('\n')[0] ?? '';

  const found = against === null ? uncommittedChanges(root, prefix) : changesSince(root, against);
  if (found.kind !== 'changes') return found;
  return {
    kind: 'changes',
    paths: [...found.paths].sort(compare),
    deleted: [...found.deleted].sort(compare),
  };
}

type Found =
  | Extract<Changes, { kind: 'unknown-ref' }>
  | { readonly kind: 'changes'; readonly paths: Set<string>; readonly deleted: Set<string> };

/** The files `git status` lists under `root`, from where the repository's top is `prefix`. */
function uncommittedChanges(root: string, prefix: string): Found {
  const status = must(
    git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      '.',
    ]),
    'status',
  );
  const paths = new Set<string>();
  const deleted = new Set<string>();
  // Porcelain paths are relative to the repository's top, wherever git runs.
  for (const entry of status.stdout.split('\0').filter((line) => line.length > 3)) {
    const named = entry.slice(3);
    const path = named.startsWith(prefix) ? named.slice(prefix.length) : named;
    paths.add(path);
    if (entry[0] === 'D' || entry[1] === 'D') deleted.add(path);
  }
  return { kind: 'changes', paths, deleted };
}

/** The files under `root` that differ from where `against` and `HEAD` last shared history. */
function changesSince(root: string, against: string): Found {
  const base = git(root, ['merge-base', against, 'HEAD']);
  if (base.status !== 0) {
    return {
      kind: 'unknown-ref',
      detail: firstLine(base.stderr) || 'it shares no history with the current commit',
    };
  }
  // `--relative` names paths from the project folder and leaves out the rest of the repository.
  const diff = must(
    git(root, [
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      '--relative',
      base.stdout.trim(),
      '--',
      '.',
    ]),
    'diff',
  );
  const paths = new Set<string>();
  const deleted = new Set<string>();
  const fields = diff.stdout.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index + 1] ?? '';
    if (path === '') continue;
    paths.add(path);
    if (fields[index]?.startsWith('D')) deleted.add(path);
  }
  const untracked = must(
    git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']),
    'ls-files',
  );
  for (const path of untracked.stdout.split('\0')) if (path !== '') paths.add(path);
  return { kind: 'changes', paths, deleted };
}

/**
 * Which of `paths` git would refuse to add because an ignore rule covers them. A tracked
 * file is never among them: ignore rules do not apply to it.
 *
 * @param root the project directory, inside a git work tree
 * @param paths POSIX paths relative to `root`, which need not exist yet
 * @throws when git refuses; the message carries git's own reason
 */
export function ignoredPaths(root: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  // `check-ignore` takes plain paths and rejects the literal-pathspec setting.
  const result = git(root, ['check-ignore', '--stdin', '-z'], nulList(paths), { literal: false });
  // Exit 1 is git's answer "none of them".
  if (result.status === 1) return [];
  return must(result, 'check-ignore')
    .stdout.split('\0')
    .filter((path) => path !== '')
    .sort(compare);
}

/**
 * The topmost folders git ignores that hold any of `paths`, each ending in `/` as
 * `--exclude` takes it: the folder a site's build writes into, when git ignores it. A path
 * ignored only by a rule on its own name, such as `*.webp`, gives none.
 *
 * @param root the project directory, inside a git work tree
 * @param paths POSIX paths relative to `root`, which need not exist yet
 * @throws when git refuses; the message carries git's own reason
 */
export function ignoredFolders(root: string, paths: readonly string[]): string[] {
  const holding = (path: string) =>
    path
      .split('/')
      .slice(0, -1)
      .map((_, depth, parts) => `${parts.slice(0, depth + 1).join('/')}/`);
  const ignored = new Set(ignoredPaths(root, [...new Set(paths.flatMap(holding))]));
  const topmost = new Set(
    paths.flatMap((path) => holding(path).find((folder) => ignored.has(folder)) ?? []),
  );
  return [...topmost].sort(compare);
}

/**
 * Why git cannot make a commit here, in git's own first line, or null when it knows a name
 * and an email to commit as.
 *
 * @param root the project directory, inside a git work tree
 */
export function identityProblem(root: string): string | null {
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const result = git(root, ['var', variable]);
    if (result.status !== 0) return firstLine(result.stderr) || `git var ${variable} failed`;
  }
  return null;
}

/**
 * Commits exactly `paths`, as they are on disk, and returns the new commit's hash. A path
 * that no longer exists is committed as a deletion. Changes staged for any other path stay
 * staged and out of the commit. A moved file keeps the executable mark its old path had.
 *
 * @param root the project directory, inside a git work tree
 * @param paths POSIX paths relative to `root`
 * @param message the commit message
 * @param moved the files among `paths` that moved, each committed at `to` with the mode
 * `from` has in the index
 * @throws when git refuses; the message carries git's own reason
 */
export function commitPaths(
  root: string,
  paths: readonly string[],
  message: string,
  moved: readonly { readonly from: string; readonly to: string }[] = [],
): string {
  const list = nulList(paths);
  const executable = executableAfterMove(root, moved);
  // The commit is made from an index of its own, HEAD with these paths as they are on disk,
  // so nothing staged for another path joins it. `git commit --only` makes the same commit
  // but gives a path new to HEAD the mode on disk, and Windows keeps no executable bit there.
  const folder = mkdtempSync(join(tmpdir(), 'upfly-commit-'));
  const own = { GIT_INDEX_FILE: join(folder, 'index') };
  try {
    must(git(root, ['read-tree', 'HEAD'], undefined, { env: own }), 'read-tree');
    stage(root, list, executable, own);
    must(git(root, ['commit', '--quiet', '-m', message], undefined, { env: own }), 'commit');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  // The project's own index then holds these paths as committed, as after any commit.
  stage(root, list, executable);
  return must(git(root, ['rev-parse', 'HEAD']), 'rev-parse').stdout.trim();
}

/** Adds the paths in `list` to an index: the one `env` names, or else the project's own. */
function stage(
  root: string,
  list: string,
  executable: readonly string[],
  env: Readonly<Record<string, string>> = {},
): void {
  must(git(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], list, { env }), 'add');
  if (executable.length === 0) return;
  must(
    git(root, ['update-index', '--chmod=+x', '-z', '--stdin'], nulList(executable), { env }),
    'update-index',
  );
}

/** Where each moved file goes whose old path the index marks executable. */
function executableAfterMove(
  root: string,
  moved: readonly { readonly from: string; readonly to: string }[],
): string[] {
  if (moved.length === 0) return [];
  // `ls-files` reads no list of paths from stdin, and a long list would not fit on a command
  // line, so it lists the project's whole index: `<mode> <object> <stage>\t<path>` per file.
  const staged = must(git(root, ['ls-files', '--stage', '-z']), 'ls-files').stdout;
  const marked = new Set(
    staged
      .split('\0')
      .filter((entry) => entry.startsWith('100755 '))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1)),
  );
  return moved.filter((move) => marked.has(move.from)).map((move) => move.to);
}

/**
 * The newest commit whose message names the run `runId` on a `Upfly-Run:` line, or null
 * when there is none or no history to search.
 *
 * @param root the project directory
 * @param runId the run to look for
 */
export function commitForRun(root: string, runId: string): string | null {
  const result = git(root, [
    'log',
    '-n',
    '1',
    '--format=%H',
    '-F',
    `--grep=${RUN_TRAILER}: ${runId}`,
  ]);
  if (result.status !== 0) return null;
  const hash = result.stdout.trim();
  return hash === '' ? null : hash;
}

interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Git itself could not be started. */
  readonly missing: boolean;
}

interface GitOptions {
  /** Whether git reads paths literally, never as patterns; true unless a command rejects it. */
  readonly literal?: boolean;
  /** More environment for the call, such as the index it works on. */
  readonly env?: Readonly<Record<string, string>>;
}

function git(
  root: string,
  args: readonly string[],
  input?: string,
  options: GitOptions = {},
): GitResult {
  const literal = options.literal ?? true;
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...(literal ? { GIT_LITERAL_PATHSPECS: '1' } : {}), ...options.env },
    ...(input === undefined ? {} : { input }),
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    missing:
      result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOENT',
  };
}

function must(result: GitResult, step: string): GitResult {
  if (result.status === 0) return result;
  const reason = firstLine(result.stderr);
  throw new Error(`git ${step} failed${reason === '' ? '' : `: ${reason}`}`);
}

function nulList(paths: readonly string[]): string {
  return `${paths.join('\0')}\0`;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
