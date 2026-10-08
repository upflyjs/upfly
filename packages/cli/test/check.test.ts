/**
 * `upfly check` through the built binary, on small sites written outside the workspace: the
 * verdict and its exit code, the size limit from the config, and `--changed` against a git
 * ref and against uncommitted changes.
 */

import { existsSync, rmSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BIN, commitAll, git, jsonLines, snapshot, tempFolder, upfly, write } from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Bytes that stand for an image: `check` reads no pixels, only names and sizes. */
function image(bytes: number, fill = 1): Buffer {
  return Buffer.alloc(bytes, fill);
}

/** A site whose one page uses one image, beside an image nothing uses. */
function site(files: Record<string, string | Buffer> = {}): string {
  const root = tempFolder(roots, 'upfly-check-');
  const all: Record<string, string | Buffer> = {
    'index.html': '<img src="img/used.png">\n',
    'img/used.png': image(100),
    'img/unused.png': image(100, 2),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) write(root, path, content);
  return root;
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

/**
 * A framework site whose component data names images on the site by path: one that does not
 * exist, one in another letter case than its file, and a bare file name.
 */
function dataSite(files: Record<string, string | Buffer> = {}): string {
  return site({
    'package.json': '{ "name": "site" }\n',
    'public/img/logo.png': image(100, 5),
    'src/team.js': [
      'export const team = [',
      '  { name: "Ana", image: "/img/ana.jpg" },',
      '  { name: "Digital", icon: "/img/Logo.png" },',
      '  { name: "File", file: "people.png" },',
      '];',
      '',
    ].join('\n'),
    ...files,
  });
}

const POSSIBLY_BROKEN = [
  'Possibly broken: image paths in code or data that name no file (2)',
  '    src/team.js:2  /img/ana.jpg',
  '    src/team.js:3  /img/Logo.png',
  '      names `public/img/logo.png` as `/img/Logo.png`: it loads on Windows and macOS and breaks on a Linux server; fix the letter case',
];

describe('upfly check', () => {
  it('passes when every reference names an image that exists, however many images are unused', () => {
    const root = site();
    const before = snapshot(root);

    const run = upfly(['check', root]);

    expect(run.status).toBe(0);
    expect(run.stdout.split('\n')[3]).toBe('Passed: no reference names a missing image.');
    expect(run.stderr).toBe('');
    expect(snapshot(root)).toEqual(before);
  });

  it('fails when a reference names a missing image, saying why in one line and then where', () => {
    const root = site({
      'about.html': '<p>About</p>\n<img src="img/used.pn">\n<img src="img/team.png">\n',
    });

    const run = upfly(['check', root]);

    expect(run.status).toBe(1);
    expect(run.stdout.slice(1, -1)).toBe(
      [
        'Upfly check',
        '',
        'Failed: 2 references name an image that does not exist.',
        '',
        'References to images that do not exist (2)',
        '    about.html:2  img/used.pn',
        '      ends in .pn, one keystroke from .png: a likely typo, so no image shows here',
        '    about.html:3  img/team.png',
        '',
      ].join('\n'),
    );
  });

  it('gives the verdict and the findings as one JSON result under --json', () => {
    const root = site({ 'about.html': '<img src="img/team.png">\n' });

    const run = upfly(['check', root, '--json']);
    const lines = jsonLines(run.stdout);

    expect(run.status).toBe(1);
    expect(lines.slice(0, -1).every((line) => line.type === 'progress')).toBe(true);
    expect(lines.at(-1)).toEqual({
      type: 'result',
      command: 'check',
      exitCode: 1,
      passed: false,
      failOn: ['broken'],
      findings: [
        {
          kind: 'broken',
          file: 'about.html',
          line: 1,
          where: 'about.html:1',
          rawPath: 'img/team.png',
        },
      ],
      possiblyBroken: { paths: [], leftOut: 0, unlisted: 0 },
      maxImageBytes: null,
      changed: null,
      leftOut: 0,
      unusedOverLimit: 0,
      unchecked: 0,
    });
  });

  it('fails on an image in use larger than check.maxImageBytes, and never on an unused one', () => {
    const root = site({
      'upfly.config.json': JSON.stringify({ check: { maxImageBytes: 150 } }),
      'index.html': '<img src="img/used.png">\n<img src="img/big.png">\n',
      'img/big.png': image(300, 3),
      'img/big-unused.png': image(400, 4),
    });

    const human = upfly(['check', root]);
    const json = result(upfly(['check', root, '--json']).stdout);

    expect(human.status).toBe(1);
    expect(human.stdout.slice(1, -1)).toBe(
      [
        'Upfly check',
        '',
        'Failed: 1 image in use is larger than check.maxImageBytes, 150 bytes.',
        '',
        'Images in use larger than 150 bytes (1)',
        '    img/big.png  300 B',
        '',
        '1 image larger than the limit is not counted: no reference uses it, and an unused image never fails the check.',
        '',
      ].join('\n'),
    );
    expect(json).toMatchObject({
      exitCode: 1,
      passed: false,
      findings: [{ kind: 'too-large', asset: 'img/big.png', bytes: 300 }],
      maxImageBytes: 150,
      unusedOverLimit: 1,
    });
  });

  it('says in its passing line that the limit held too', () => {
    const root = site({ 'upfly.config.json': JSON.stringify({ check: { maxImageBytes: 150 } }) });

    const run = upfly(['check', root]);

    expect(run.status).toBe(0);
    expect(run.stdout.split('\n')[3]).toBe(
      'Passed: no reference names a missing image, and no image in use is larger than check.maxImageBytes, 150 bytes.',
    );
  });

  it('refuses a limit that is not a whole number of bytes, and a setting it does not know', () => {
    const negative = site({ 'upfly.config.json': '{ "check": { "maxImageBytes": -1 } }' });
    const unknown = site({ 'upfly.config.json': '{ "check": { "maxWidth": 10 } }' });

    const first = upfly(['check', negative]);
    const second = upfly(['check', unknown]);

    expect(first.status).toBe(2);
    expect(first.stderr).toContain(
      '`check.maxImageBytes` must be a whole number of bytes above 0, such as 500000.',
    );
    expect(second.status).toBe(2);
    expect(second.stderr).toContain(
      'unknown setting `check.maxWidth`. The settings under `check` are `maxImageBytes` and `failOn`.',
    );
  });

  it('counts what it could not check, since a path the build decides names no file to look for', () => {
    const root = site({ 'styles.scss': '.hero { background: url($hero); }\n' });

    const run = upfly(['check', root]);

    expect(run.status).toBe(0);
    expect(run.stdout.slice(1, -1)).toBe(
      [
        'Upfly check',
        '',
        'Passed: no reference names a missing image.',
        '',
        '1 reference could not be checked, since Upfly cannot know which file it names; `npx upfly audit` lists it with the reason.',
        '',
      ].join('\n'),
    );
  });

  it('counts a file it could not parse, since no reference in it was checked', () => {
    const root = site({ 'src/broken.scss': '.a { color: red' });

    const run = upfly(['check', root]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      '1 file could not be parsed or read, so no reference in it was checked; `npx upfly audit` names it with the reason.',
    );
  });

  /**
   * A site a script converted: twelve root-relative images in its page, ten of them now only a
   * WebP beside the name the page still uses. With two folders, the images alternate between.
   */
  function convertedByScript(folders: readonly string[] = ['public']): string {
    const root = tempFolder(roots, 'upfly-check-named-');
    const tags = Array.from({ length: 12 }, (_, n) => `<img src="/img/photo-${n + 1}.png">`);
    write(root, 'index.html', `${tags.join('\n')}\n`);
    for (let n = 1; n <= 12; n += 1) {
      const folder = folders[n % folders.length] ?? 'public';
      write(root, `${folder}/img/photo-${n}.${n <= 2 ? 'png' : 'webp'}`, image(100, n));
    }
    return root;
  }

  it('lists what a folder named with --public did not resolve, with exit 1, not asking for it again', () => {
    const root = convertedByScript();

    const human = upfly(['check', root, '--public', 'public']);
    const json = upfly(['check', root, '--public', 'public', '--json']);

    expect(human.status).toBe(1);
    expect(human.stdout.slice(1, -1)).toBe(
      [
        'Upfly check',
        '',
        'Failed: 10 references name an image that does not exist.',
        'Only 2 of 12 root-relative references resolved in public, named as the folder the site is served from; if it is, the other 10 name no file there.',
        '',
        'References to images that do not exist (10)',
        ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `    index.html:${n}  /img/photo-${n}.png`),
        '',
      ].join('\n'),
    );
    expect(human.stderr).toBe('');
    expect(json.status).toBe(1);
    const said = result(json.stdout);
    expect(said).toMatchObject({
      exitCode: 1,
      passed: false,
      fewResolved: { folders: ['public'], linked: 2, checkable: 12 },
    });
    expect(said.findings).toHaveLength(10);
    expect(said.findings).toContainEqual({
      kind: 'broken',
      file: 'index.html',
      line: 3,
      where: 'index.html:3',
      rawPath: '/img/photo-3.png',
    });

    // With no folder named, the same project still stops, asking for one.
    const unnamed = upfly(['check', root]);
    expect(unnamed.status).toBe(3);
    expect(unnamed.stderr).toContain('--public <dir>');
  });

  it('trusts folders named by publicDirs in the config the same way, one or two', () => {
    for (const folders of [['public'], ['public', 'static']]) {
      const root = convertedByScript(folders);
      write(root, 'upfly.config.json', `${JSON.stringify({ publicDirs: folders })}\n`);

      const human = upfly(['check', root]);
      const json = upfly(['check', root, '--json']);

      expect(human.status).toBe(1);
      expect(human.stdout).toContain(
        `Only 2 of 12 root-relative references resolved in ${folders.join(' and ')}, named as the`,
      );
      expect(human.stdout + human.stderr).not.toMatch(/--public|publicDirs|could not work out/);
      expect(result(json.stdout)).toMatchObject({
        exitCode: 1,
        fewResolved: { folders, linked: 2, checkable: 12 },
      });
    }
  });

  it('refuses with exit 3 when it cannot tell where the site is served from', () => {
    const root = tempFolder(roots, 'upfly-check-unknown-root-');
    const missing = Array.from({ length: 10 }, (_, n) => `<img src="/pictures/missing-${n}.png">`);
    write(root, 'index.html', `${missing.join('\n')}\n<img src="logo.png">\n`);
    write(root, 'logo.png', image(100));

    const human = upfly(['check', root]);
    const json = upfly(['check', root, '--json']);

    expect(human.status).toBe(3);
    expect(human.stderr).toContain('Upfly could not work out where this project serves files from');
    expect(human.stderr).toContain('--public <dir>');
    expect(json.status).toBe(3);
    expect(result(json.stdout)).toMatchObject({
      type: 'error',
      command: 'check',
      exitCode: 3,
      reason: 'SERVING_ROOT_UNKNOWN',
    });
  });
});

describe('upfly check: image paths in code or data that name no file', () => {
  const NOTE =
    'A possibly broken path is a string Upfly does not read as a reference: a page that shows it shows no image, but Upfly cannot tell whether a page does. Such paths fail the check only when check.failOn or --fail-on names possibly-broken.';
  const UNLISTED =
    '1 more string ends in an image extension and names no file, but does not start with / as a path on the site does; `npx upfly audit --include-discarded` lists it.';

  it('lists them apart from the findings, with file and line, and passes by default', () => {
    const root = dataSite();

    const human = upfly(['check', root]);
    const json = result(upfly(['check', root, '--json']).stdout);

    expect(human.status).toBe(0);
    expect(human.stdout.slice(1, -1)).toBe(
      [
        'Upfly check',
        '',
        'Passed: no reference names a missing image.',
        '',
        ...POSSIBLY_BROKEN,
        '',
        NOTE,
        UNLISTED,
        '',
      ].join('\n'),
    );
    expect(json).toMatchObject({
      exitCode: 0,
      passed: true,
      failOn: ['broken'],
      findings: [],
      possiblyBroken: {
        paths: [
          { file: 'src/team.js', line: 2, where: 'src/team.js:2', rawPath: '/img/ana.jpg' },
          {
            file: 'src/team.js',
            line: 3,
            where: 'src/team.js:3',
            rawPath: '/img/Logo.png',
            note: 'names `public/img/logo.png` as `/img/Logo.png`: it loads on Windows and macOS and breaks on a Linux server; fix the letter case',
          },
        ],
        leftOut: 0,
        unlisted: 1,
      },
    });
  });

  it('fails on them only when check.failOn names them, and a flag overrides the config', () => {
    const root = dataSite({
      'upfly.config.json': JSON.stringify({ check: { failOn: ['broken', 'possibly-broken'] } }),
    });

    const named = upfly(['check', root]);
    const overridden = upfly(['check', root, '--fail-on', 'broken']);
    const byFlag = upfly(['check', dataSite(), '--fail-on', 'broken,possibly-broken', '--json']);

    expect(named.status).toBe(1);
    expect(named.stdout.split('\n')[3]).toBe('Failed: 2 image paths in code or data name no file.');
    expect(named.stdout).toContain(POSSIBLY_BROKEN.join('\n'));
    expect(named.stdout).not.toContain('Such paths fail the check only when');
    expect(overridden.status).toBe(0);
    expect(byFlag.status).toBe(1);
    expect(result(byFlag.stdout)).toMatchObject({
      exitCode: 1,
      passed: false,
      failOn: ['broken', 'possibly-broken'],
      findings: [],
    });
  });

  it('under --warn lists everything and exits 0, while a usage or configuration error still stops it', () => {
    const root = dataSite({ 'about.html': '<img src="img/team.png">\n' });
    const misconfigured = site({ 'upfly.config.json': '{ "check": { "failOn": ["unused"] } }' });

    const warned = upfly(['check', root, '--warn']);
    const json = result(upfly(['check', root, '--warn', '--json']).stdout);
    const refused = upfly(['check', misconfigured, '--warn']);

    expect(warned.status).toBe(0);
    expect(warned.stdout.slice(1, -1).split('\n').slice(0, 7)).toEqual([
      'Upfly check',
      '',
      'Warning: 1 reference names an image that does not exist. --warn keeps the exit code at 0.',
      '',
      'References to images that do not exist (1)',
      '    about.html:1  img/team.png',
      '',
    ]);
    expect(warned.stdout).toContain(POSSIBLY_BROKEN.join('\n'));
    expect(json).toMatchObject({ exitCode: 0, passed: true, failOn: [] });
    expect(json.findings).toHaveLength(1);
    expect(refused.status).toBe(2);
  });

  it('says why a broken reference does not fail it when failOn leaves broken out', () => {
    const root = site({
      'about.html': '<img src="img/team.png">\n',
      'upfly.config.json': JSON.stringify({
        check: { maxImageBytes: 500, failOn: ['too-large'] },
      }),
    });

    const run = upfly(['check', root]);

    expect(run.status).toBe(0);
    expect(run.stdout.split('\n')[3]).toBe(
      'Warning: 1 reference names an image that does not exist; check.failOn does not name broken, so it does not fail the check.',
    );
  });

  it('refuses to fail on unused images, or on a size with no limit set', () => {
    const unused = site({ 'upfly.config.json': '{ "check": { "failOn": ["unused"] } }' });
    const noLimit = site({ 'upfly.config.json': '{ "check": { "failOn": ["too-large"] } }' });
    const plain = site();

    const runs = {
      unused: upfly(['check', unused]),
      noLimit: upfly(['check', noLimit]),
      flagUnused: upfly(['check', plain, '--fail-on', 'unused']),
      flagNoLimit: upfly(['check', plain, '--fail-on', 'too-large']),
      both: upfly(['check', plain, '--warn', '--fail-on', 'broken']),
      empty: upfly(['check', plain, '--fail-on', '']),
    };

    for (const run of Object.values(runs)) expect(run.status).toBe(2);
    expect(runs.unused.stderr).toContain(
      '`check.failOn` holds `unused`, which the check cannot fail on: the choices are `broken`, `too-large` and `possibly-broken`, and an unused image never fails the check.',
    );
    expect(runs.noLimit.stderr).toContain(
      '`check.failOn` names `too-large`, which needs `check.maxImageBytes`, the largest an image in use may be.',
    );
    expect(runs.flagUnused.stderr).toContain(
      '--fail-on takes broken, too-large or possibly-broken, separated by commas; got `unused`, and an unused image never fails the check',
    );
    expect(runs.flagNoLimit.stderr).toContain(
      '--fail-on too-large needs check.maxImageBytes in the config file, the largest an image in use may be',
    );
    expect(runs.both.stderr).toContain(
      '--warn and --fail-on cannot be used together: --warn makes nothing fail',
    );
    expect(runs.empty.stderr).toContain(
      '--fail-on needs at least one of broken, too-large and possibly-broken; --warn makes nothing fail',
    );
  });
});

describe('upfly check --changed', () => {
  /** A repository whose first commit already holds a broken reference in `old.html`. */
  function repository(): { readonly root: string; readonly start: string } {
    const root = site({ 'old.html': '<img src="img/gone-long-ago.png">\n' });
    commitAll(root);
    return { root, start: git(root, 'rev-parse', 'HEAD').trim() };
  }

  it('keeps only the findings in files changed since a ref, and counts the rest', () => {
    const { root, start } = repository();
    write(root, 'new.html', '<img src="img/new-and-missing.png">\n');
    git(root, 'add', 'new.html');
    git(root, 'commit', '--quiet', '-m', 'add a page');

    const run = upfly(['check', root, '--changed', start]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('    new.html:1  img/new-and-missing.png');
    expect(run.stdout).not.toContain('old.html');
    expect(run.stdout).toContain(
      `Checked the 1 file changed against ${start}; 1 finding in files this change did not touch was left out.`,
    );
  });

  it('passes when the change broke nothing, even though older findings remain', () => {
    const { root, start } = repository();
    write(root, 'new.html', '<img src="img/used.png">\n');
    git(root, 'add', 'new.html');
    git(root, 'commit', '--quiet', '-m', 'add a page');

    const run = upfly(['check', root, '--changed', start, '--json']);

    expect(run.status).toBe(0);
    expect(result(run.stdout)).toMatchObject({
      passed: true,
      findings: [],
      changed: { against: start, files: 1 },
      leftOut: 1,
    });
  });

  it('without a ref, keeps the findings in files with uncommitted changes, untracked ones included', () => {
    const { root } = repository();
    write(root, 'draft.html', '<img src="img/draft-missing.png">\n');

    const run = upfly(['check', root, '--changed']);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('    draft.html:1  img/draft-missing.png');
    expect(run.stdout).not.toContain('old.html');
    expect(run.stdout).toContain('Checked the 1 file changed since the last commit;');
  });

  it('keeps a reference in an unchanged page to an image the change deleted', () => {
    const { root, start } = repository();
    git(root, 'rm', '--quiet', 'img/used.png');
    git(root, 'commit', '--quiet', '-m', 'remove an image');

    const run = upfly(['check', root, '--changed', start]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('    index.html:1  img/used.png');
    expect(run.stdout).not.toContain('old.html');
  });

  it('keeps only the images in use the change added or modified, under the size limit', () => {
    const { root, start } = repository();
    write(root, 'upfly.config.json', JSON.stringify({ check: { maxImageBytes: 150 } }));
    write(root, 'img/used.png', image(200));
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'a larger image and a limit');

    const json = result(upfly(['check', root, '--changed', start, '--json']).stdout);

    expect(json).toMatchObject({
      passed: false,
      findings: [{ kind: 'too-large', asset: 'img/used.png', bytes: 200 }],
    });
  });

  it('limits the image paths that name no file as it limits the findings', () => {
    const root = dataSite();
    commitAll(root);
    const start = git(root, 'rev-parse', 'HEAD').trim();
    write(root, 'src/hero.js', 'export const hero = { src: "/img/hero.png" };\n');
    git(root, 'add', 'src/hero.js');
    git(root, 'commit', '--quiet', '-m', 'add a hero');

    const run = upfly(['check', root, '--changed', start]);
    const json = result(upfly(['check', root, '--changed', start, '--json']).stdout);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'Possibly broken: image paths in code or data that name no file (1)\n    src/hero.js:1  /img/hero.png\n',
    );
    expect(run.stdout).toContain(
      `Checked the 1 file changed against ${start}; 2 possibly broken paths in files this change did not touch were left out.`,
    );
    expect(json).toMatchObject({
      leftOut: 0,
      possiblyBroken: { leftOut: 2, unlisted: 0 },
    });
  });

  it('keeps a path in unchanged data that names an image the change deleted', () => {
    const root = dataSite({ 'src/brand.js': 'export const brand = { logo: "/img/logo.png" };\n' });
    commitAll(root);
    const start = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'rm', '--quiet', 'public/img/logo.png');
    git(root, 'commit', '--quiet', '-m', 'remove the logo');

    const run = upfly(['check', root, '--changed', start]);

    expect(run.stdout).toContain('    src/brand.js:1  /img/logo.png');
    expect(run.stdout).not.toContain('/img/ana.jpg');
  });

  it('says so with exit 2 when git knows no such ref, and outside a repository', () => {
    const { root } = repository();
    const plain = site();

    const unknown = upfly(['check', root, '--changed', 'no-such-branch']);
    const outside = upfly(['check', plain, '--changed']);

    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('git knows no commit called `no-such-branch` here');
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain('--changed needs a git repository');
    expect(outside.stderr).toContain('is not in a git repository');
  });

  it('reads a folder written after --changed as the ref, and says how to name the folder instead', () => {
    const { root } = repository();

    const run = upfly(['check', '--changed', 'img'], { cwd: root });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      '`img` is a folder: to check the uncommitted changes in it, put the folder before --changed, as in `npx upfly check img --changed`',
    );
  });
});
