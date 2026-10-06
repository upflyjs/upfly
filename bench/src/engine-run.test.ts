/**
 * That the corpus guard is reached, which is a different claim from the guard working.
 *
 * `repos.test.ts` proves `refuseValidationCorpus` refuses. This proves `optimizeTree`
 * calls it, because a guard nothing calls protects nothing.
 */

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filesAfterMove, optimizeTree, runEngine } from './engine-run.js';
import { VALIDATION_ROOT } from './repos.js';

describe('the search after a move', () => {
  it('reads the files the run excluded, since a scope limits what a run changes, never what it reads', async () => {
    // An excluded page that names the image breaks when the image moves, and only a search
    // that reads it can say so.
    const root = await mkdtemp(join(tmpdir(), 'upfly-bench-move-'));
    try {
      const logo = join(
        dirname(fileURLToPath(import.meta.url)),
        '../../fixtures/plain-html/images/logo.png',
      );
      await mkdir(join(root, 'img'));
      await mkdir(join(root, 'legacy'));
      await copyFile(logo, join(root, 'img/a.png'));
      await writeFile(join(root, 'index.html'), '<img src="img/a.png">\n');
      await writeFile(join(root, 'legacy/old.html'), '<img src="../img/a.png">\n');
      await writeFile(join(root, '.upflyignore'), 'legacy/\n');

      const { discovery } = await runEngine(root, { declared: true, dirs: [''] }, false);

      expect(await filesAfterMove(discovery)).toContain('legacy/old.html');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('optimizeTree', () => {
  it('refuses a path inside the pinned corpus before it reads anything', async () => {
    // A directory that does not exist, so that without the guard this rejects on the
    // missing root and still cannot convert a real image. The message tells the two
    // rejections apart.
    const target = join(VALIDATION_ROOT, '__guard-probe-no-such-repository__');

    await expect(optimizeTree(target)).rejects.toThrow(/pinned validation corpus/);
  });
});
