/**
 * `upfly optimize --apply --expect-plan <hash>`: an apply that writes only the plan its caller
 * read, named by the hash a dry run gave.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  commitAll,
  copyFixture,
  git,
  jsonLines,
  snapshot,
  tempFolder,
  upfly,
} from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function standalone(): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-plan-guard-'));
  commitAll(root);
  return root;
}

function optimize(root: string, ...args: string[]) {
  const run = upfly(['optimize', root, '--public', '.', '--json', ...args]);
  return { status: run.status, stderr: run.stderr, last: jsonLines(run.stdout).at(-1) ?? {} };
}

describe('optimize --expect-plan', () => {
  it('applies the plan a dry run named by its hash, and gives the same hash', () => {
    const root = standalone();
    const plan = optimize(root);
    expect(plan.last.planHash).toMatch(/^[0-9a-f]{64}$/);

    const applied = optimize(root, '--apply', '--expect-plan', String(plan.last.planHash));

    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.last.planHash).toBe(plan.last.planHash);
    expect(applied.last.run).not.toBeNull();
  }, 60_000);

  it('refuses, writing nothing, when the plan changed since the dry run', () => {
    const root = standalone();
    const plan = optimize(root);
    const page = join(root, 'index.html');
    writeFileSync(
      page,
      readFileSync(page, 'utf8').replace('<img src="images/logo.png" alt="Logo" />', ''),
    );
    git(root, 'commit', '--quiet', '-am', 'the logo goes');
    const before = snapshot(root, ['.git']);

    const applied = optimize(root, '--apply', '--expect-plan', String(plan.last.planHash));

    expect(applied.status).toBe(3);
    expect(applied.last).toMatchObject({ reason: 'PLAN_CHANGED' });
    expect(String(applied.last.message)).toContain('it now converts 4 images');
    expect(snapshot(root, ['.git'])).toEqual(before);
  }, 60_000);

  it('only changes what --apply does', () => {
    const run = upfly(['optimize', standalone(), '--expect-plan', 'abc']);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--expect-plan');
  });
});
