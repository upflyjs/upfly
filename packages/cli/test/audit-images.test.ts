/**
 * `audit --json --include-images` through the built binary: every image with its size, each
 * reference to it at its file and line, and the kinds of finding that name it; and
 * `--include-text`, the report file's text in the JSON.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BIN, copyFixture, jsonLines, tempFolder, upfly } from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Listed {
  readonly path: string;
  readonly bytes: number;
  readonly references: { file: string; line: number | null; text: string }[];
  readonly findings: string[];
}

describe('audit --include-images', () => {
  it('lists each image with its references at their lines and the findings that name it', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-images-'));

    const run = upfly(['audit', root, '--json', '--public', '.', '--include-images']);

    expect(run.status, run.stderr).toBe(0);
    const images = jsonLines(run.stdout).at(-1)?.images as Listed[];
    expect(images.map((image) => image.path)).toEqual([...images.map((i) => i.path)].sort());
    const hero = images.find((image) => image.path === 'images/hero.jpg');
    expect(hero?.references).toEqual([
      { file: 'index.html', line: 12, text: 'images/hero.jpg' },
      { file: 'index.html', line: 13, text: 'images/hero.jpg' },
    ]);
    expect(hero?.findings).toEqual(['format-opportunity']);
    expect(hero?.bytes).toBeGreaterThan(0);
    const unused = images.find((image) => image.path === 'images/never-referenced.png');
    expect(unused).toMatchObject({ references: [], findings: ['dead', 'duplicate'] });
  }, 60_000);

  it('leaves the images out without the flag, so the default answer stays as it was', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-images-'));

    const run = upfly(['audit', root, '--json', '--public', '.', '--no-probe']);

    expect(run.status, run.stderr).toBe(0);
    expect(jsonLines(run.stdout).at(-1)).not.toHaveProperty('images');
  }, 60_000);

  it('needs --json', () => {
    const run = upfly(['audit', '--include-images']);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--include-images needs --json');
  });
});

describe('audit --include-text', () => {
  it('gives the report file as text in the JSON, writing no file', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-text-'));
    const written = copyFixture('plain-html', tempFolder(roots, 'upfly-text-file-'));
    expect(upfly(['audit', written, '--public', '.', '--no-probe']).status).toBe(0);

    const run = upfly(['audit', root, '--json', '--public', '.', '--no-probe', '--include-text']);

    expect(run.status, run.stderr).toBe(0);
    const text = jsonLines(run.stdout).at(-1)?.text as string;
    const file = readFileSync(join(written, '.upfly/audit.txt'), 'utf8');
    // The file names when the run started and in which folder; the rest is the same text.
    const body = (report: string, folder: string) =>
      report.split('\n').slice(3).join('\n').replaceAll(folder, '<root>');
    expect(body(text, root)).toBe(body(file, written));
    expect(text).toContain('Upfly audit');
    // Nor does the text send its reader to a file the run did not write.
    expect(text).not.toContain('.upfly/audit.txt');
    expect(text).toContain('this report lists them');
    expect(existsSync(join(root, '.upfly'))).toBe(false);
  }, 60_000);
});
