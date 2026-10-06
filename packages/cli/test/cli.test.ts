/**
 * The built `upfly` binary, run as a user runs it. Importing the command functions would
 * pass while the shipped `bin` was broken, so every test here spawns `dist/bin.js`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const NO_NETWORK = fileURLToPath(new URL('./no-network.mjs', import.meta.url));
const KILL_SWITCH = readFileSync(fileURLToPath(new URL('./v2-kill-switch.json', import.meta.url)));
/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A small site: one image a page uses, one nothing uses. Outside the workspace. */
function site(extra: Record<string, string | Buffer> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'upfly-cli-'));
  roots.push(root);
  const files: Record<string, string | Buffer> = {
    'index.html': '<img src="img/used.png">\n',
    'img/used.png': PNG,
    'img/unused.png': PNG,
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function upfly(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; preload?: string } = {},
) {
  const env = { ...process.env, ...options.env };
  for (const key of ['NO_COLOR', 'FORCE_COLOR']) if (!(key in (options.env ?? {}))) delete env[key];
  const result = spawnSync(
    process.execPath,
    [...(options.preload ? ['--import', pathToFileURL(options.preload).href] : []), BIN, ...args],
    { encoding: 'utf8', env },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every file under `root` with a hash of its bytes, to prove a command wrote nothing. */
function snapshot(root: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, snapshot(root, path));
    else
      files[path] = createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
  }
  return files;
}

describe('upfly', () => {
  it('prints the version in its package.json, and its help', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(upfly(['--version'])).toEqual({
      status: 0,
      stdout: `${manifest.version}\n`,
      stderr: '',
    });
    const help = upfly(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: upfly <command> [dir] [options]');
    expect(upfly(['audit', '--help']).stdout).toContain('Usage: upfly audit [dir] [options]');
  });

  it('exits 2 on a usage error and names it, without colour when stderr is not a terminal', () => {
    const result = upfly(['audit', '--nope']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('upfly: unknown option `--nope`\nSee `npx upfly audit --help`.\n');
  });
});

describe('upfly audit', () => {
  it('prints a summary, keeps the full report in its own folder, and changes no project file', () => {
    const root = site();
    const before = snapshot(root);

    const result = upfly(['audit', root, '--no-probe']);
    const after = snapshot(root);
    const report = readFileSync(join(root, '.upfly/audit.txt'), 'utf8');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Upfly audit');
    expect(result.stdout).toContain('  Full report  .upfly/audit.txt\n');
    expect(report).toContain('img/unused.png');
    expect(Object.keys(after).filter((path) => path.startsWith('.upfly/'))).toEqual([
      '.upfly/.gitignore',
      '.upfly/audit.txt',
    ]);
    expect(
      Object.fromEntries(Object.entries(after).filter(([path]) => !path.startsWith('.upfly/'))),
    ).toEqual(before);
  });

  it('says under a broken reference that its extension is a likely typo, in the text and the JSON', () => {
    const root = site({ 'about.html': '<p>About</p>\n<img src="img/used.pn">\n' });

    const human = upfly(['audit', root, '--no-probe', '--full']);
    const json = upfly(['audit', root, '--no-probe', '--json']);
    const report = JSON.parse(json.stdout.trimEnd().split('\n').at(-1) ?? '{}').report;

    expect(human.status).toBe(0);
    expect(human.stdout).toContain(
      '      about.html:2  img/used.pn\n        ends in .pn, one keystroke from .png: a likely typo, so no image shows here\n',
    );
    expect(report.findings).toContainEqual({
      kind: 'broken',
      file: 'about.html',
      line: 2,
      where: 'about.html:2',
      rawPath: 'img/used.pn',
      note: 'ends in .pn, one keystroke from .png: a likely typo, so no image shows here',
    });
  });

  it('counts the messages the parsers left, without claiming they concern the files listed', () => {
    const result = upfly(['audit', site({ 'src/broken.scss': '.a { color: red' }), '--no-probe']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'The imaging and parsing libraries left 1 message of their own; `npx upfly audit --json` includes their text.',
    );
  });

  it('prints JSON lines under --json: progress first, the report last', () => {
    const result = upfly(['audit', site(), '--json', '--no-probe']);
    const lines = result.stdout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(result.status).toBe(0);
    expect(lines.at(-1)).toMatchObject({ type: 'result', command: 'audit', exitCode: 0 });
    expect(lines.at(-1).report.version).toBe(7);
    expect(lines.slice(0, -1).map((line) => [line.type, line.stage])).toEqual([
      ['progress', 'discovered'],
      ['progress', 'scanned'],
      ['progress', 'resolved'],
      ['progress', 'audited'],
    ]);
  });

  it('refuses the v2 extension config with exit 3, leaves it untouched, and says what to do', () => {
    const root = site({ 'upfly.config.json': KILL_SWITCH });

    const human = upfly(['audit', root]);
    const json = upfly(['audit', root, '--json']);

    expect(human.status).toBe(3);
    expect(human.stderr).toContain('Upfly VS Code extension (v2)');
    expect(human.stderr).toContain('create upfly.config.ts');
    expect(json.status).toBe(3);
    expect(JSON.parse(json.stdout)).toMatchObject({ type: 'error', exitCode: 3 });
    expect(readFileSync(join(root, 'upfly.config.json'))).toEqual(KILL_SWITCH);
  });

  it('reads upfly.config.ts ahead of the v2 file beside it', () => {
    const root = site({
      'upfly.config.json': KILL_SWITCH,
      'upfly.config.ts': "export default { publicDirs: ['.'] };\n",
    });

    const result = upfly(['audit', root, '--json', '--no-probe']);
    const report = JSON.parse(result.stdout.trimEnd().split('\n').at(-1) ?? '{}').report;

    expect(result.status).toBe(0);
    expect(report.coverage.servingRoots).toMatchObject({ dirs: [''], declared: true });
  });

  it('opens no connection and resolves no name, with a config file to load', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'upfly-net-')), 'attempts.log');
    roots.push(dirname(log));
    const env = { UPFLY_NETWORK_LOG: log };

    // The preload works: a script that fetches is caught and logged.
    spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(NO_NETWORK).href,
        '-e',
        "fetch('https://example.com').catch(() => {})",
      ],
      { env: { ...process.env, ...env } },
    );
    expect(readFileSync(log, 'utf8')).toBe('fetch\n');
    rmSync(log);

    const root = site({ 'upfly.config.ts': "export default { format: 'webp' };\n" });
    const result = upfly(['audit', root], { env, preload: NO_NETWORK });

    expect(result.status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
});
