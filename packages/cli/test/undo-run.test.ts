/**
 * `upfly undo --run <id>`, which undoes an earlier run whose record is kept, through the built
 * binary on copies of the plain HTML fixture with two applied runs in them.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BIN, commitAll, copyFixture, jsonLines, snapshot, tempFolder, upfly } from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOT_THE_PROJECT = ['.git', '.upfly'];

function last(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

/** A run converting the one image `only` names, its original removed. */
function convert(root: string, only: string, ...flags: string[]): string {
  const run = upfly([
    'optimize',
    root,
    '--apply',
    '--replace',
    '--public',
    '.',
    '--only',
    only,
    '--json',
    ...flags,
  ]);
  expect(run.status, run.stdout).toBe(0);
  return (last(run.stdout).run as { id: string }).id;
}

/**
 * Two runs on one copy: the first converts `first`, the second `second`, over the first's
 * uncommitted changes.
 */
function twoRuns(first: string, second: string) {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-runs-'));
  commitAll(root);
  const before = snapshot(root, NOT_THE_PROJECT);
  const a = convert(root, first);
  const b = convert(root, second, '--allow-dirty');
  return { root, before, a, b };
}

/**
 * Three runs on one copy, then the last run's record deleted by hand: the first and the third
 * convert images `index.html` names, the second one `css/site.css` names.
 */
function threeRunsWithoutTheLastRecord() {
  const { root, a, b } = twoRuns('images/logo.png', 'images/texture.png');
  convert(root, 'images/inline.png', '--allow-dirty');
  rmSync(join(root, '.upfly', 'manifest.json'));
  return { root, a, b };
}

function undo(root: string, ...args: string[]) {
  return upfly(['undo', ...args], { cwd: root });
}

describe('undo --run', () => {
  it('undoes an earlier run whose files no later run changed, and the later one stands', () => {
    const { root, before, a, b } = twoRuns('images/logo.png', 'images/texture.png');
    const afterBoth = snapshot(root, NOT_THE_PROJECT);

    const earlier = undo(root, '--run', a, '--json');

    expect(earlier.status, earlier.stdout).toBe(0);
    expect(last(earlier.stdout)).toMatchObject({
      undone: { id: a, restored: ['images/logo.png'], reverted: ['index.html'] },
    });
    const now = snapshot(root, NOT_THE_PROJECT);
    expect(now['index.html']).toBe(before['index.html']);
    expect(now['images/logo.png']).toBe(before['images/logo.png']);
    expect(now['images/logo.webp']).toBeUndefined();
    expect(now['css/site.css']).toBe(afterBoth['css/site.css']);
    expect(now['images/texture.webp']).toBe(afterBoth['images/texture.webp']);

    const latest = undo(root, '--json');
    expect(last(latest.stdout)).toMatchObject({ undone: { id: b } });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);

  it('refuses while a later run that changed the same file stands, naming it, then undoes it', () => {
    const { root, before, a, b } = twoRuns('images/logo.png', 'images/hero.jpg');
    const afterBoth = snapshot(root, NOT_THE_PROJECT);

    const refused = undo(root, '--run', a, '--json');

    expect(refused.status).toBe(3);
    expect(last(refused.stdout)).toMatchObject({
      reason: 'LATER_RUN_STANDS',
      message: expect.stringContaining(`Undo ${b} first`),
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(afterBoth);
    expect(undo(root, '--run', a, '--file', 'index.html', '--line', '10').status).toBe(3);

    expect(undo(root).status).toBe(0);
    const earlier = undo(root, '--run', a);
    expect(earlier.status, earlier.stderr).toBe(0);
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);

  it('undoes one line of an earlier run, and lists the kept runs newest first', () => {
    const { root, a, b } = twoRuns('images/logo.png', 'images/texture.png');

    const part = undo(root, '--run', a, '--file', 'index.html', '--line', '10', '--json');
    const listed = undo(root, '--list', '--json');
    const named = undo(root, '--list', '--run', a, '--json');

    expect(part.status, part.stdout).toBe(0);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('images/logo.png');
    expect((last(listed.stdout).runs as { id: string }[]).map((run) => run.id)).toEqual([b, a]);
    expect((last(named.stdout).run as { id: string }).id).toBe(a);
  }, 120_000);

  it('lists the runs still kept newest first when the record of the last run is gone', () => {
    const { root, a, b } = threeRunsWithoutTheLastRecord();

    const listed = undo(root, '--list', '--json');

    expect(listed.status, listed.stdout).toBe(0);
    expect(last(listed.stdout)).toMatchObject({
      run: null,
      notes: [expect.stringContaining('.upfly/manifest.json, is gone')],
    });
    expect((last(listed.stdout).runs as { id: string }[]).map((run) => run.id)).toEqual([b, a]);
  }, 120_000);

  it('undoes nothing on a plain undo when the record of the last run is gone, and names --run', () => {
    const { root } = threeRunsWithoutTheLastRecord();
    const before = snapshot(root, NOT_THE_PROJECT);

    const plain = undo(root, '--json');

    expect(plain.status, plain.stdout).toBe(0);
    expect(last(plain.stdout)).toMatchObject({
      undone: null,
      notes: [expect.stringContaining('undo --run <id> undoes one of them')],
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 120_000);

  it('names a run that is not kept as a usage error', () => {
    const { root } = twoRuns('images/logo.png', 'images/texture.png');

    const missing = undo(root, '--run', '20260101T000000-dead', '--json');

    expect(missing.status).toBe(2);
    expect(last(missing.stdout)).toMatchObject({ reason: 'RUN_NOT_FOUND' });
  }, 120_000);
});
