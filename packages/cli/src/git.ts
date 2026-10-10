/**
 * The git operations `optimize` and `undo` need. Every call passes an argument array to
 * `spawnSync`, never a command string, so no path or message is ever read by a shell.
 * Paths travel on stdin, which also keeps a run with thousands of files under Windows'
 * limit on the length of a command line, and git reads them literally, so a name holding
 * `*` or `[` never matches a second file.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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
 * What the repository is part way through, in a word: `merge`, `rebase`, `cherry-pick` or
 * `revert`; null when it is none of them. A commit made now would become part of it, so a run
 * that commits asks this before it writes, by the files `commitPaths` reads to refuse.
 *
 * @param root the project directory, inside a git work tree
 */
export function operationInProgress(root: string): string | null {
  return groundFor(root).started;
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
 * @throws when git refuses, and when the repository is part way through a merge, a rebase,
 * a cherry-pick or a revert; the message carries the reason
 */
export function commitPaths(
  root: string,
  paths: readonly string[],
  message: string,
  moved: readonly { readonly from: string; readonly to: string }[] = [],
): string {
  const ground = groundFor(root);
  if (ground.started !== null) {
    throw new Error(
      `this repository is part way through a ${ground.started}, so nothing was committed`,
    );
  }
  // The commit is made from an index of its own, HEAD with these paths as they are on disk,
  // so nothing staged for another path joins it. `git commit --only` makes the same commit
  // but gives a path new to HEAD the mode on disk, and Windows keeps no executable bit there.
  const folder = mkdtempSync(join(tmpdir(), 'upfly-commit-'));
  const own = { GIT_INDEX_FILE: join(folder, 'index') };
  let list: string;
  let executable: string[];
  try {
    const recorded = headInto(root, ground, paths, own);
    const named = paths.map((path) => recorded.get(path) ?? path);
    list = nulList(named);
    executable = executableAfterMove(
      root,
      moved.map((move) => ({ from: recorded.get(move.from) ?? move.from, to: move.to })),
    );
    stage(root, list, executable, own);
    mustHoldEvery(root, ground.prefix, named, own);
    must(git(root, ['commit', '--quiet', '-m', message], undefined, { env: own }), 'commit');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  // The project's own index then holds these paths as committed, as after any commit.
  stage(root, list, executable);
  return must(git(root, ['rev-parse', 'HEAD']), 'rev-parse').stdout.trim();
}

/** What the repository is part way through, by the file git itself reads to decide. */
const PART_WAY_THROUGH: readonly (readonly [string, string])[] = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
];

interface CommitGround {
  /** Where the project sits inside the repository: POSIX, ending in `/`, or empty. */
  readonly prefix: string;
  /** The project's own index, wherever git keeps it. */
  readonly index: string;
  /**
   * What the repository is part way through, in a word, or null when it is nothing. A plain
   * `git commit` made in one of those states ends it: a merge would take the other branch as
   * a second parent and carry the user's half-finished resolution into the run's commit. Git
   * refused a commit of named paths in every one of them.
   */
  readonly started: string | null;
  /** Whether HEAD names a commit; a branch can have none yet. */
  readonly head: boolean;
}

/** What a commit here needs to know, in one call: each part is a question for `rev-parse`. */
function groundFor(root: string): CommitGround {
  const named = ['index', ...PART_WAY_THROUGH.map(([file]) => file)];
  // `--quiet --verify HEAD` comes last, so it prints its hash after the paths, or prints
  // nothing and exits 1 where the branch has no commit yet. Each answer is one line, and the
  // prefix an empty one at the repository's top.
  const asked = [
    '--show-prefix',
    ...named.flatMap((file) => ['--git-path', file]),
    '--quiet',
    '--verify',
    'HEAD',
  ];
  const result = git(root, ['rev-parse', ...asked]);
  const [prefix = '', ...lines] = (result.status === 1 ? result : must(result, 'rev-parse')).stdout
    .replace(/\n$/, '')
    .split('\n');
  const at = PART_WAY_THROUGH.findIndex((_, index) => inGitFolder(root, lines[index + 1]));
  return {
    prefix,
    index: resolve(root, lines[0]?.trim() ?? ''),
    started: at === -1 ? null : (PART_WAY_THROUGH[at]?.[1] ?? null),
    head: lines.length > named.length,
  };
}

/** Whether the file `line` names is there, where an empty line means git named none. */
function inGitFolder(root: string, line: string | undefined): boolean {
  const named = line?.trim() ?? '';
  return named !== '' && existsSync(resolve(root, named));
}

/**
 * Fills the commit's own index with HEAD, keeping the size and time the project's index
 * recorded for every file whose content HEAD holds, except the files in `paths`.
 *
 * `git commit` refreshes its index first, and for an entry with no size recorded git has to
 * read the file to learn whether it changed, so an index straight from `read-tree` costs a
 * read of every tracked file: seconds on a large repository. A copy of the project's index
 * carries those sizes and times, and `read-tree -m` keeps them for every entry whose content
 * already matches. What is left to read is each file the user had staged differently, and
 * each file in `paths`.
 *
 * Returns the name git records for each of `paths` it holds only in another letter case.
 */
function headInto(
  root: string,
  ground: CommitGround,
  paths: readonly string[],
  own: { readonly GIT_INDEX_FILE: string },
): ReadonlyMap<string, string> {
  // A branch with no commit starts from an empty index, which is the whole of its first commit.
  if (!ground.head) return new Map();
  try {
    copyFileSync(ground.index, own.GIT_INDEX_FILE);
  } catch {
    // No index to copy, so there is nothing to keep: reading HEAD afresh below is enough.
  }
  // `-m` refuses an index holding an unresolved merge, which a conflicted `git stash pop`
  // leaves behind. Then the sizes cannot be kept and the commit is the slow one it was.
  if (git(root, ['read-tree', '-m', 'HEAD'], undefined, { env: own }).status !== 0) {
    must(git(root, ['read-tree', 'HEAD'], undefined, { env: own }), 'read-tree');
  }
  // The run's own files are never taken from that record. Git trusts a recorded size and time
  // unless the index is no newer than them, and on Linux and macOS a copy carries the moment it
  // was made, so a file rewritten at its size within the second git recorded it would go into
  // the commit as it was. `--index-info` records each again with no size or time, which makes
  // `git add` read it, and names paths from the repository's top, as `ls-files --full-name`
  // prints them.
  const listed = must(
    git(root, ['ls-files', '--stage', '-z', '--full-name'], undefined, { env: own }),
    'ls-files',
  ).stdout;
  // Each entry is `<mode> <object> <stage>\t<path>`, the form `--index-info` reads back.
  const entries = listed.split('\0').filter((entry) => entry !== '');
  const recorded = recordedNames(root, ground.prefix, paths, entries.map(nameOf));
  const written = new Set(paths.map((path) => ground.prefix + (recorded.get(path) ?? path)));
  const runs = entries.filter((entry) => written.has(nameOf(entry)));
  if (runs.length > 0) {
    must(
      git(root, ['update-index', '-z', '--index-info'], nulList(runs), { env: own }),
      'update-index',
    );
  }
  return recorded;
}

/**
 * The name git records for each of `paths` it holds only in another letter case, where git
 * folds case as the filesystem does. `git add` passes over a file renamed so outside git
 * without a word, as it matches the new name against the old one in the index; under the name
 * git records, the run's change goes into the commit and no rename the person never committed
 * goes with it.
 *
 * @param names every path the index records, from the repository's top
 */
function recordedNames(
  root: string,
  prefix: string,
  paths: readonly string[],
  names: readonly string[],
): ReadonlyMap<string, string> {
  const exact = new Set(names);
  const unrecorded = paths.filter((path) => !exact.has(prefix + path));
  if (unrecorded.length === 0) return new Map();
  const folded = new Map<string, string[]>();
  for (const name of names) {
    const key = name.toLowerCase();
    folded.set(key, [...(folded.get(key) ?? []), name]);
  }
  const recorded = new Map<string, string>();
  for (const path of unrecorded) {
    const [only, ...more] = folded.get((prefix + path).toLowerCase()) ?? [];
    // Two names for one file on disk leave nothing to choose by; the check before the commit
    // then refuses it.
    if (only?.startsWith(prefix) && more.length === 0)
      recorded.set(path, only.slice(prefix.length));
  }
  const folds =
    git(root, ['config', '--bool', '--get', 'core.ignorecase']).stdout.trim() === 'true';
  return recorded.size > 0 && folds ? recorded : new Map();
}

/**
 * Throws unless the commit's own index holds each of `paths` as it is on disk, and holds no
 * path that is gone from it. `git add` passes over some paths without a word, such as a file
 * in a repository nested inside this one, and a commit made then would leave that file out.
 */
function mustHoldEvery(
  root: string,
  prefix: string,
  paths: readonly string[],
  own: { readonly GIT_INDEX_FILE: string },
): void {
  const listed = must(
    git(root, ['ls-files', '--stage', '-z', '--full-name'], undefined, { env: own }),
    'ls-files',
  ).stdout;
  const objects = new Map(
    listed
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => [nameOf(entry), entry.split(' ')[1]]),
  );
  const present = paths.filter((path) => existsSync(join(root, path)));
  const kept = new Set(present);
  // `hash-object` applies the same filters `git add` did, so both name one object for a file.
  // It reads these paths from the repository's top, which is where it runs from.
  const hashed =
    present.length === 0
      ? []
      : must(
          git(
            root,
            ['hash-object', '--stdin-paths'],
            `${present.map((path) => quoted(prefix + path)).join('\n')}\n`,
          ),
          'hash-object',
        ).stdout.split('\n');
  const leftOut = [
    ...present.filter((path, index) => objects.get(prefix + path) !== hashed[index]),
    ...paths.filter((path) => !kept.has(path) && objects.has(prefix + path)),
  ].sort(compare);
  if (leftOut.length > 0) {
    const named = leftOut.slice(0, 3).join(', ');
    const rest = leftOut.length > 3 ? ` and ${leftOut.length - 3} more` : '';
    throw new Error(`git would leave ${named}${rest} out of the commit, so nothing was committed`);
  }
}

/**
 * A path as `--stdin-paths` reads it: one per line, so a path holding a line break, or one
 * that starts with a quotation mark, goes in quotes with C-style escapes.
 */
function quoted(path: string): string {
  if (!/[\n\r]/.test(path) && !path.startsWith('"')) return path;
  const escaped = path
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
  return `"${escaped}"`;
}

/** The path of an index entry as `ls-files --stage` prints it: `<mode> <object> <stage>\t<path>`. */
function nameOf(entry: string): string {
  return entry.slice(entry.indexOf('\t') + 1);
}

/**
 * Which of `paths` sit inside a submodule, each with the submodule's folder. A commit of this
 * repository holds a submodule only as the commit it points at, so `git add` refuses a path
 * inside one.
 *
 * @param root the project directory, inside a git work tree
 * @param paths POSIX paths relative to `root`
 * @throws when git refuses; the message carries git's own reason
 */
export function pathsInSubmodules(
  root: string,
  paths: readonly string[],
): { readonly path: string; readonly submodule: string }[] {
  if (paths.length === 0) return [];
  // From the project folder, and a submodule's entry has the mode 160000.
  const submodules = must(git(root, ['ls-files', '--stage', '-z']), 'ls-files')
    .stdout.split('\0')
    .filter((entry) => entry.startsWith('160000 '))
    .map(nameOf);
  return paths
    .flatMap((path) => {
      const submodule = submodules.find((folder) => path.startsWith(`${folder}/`));
      return submodule === undefined ? [] : [{ path, submodule }];
    })
    .sort((a, b) => compare(a.path, b.path));
}

/** Adds the paths in `list` to an index: the one `env` names, or else the project's own. */
function stage(
  root: string,
  list: string,
  executable: readonly string[],
  env: Readonly<Record<string, string>> = {},
): void {
  // A plain `git add` of a tracked file inside a folder git ignores adds it, then exits 1 for
  // the ignore rule. Each file the run writes that git does not track was checked against the
  // ignore rules before anything was written, so `--force` adds only what the run wrote.
  must(
    git(root, ['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], list, { env }),
    'add',
  );
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
  // Git gives its reason on the standard error, among warnings and hints that are not the
  // reason, but `commit` reports "nothing to commit" on its standard output, after the branch's
  // name, so that reason is the output's last line.
  const reason = firstLine(withoutAdvice(result.stderr)) || lastLine(result.stdout);
  throw new Error(`git ${step} failed${reason === '' ? '' : `: ${reason}`}`);
}

/** Git's text without the lines it marks as a warning or a hint. */
function withoutAdvice(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('warning: ') && !line.startsWith('hint: '))
    .join('\n');
}

function nulList(paths: readonly string[]): string {
  return `${paths.join('\0')}\0`;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
