/**
 * `upfly undo` through the built binary, after real applied runs on copies of the plain
 * HTML fixture outside the workspace.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
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

const NOT_THE_PROJECT = ['.git', '.upfly'];

const POLICIES = [
  ['keep-original', []],
  ['replace', ['--replace', '--public', '.']],
] as const;

function standalone(): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-undo-'));
  commitAll(root);
  return root;
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

function manifestState(root: string): string {
  return (JSON.parse(readFileSync(join(root, '.upfly/manifest.json'), 'utf8')) as { state: string })
    .state;
}

describe.each(POLICIES)('upfly undo after optimize --apply, %s', (policy, flags) => {
  it('puts back every file byte for byte, and does nothing the second time', () => {
    const root = standalone();
    const original = snapshot(root, NOT_THE_PROJECT);
    const applied = upfly(['optimize', root, '--apply', '--json', ...flags]);
    expect(applied.status, applied.stderr).toBe(0);
    const run = result(applied.stdout).run as { removed: string[] };
    if (policy === 'replace') expect(run.removed.length).toBeGreaterThan(0);
    expect(snapshot(root, NOT_THE_PROJECT)).not.toEqual(original);

    const undo = upfly(['undo', root]);
    expect(undo.status, undo.stderr).toBe(0);
    expect(undo.stdout).toContain('Every file that run changed is as it was before it.');
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(original);
    expect(manifestState(root)).toBe('reverted');

    const again = upfly(['undo', root]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('was already undone');
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(original);
  }, 120_000);
});

describe('upfly undo', () => {
  it('after a --commit run, restores the files and says the commit is still in the history', () => {
    const root = standalone();
    const original = snapshot(root, NOT_THE_PROJECT);
    expect(upfly(['optimize', root, '--apply', '--commit']).status).toBe(0);
    const commit = git(root, 'rev-parse', 'HEAD').trim();

    const undo = upfly(['undo', root, '--json']);

    expect(undo.status, undo.stderr).toBe(0);
    expect(result(undo.stdout)).toMatchObject({
      type: 'result',
      command: 'undo',
      exitCode: 0,
      commit,
      notes: [expect.stringContaining('still in the history')],
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(original);
    // The restored files are the reverse of that commit, not yet committed.
    expect(git(root, 'status', '--porcelain')).not.toBe('');
  }, 60_000);

  it('changes nothing, and says which file, when one was edited since the run', () => {
    const root = standalone();
    expect(upfly(['optimize', root, '--apply']).status).toBe(0);
    write(root, 'index.html', '<p>edited after the run</p>\n');
    const before = snapshot(root, NOT_THE_PROJECT);

    const undo = upfly(['undo', root, '--json']);

    expect(undo.status).toBe(3);
    expect(result(undo.stdout)).toMatchObject({
      type: 'error',
      reason: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('index.html'),
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 60_000);

  it('changes nothing when a backup of a removed original is gone', () => {
    const root = standalone();
    const applied = upfly(['optimize', root, '--apply', '--replace', '--public', '.', '--json']);
    const run = result(applied.stdout).run as { id: string; removed: string[] };
    const [removed] = run.removed;
    expect(removed).toBeDefined();
    rmSync(join(root, '.upfly/runs', run.id, 'backup', removed as string));
    const before = snapshot(root, NOT_THE_PROJECT);

    const undo = upfly(['undo', root, '--json']);

    expect(undo.status).toBe(3);
    expect(result(undo.stdout)).toMatchObject({
      reason: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('The backup of 1 removed original is gone'),
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 60_000);

  it('puts back a run whose record says it stopped part way', () => {
    const root = standalone();
    const original = snapshot(root, NOT_THE_PROJECT);
    expect(upfly(['optimize', root, '--apply', '--replace', '--public', '.']).status).toBe(0);
    const path = join(root, '.upfly/manifest.json');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('"state": "committed"', '"state": "pending"'),
    );
    expect(manifestState(root)).toBe('pending');

    expect(upfly(['optimize', root, '--apply', '--allow-dirty']).status).toBe(3);
    const undo = upfly(['undo', root]);

    expect(undo.status, undo.stderr).toBe(0);
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(original);
  }, 60_000);

  it('says there is nothing to undo where Upfly has never written', () => {
    const root = standalone();

    const undo = upfly(['undo', root]);

    expect(undo.status).toBe(0);
    expect(undo.stdout).toContain('nothing to undo');
  });

  it('opens no connection and resolves no name', () => {
    const root = standalone();
    expect(upfly(['optimize', root, '--apply']).status).toBe(0);
    const log = join(tempFolder(roots, 'upfly-net-'), 'attempts.log');

    const undo = upfly(['undo', root], { env: { UPFLY_NETWORK_LOG: log }, preload: NO_NETWORK });

    expect(undo.status, undo.stderr).toBe(0);
    expect(existsSync(log)).toBe(false);
  }, 60_000);
});
