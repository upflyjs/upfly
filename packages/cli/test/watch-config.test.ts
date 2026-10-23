/**
 * The `watch` settings an editor keeps in `upfly.config.json`, through the built binary: every
 * command reads them, checks them, and does exactly what it does without them.
 */

import { existsSync, rmSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BIN, copyFixture, jsonLines, tempFolder, upfly, write } from './helpers.js';

/** The $schema line `init` writes, which marks a JSON config as this CLI's. */
const CONFIG_SCHEMA = './node_modules/upfly/schema/config.json';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WATCH = {
  folders: ['images'],
  skip: ['images/vendor'],
  keepOriginals: false,
  outside: 'replace',
};

function site(config: Record<string, unknown>): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-watch-'));
  write(
    root,
    'upfly.config.json',
    JSON.stringify({ $schema: CONFIG_SCHEMA, publicDirs: ['.'], ...config }),
  );
  return root;
}

/** The last line of a `--json` run, with the folder it ran in written as `<root>`. */
function answer(args: readonly string[], root: string): string {
  const run = upfly([...args, root, '--json']);
  expect(run.status, run.stderr).toBe(0);
  return JSON.stringify(jsonLines(run.stdout).at(-1)).replaceAll(
    JSON.stringify(root).slice(1, -1),
    '<root>',
  );
}

describe('a config with watch settings', () => {
  it.each([['audit'], ['optimize'], ['check', '--warn']])(
    '%s answers as it does without them',
    (...args) => {
      expect(answer(args, site({ watch: WATCH }))).toBe(answer(args, site({})));
    },
    120_000,
  );

  it('stops every command with exit 2 when a watch setting is wrong, naming it', () => {
    const root = site({ watch: { ...WATCH, keepOriginals: 'yes' } });

    const run = upfly(['audit', root, '--json']);

    expect(run.status).toBe(2);
    expect(jsonLines(run.stdout).at(-1)?.message).toContain(
      '`watch.keepOriginals` must be true or false.',
    );
  });
});
