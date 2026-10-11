/**
 * The progress line names the stages a command runs itself, after the engine's last report,
 * run in this process so that stderr can be a terminal: `refs`' search of every file, and the
 * savings `audit` works out. Each line is cleared before the command's answer.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { copyFixture, tempFolder } from './helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function terminal() {
  const err: string[] = [];
  const io = {
    stdout: { write: () => true, isTTY: true },
    stderr: { write: (text: string) => err.push(text), isTTY: true },
    env: {},
  };
  return { io, err };
}

describe('the progress line, on a terminal', () => {
  it("names refs' search of every file, and clears it before the answer", async () => {
    const root = copyFixture('vite-react', tempFolder(roots, 'upfly-progress-'));
    const { io, err } = terminal();
    expect(await main(['refs', join(root, 'public', 'screenshot.png'), root], io)).toBe(0);
    expect(err).toContain('\r\u001b[2Ksearching every file for public/screenshot.png');
    expect(err.at(-1)).toBe('\r\u001b[2K');
  });

  it('names the savings audit works out, and clears it before the report', async () => {
    const root = copyFixture('vite-react', tempFolder(roots, 'upfly-progress-'));
    const { io, err } = terminal();
    expect(await main(['audit', root], io)).toBe(0);
    expect(err).toContain('\r\u001b[2Kworking out what optimize would save');
    expect(err.at(-1)).toBe('\r\u001b[2K');
  });
});
