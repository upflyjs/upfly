/**
 * `upfly optimize` through the built binary, on copies of the plain HTML fixture outside
 * the workspace: the dry run, applied runs in a repository of their own and inside a larger
 * one under both policies, and each refusal.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  FIXTURES,
  NO_NETWORK,
  commitAll,
  copyFixture,
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

/** Upfly's own folder and git's, left out when comparing a project's files. */
const NOT_THE_PROJECT = ['.git', '.upfly'];

/**
 * Under --replace an original is removed only inside a folder the site is served from, so
 * those runs declare the project root as one.
 */
const POLICIES = [
  ['keep-original', ['--keep-originals']],
  ['replace', ['--replace', '--public', '.']],
] as const;

/** A copy of the plain HTML site, committed in a repository of its own. */
function standalone(): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-optimize-'));
  commitAll(root);
  return root;
}

/** The same site as `site/` in a larger repository that holds other work too. */
function nested(): { readonly outer: string; readonly site: string } {
  const outer = tempFolder(roots, 'upfly-outer-');
  write(outer, 'notes.txt', 'the rest of the repository\n');
  copyFixture('plain-html', join(outer, 'site'));
  commitAll(outer);
  return { outer, site: join(outer, 'site') };
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

function committedFiles(root: string): string[] {
  return git(root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
}

describe('upfly optimize without --apply', () => {
  it('names the excluded page that keeps an original, without --include-declined', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-optimize-'));
    write(root, 'legacy/old.html', '<img src="../images/logo.png">\n');
    commitAll(root);

    const run = upfly([
      'optimize',
      root,
      '--replace',
      '--public',
      '.',
      '--exclude',
      'legacy',
      '--full',
    ]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'images/logo.png: converting it would delete the original, and legacy/old.html:1 still names its path, in a file this run excluded',
    );
  });

  it('shows a summary of the plan, and writes only its report, in its own folder, which git ignores', () => {
    const root = standalone();
    const before = snapshot(root, NOT_THE_PROJECT);

    const run = upfly(['optimize', root]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Upfly optimize · dry run');
    expect(run.stdout).toContain('  Convert      5 images to WebP,');
    expect(run.stdout).toContain('  Dry run: no project file was changed.');
    expect(readFileSync(join(root, '.upfly/optimize.txt'), 'utf8')).toContain(
      'Each image converts to WebP',
    );
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('prints each stage as a JSON line, then the plan, which names no run and no commit', () => {
    const root = standalone();

    const run = upfly(['optimize', root, '--json']);
    const lines = jsonLines(run.stdout);

    expect(run.status).toBe(0);
    // One `measuring` line per image here, so repeats are collapsed to the order alone.
    const stages = lines.slice(0, -1).map((line) => line.stage);
    expect(stages.filter((stage, index) => stage !== stages[index - 1])).toEqual([
      'discovered',
      'scanned',
      'resolved',
      'measuring',
      'measured',
      'audited',
      'planned',
    ]);
    expect(lines.at(-1)).toMatchObject({
      type: 'result',
      command: 'optimize',
      exitCode: 0,
      apply: false,
      run: null,
      commit: null,
      repository: { path: '' },
    });
    expect((lines.at(-1)?.plan as { conversions: unknown[] }).conversions.length).toBeGreaterThan(
      0,
    );
  });
});

describe.each(POLICIES)('upfly optimize --apply --commit, %s', (policy, flags) => {
  it('makes one commit of exactly the files it wrote, finds nothing to do the second time, and git revert restores every byte', () => {
    const root = standalone();
    const original = snapshot(root, NOT_THE_PROJECT);

    const first = upfly(['optimize', root, '--apply', '--commit', '--json', ...flags]);
    expect(first.status, first.stderr).toBe(0);
    const applied = result(first.stdout) as {
      run: { created: string[]; changed: string[]; removed: string[] };
      commit: string;
    };

    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(applied.commit);
    expect(committedFiles(root)).toEqual(
      [...applied.run.created, ...applied.run.changed, ...applied.run.removed].sort(),
    );
    // Clean afterwards: the run's own folder is hidden from git by the .gitignore it wrote.
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, '.upfly/.gitignore'), 'utf8')).toBe('*\n');
    if (policy === 'replace') expect(applied.run.removed.length).toBeGreaterThan(0);
    else expect(applied.run.removed).toEqual([]);
    // The fixture's one broken reference is there on purpose, and nothing may join it.
    const audit = upfly(['audit', root, '--json', '--no-probe', ...flags.slice(1)]);
    const findings = (result(audit.stdout).report as { findings: Record<string, string>[] })
      .findings;
    expect(findings.filter((f) => f.kind === 'broken').map((f) => f.rawPath)).toEqual([
      'images/missing-on-purpose.png',
    ]);

    const afterFirst = snapshot(root, NOT_THE_PROJECT);
    const second = upfly(['optimize', root, '--apply', '--json', ...flags]);
    expect(second.status, second.stderr).toBe(0);
    expect(result(second.stdout)).toMatchObject({ run: null, commit: null });
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(afterFirst);

    git(root, 'revert', '--no-edit', 'HEAD');
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(original);
  }, 120_000);
});

describe('each original, once every reference to it has moved', () => {
  /** The applied run's removed files, with the folder the site is served from declared. */
  function removedBy(root: string, flags: readonly string[]): string[] {
    const run = upfly(['optimize', root, '--public', '.', '--apply', '--json', ...flags]);
    expect(run.status, run.stderr).toBe(0);
    return (result(run.stdout) as { run: { removed: string[] } }).run.removed;
  }

  it('is removed by default, and --replace names that default', () => {
    expect(removedBy(standalone(), []).length).toBeGreaterThan(0);
    expect(removedBy(standalone(), ['--replace'])).toEqual(removedBy(standalone(), []));
  }, 120_000);

  it('is kept with --keep-originals, or when the config file asks for keep-original', () => {
    const configured = () => {
      const root = copyFixture('plain-html', tempFolder(roots, 'upfly-optimize-'));
      write(root, 'upfly.config.json', '{ "publicPolicy": "keep-original" }\n');
      commitAll(root);
      return root;
    };

    expect(removedBy(standalone(), ['--keep-originals'])).toEqual([]);
    expect(removedBy(configured(), [])).toEqual([]);
    expect(removedBy(configured(), ['--replace']).length).toBeGreaterThan(0);
  }, 120_000);
});

describe('upfly optimize in a project inside a larger repository', () => {
  it('checks and commits only the project, leaves the rest of the repository alone, and names it', () => {
    const { outer, site } = nested();
    write(outer, 'notes.txt', 'changed outside the project, and staged\n');
    git(outer, 'add', 'notes.txt');
    write(outer, 'draft.md', 'untracked, outside the project\n');

    const dry = upfly(['optimize', site, '--full']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`  Repository   site/ in the git repository at ${outer}\n`);

    const applied = upfly(['optimize', site, '--apply', '--commit', '--full']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain(
      `  Repository   site/ in the git repository at ${outer}\n                 the commit holds only the files under it\n`,
    );
    const files = committedFiles(outer);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.startsWith('site/'))).toBe(true);
    expect(git(outer, 'diff', '--cached', '--name-only').trim()).toBe('notes.txt');
    expect(git(outer, 'status', '--porcelain', '--', 'draft.md').trim()).toBe('?? draft.md');
  }, 120_000);

  it('refuses when the project itself has uncommitted changes, naming the file and the repository', () => {
    const { outer, site } = nested();
    write(site, 'about.html', '<p>edited by hand</p>\n');
    const before = snapshot(site);

    const run = upfly(['optimize', site, '--apply']);

    expect(run.status).toBe(3);
    expect(run.stderr).toContain('Uncommitted changes in 1 file under this folder');
    expect(run.stderr).toContain(`in the git repository at ${outer}, where this folder is site/`);
    expect(run.stderr).toContain('about.html');
    expect(snapshot(site)).toEqual(before);
  });
});

describe('upfly optimize refuses to write, with exit 3 and what to do', () => {
  it('while the project has uncommitted changes, unless --allow-dirty', () => {
    const root = standalone();
    write(root, 'about.html', '<p>edited by hand</p>\n');
    const before = snapshot(root, ['.git']);

    const refused = upfly(['optimize', root, '--apply', '--json']);
    expect(refused.status).toBe(3);
    expect(result(refused.stdout)).toMatchObject({
      type: 'error',
      exitCode: 3,
      reason: 'UNCOMMITTED_CHANGES',
      message: expect.stringContaining('about.html'),
    });
    expect(snapshot(root, ['.git'])).toEqual(before);

    const allowed = upfly(['optimize', root, '--apply', '--allow-dirty']);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(existsSync(join(root, 'images/logo.webp'))).toBe(true);
  });

  it('for an untracked file alone, which git could not restore if the run removed it', () => {
    const root = standalone();
    write(root, 'images/new.png', readFileSync(join(root, 'images/logo.png')));

    const run = upfly(['optimize', root, '--apply', '--replace', '--public', '.', '--json']);

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      reason: 'UNCOMMITTED_CHANGES',
      message: expect.stringContaining('images/new.png'),
    });
    expect(existsSync(join(root, '.upfly'))).toBe(false);
  });

  it('outside a repository, unless --allow-dirty; and --commit there is a usage error', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-no-git-'));
    const before = snapshot(root);

    const refused = upfly(['optimize', root, '--apply', '--json']);
    const commit = upfly(['optimize', root, '--apply', '--commit']);
    expect(refused.status).toBe(3);
    expect(result(refused.stdout)).toMatchObject({ reason: 'NO_REPOSITORY' });
    expect(commit.status).toBe(2);
    expect(commit.stderr).toContain('--commit needs a git repository');
    expect(snapshot(root)).toEqual(before);

    const allowed = upfly(['optimize', root, '--apply', '--allow-dirty']);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(existsSync(join(root, 'images/logo.webp'))).toBe(true);
  });

  it('while another run holds the project, and after a run that stopped part way', () => {
    const root = standalone();
    const before = snapshot(root, NOT_THE_PROJECT);
    // This test's own process is alive, so to the binary it is another run.
    const holder = { pid: process.pid, startedAt: '2026-09-26T00:00:00.000Z', runId: 'run-other' };
    write(root, '.upfly/lock', `${JSON.stringify(holder)}\n`);

    const locked = upfly(['optimize', root, '--apply', '--json']);
    expect(locked.status).toBe(3);
    expect(result(locked.stdout)).toMatchObject({
      reason: 'TRANSACTION_LOCKED',
      message: expect.stringContaining('run-other'),
    });

    // A lock another run has created and not yet written: refused before the project is
    // read, so nothing is staged.
    write(root, '.upfly/lock', '');
    const starting = upfly(['optimize', root, '--apply', '--json']);
    expect(starting.status).toBe(3);
    expect(result(starting.stdout)).toMatchObject({
      reason: 'TRANSACTION_LOCKED',
      message: expect.stringContaining('delete .upfly/lock'),
    });
    expect(existsSync(join(root, '.upfly/runs'))).toBe(false);

    rmSync(join(root, '.upfly/lock'));
    write(
      root,
      '.upfly/manifest.json',
      `${JSON.stringify({
        schemaVersion: 1,
        hashAlgorithm: 'sha256',
        runId: 'run-stopped',
        startedAt: '2026-09-26T00:00:00.000Z',
        completedAt: null,
        revertedAt: null,
        state: 'pending',
        runDir: '.upfly/runs/run-stopped',
        operations: [],
        declined: [],
      })}\n`,
    );
    const interrupted = upfly(['optimize', root, '--apply', '--json']);
    expect(interrupted.status).toBe(3);
    expect(result(interrupted.stdout)).toMatchObject({
      reason: 'TRANSACTION_INTERRUPTED',
      message: expect.stringContaining('upfly undo'),
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  });

  it('when a folder was named and too few references resolve there, without asking for it again', () => {
    const root = tempFolder(roots, 'upfly-named-root-');
    const tags = Array.from({ length: 12 }, (_, n) => `<img src="/img/photo-${n + 1}.png">`);
    write(root, 'index.html', `${tags.join('\n')}\n`);
    const logo = readFileSync(join(FIXTURES, 'plain-html/images/logo.png'));
    for (const n of [1, 2]) write(root, `public/img/photo-${n}.png`, logo);

    const human = upfly(['optimize', root, '--public', 'public']);
    const run = upfly(['optimize', root, '--public', 'public', '--json']);

    expect(human.status).toBe(3);
    expect(human.stderr).toContain(
      'Only 2 of 12 root-relative references resolved in public, named as the folder the site is served from; if it is, the other 10 name no file there. Upfly rewrites nothing while so few resolve. `npx upfly check` lists the 10 references with the file and line of each.',
    );
    expect(human.stderr).not.toMatch(/--public|publicDirs/);
    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      reason: 'SERVING_ROOT_UNKNOWN',
      message: expect.stringContaining('`npx upfly check` lists the 10 references'),
    });
  });

  it('when most root-relative references point nowhere, so the served folder is unknown', () => {
    const root = tempFolder(roots, 'upfly-unknown-root-');
    const missing = Array.from({ length: 10 }, (_, n) => `<img src="/pictures/missing-${n}.png">`);
    write(root, 'index.html', `${missing.join('\n')}\n<img src="logo.png">\n`);
    write(root, 'logo.png', readFileSync(join(FIXTURES, 'plain-html/images/logo.png')));

    const run = upfly(['optimize', root, '--json']);

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      reason: 'SERVING_ROOT_UNKNOWN',
      message: expect.stringContaining('--public <dir>'),
    });
    // The run prints no report, so the refusal says where the references it set aside are.
    expect(result(run.stdout)).toMatchObject({
      message: expect.stringContaining(
        '`npx upfly audit` lists the 10 references that did not resolve',
      ),
    });
  });

  it('with --commit, before writing anything, when git ignores a file the run would write', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-ignored-'));
    write(root, '.gitignore', '*.webp\n');
    commitAll(root);
    const before = snapshot(root, ['.git']);

    const run = upfly(['optimize', root, '--apply', '--commit', '--json']);

    expect(run.status).toBe(3);
    expect(result(run.stdout)).toMatchObject({
      reason: 'IGNORED_BY_GIT',
      message: expect.stringContaining('this run would write: images/hero.webp'),
    });
    // Git ignores the files by their own name, not a folder holding them: there is no
    // folder to leave out.
    expect(result(run.stdout)).toMatchObject({
      message: expect.stringMatching(/Run without --commit, or change what git ignores\.$/),
    });
    expect(snapshot(root, ['.git'])).toEqual(before);
  });

  it('with --commit on a site built before the run, naming the ignored build folder to leave out, and that advice gives a correct run', () => {
    // A built site whose generator Upfly cannot tell from its settings file: `config.toml` is
    // Hugo's older name and other tools' too. `public/` is the build output, ignored by git,
    // and holds a copy of the image the post names, which a run would otherwise plan as source.
    // Originals are kept: left out, the output still names the original, which a run that
    // removes originals then keeps by declining the conversion.
    const root = tempFolder(roots, 'upfly-built-site-');
    const logo = readFileSync(join(FIXTURES, 'plain-html/images/logo.png'));
    write(root, 'config.toml', 'title = "A built site"\n');
    write(root, 'content/post.md', '![The logo](/img/a.png)\n');
    write(root, 'static/img/a.png', logo);
    write(root, '.gitignore', 'public/\n');
    commitAll(root);
    write(root, 'public/img/a.png', logo);
    write(root, 'public/index.html', '<img src="/img/a.png" alt="The logo">\n');
    const before = snapshot(root, ['.git']);

    const refused = upfly(['optimize', root, '--apply', '--commit', '--keep-originals', '--json']);

    expect(refused.status).toBe(3);
    expect(result(refused.stdout)).toMatchObject({
      reason: 'IGNORED_BY_GIT',
      message: expect.stringContaining(
        "If that is a build's output, leave it out with --exclude public/ and run again",
      ),
    });
    expect(snapshot(root, ['.git'])).toEqual(before);

    const run = upfly([
      'optimize',
      root,
      '--apply',
      '--commit',
      '--keep-originals',
      '--exclude',
      'public/',
      '--json',
    ]);

    expect(run.status).toBe(0);
    expect(readFileSync(join(root, 'content/post.md'), 'utf8')).toBe('![The logo](/img/a.webp)\n');
    expect(existsSync(join(root, 'static/img/a.webp'))).toBe(true);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});

describe('upfly optimize on a site built before the run', () => {
  it("on a built Hugo site, without --commit, converts the source image and leaves Hugo's output alone", () => {
    // Beside `hugo.toml`, `public/` is Hugo's output: a run that read it as the website folder
    // would rewrite the post to name a file only the output holds, which the next clean
    // build does not make.
    const root = tempFolder(roots, 'upfly-hugo-built-');
    const logo = readFileSync(join(FIXTURES, 'plain-html/images/logo.png'));
    write(root, 'hugo.toml', 'title = "A built site"\n');
    write(root, 'content/post.md', '![The logo](/img/a.png)\n');
    write(root, 'static/img/a.png', logo);
    write(root, '.gitignore', 'public/\n');
    commitAll(root);
    write(root, 'public/img/a.png', logo);
    write(root, 'public/index.html', '<img src="/img/a.png" alt="The logo">\n');
    const output = snapshot(join(root, 'public'), []);

    const run = upfly(['optimize', root, '--apply', '--json']);

    expect(run.status).toBe(0);
    expect(readFileSync(join(root, 'content/post.md'), 'utf8')).toBe('![The logo](/img/a.webp)\n');
    expect(existsSync(join(root, 'static/img/a.webp'))).toBe(true);
    expect(git(root, 'status', '--porcelain').trimEnd().split('\n').sort()).toEqual([
      ' D static/img/a.png',
      ' M content/post.md',
      '?? static/img/a.webp',
    ]);
    expect(snapshot(join(root, 'public'), [])).toEqual(output);
  });
});

describe('upfly optimize --only', () => {
  it('plans only the images it names, reading the whole project, and says how many it left', () => {
    const root = standalone();

    const run = upfly(['optimize', root, '--only', 'images/logo.png', '--full']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('  Convert      1 image to WebP, 7.2 KB → 850 B\n');
    expect(run.stdout).toContain('      images/logo.png → images/logo.webp  7.2 KB → 850 B\n');
    expect(run.stdout).toContain('      index.html  1 reference\n');
    expect(run.stdout).toContain(
      '  Note         --only named 1 of 11 images; the other 10 were not',
    );
  });

  it('takes patterns in .gitignore syntax, repeated, and names one that matches no image', () => {
    const root = standalone();

    const run = upfly(['optimize', root, '--only', '*.jpg', '--only', 'images/nope.png', '--json']);
    const final = result(run.stdout) as {
      plan: { conversions: { asset: string }[] };
      only: unknown;
      notes: string[];
    };

    expect(run.status).toBe(0);
    // team.jpg is measured, and its saving is too small to count, so it stays as it is.
    expect(final.plan.conversions.map((c) => c.asset)).toEqual([
      'images/hero.jpg',
      'images/hero@2x.jpg',
    ]);
    expect(final.only).toEqual({
      images: ['images/hero.jpg', 'images/hero@2x.jpg', 'images/team.jpg'],
      unmatched: ['images/nope.png'],
    });
    expect(final.notes).toContain('--only images/nope.png named no image in the project.');
  });

  it('writes only that image and its references, and under --replace removes it only once they moved', () => {
    const root = standalone();

    const run = upfly([
      'optimize',
      root,
      '--only',
      'images/logo.png',
      '--replace',
      '--public',
      '.',
      '--apply',
      '--json',
    ]);

    expect(run.status, run.stderr).toBe(0);
    expect(result(run.stdout)).toMatchObject({
      run: { created: ['images/logo.webp'], changed: ['index.html'], removed: ['images/logo.png'] },
    });
    const changed = git(root, 'status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.includes('.upfly'))
      .sort();
    expect(changed).toEqual(['?? images/logo.webp', 'D images/logo.png', 'M index.html']);
  });
});

describe('upfly optimize and the network', () => {
  it('opens no connection and resolves no name while it writes and commits', () => {
    const root = standalone();
    const log = join(tempFolder(roots, 'upfly-net-'), 'attempts.log');

    const run = upfly(['optimize', root, '--apply', '--commit'], {
      env: { UPFLY_NETWORK_LOG: log },
      preload: NO_NETWORK,
    });

    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
});
