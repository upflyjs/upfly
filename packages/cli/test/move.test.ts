/**
 * `upfly move` through the built binary, on small sites written outside the workspace: the
 * plan, an applied and committed run that `upfly undo` reverses byte for byte, a folder, the
 * lines left naming an old path, and the refusals.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  FIXTURES,
  commitAll,
  git,
  jsonLines,
  snapshot,
  tempFolder,
  upfly,
  write,
} from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOGO = readFileSync(join(FIXTURES, 'plain-html/images/logo.png'));

/** What a package manager sets when it starts the run, as `pnpm exec upfly` does. */
const PACKAGE_MANAGER = { npm_config_user_agent: 'pnpm/10.12.1 npm/? node/v22.14.0 win32 x64' };

/** A site served from `public`: the hero named three ways, and by a full address. */
function site(): string {
  const root = tempFolder(roots, 'upfly-move-');
  write(root, 'upfly.config.json', '{ "publicDirs": ["public"] }\n');
  write(root, 'public/hero.png', LOGO);
  write(root, 'public/icons/a.png', LOGO);
  write(root, 'public/icons/b.png', LOGO);
  write(root, 'index.html', '<img src="/hero.png" alt="">\n<img src="/icons/a.png" alt="">\n');
  write(root, 'about/index.html', '<img src="../public/hero.png" alt="">\n');
  write(
    root,
    'styles.css',
    '.hero { background: url(/hero.png); }\n.b { background: url(/icons/b.png); }\n',
  );
  write(root, 'src/seo.ts', "export const image = 'https://example.com/hero.png';\n");
  return root;
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

describe('upfly move', () => {
  it('plans the move, lists what still names the old path, and changes no project file', () => {
    const root = site();
    const before = snapshot(root);

    const run = upfly(['move', 'public/hero.png', 'public/img/hero.png', '--json'], { cwd: root });

    expect(run.status, run.stderr).toBe(0);
    expect(result(run.stdout)).toMatchObject({
      command: 'move',
      apply: false,
      run: null,
      plan: {
        moves: [{ from: 'public/hero.png', to: 'public/img/hero.png' }],
        refused: [],
        declined: [],
        unfollowed: [
          {
            from: 'public/hero.png',
            file: 'src/seo.ts',
            line: 1,
            text: 'https://example.com/hero.png',
            reason: 'full-address',
            host: 'example.com',
          },
        ],
      },
    });
    const rewrites = (result(run.stdout).plan as { rewrites: { file: string }[] }).rewrites;
    expect(rewrites.map((rewrite) => rewrite.file)).toEqual([
      'about/index.html',
      'index.html',
      'styles.css',
    ]);
    expect(snapshot(root, ['.upfly'])).toEqual(before);
  });

  it('prints a summary of the plan with the command that applies it', () => {
    const root = site();
    commitAll(root);

    const run = upfly(['move', 'public/hero.png', 'public/img/hero.png'], { cwd: root });

    expect(run.status, run.stderr).toBe(0);
    for (const line of [
      'Move',
      'public/hero.png to public/img/hero.png',
      '3 references in 3 files',
      'Not followed',
      '1 line still names an old path',
      'upfly move public/hero.png public/img/hero.png --apply',
    ]) {
      expect(run.stdout).toContain(line);
    }
    expect(readFileSync(join(root, '.upfly/move.txt'), 'utf8')).toContain(
      'src/seo.ts:1  https://example.com/hero.png',
    );
  });

  it('prints each command as a project install types it when a package manager starts it', () => {
    const root = site();
    commitAll(root);
    const elsewhere = tempFolder(roots, 'upfly-move-elsewhere-');
    const run = (...args: string[]) =>
      upfly(['move', ...args], { cwd: root, env: PACKAGE_MANAGER });

    const plan = run('public/hero.png', 'public/img/hero.png');
    const outside = run('public/hero.png', join(elsewhere, 'hero.png'));
    const none = run('public/hero.png');
    const applied = run('public/hero.png', 'public/img/hero.png', '--apply');

    expect(plan.stdout).toMatch(
      /\n {2}Next +npx upfly move public\/hero\.png public\/img\/hero\.png --apply\n/,
    );
    expect(outside.stderr).toContain('name its project after them: npx upfly move <from> <to>');
    expect(none.stderr).toContain('such as `npx upfly move public/hero.png public/img/hero.png`');
    expect(none.stderr).toContain('See `npx upfly move --help`.');
    expect(applied.stdout).toContain(
      "run the project's build, if it has one, then npx upfly check",
    );
    expect(applied.stdout).toContain('npx upfly undo puts every file back');
  });

  it('moves and commits exactly the run, and upfly undo puts every byte back', () => {
    const root = site();
    commitAll(root);
    const start = git(root, 'rev-parse', 'HEAD').trim();

    const run = upfly(['move', 'public/hero.png', 'public/img/hero.png', '--apply', '--commit'], {
      cwd: root,
    });

    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(root, 'public/img/hero.png'))).toBe(true);
    expect(existsSync(join(root, 'public/hero.png'))).toBe(false);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('<img src="/img/hero.png"');
    expect(readFileSync(join(root, 'about/index.html'), 'utf8')).toContain(
      '../public/img/hero.png',
    );
    expect(
      git(root, 'show', '--name-only', '--no-renames', '--format=', 'HEAD')
        .trim()
        .split('\n')
        .sort(),
    ).toEqual([
      'about/index.html',
      'index.html',
      'public/hero.png',
      'public/img/hero.png',
      'styles.css',
    ]);
    expect(git(root, 'status', '--porcelain')).toBe('');

    const undo = upfly(['undo'], { cwd: root });
    expect(undo.status, undo.stderr).toBe(0);
    expect(undo.stdout).toContain(
      '3 files with references put back, 1 image moved back where it was.',
    );
    // After --commit, git's index holds the run's files, so the tree is compared staged.
    git(root, 'add', '-A');
    expect(git(root, 'diff', '--cached', '--name-only', start)).toBe('');
  });

  it('commits a moved image with the executable mark it was committed with', () => {
    const root = site();
    commitAll(root);
    chmodSync(join(root, 'public/hero.png'), 0o755);
    git(root, 'update-index', '--chmod=+x', 'public/hero.png');
    git(root, 'commit', '--quiet', '-m', 'an executable image');

    const run = upfly(['move', 'public/hero.png', 'public/img/hero.png', '--apply', '--commit'], {
      cwd: root,
    });

    expect(run.status, run.stderr).toBe(0);
    expect(git(root, 'ls-tree', 'HEAD', 'public/img/hero.png')).toMatch(/^100755 /);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('moves every image in a folder, and into a folder named with a slash', () => {
    const root = site();

    const folder = upfly(['move', 'public/icons', 'public/symbols', '--json'], { cwd: root });
    const into = upfly(['move', 'public/hero.png', 'public/img/', '--json'], { cwd: root });

    expect((result(folder.stdout).plan as { moves: unknown[] }).moves).toEqual([
      { from: 'public/icons/a.png', to: 'public/symbols/a.png' },
      { from: 'public/icons/b.png', to: 'public/symbols/b.png' },
    ]);
    expect((result(into.stdout).plan as { moves: unknown[] }).moves).toEqual([
      { from: 'public/hero.png', to: 'public/img/hero.png' },
    ]);
  });

  it('lists a page the run excluded that names the old path, and leaves it as written', () => {
    const root = site();
    write(root, 'legacy/old.html', '<img src="/hero.png" alt="">\n');

    const run = upfly(
      ['move', 'public/hero.png', 'public/img/hero.png', '--exclude', 'legacy', '--json'],
      { cwd: root },
    );

    const lines = (result(run.stdout).plan as { unfollowed: { file: string; why: string }[] })
      .unfollowed;
    expect(lines.find((line) => line.file === 'legacy/old.html')?.why).toContain('leaves out');
  });

  it('exits 2 for a path that is missing, outside the project or not an image', () => {
    const root = site();
    const elsewhere = tempFolder(roots, 'upfly-move-elsewhere-');

    const missing = upfly(['move', 'public/nope.png', 'public/x.png'], { cwd: root });
    const outside = upfly(['move', 'public/hero.png', join(elsewhere, 'hero.png')], { cwd: root });
    const page = upfly(['move', 'index.html', 'home.html'], { cwd: root });
    const none = upfly(['move', 'public/hero.png'], { cwd: root });

    expect([missing.status, outside.status, page.status, none.status]).toEqual([2, 2, 2, 2]);
    expect(missing.stderr).toContain('there is no file or folder at public/nope.png');
    expect(outside.stderr).toContain('is outside the project');
    expect(page.stderr).toContain('is not an image Upfly found in the project');
    expect(none.stderr).toContain('move needs the image or folder to move and where it goes');
  });

  it('exits 3 when every move is refused, and when --apply meets uncommitted changes', () => {
    const root = site();
    commitAll(root);

    const occupied = upfly(['move', 'public/hero.png', 'public/icons/a.png', '--json'], {
      cwd: root,
    });
    write(root, 'index.html', '<img src="/hero.png" alt="">\n');
    const dirty = upfly(['move', 'public/hero.png', 'public/img/hero.png', '--apply', '--json'], {
      cwd: root,
    });

    expect(result(occupied.stdout)).toMatchObject({
      type: 'error',
      exitCode: 3,
      reason: 'MOVE_REFUSED',
      message: expect.stringContaining('public/icons/a.png already exists'),
    });
    expect(result(dirty.stdout)).toMatchObject({ exitCode: 3, reason: 'UNCOMMITTED_CHANGES' });
  });

  it('refuses --commit during a rebase stopped with a clean tree, before writing anything', () => {
    // A commit made now would join the rebase, so it is refused while nothing is written,
    // as a commit that could not hold the run is.
    const root = site();
    commitAll(root);
    write(root, 'notes.txt', 'two\n');
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '--quiet', '-m', 'two');
    // `--exec false` stops the rebase after its pick, with nothing to resolve.
    spawnSync('git', ['rebase', '--exec', 'false', 'HEAD~1'], { cwd: root, encoding: 'utf8' });
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const before = snapshot(root, ['.git']);

    const run = upfly(
      ['move', 'public/hero.png', 'public/img/hero.png', '--apply', '--commit', '--json'],
      { cwd: root },
    );

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      type: 'error',
      exitCode: 3,
      reason: 'GIT_OPERATION_IN_PROGRESS',
      message: expect.stringContaining('part way through a rebase'),
    });
    expect(snapshot(root, ['.git'])).toEqual(before);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(root, 'status')).toContain('rebase');
  });
});
