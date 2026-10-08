import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUN_TRAILER,
  commitForRun,
  commitPaths,
  gitState,
  identityProblem,
  ignoredFolders,
  ignoredPaths,
  operationInProgress,
} from './git.js';

// The long form of the path: on some machines the temporary folder is named in the short
// form, while git always answers in the long one.
const TEMP = realpathSync.native(tmpdir());

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A repository with one commit, and its own identity so the machine's does not matter. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(TEMP, 'upfly-git-'));
  roots.push(root);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Upfly Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  return root;
}

/**
 * How many files git had to read while making a commit to see that they had not changed,
 * from its own performance trace, or null when the trace holds no such count. `git add`
 * writes none, so a count over the whole call is the commit's.
 */
function filesRead(trace: string): number | null {
  const counts = readFileSync(trace, 'utf8')
    .split('\n')
    .filter((line) => line.includes('refresh/sum_scan'))
    .map((line) => Number(line.slice(line.indexOf('refresh/sum_scan:') + 17).trim()));
  return counts.length === 0 ? null : counts.reduce((sum, count) => sum + count, 0);
}

/** Runs `body` with some environment variables set, then puts them back. */
function withEnv<T>(values: Record<string, string>, body: () => T): T {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

describe('gitState', () => {
  it('says when a directory is not in a repository', () => {
    const root = mkdtempSync(join(TEMP, 'upfly-git-'));
    roots.push(root);
    // A machine can keep a repository above its temporary folder; git must not look there.
    const state = withEnv({ GIT_CEILING_DIRECTORIES: dirname(root) }, () => gitState(root));
    expect(state).toEqual({ kind: 'not-a-repository' });
  });

  it('lists modified and untracked files, and nothing for a clean tree', () => {
    const root = repository({ 'index.html': 'a', 'img/logo.png': 'b' });
    expect(gitState(root)).toEqual({
      kind: 'repository',
      top: resolve(root),
      prefix: '',
      tracked: true,
      changed: [],
    });

    write(root, 'index.html', 'changed');
    write(root, 'img/new.png', 'untracked');
    expect(gitState(root)).toMatchObject({ changed: ['img/new.png', 'index.html'] });
  });

  it('does not see a folder that ignores itself, which is how .upfly stays out of the way', () => {
    const root = repository({ 'index.html': 'a' });
    write(root, '.upfly/.gitignore', '*\n');
    write(root, '.upfly/manifest.json', '{}');
    expect(gitState(root)).toMatchObject({ changed: [] });
  });

  it('answers for the project alone inside a larger repository, with paths relative to it', () => {
    const outer = repository({ 'notes.txt': 'n', 'web/index.html': 'a', 'web/img/a.png': 'b' });
    const project = join(outer, 'web');
    write(outer, 'notes.txt', 'changed outside the project');
    write(project, 'index.html', 'changed inside it');

    expect(gitState(project)).toEqual({
      kind: 'repository',
      top: resolve(outer),
      prefix: 'web/',
      tracked: true,
      changed: ['index.html'],
    });
  });

  it('says when the repository around the project tracks none of its files', () => {
    const outer = repository({ 'notes.txt': 'n' });
    const project = join(outer, 'site');
    write(project, 'index.html', 'never added');

    expect(gitState(project)).toMatchObject({
      kind: 'repository',
      prefix: 'site/',
      tracked: false,
      changed: ['index.html'],
    });
  });
});

describe('commitPaths', () => {
  it('commits exactly the paths given, additions, edits and deletions, as one commit', () => {
    const root = repository({ 'index.html': 'a', 'img/logo.png': 'b', 'notes.txt': 'c' });
    write(root, 'index.html', '<img src="img/logo.webp">');
    write(root, 'img/logo.webp', 'new');
    rmSync(join(root, 'img/logo.png'));
    write(root, 'notes.txt', 'the user was here');

    const hash = commitPaths(
      root,
      ['img/logo.png', 'img/logo.webp', 'index.html'],
      'Optimize images\n\nOne line with "quotes" and $(no shell)',
    );

    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(hash);
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(git(root, 'log', '-1', '--format=%B').trim()).toBe(
      'Optimize images\n\nOne line with "quotes" and $(no shell)',
    );
    expect(git(root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n')).toEqual([
      'D\timg/logo.png',
      'A\timg/logo.webp',
      'M\tindex.html',
    ]);
    expect(gitState(root)).toMatchObject({ changed: ['notes.txt'] });
  });

  it('commits a moved file with the mode its old path had, executable or not', () => {
    const root = repository({
      'img/run.gif': 'gif',
      'img/plain.gif': 'gif too',
      'index.html': 'a',
    });
    chmodSync(join(root, 'img/run.gif'), 0o755);
    git(root, 'update-index', '--chmod=+x', 'img/run.gif');
    git(root, 'commit', '--quiet', '-m', 'one executable image');
    mkdirSync(join(root, 'moved'));
    renameSync(join(root, 'img/run.gif'), join(root, 'moved/run.gif'));
    renameSync(join(root, 'img/plain.gif'), join(root, 'moved/plain.gif'));
    write(root, 'index.html', 'b');

    commitPaths(
      root,
      ['img/plain.gif', 'img/run.gif', 'index.html', 'moved/plain.gif', 'moved/run.gif'],
      'the move',
      [
        { from: 'img/plain.gif', to: 'moved/plain.gif' },
        { from: 'img/run.gif', to: 'moved/run.gif' },
      ],
    );

    const modes = git(root, 'ls-tree', 'HEAD', 'moved/')
      .trim()
      .split('\n')
      .map((line) => line.split(' ')[0]);
    expect(modes).toEqual(['100644', '100755']);
    expect(gitState(root)).toMatchObject({ changed: [] });
  });

  it('takes a path with spaces and shell characters literally', () => {
    const root = repository({ 'img/a b;$(x).png': 'old' });
    write(root, 'img/a b;$(x).png', 'new');
    commitPaths(root, ['img/a b;$(x).png'], 'one file');
    expect(gitState(root)).toMatchObject({ changed: [] });
  });

  it('never lets a name read as a pattern take a second file', () => {
    // As a pattern, `a[1].png` also matches `a1.png`.
    const root = repository({ 'a[1].png': 'x', 'a1.png': 'y' });
    write(root, 'a[1].png', 'x2');
    write(root, 'a1.png', 'y2');

    commitPaths(root, ['a[1].png'], 'one file');

    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('a[1].png');
    expect(gitState(root)).toMatchObject({ changed: ['a1.png'] });
  });

  it('reads no file the run did not write, whatever else the repository tracks', () => {
    const root = repository({
      'index.html': 'a',
      'img/logo.png': 'p',
      'img/hero.png': 'h',
      'notes.txt': 'n',
      'src/app.js': 'j',
      'src/style.css': 'c',
    });
    write(root, 'index.html', '<img src="img/logo.webp">');
    write(root, 'img/logo.webp', 'new');
    const trace = join(root, 'trace.txt');

    withEnv({ GIT_TRACE2_PERF: trace }, () =>
      commitPaths(root, ['img/logo.webp', 'index.html'], 'the run'),
    );

    expect(filesRead(trace)).toBe(0);
    expect(gitState(root)).toMatchObject({ changed: ['trace.txt'] });
  });

  it('reads only the files whose staged content it has to put back', () => {
    const root = repository({ 'index.html': 'a', 'notes.txt': 'n', 'img/logo.png': 'p' });
    write(root, 'notes.txt', 'staged by the user');
    git(root, 'add', '--', 'notes.txt');
    write(root, 'index.html', 'written by the run');
    const trace = join(root, 'trace.txt');

    withEnv({ GIT_TRACE2_PERF: trace }, () => commitPaths(root, ['index.html'], 'the run'));

    // The commit holds HEAD's `notes.txt`, whose size and time the index recorded for the
    // staged one, so git reads that file and no other.
    expect(filesRead(trace)).toBe(1);
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('notes.txt');
  });

  it('never ends a merge the person started', () => {
    const root = repository({ 'shared.txt': 'base\n' });
    git(root, 'checkout', '--quiet', '-b', 'theirs');
    write(root, 'shared.txt', 'theirs\n');
    git(root, 'commit', '--quiet', '-am', 'theirs');
    git(root, 'checkout', '--quiet', '-');
    write(root, 'shared.txt', 'ours\n');
    git(root, 'commit', '--quiet', '-am', 'ours');
    spawnSync('git', ['merge', 'theirs'], { cwd: root, encoding: 'utf8' });
    const before = git(root, 'rev-parse', 'HEAD').trim();
    write(root, 'hero.webp', 'written by the run');

    expect(() => commitPaths(root, ['hero.webp'], 'the run')).toThrow(/part way through a merge/);

    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(git(root, 'rev-parse', '--verify', 'MERGE_HEAD').trim()).not.toBe('');
  });

  it('says what the repository is part way through, a revert among them, and nothing otherwise', () => {
    const root = repository({ 'shared.txt': 'one\n' });
    expect(operationInProgress(root)).toBeNull();
    write(root, 'shared.txt', 'two\n');
    git(root, 'commit', '--quiet', '-am', 'two');
    write(root, 'shared.txt', 'three\n');
    git(root, 'commit', '--quiet', '-am', 'three');
    spawnSync('git', ['revert', '--no-edit', 'HEAD~1'], { cwd: root, encoding: 'utf8' });

    expect(operationInProgress(root)).toBe('revert');
  });

  it('never ends a cherry-pick the person started', () => {
    const root = repository({ 'shared.txt': 'base\n' });
    git(root, 'checkout', '--quiet', '-b', 'theirs');
    write(root, 'shared.txt', 'theirs\n');
    git(root, 'commit', '--quiet', '-am', 'theirs');
    git(root, 'checkout', '--quiet', '-');
    write(root, 'shared.txt', 'ours\n');
    git(root, 'commit', '--quiet', '-am', 'ours');
    spawnSync('git', ['cherry-pick', 'theirs'], { cwd: root, encoding: 'utf8' });
    const before = git(root, 'rev-parse', 'HEAD').trim();
    write(root, 'hero.webp', 'written by the run');

    expect(() => commitPaths(root, ['hero.webp'], 'the run')).toThrow(
      /part way through a cherry-pick/,
    );

    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(before);
  });

  it('makes the first commit on a branch that has none', () => {
    const root = repository({ 'index.html': 'a', 'notes.txt': 'n' });
    git(root, 'checkout', '--quiet', '--orphan', 'fresh');
    write(root, 'img/logo.webp', 'written by the run');

    commitPaths(root, ['img/logo.webp'], 'the run');

    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('img/logo.webp');
  });

  it('inside a larger repository, leaves work staged elsewhere out of the commit, and staged', () => {
    const outer = repository({ 'notes.txt': 'n', 'web/index.html': 'a' });
    const project = join(outer, 'web');
    write(outer, 'notes.txt', 'staged by the user, outside the project');
    git(outer, 'add', 'notes.txt');
    write(project, 'index.html', 'written by the run');
    write(project, 'img/logo.webp', 'created by the run');

    commitPaths(project, ['img/logo.webp', 'index.html'], 'the run');

    expect(git(outer, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n')).toEqual([
      'A\tweb/img/logo.webp',
      'M\tweb/index.html',
    ]);
    expect(git(outer, 'diff', '--cached', '--name-only').trim()).toBe('notes.txt');
  });
});

describe('ignoredPaths', () => {
  it('names the new files git would refuse to add, and never a tracked one', () => {
    const root = repository({ '.gitignore': '*.webp\nbuild/\n', 'index.html': 'a' });

    expect(ignoredPaths(root, ['img/a.webp', 'index.html', 'img/a.png', 'build/x.png'])).toEqual([
      'build/x.png',
      'img/a.webp',
    ]);
    expect(ignoredPaths(root, ['index.html'])).toEqual([]);
    expect(ignoredPaths(root, [])).toEqual([]);
  });
});

describe('ignoredFolders', () => {
  it('names the topmost ignored folder holding each path, and none for a path ignored by its own name', () => {
    const root = repository({ '.gitignore': '*.webp\npublic/\n', 'index.html': 'a' });

    expect(
      ignoredFolders(root, ['public/img/a.webp', 'public/index.html', 'img/b.webp', 'index.html']),
    ).toEqual(['public/']);
    expect(ignoredFolders(root, ['img/b.webp'])).toEqual([]);
    expect(ignoredFolders(root, [])).toEqual([]);
  });
});

describe('identityProblem', () => {
  it('is null where git knows who commits, and git words the problem where it does not', () => {
    const root = repository({ 'index.html': 'a' });
    expect(identityProblem(root)).toBeNull();

    const bare = mkdtempSync(join(TEMP, 'upfly-git-'));
    roots.push(bare);
    git(bare, 'init', '--quiet');
    const home = join(bare, 'home');
    mkdirSync(home);
    const problem = withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(home, 'none'),
        // Otherwise git may make up an address from the machine's name.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.useConfigOnly',
        GIT_CONFIG_VALUE_0: 'true',
      },
      () => identityProblem(bare),
    );
    expect(problem).toMatch(/^Author identity unknown/);
  });
});

describe('commitForRun', () => {
  it('finds the commit that names a run, and nothing for a run no commit names', () => {
    const root = repository({ 'index.html': 'a' });
    write(root, 'index.html', 'b');
    const hash = commitPaths(
      root,
      ['index.html'],
      `the run\n\n${RUN_TRAILER}: 20260926T010203-abcd\n`,
    );

    expect(commitForRun(root, '20260926T010203-abcd')).toBe(hash);
    expect(commitForRun(root, '20260926T010203-ffff')).toBeNull();
  });
});
