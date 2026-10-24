/**
 * A dry run's notes that say what `--apply` would refuse carry the reason its error line would
 * give, so a program can tell them from the other notes without reading their words.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BIN, commitAll, copyFixture, jsonLines, tempFolder, upfly, write } from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plan(command: string, root: string) {
  const run = upfly([command, root, '--public', '.', '--json']);
  expect(run.status, run.stderr).toBe(0);
  return jsonLines(run.stdout).at(-1) as { notes: string[]; applyRefusals: unknown[] };
}

describe.each(['optimize', 'dedupe'])('a dry run of %s', (command) => {
  it('names the note about uncommitted changes by the reason --apply would give', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-refusals-'));
    commitAll(root);
    write(root, 'index.html', '<p>edited</p>\n');

    const result = plan(command, root);

    expect(result.applyRefusals).toEqual([
      { reason: 'UNCOMMITTED_CHANGES', note: expect.stringContaining('Uncommitted changes') },
    ]);
    const [refusal] = result.applyRefusals as { note: string }[];
    expect(result.notes).toContain(refusal?.note);
  });

  it('names the note about a folder git does not track, and none in a clean repository', () => {
    const outside = copyFixture('plain-html', tempFolder(roots, 'upfly-refusals-'));
    const clean = copyFixture('plain-html', join(tempFolder(roots, 'upfly-refusals-'), 'site'));
    commitAll(clean);

    expect(plan(command, outside).applyRefusals).toEqual([
      { reason: 'NO_REPOSITORY', note: expect.any(String) },
    ]);
    expect(plan(command, clean).applyRefusals).toEqual([]);
  });
});
