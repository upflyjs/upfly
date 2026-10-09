/**
 * What the tests of the built binary share: running it as a user does, copying a fixture
 * outside the workspace, and git repositories to run it in.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
export const NO_NETWORK = fileURLToPath(new URL('./no-network.mjs', import.meta.url));
export const MODULE_LOG = fileURLToPath(new URL('./module-log.mjs', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/**
 * The temporary folder in its long form. Some machines name it in the short form, and git
 * always answers in the long one, so a path git prints would not match.
 */
export const TEMP = realpathSync.native(tmpdir());

/**
 * Runs `dist/bin.js`. Git is stopped from looking above the temporary folder, where a
 * machine can keep a repository of its own.
 */
export function upfly(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; preload?: string; cwd?: string } = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: TEMP, ...options.env };
  for (const key of ['NO_COLOR', 'FORCE_COLOR']) if (!(key in (options.env ?? {}))) delete env[key];
  const result = spawnSync(
    process.execPath,
    [...(options.preload ? ['--import', pathToFileURL(options.preload).href] : []), BIN, ...args],
    { encoding: 'utf8', env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The environment `upfly` runs a command with, as plain strings, for a process started by
 * something else, such as an MCP client starting `upfly-mcp`.
 */
export function commandEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'NO_COLOR' && key !== 'FORCE_COLOR') env[key] = value;
  }
  return { ...env, GIT_CEILING_DIRECTORIES: TEMP, ...extra };
}

/** The JSON lines a `--json` run printed, parsed. */
export function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A fresh folder under the temporary folder, recorded so the test can remove it. */
export function tempFolder(roots: string[], prefix: string): string {
  const root = mkdtempSync(join(TEMP, prefix));
  roots.push(root);
  return root;
}

/**
 * A copy of a fixture at `into`, which must not exist yet or must be empty. Its
 * `node_modules` is left out: pnpm fills it with links, which Windows lets only some users
 * create, and Upfly never reads it.
 */
export function copyFixture(name: string, into: string): string {
  cpSync(join(FIXTURES, name), into, {
    recursive: true,
    filter: (source) => basename(source) !== 'node_modules',
  });
  return into;
}

export function write(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Runs git in `cwd`, failing the test on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: TEMP },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/**
 * Makes `root` a repository with everything in it committed once. Line endings are kept
 * exactly as written, so a byte comparison after `git revert` means what it says.
 */
export function commitAll(root: string): void {
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Upfly Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
}

/**
 * Every file under `root` with a hash of its bytes, leaving out the folders named in
 * `except`, to prove what a command did or did not write.
 */
export function snapshot(
  root: string,
  except: readonly string[] = [],
  prefix = '',
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (except.includes(path)) continue;
    if (entry.isDirectory()) Object.assign(files, snapshot(root, except, path));
    else {
      files[path] = createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
    }
  }
  return files;
}
