/**
 * `--no-code-config`, which an editor passes for a folder it does not trust: through the built
 * binary, no command runs a config written as code, and each says so and stops.
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

/** A site whose config, when run, leaves a file behind, so running it can be seen. */
function marked(): { root: string; mark: string } {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-nocode-'));
  const mark = join(tempFolder(roots, 'upfly-nocode-mark-'), 'ran');
  write(
    root,
    'upfly.config.mjs',
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(mark)}, 'ran');\nexport default { publicDirs: ['.'] };\n`,
  );
  commitAll(root);
  return { root, mark };
}

const COMMANDS: readonly (readonly string[])[] = [
  ['audit'],
  ['optimize'],
  ['check'],
  ['refs', 'images/logo.png'],
  ['dedupe'],
  ['move', 'images/logo.png', 'images/brand/logo.png'],
];

describe('--no-code-config', () => {
  it('runs the config without the flag, so the mark below means something', () => {
    const { root, mark } = marked();

    const run = upfly(['audit', '--json'], { cwd: root });

    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(mark)).toBe(true);
  }, 60_000);

  it.each(COMMANDS)(
    'stops %s with exit 3, naming the file, and runs none of it',
    (...args) => {
      const { root, mark } = marked();

      const run = upfly([...args, '--no-code-config', '--json'], { cwd: root });

      expect(run.status, run.stdout).toBe(3);
      expect(jsonLines(run.stdout).at(-1)).toMatchObject({
        type: 'error',
        reason: 'CODE_CONFIG_NOT_RUN',
        message: expect.stringContaining('upfly.config.mjs'),
        file: 'upfly.config.mjs',
      });
      expect(existsSync(mark)).toBe(false);
    },
    60_000,
  );

  it('reads upfly.config.json as before, which is data', () => {
    const root = copyFixture('plain-html', tempFolder(roots, 'upfly-nocode-json-'));
    write(root, 'upfly.config.json', '{ "publicDirs": ["."] }\n');

    const run = upfly(['audit', '--no-code-config', '--json'], { cwd: root });

    expect(run.status, run.stderr).toBe(0);
  }, 60_000);

  it('is taken by undo and init too, which run no config at all', () => {
    const { root, mark } = marked();

    expect(upfly(['undo', '--no-code-config'], { cwd: root }).status).toBe(0);
    expect(upfly(['init', '--no-code-config'], { cwd: root }).status).toBe(3);
    expect(existsSync(mark)).toBe(false);
  }, 60_000);
});
