/**
 * `upfly dedupe` through the built binary, on small sites written outside the workspace: the
 * plan, an applied and committed run that `upfly undo` reverses, `--keep`, and the refusals.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

/** Two copies of one image: the copy two pages use, and the one a single page uses. */
function site(): string {
  const root = tempFolder(roots, 'upfly-dedupe-');
  write(root, 'index.html', '<img src="img/logo.png">\n<img src="img/logo-copy.png">\n');
  write(root, 'about/index.html', '<img src="../img/logo-copy.png">\n');
  write(root, 'img/logo.png', LOGO);
  write(root, 'img/logo-copy.png', LOGO);
  return root;
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

describe('upfly dedupe', () => {
  it('keeps the plan, the copy it keeps and why, which --full prints, and changes no project file', () => {
    const root = site();
    const before = snapshot(root);

    const run = upfly(['dedupe', root, '--full']);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`\n${readFileSync(join(root, '.upfly/dedupe.txt'), 'utf8')}\n`);
    for (const line of [
      '  Sets         1 set of identical images, 2 files',
      '      img/logo-copy.png  7.2 KB, kept: more references use it than any other copy',
      '        img/logo.png  its 1 reference moves to the kept copy',
      '      index.html  1 reference',
      '      img/logo.png',
    ]) {
      expect(run.stdout).toContain(`${line}\n`);
    }
    expect(run.stdout).toContain(
      'Dry run: no project file was changed. With --apply, 1 reference in 1 file',
    );
    expect(snapshot(root, ['.upfly'])).toEqual(before);
  });

  it('writes and commits exactly the edited pages, keeps every file, and upfly undo puts them back', () => {
    const root = site();
    commitAll(root);
    const before = snapshot(root, ['.git']);

    const run = upfly(['dedupe', root, '--apply', '--commit', '--full']);
    const edited = readFileSync(join(root, 'index.html'), 'utf8');
    const committed = git(root, 'show', '--name-only', '--format=', 'HEAD').trim();
    const undo = upfly(['undo', root]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(': 0 files created, 1 changed, 0 removed');
    expect(edited).toBe('<img src="img/logo-copy.png">\n<img src="img/logo-copy.png">\n');
    expect(existsSync(join(root, 'img/logo.png'))).toBe(true);
    expect(committed).toBe('index.html');
    expect(undo.status, undo.stderr).toBe(0);
    expect(snapshot(root, ['.git', '.upfly'])).toEqual(before);
  });

  it('keeps the copy --keep names, and refuses one that is no copy, or two copies of one image', () => {
    const root = site();

    const kept = result(upfly(['dedupe', root, '--keep', 'img/logo.png', '--json']).stdout) as {
      plan: { sets: { keep: string; kept: string }[] };
    };
    const stranger = upfly(['dedupe', root, '--keep', 'img/other.png']);
    const both = upfly(['dedupe', root, '--keep', 'img/logo.png', '--keep', 'img/logo-copy.png']);

    expect(kept.plan.sets[0]).toMatchObject({ keep: 'img/logo.png', kept: 'chosen' });
    expect(stranger.status).toBe(2);
    expect(stranger.stderr).toContain(
      '--keep img/other.png is not one of the identical copies Upfly found',
    );
    expect(both.status).toBe(2);
    expect(both.stderr).toContain(
      '--keep names two copies of one image, img/logo-copy.png and img/logo.png; keep one',
    );
  });

  it('gives the plan and the run as one JSON result under --json', () => {
    const root = site();

    const run = upfly(['dedupe', root, '--json']);

    expect(run.status).toBe(0);
    expect(result(run.stdout)).toMatchObject({
      type: 'result',
      command: 'dedupe',
      exitCode: 0,
      apply: false,
      plan: {
        sets: [
          {
            keep: 'img/logo-copy.png',
            kept: 'most-used',
            copies: [{ path: 'img/logo.png', references: 1, moved: 1, unusedAfter: true }],
          },
        ],
      },
      run: null,
      commit: null,
    });
  });

  it('says so when no two images are identical', () => {
    const root = tempFolder(roots, 'upfly-dedupe-none-');
    write(root, 'index.html', '<img src="a.png">\n');
    write(root, 'a.png', LOGO);

    const run = upfly(['dedupe', root, '--full']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('  Sets         none: no two images hold the same bytes\n');
    expect(run.stdout).toContain('no project file was changed, and there is nothing to do.');
  });

  it('refuses to write over uncommitted changes, as optimize does', () => {
    const root = site();
    commitAll(root);
    write(root, 'draft.html', '<p>unsaved work</p>\n');

    const run = upfly(['dedupe', root, '--apply', '--json']);

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({ reason: 'UNCOMMITTED_CHANGES' });
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('img/logo.png');
  });

  it('refuses --commit while a cherry-pick is part way through, before writing anything', () => {
    // A pick whose change this branch already holds stops with nothing left uncommitted.
    const root = site();
    commitAll(root);
    git(root, 'checkout', '--quiet', '-b', 'theirs');
    write(root, 'notes.txt', 'the same\n');
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '--quiet', '-m', 'theirs');
    git(root, 'checkout', '--quiet', '-');
    write(root, 'notes.txt', 'the same\n');
    git(root, 'add', 'notes.txt');
    git(root, 'commit', '--quiet', '-m', 'ours');
    spawnSync('git', ['cherry-pick', 'theirs'], { cwd: root, encoding: 'utf8' });
    const before = snapshot(root, ['.git']);

    const run = upfly(['dedupe', root, '--apply', '--commit', '--json']);

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      reason: 'GIT_OPERATION_IN_PROGRESS',
      message: expect.stringContaining('part way through a cherry-pick'),
    });
    expect(snapshot(root, ['.git'])).toEqual(before);
  });
});
