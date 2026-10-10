/**
 * The progress line when the engine fails part way, run in this process so that stderr can
 * be a terminal: the command clears the line before the failure is printed, so the message
 * starts on a line of its own with no dot before it, and the dots stop with the run.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempFolder, write } from './helpers.js';

vi.mock('upfly-core', async (importOriginal) => {
  const real = await importOriginal<typeof import('upfly-core')>();
  // Reports the first stage, works long enough for a dot to appear, then fails.
  const failing = async (input: { readonly onProgress?: (event: object) => void }) => {
    input.onProgress?.({ stage: 'discovered', images: 1, files: 2 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    throw new Error('the disk went away');
  };
  return { ...real, runPipeline: failing, optimizeProject: failing };
});

const { main } = await import('../src/main.js');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the progress line when the engine fails', () => {
  it.each([['audit'], ['check'], ['init'], ['refs']])(
    '%s clears it before saying so, and its dots stop',
    async (command) => {
      const root = tempFolder(roots, 'upfly-progress-');
      write(root, 'img/a.png', 'not read: the engine never runs');
      const err: string[] = [];
      const io = {
        stdout: { write: () => true },
        stderr: { write: (text: string) => err.push(text), isTTY: true },
        env: {},
      };
      const operands = command === 'refs' ? [join(root, 'img', 'a.png'), root] : [root];

      expect(await main([command, ...operands], io)).toBe(4);
      expect(err).toContain('\r\u001b[2Kdiscovered: 1 image, 2 files .');
      expect(err.slice(-2)).toEqual([
        '\r\u001b[2K',
        'upfly: failed unexpectedly: the disk went away\n',
      ]);
      const written = err.length;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(err).toHaveLength(written);
    },
  );
});
