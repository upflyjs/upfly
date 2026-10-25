/**
 * `upfly optimize --image <path>`: images named by their exact paths, whatever characters the
 * paths hold, beside `--only`, which reads a pattern.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BIN, FIXTURES, commitAll, jsonLines, tempFolder, upfly, write } from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const IMAGES = ['logo.png', 'src/assets/logo.png', 'app/blog/[slug]/og.png', 'with space/logo.png'];

/** A site whose images share names and hold characters a pattern reads as its own. */
function site(): string {
  const root = tempFolder(roots, 'upfly-image-');
  for (const image of IMAGES) {
    mkdirSync(dirname(join(root, image)), { recursive: true });
    copyFileSync(join(FIXTURES, 'plain-html/images/logo.png'), join(root, image));
  }
  write(
    root,
    'index.html',
    `${IMAGES.map((image) => `<img src="/${image}" alt="">`).join('\n')}\n`,
  );
  commitAll(root);
  return root;
}

function only(root: string, ...args: string[]) {
  const run = upfly(['optimize', root, '--public', '.', '--json', ...args], { cwd: root });
  return { status: run.status, stderr: run.stderr, result: jsonLines(run.stdout).at(-1) ?? {} };
}

describe('upfly optimize --image', () => {
  it.each(IMAGES)('names %s and no other image', (image) => {
    const run = only(site(), '--image', image);

    expect(run.status, run.stderr).toBe(0);
    expect(run.result.only).toEqual({ images: [image], unmatched: [] });
  });

  it('reads a path from the current folder, in either separator', () => {
    const root = site();

    const run = only(root, '--image', join(root, 'src', 'assets', 'logo.png'));

    expect(run.result.only).toEqual({ images: ['src/assets/logo.png'], unmatched: [] });
  });

  it('leaves --only a pattern, which names both logos', () => {
    const run = only(site(), '--only', 'logo.png');

    expect((run.result.only as { images: string[] }).images).toEqual([
      'logo.png',
      'src/assets/logo.png',
      'with space/logo.png',
    ]);
  });

  it('says so of a path that is not an image in the project, and converts nothing for it', () => {
    const run = only(site(), '--image', 'missing.png');

    expect(run.status).toBe(0);
    expect(run.result.only).toEqual({ images: [], unmatched: ['missing.png'] });
    expect((run.result.notes as string[]).join(' ')).toContain('--image missing.png');
  });

  it('refuses a path outside the project as a usage error', () => {
    const run = upfly(['optimize', site(), '--image', '../elsewhere.png']);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('../elsewhere.png');
  });
});

/** The site with one more image, which no file names yet, as a person pastes one. */
function withNewImage(): string {
  const root = site();
  copyFileSync(join(FIXTURES, 'plain-html/images/logo.png'), join(root, 'fresh.png'));
  commitAll(root);
  return root;
}

describe('upfly optimize --image, an image no file names yet', () => {
  it('converts it, and removes the original, as a paste in the editor wants', () => {
    const root = withNewImage();

    const run = only(root, '--image', 'fresh.png', '--apply');

    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(root, 'fresh.webp'))).toBe(true);
    expect(existsSync(join(root, 'fresh.png'))).toBe(false);
  });

  it('keeps the original with --keep-originals, as an image arriving from outside wants', () => {
    const root = withNewImage();

    const run = only(root, '--image', 'fresh.png', '--apply', '--keep-originals');

    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(root, 'fresh.webp'))).toBe(true);
    expect(existsSync(join(root, 'fresh.png'))).toBe(true);
  });

  it('leaves it as it is under --only, whose pattern a run over the project reads as before', () => {
    const run = only(withNewImage(), '--only', 'fresh.png');

    expect(run.status, run.stderr).toBe(0);
    expect((run.result.plan as { conversions: unknown[] }).conversions).toEqual([]);
  });
});
