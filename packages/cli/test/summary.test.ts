/**
 * What `audit`, `optimize` and `dedupe` print by default, through the built binary, on
 * committed copies of two fixtures: a short summary, the report file each command writes
 * under its own name (the summary with each row's complete list), `--full` printing that file,
 * and `--json` unchanged. Each run uses its copy as the working folder and names no folder, so
 * the summary holds no temporary path.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { columns } from '../src/layout.js';
import { BIN, FIXTURES, commitAll, copyFixture, git, tempFolder, upfly, write } from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function committed(fixture: string): string {
  const root = copyFixture(fixture, tempFolder(roots, 'upfly-summary-'));
  commitAll(root);
  return root;
}

function run(root: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  return upfly(args, { cwd: root, ...(env === undefined ? {} : { env }) });
}

/** The copy's path, a run's id and the time it started, which differ on every run, as placeholders. */
function placeholders(text: string, root: string): string {
  const escaped = JSON.stringify(root).slice(1, -1);
  return text
    .replaceAll(escaped, '<root>')
    .replaceAll(root, '<root>')
    .replace(/\b\d{8}T\d{6}-[0-9a-f]{4}\b/g, '<run>')
    .replace(/^Run \d{4}-\d\d-\d\d \d\d:\d\d in /m, 'Run <time> in ');
}

/** Every line of the text, wider than 80 columns. */
function overWide(text: string): string[] {
  return text.split('\n').filter((line) => columns(line) > 80);
}

const SUMMARIES = {
  'audit vite-react': [
    '',
    'Upfly audit',
    '',
    '  Images       12 images, 126.9 KB',
    '  References   12 of 12 resolved, from 5 source files',
    '  Savings      75.5 KB as WebP at quality 80, across 5 images',
    '  Broken       none',
    '  Unused       1 image, 70 B',
    '                 and 1 unreferenced SVG, counted, not listed',
    '                 .upfly/audit.txt lists them; Upfly never deletes one',
    '  Copies       1 set of identical images, 210 B recoverable',
    "                 upfly dedupe points each set's references at one copy",
    '  Skipped      nothing',
    '',
    '  Full report  .upfly/audit.txt',
    '  Next         upfly optimize',
    '',
    '  upfly optimize would convert 5 images and save 75.5 KB.',
    '',
    '',
  ],
  'audit plain-html': [
    '',
    'Upfly audit',
    '',
    '  Images       11 images, 152.5 KB',
    '  References   10 of 11 resolved, from 3 source files',
    '  Savings      93.1 KB as WebP at quality 80, across 5 images',
    '  Broken       1 reference names an image that does not exist',
    '                 upfly check lists each with its file and line',
    '  Unused       1 image, 70 B',
    '                 1 possibly unused: its name appears in the project',
    '                 .upfly/audit.txt lists them; Upfly never deletes one',
    '  Copies       1 set of identical images, 280 B recoverable',
    "                 upfly dedupe points each set's references at one copy",
    '  Skipped      nothing',
    '',
    '  Full report  .upfly/audit.txt',
    '  Next         upfly optimize',
    '',
    '  upfly optimize would convert 5 images and save 93.1 KB.',
    '',
    '',
  ],
  'optimize vite-react': [
    '',
    'Upfly optimize · dry run',
    '',
    '  Convert      5 images to WebP, 124.2 KB → 48.8 KB',
    '                 5 originals to remove, 124.2 KB, once their references move',
    '                 3 of them are in a folder the site is served from, where a link',
    '                 from outside the project (an email, another site, a CMS) then',
    '                 stops working; --keep-originals keeps them',
    '  Update       7 references in 2 files',
    '  Leave        7 images, 2.7 KB',
    '                 3  would save too little',
    '                 2  SVG, which Upfly does not convert',
    '                 1  no reference would move to a new file',
    '                 1  nothing links to it',
    '',
    '  Full plan    .upfly/optimize.txt',
    '  Next         upfly optimize --apply',
    '',
    '  Dry run: no project file was changed. With --apply, upfly optimize would',
    '  convert 5 images and save 75.5 KB.',
    '',
    '',
  ],
  'optimize plain-html': [
    '',
    'Upfly optimize · dry run',
    '',
    '  Convert      5 images to WebP, 150.1 KB → 57 KB',
    '                 5 originals kept, each for a reason in the full plan',
    '  Update       6 references in 2 files',
    '  Leave        6 images, 2.4 KB',
    '                 3  would save too little',
    '                 2  nothing links to it',
    '                 1  no reference would move to a new file',
    '',
    '  Full plan    .upfly/optimize.txt',
    '  Next         upfly optimize --apply',
    '',
    '  Dry run: no project file was changed. With --apply, upfly optimize would',
    '  convert 5 images and save 93.1 KB.',
    '',
    '',
  ],
  'dedupe vite-react': [
    '',
    'Upfly dedupe · dry run',
    '',
    '  Sets         1 set of identical images, 4 files',
    '  Update       no reference',
    '  Leave        2 references as written',
    '                 2  an import cannot reach a folder the site serves',
    '  Unused       1 copy, 70 B, with no reference left',
    '                 Upfly never deletes it; upfly audit lists it as unused',
    '',
    '  Full plan    .upfly/dedupe.txt',
    '',
    '  Dry run: no project file was changed, and there is nothing to do.',
    '',
    '',
  ],
} as const;

/**
 * Each case's name, fixture and command; the golden file of what `--full` prints; and, for
 * `optimize`, a golden file of the report file alone, which `--full` prints with a blank line
 * before and after.
 */
const CASES = [
  ['audit vite-react', 'vite-react', 'audit', 'audit-vite-react.txt', null],
  ['audit plain-html', 'plain-html', 'audit', 'audit-plain-html.txt', null],
  [
    'optimize vite-react',
    'vite-react',
    'optimize',
    'optimize-vite-react.txt',
    'optimize-vite-react.report.txt',
  ],
  [
    'optimize plain-html',
    'plain-html',
    'optimize',
    'optimize-plain-html.txt',
    'optimize-plain-html.report.txt',
  ],
  ['dedupe vite-react', 'vite-react', 'dedupe', 'dedupe-vite-react.txt', null],
] as const;

describe.each(CASES)('upfly %s', (name, fixture, command, golden, reportGolden) => {
  // One copy and two runs serve both tests: each run measures every image, and the suite
  // runs beside other heavy files.
  let root = '';
  let summary: ReturnType<typeof run>;
  let kept = '';
  let full: ReturnType<typeof run>;
  beforeAll(() => {
    root = committed(fixture);
    summary = run(root, [command]);
    kept = readFileSync(join(root, `.upfly/${command}.txt`), 'utf8');
    full = run(root, [command, '--full']);
  }, 120_000);

  it('prints the summary, in plain text when stdout is not a terminal, within 80 columns', () => {
    expect(summary.status, summary.stderr).toBe(0);
    expect(summary.stdout).toBe(SUMMARIES[name].join('\n'));
    expect(summary.stdout.includes('\u001b')).toBe(false);
    expect(overWide(summary.stdout)).toEqual([]);
  });

  it('keeps the summary with every list in a file named after the command, which --full prints', async () => {
    expect(full.status, full.stderr).toBe(0);
    await expect(placeholders(full.stdout, root)).toMatchFileSnapshot(`./golden/${golden}`);
    expect(placeholders(full.stdout, root)).toBe(placeholders(`\n${kept}\n`, root));
    if (reportGolden !== null) {
      await expect(placeholders(kept, root)).toMatchFileSnapshot(`./golden/${reportGolden}`);
    }
  });
});

describe('the report file', () => {
  it('is written with the folder ignored by git, so audit then optimize --apply is not refused', () => {
    const root = committed('plain-html');

    const audit = run(root, ['audit']);
    const written = readdirSync(join(root, '.upfly')).sort();
    const status = git(root, 'status', '--porcelain', '--untracked-files=all');
    const applied = run(root, ['optimize', '--apply']);

    expect(audit.status, audit.stderr).toBe(0);
    expect(written).toEqual(['.gitignore', 'audit.txt']);
    expect(readFileSync(join(root, '.upfly/.gitignore'), 'utf8')).toBe('*\n');
    expect(status).toBe('');
    expect(applied.status, applied.stderr).toBe(0);
  });

  it('is kept as a copy in the folder of the applied run it describes', async () => {
    const root = committed('plain-html');

    const applied = run(root, ['optimize', '--apply']);
    const [id = ''] = readdirSync(join(root, '.upfly/runs'));
    const report = readFileSync(join(root, '.upfly/optimize.txt'), 'utf8');

    expect(applied.status, applied.stderr).toBe(0);
    expect(placeholders(applied.stdout, root)).toBe(
      [
        '',
        'Upfly optimize · applied',
        '',
        '  Converted    5 images to WebP, 150.1 KB → 57 KB',
        '                 5 originals kept, each for a reason in the full plan',
        '  Updated      6 references in 2 files',
        '  Left alone   6 images, 2.4 KB',
        '                 3  would save too little',
        '                 2  nothing links to it',
        '                 1  no reference would move to a new file',
        '',
        '  Run          <run>: 5 files created, 2 changed, 0 removed',
        '  Full plan    .upfly/optimize.txt',
        "  Next         run the project's build, if it has one, then upfly check",
        '                 upfly undo puts every file back',
        '',
        '  Upfly converted 5 images and saved 93.1 KB.',
        '',
        '',
      ].join('\n'),
    );
    expect(readFileSync(join(root, '.upfly/runs', id, 'optimize.txt'), 'utf8')).toBe(report);
    expect(report).toContain(`  Run          ${id}: 5 files created, 2 changed, 0 removed\n`);
    await expect(placeholders(report, root)).toMatchFileSnapshot(
      './golden/optimize-apply-plain-html.txt',
    );
  });

  it('lists every image and reference left alone with its reason, as the summary says', () => {
    const root = committed('partial-pattern');

    const summary = run(root, ['optimize']);
    const report = readFileSync(join(root, '.upfly/optimize.txt'), 'utf8');
    const leave = run(root, ['optimize', '--show', 'leave']);

    expect(summary.stdout).toContain('stays as written, each for a reason in the');
    expect(report).toContain(
      '      public/theme-dark.png  70 B  `src/App.jsx` reaches it only through `/theme-${mode}.png`, a path assembled at runtime that no run can rewrite. No reference would move to a new file, so it would be used by nobody. Upfly converts an image only when a reference moves to the new file\n',
    );
    expect(report).toContain(
      '      src/App.jsx  stays: a template reference is assembled at runtime, so its text cannot be repointed, and none of the 4 assets it matches converts\n',
    );
    expect(leave.stdout).toContain(
      '      public/theme-dark.png  70 B  `src/App.jsx` reaches it only through',
    );
    expect(report).toContain(leave.stdout.trim());
  });

  it('prints one row with its list under --show, as the file holds it', () => {
    const root = committed('plain-html');

    const audit = run(root, ['audit']);
    const report = readFileSync(join(root, '.upfly/audit.txt'), 'utf8');
    const broken = run(root, ['audit', '--show', 'broken']);
    const copies = run(root, ['audit', '--show', 'copies']);
    const oversized = run(root, ['audit', '--show', 'oversized']);

    expect(audit.status, audit.stderr).toBe(0);
    expect(broken.stdout).toBe(
      [
        '',
        '  Broken       1 reference names an image that does not exist',
        '                 upfly check lists each with its file and line',
        '',
        '    Each of these names an image that does not exist, at the file and line',
        '    given: fix the path, or put the image back. upfly check fails while any is',
        '    left.',
        '      about.html:10  images/missing-on-purpose.png',
        '',
        '',
      ].join('\n'),
    );
    for (const shown of [broken, copies]) expect(report).toContain(shown.stdout.trim());
    expect(oversized.stdout).toBe('\n  This run has nothing under oversized.\n\n');
  });

  it('is not written under --json, whose output is unchanged', async () => {
    const cases = [
      ['plain-html', ['audit', '--json', '--no-probe'], 'audit-plain-html.jsonl'],
      ['plain-html', ['optimize', '--json'], 'optimize-plain-html.jsonl'],
      ['vite-react', ['dedupe', '--json'], 'dedupe-vite-react.jsonl'],
    ] as const;
    for (const [fixture, args, golden] of cases) {
      const root = committed(fixture);
      const result = run(root, args);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(root, '.upfly')), args.join(' ')).toBe(false);
      await expect(placeholders(result.stdout, root)).toMatchFileSnapshot(`./golden/${golden}`);
    }
  });

  it('refuses --full beside --json, since one of them would change nothing', () => {
    const result = upfly(['audit', '--full', '--json']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: 'error', exitCode: 2 });
  });
});

describe('the next command', () => {
  it('repeats the options that shaped the plan, and adds --allow-dirty outside git', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-next-'));

    const replace = upfly(['optimize', '.', '--replace', '--public', '.'], { cwd: root });
    const only = upfly(['optimize', '--only', '*.png'], { cwd: root });

    expect(replace.status, replace.stderr).toBe(0);
    expect(replace.stdout).toContain(
      '                 5 originals to remove, 150.1 KB, once their references move\n',
    );
    expect(replace.stdout).toContain(
      '  Next         upfly optimize --replace --public . --apply --allow-dirty\n',
    );
    expect(only.stdout).toContain(
      '  Next         upfly optimize --only "*.png" --apply --allow-dirty\n',
    );
  });

  it('asks for the served folder, not a plan optimize would refuse, when the audit could not tell it', () => {
    const root = tempFolder(roots, 'upfly-next-');
    const missing = Array.from({ length: 10 }, (_, n) => `<img src="/pictures/missing-${n}.png">`);
    write(root, 'index.html', `${missing.join('\n')}\n<img src="logo.png">\n`);
    write(root, 'logo.png', readFileSync(join(FIXTURES, 'plain-html/images/logo.png')));

    const result = upfly(['audit'], { cwd: root });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      [
        '  Broken       not judged: where the site is served from is unknown',
        '                 name the folder with --public <dir>; the full report says more',
      ].join('\n'),
    );
    expect(result.stdout).toContain(
      '  Next         name the folder the site serves: upfly audit --public <dir>\n',
    );
  });

  it('says it in words when the command is too long to print whole', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-next-'));

    const result = upfly(
      ['optimize', '--replace', '--public', '.', '--exclude', 'legacy', '--only', '*.png'],
      { cwd: root },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('  Next         the same command with --apply --allow-dirty\n');
  });
});

describe('what is left alone', () => {
  it('counts every reason the planner gave under a group of its own, an image a build loads among them', () => {
    // partial-pattern imports an image and names no build Upfly knows, so the image keeps its
    // format with the planner's build sentence.
    const root = committed('partial-pattern');

    const result = run(root, ['optimize']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      [
        '  Leave        5 images, 32.3 KB',
        '                 3  no reference would move to a new file',
        '                 1  could not be measured',
        '                 1  its build may not load the new format',
      ].join('\n'),
    );
    expect(result.stdout).not.toContain('another reason');
  });
});

describe('a project inside a larger repository', () => {
  it('names that repository whole in the summaries of optimize and dedupe, since --commit commits there', () => {
    // The path is never cut short, as other long paths are: the reader needs all of it to
    // know where the commit lands.
    const top = tempFolder(roots, 'upfly-summary-nested-');
    copyFixture('vite-react', join(top, 'site'));
    write(top, 'notes.txt', 'the rest of the repository\n');
    commitAll(top);
    const repository = `  Repository   site/ in the git repository at ${top}\n`;

    const deduped = run(top, ['dedupe', 'site']);
    const dry = run(top, ['optimize', 'site']);
    const applied = run(top, ['optimize', 'site', '--apply', '--commit']);

    for (const result of [deduped, dry]) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `${repository}                 --apply checks, and --commit commits, only the files under it\n`,
      );
      expect(result.stdout).not.toContain('This folder is site/');
    }
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain(
      `${repository}                 the commit holds only the files under it\n`,
    );
  });
});
