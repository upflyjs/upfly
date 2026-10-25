/**
 * `upfly optimize --apply --no-undo`, as an editor converting new images as they arrive runs
 * it, through the built binary, on copies of the plain HTML fixture outside the workspace.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  FIXTURES,
  commitAll,
  copyFixture,
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

const NOT_THE_PROJECT = ['.git', '.upfly'];
const LOGO = join(FIXTURES, 'plain-html/images/logo.png');

interface Run {
  readonly id: string;
  readonly created: string[];
  readonly changed: string[];
  readonly removed: string[];
  readonly undoable: boolean;
}

function standalone(prepare?: (root: string) => void): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-no-undo-'));
  prepare?.(root);
  commitAll(root);
  return root;
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

/** An image arriving, named by a new page, as a person or an agent adds one. */
function arrive(root: string, name: string): void {
  copyFileSync(LOGO, join(root, `images/${name}.png`));
  write(root, `${name}.html`, `<img src="images/${name}.png" alt="">\n`);
}

/** The automatic conversion of one image that arrived. */
function convertAutomatically(root: string, name: string) {
  return upfly([
    'optimize',
    root,
    '--apply',
    '--allow-dirty',
    '--no-undo',
    '--public',
    '.',
    '--only',
    `/images/${name}.png`,
    '--json',
  ]);
}

describe('upfly optimize --apply --no-undo', () => {
  it('leaves the last run for undo, every byte back, through any number of them', () => {
    const root = standalone();
    const original = snapshot(root, NOT_THE_PROJECT);
    const person = upfly(['optimize', root, '--apply', '--public', '.', '--json']);
    expect(person.status, person.stderr).toBe(0);
    const last = result(person.stdout).run as Run;
    expect(last.removed.length).toBeGreaterThan(0);
    const manifest = join(root, '.upfly/manifest.json');
    const record = readFileSync(manifest);
    const recordTime = statSync(manifest).mtimeMs;
    const folder = snapshot(join(root, '.upfly/runs', last.id));

    const automatic: Run[] = [];
    for (const name of ['arrived-a', 'arrived-b', 'arrived-c']) {
      arrive(root, name);
      const converted = convertAutomatically(root, name);
      expect(converted.status, converted.stderr).toBe(0);
      const run = result(converted.stdout).run as Run;
      expect(run).toMatchObject({ created: [`images/${name}.webp`], undoable: false });
      automatic.push(run);
    }

    expect(readFileSync(manifest)).toEqual(record);
    expect(statSync(manifest).mtimeMs).toBe(recordTime);
    expect(snapshot(join(root, '.upfly/runs', last.id))).toEqual(folder);
    expect(existsSync(join(root, '.upfly/no-undo'))).toBe(false);

    const listed = upfly(['undo', root, '--list', '--json']);
    const run = result(listed.stdout).run as {
      id: string;
      files: { path: string; changes: { line: number }[] }[];
    };
    expect(run.id).toBe(last.id);
    const [first] = run.files;
    expect(first).toBeDefined();
    const line = upfly([
      'undo',
      root,
      '--file',
      join(root, first?.path ?? ''),
      '--line',
      String(first?.changes[0]?.line),
    ]);
    expect(line.status, line.stderr).toBe(0);

    const undo = upfly(['undo', root, '--json']);
    expect(undo.status, undo.stderr).toBe(0);
    expect((result(undo.stdout).undone as { id: string }).id).toBe(last.id);
    const theirs = new Set(
      automatic.flatMap((each) => [...each.created, ...each.changed, ...each.removed]),
    );
    const now = snapshot(root, NOT_THE_PROJECT);
    for (const path of new Set([...Object.keys(original), ...Object.keys(now)])) {
      if (theirs.has(path)) continue;
      expect(now[path], path).toBe(original[path]);
    }
  }, 240_000);

  it('refuses the undo of a file it rewrote since that run, naming the file', () => {
    // A line naming an image that does not exist yet: the run leaves it, and the conversion
    // of the image when it arrives rewrites the same file.
    const root = standalone((dir) =>
      writeFileSync(
        join(dir, 'index.html'),
        `${readFileSync(join(dir, 'index.html'), 'utf8')}<img src="images/arrived.png" alt="">\n`,
      ),
    );
    expect(upfly(['optimize', root, '--apply', '--public', '.']).status).toBe(0);
    const changed = (
      result(upfly(['undo', root, '--list', '--json']).stdout).run as {
        files: { path: string }[];
      }
    ).files.map((file) => file.path);
    expect(changed).toContain('index.html');
    copyFileSync(LOGO, join(root, 'images/arrived.png'));
    expect(convertAutomatically(root, 'arrived').status).toBe(0);

    const undo = upfly(['undo', root, '--file', join(root, 'index.html'), '--json']);

    expect(undo.status).toBe(3);
    expect(result(undo.stdout)).toMatchObject({
      reason: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('index.html'),
    });
  }, 120_000);

  it('is refused while another run holds the lock', () => {
    const root = standalone();
    arrive(root, 'arrived');
    mkdirSync(join(root, '.upfly'), { recursive: true });
    const holder = { pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z', runId: 'another' };
    writeFileSync(join(root, '.upfly/lock'), `${JSON.stringify(holder)}\n`);
    const before = snapshot(root, NOT_THE_PROJECT);

    const converted = convertAutomatically(root, 'arrived');

    expect(converted.status).toBe(3);
    expect(result(converted.stdout)).toMatchObject({ reason: 'TRANSACTION_LOCKED' });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 60_000);

  it('says what it wrote, and never points at undo for it', () => {
    const root = standalone();
    arrive(root, 'arrived');

    const converted = upfly([
      'optimize',
      root,
      '--apply',
      '--allow-dirty',
      '--no-undo',
      '--public',
      '.',
      '--only',
      '/images/arrived.png',
    ]);

    expect(converted.status, converted.stderr).toBe(0);
    expect(converted.stdout).toContain('--no-undo');
    expect(converted.stdout).not.toContain('undo puts every file back');
    expect(existsSync(join(root, '.upfly/no-undo'))).toBe(false);
  }, 60_000);

  it('only changes what --apply does', () => {
    const plan = upfly(['optimize', standalone(), '--no-undo']);

    expect(plan.status).toBe(2);
    expect(plan.stderr).toContain('--no-undo');
  });
});

/**
 * A run made without undo, cut off after its last change: a real applied run whose record and
 * folder are moved to the place such a run keeps them, its record pending again.
 */
function cutOff(root: string): string {
  expect(upfly(['optimize', root, '--apply', '--public', '.']).status).toBe(0);
  const record = JSON.parse(readFileSync(join(root, '.upfly/manifest.json'), 'utf8')) as {
    runId: string;
  };
  const folder = `.upfly/no-undo/${record.runId}`;
  mkdirSync(join(root, '.upfly/no-undo'), { recursive: true });
  renameSync(join(root, '.upfly/runs', record.runId), join(root, folder));
  const pending = {
    ...record,
    state: 'pending',
    completedAt: null,
    runDir: folder,
  };
  writeFileSync(
    join(root, '.upfly/no-undo/manifest.json'),
    `${JSON.stringify(pending, null, 2)}\n`,
  );
  rmSync(join(root, '.upfly/manifest.json'));
  return record.runId;
}

const NEXT: readonly (readonly [string, readonly string[]])[] = [
  ['undo', ['undo']],
  ['optimize --apply', ['optimize', '--apply', '--allow-dirty', '--public', '.']],
  [
    'optimize --apply --no-undo',
    [
      'optimize',
      '--apply',
      '--allow-dirty',
      '--no-undo',
      '--public',
      '.',
      '--only',
      '/images/logo.png',
    ],
  ],
];

describe.each(NEXT)('a run made with --no-undo and cut off part way, then %s', (_, args) => {
  it('is put back first, every byte, and the command says so', () => {
    const root = standalone();
    const original = snapshot(root, NOT_THE_PROJECT);
    const id = cutOff(root);
    expect(snapshot(root, NOT_THE_PROJECT)).not.toEqual(original);
    const [command, ...rest] = args;

    const next = upfly([command ?? '', root, ...rest, '--json']);

    expect(next.status, next.stderr).toBe(0);
    expect((result(next.stdout).notes as string[]).join(' ')).toContain(id);
    expect(existsSync(join(root, '.upfly/no-undo'))).toBe(false);
    if (command === 'undo') expect(snapshot(root, NOT_THE_PROJECT)).toEqual(original);
  }, 120_000);
});

describe('a run made with --no-undo and cut off part way, a file of which changed since', () => {
  it('stops the next command that writes, saying how to keep every file as it is', () => {
    const root = standalone();
    cutOff(root);
    write(root, 'index.html', `${readFileSync(join(root, 'index.html'), 'utf8')}<!-- edited -->\n`);
    const before = snapshot(root, NOT_THE_PROJECT);

    const next = upfly(['optimize', root, '--apply', '--allow-dirty', '--public', '.', '--json']);

    expect(next.status).toBe(3);
    expect(result(next.stdout)).toMatchObject({
      reason: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('To keep every file as it is now, delete .upfly/no-undo'),
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);
});

describe('a dry run over a run made with --no-undo and cut off part way', () => {
  it('says the next run that writes puts it back first, and changes nothing', () => {
    const root = standalone();
    const id = cutOff(root);
    const before = snapshot(root, NOT_THE_PROJECT);

    const plan = upfly(['optimize', root, '--public', '.', '--json']);

    expect(plan.status, plan.stderr).toBe(0);
    expect((result(plan.stdout).notes as string[]).join(' ')).toContain(id);
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
    expect(existsSync(join(root, '.upfly/no-undo/manifest.json'))).toBe(true);
  }, 120_000);
});
