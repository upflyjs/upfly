/**
 * Every line the built CLI prints under `--json`, checked against the schema the package
 * ships for it: each command on a copy of a fixture, and on a small site made to produce
 * every kind of finding, verdict, progress stage, diagnostic and error the schemas describe.
 * The last test says which of those the runs produced, so a schema branch no run reaches is
 * named rather than passed untested.
 */

import { copyFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURES,
  commitAll,
  copyFixture,
  git,
  jsonLines,
  tempFolder,
  upfly,
  write,
} from './helpers.js';

const SCHEMA_DIR = fileURLToPath(new URL('../schema/', import.meta.url));
// `sharp` is the engine's dependency, not the CLI's, so it is loaded from there.
const sharp = createRequire(new URL('../../core/package.json', import.meta.url))('sharp') as (
  options: object,
) => { png(): { toBuffer(): Promise<Buffer> } };

type Line = Record<string, unknown>;
type Run = ReturnType<typeof upfly>;

const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addVocabulary(['patternErrorMessage']);
for (const file of readdirSync(SCHEMA_DIR)) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')), file);
}

/** What the runs produced, by schema branch, for the last test. */
const seen = new Set<string>();

/**
 * The run's JSON lines, each checked against its schema: a result against its command's,
 * any other line against `events.json`. The last line's exit code is the process's.
 */
function checked(run: Run): Line[] {
  const lines = jsonLines(run.stdout);
  for (const line of lines) {
    const name = line.type === 'result' ? `${String(line.command)}.json` : 'events.json';
    const validate = ajv.getSchema(name);
    if (validate === undefined) throw new Error(`no schema named ${name}`);
    if (!validate(line)) {
      throw new Error(
        `${name}: ${ajv.errorsText(validate.errors, { dataVar: 'line' })}\n${JSON.stringify(line).slice(0, 2000)}`,
      );
    }
    record(line);
  }
  expect(lines.at(-1)?.exitCode, run.stderr).toBe(run.status);
  return lines;
}

function result(run: Run): Line {
  const last = checked(run).at(-1);
  if (last?.type !== 'result') throw new Error(`no result: ${run.stdout.slice(-500)}`);
  return last;
}

function record(line: Line): void {
  if (line.type === 'progress') seen.add(`progress ${String(line.stage)}`);
  else if (line.type === 'diagnostic') seen.add(`diagnostic ${String(line.source)}`);
  else if (line.type === 'error') {
    seen.add(line.reason === undefined ? 'error without a reason' : 'error with a reason');
  } else recordResult(line);
}

/** Branches of a result's schema that only some runs reach, each with how to tell. */
const RESULT_BRANCHES: readonly (readonly [string, (line: Line) => boolean])[] = [
  ['audit savings', (line) => line.command === 'audit' && line.savings !== null],
  ['audit no savings', (line) => line.command === 'audit' && line.savings === null],
  ['check --changed', (line) => line.command === 'check' && line.changed !== null],
  ['check unread', (line) => line.command === 'check' && line.unread !== undefined],
  ['init ties', (line) => line.command === 'init' && line.ties !== undefined],
  ['optimize --only', (line) => line.command === 'optimize' && line.only !== null],
  ['optimize applied', (line) => line.command === 'optimize' && line.run !== null],
  ['dedupe applied', (line) => line.command === 'dedupe' && line.run !== null],
  [
    'refs unfollowed',
    (line) => line.command === 'refs' && (line.unfollowed as unknown[]).length > 0,
  ],
  ['undo a run', (line) => line.command === 'undo' && line.undone !== null],
  ['undo none', (line) => line.command === 'undo' && line.undone === null],
];

function recordResult(line: Line): void {
  seen.add(`result ${String(line.command)}`);
  if (line.report !== undefined) recordReport(line.report as Report);
  if (line.command === 'refs') seen.add(`verdict ${(line.verdict as Kind).kind}`);
  if (line.command === 'check') {
    for (const finding of line.findings as Kind[]) seen.add(`check ${finding.kind}`);
  }
  for (const [branch, reached] of RESULT_BRANCHES) if (reached(line)) seen.add(branch);
}

interface Kind {
  readonly kind: string;
}

interface Report {
  readonly findings: readonly (Kind & { readonly note?: string })[];
  readonly unusedVectors: { readonly assets: readonly unknown[] | null };
  readonly keptOriginals: { readonly assets: readonly unknown[] };
  readonly declined: { readonly assets: readonly unknown[] | null };
  readonly staleConversions: readonly unknown[];
  readonly references: {
    readonly unsafe: readonly { readonly resolution: string }[];
    readonly discarded: readonly unknown[] | null;
  };
}

function recordReport(report: Report): void {
  for (const finding of report.findings) {
    seen.add(`finding ${finding.kind}`);
    if (finding.note !== undefined) seen.add('finding with a note');
  }
  for (const entry of report.references.unsafe) seen.add(`unsafe ${entry.resolution}`);
  if ((report.unusedVectors.assets ?? []).length > 0) seen.add('unused vectors listed');
  if ((report.references.discarded ?? []).length > 0) seen.add('discarded listed');
  if ((report.declined.assets ?? []).length > 0) seen.add('declined listed');
  if (report.keptOriginals.assets.length > 0) seen.add('kept originals');
  if (report.staleConversions.length > 0) seen.add('stale conversion');
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A PNG of one colour, made by the engine's own image library. */
function png(width: number, height: number, red: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: red, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
}

/**
 * A plain site whose folder is served as it is, made to produce every finding: a converting
 * photo, two identical copies, an image too wide, a file that is not an image, a typo, a
 * missing image beside its SVG, a reference into node_modules, a path built at runtime, an
 * alias nothing maps, a script that does not parse, an image named only in a text file, a
 * path-like string in JSON that leads nowhere, an unused image and an unused SVG.
 */
async function everythingSite(): Promise<string> {
  const root = tempFolder(roots, 'upfly-schema-site-');
  const fixture = (path: string) => join(FIXTURES, path);
  write(
    root,
    'index.html',
    [
      '<!doctype html>',
      '<img src="img/banner.png" alt="">',
      '<img src="img/copy-a.png" alt="">',
      '<img src="img/copy-b.png" alt="">',
      '<img src="img/wide.png" alt="">',
      '<img src="img/not-image.png" alt="">',
      '<img src="img/logo.pn" alt="">',
      '<img src="img/hero.png" alt="">',
      '<img src="node_modules/pkg/pic.png" alt="">',
      '<script type="module" src="app.js"></script>',
      '',
    ].join('\n'),
  );
  write(
    root,
    'app.js',
    "import brand from '@/brand/logo.png';\nexport const photo = `${window.base}/photo-${window.n}.jpg`;\nexport { brand };\n",
  );
  write(root, 'broken.js', 'export const = ;\n');
  write(root, 'notes.txt', 'The old header used img/maybe.png.\n');
  write(root, 'data.json', '{ "icon": "icons/gone.png" }\n');
  write(root, 'img/banner.png', readFileSync(fixture('vite-react/src/assets/banner.png')));
  write(root, 'img/copy-a.png', readFileSync(fixture('plain-html/images/logo.png')));
  copyFileSync(join(root, 'img/copy-a.png'), join(root, 'img/copy-b.png'));
  write(root, 'img/wide.png', await png(4001, 2, 200));
  write(root, 'img/not-image.png', 'not an image\n');
  write(root, 'img/maybe.png', readFileSync(fixture('plain-html/images/texture.png')));
  write(root, 'img/unused.png', readFileSync(fixture('vite-react/public/screenshot.png')));
  write(root, 'img/hero.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>\n');
  write(root, 'img/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n');
  write(root, 'node_modules/pkg/pic.png', await png(3, 3, 10));
  return root;
}

describe('every --json line validates against the published schemas', () => {
  let site = '';
  beforeAll(async () => {
    site = await everythingSite();
    commitAll(site);
  });

  it('audit, with the lists that are null unless asked for', () => {
    const listed = result(
      upfly([
        'audit',
        site,
        '--json',
        '--public',
        '.',
        '--include-discarded',
        '--include-unused-svg',
      ]),
    );
    expect((listed.report as Report).findings.length).toBeGreaterThan(0);
    result(upfly(['audit', site, '--json', '--public', '.', '--no-probe']));
  }, 120_000);

  it('dedupe, applied and committed, and undo putting it back', () => {
    result(upfly(['dedupe', site, '--json', '--public', '.']));
    const applied = result(
      upfly(['dedupe', site, '--json', '--public', '.', '--apply', '--commit']),
    );
    expect(applied.commit).toMatch(/^[0-9a-f]{40}$/);
    const undone = result(upfly(['undo', site, '--json']));
    expect(undone.undone).not.toBeNull();
    result(upfly(['undo', site, '--json']));
  }, 120_000);

  it('optimize refusing, planning with --only and --include-declined, then applying', () => {
    // Undo left the dedupe commit's files changed, so --apply refuses until they are committed.
    const refused = checked(upfly(['optimize', site, '--json', '--public', '.', '--apply']));
    expect(refused.at(-1)?.reason).toBe('UNCOMMITTED_CHANGES');
    git(site, 'add', '-A');
    git(site, 'commit', '--quiet', '-m', 'the undo');

    result(
      upfly([
        'optimize',
        site,
        '--json',
        '--public',
        '.',
        '--include-declined',
        '--only',
        'img/*.png',
        '--only',
        'nothing/*.gif',
      ]),
    );
    const applied = result(
      upfly([
        'optimize',
        site,
        '--json',
        '--public',
        '.',
        '--keep-originals',
        '--apply',
        '--commit',
      ]),
    );
    expect((applied.run as { created: string[] }).created).toContain('img/banner.webp');
    // An original kept beside its converted file, as --keep-originals asks, shows in the next
    // audit.
    result(upfly(['audit', site, '--json', '--public', '.', '--no-probe']));
    result(upfly(['undo', site, '--json']));
  }, 180_000);

  it('check passing, failing, and limited to a change', () => {
    const failed = result(upfly(['check', site, '--json', '--public', '.']));
    expect(failed.passed).toBe(false);
    result(upfly(['check', site, '--json', '--public', '.', '--changed']));

    const small = tempFolder(roots, 'upfly-schema-check-');
    write(small, 'index.html', '<img src="big.png" alt="">\n');
    write(small, 'big.png', readFileSync(join(FIXTURES, 'vite-react/src/assets/banner.png')));
    write(
      small,
      'upfly.config.json',
      '{ "publicDirs": ["."], "check": { "maxImageBytes": 1000 } }\n',
    );
    const tooLarge = result(upfly(['check', small, '--json']));
    expect(tooLarge.exitCode).toBe(1);
    write(small, 'upfly.config.json', '{ "publicDirs": ["."] }\n');
    expect(result(upfly(['check', small, '--json'])).passed).toBe(true);
  }, 120_000);

  it('refs, one image per verdict', () => {
    for (const image of [
      'img/banner.png',
      'img/not-image.png',
      'img/unused.png',
      'img/maybe.png',
    ]) {
      result(upfly(['refs', join(site, image), site, '--json', '--public', '.']));
    }
    const missing = checked(upfly(['refs', join(site, 'img/nothing.png'), site, '--json']));
    expect(missing.at(-1)?.exitCode).toBe(2);
  }, 120_000);

  it('init, with the folders it found, with a tie, and refusing a second time', () => {
    const plain = copyFixture('plain-html', tempFolder(roots, 'upfly-schema-init-'));
    result(upfly(['init', plain, '--json']));
    const again = checked(upfly(['init', plain, '--json']));
    expect(again.at(-1)?.reason).toBe('CONFIG_EXISTS');

    // Every page path resolves both at the top and under images/, so neither can be chosen.
    const tie = tempFolder(roots, 'upfly-schema-tie-');
    write(tie, 'index.html', '<img src="/a.png"><img src="/b.png"><img src="/c.png">\n');
    for (const name of ['a', 'b', 'c']) {
      write(tie, `${name}.png`, readFileSync(join(FIXTURES, 'plain-html/images/logo.png')));
      write(tie, `images/${name}.png`, readFileSync(join(FIXTURES, 'plain-html/images/logo.png')));
    }
    expect(result(upfly(['init', tie, '--json'])).ties).toBeDefined();
  }, 120_000);

  it('the serving root unknown, usage errors, and a real fixture', () => {
    // Ten root-relative paths, none of which any folder resolves.
    const unknown = tempFolder(roots, 'upfly-schema-unknown-');
    const pages = Array.from({ length: 10 }, (_, n) => `<img src="/pics/${n}.png">`);
    write(unknown, 'index.html', `${pages.join('\n')}\n`);
    write(unknown, 'assets/a.png', readFileSync(join(FIXTURES, 'plain-html/images/logo.png')));
    result(upfly(['audit', unknown, '--json', '--no-probe']));
    expect(checked(upfly(['optimize', unknown, '--json'])).at(-1)?.reason).toBe(
      'SERVING_ROOT_UNKNOWN',
    );

    checked(upfly(['optimize', '--commit', '--json']));
    checked(upfly(['nothing', '--json']));

    const vite = copyFixture('vite-react', tempFolder(roots, 'upfly-schema-vite-'));
    result(upfly(['audit', vite, '--json']));
    result(upfly(['optimize', vite, '--json']));
  }, 180_000);

  it('reached every branch the schemas describe', () => {
    const expected = [
      'progress discovered',
      'progress scanned',
      'progress resolved',
      'progress measured',
      'progress audited',
      'progress planned',
      'progress written',
      'diagnostic image',
      'diagnostic parser',
      'error with a reason',
      'error without a reason',
      'result audit',
      'audit savings',
      'audit no savings',
      'result optimize',
      'result undo',
      'result check',
      'result init',
      'result refs',
      'result dedupe',
      'finding dead',
      'finding possibly-dead',
      'finding broken',
      'finding with a note',
      'finding serving-root-unknown',
      'finding oversized',
      'finding format-opportunity',
      'finding duplicate',
      'unsafe dynamic',
      'unsafe unresolved-alias',
      'unsafe out-of-scope',
      'unused vectors listed',
      'discarded listed',
      'declined listed',
      'kept originals',
      'stale conversion',
      'verdict converts',
      'verdict not-converted',
      'verdict unused',
      'verdict possibly-unused',
      'check broken',
      'check too-large',
      'check --changed',
      'check unread',
      'init ties',
      'optimize --only',
      'optimize applied',
      'dedupe applied',
      'refs unfollowed',
      'undo a run',
      'undo none',
    ];
    expect(expected.filter((branch) => !seen.has(branch))).toEqual([]);
  });
});
