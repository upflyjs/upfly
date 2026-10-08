#!/usr/bin/env node
// @ts-check
/**
 * Proves the packages work as npm will publish them: packs both, checks each tarball holds
 * every file its `files` list names, installs the two tarballs into an empty folder outside
 * the checkout, and runs the installed `upfly` there as a user would. Its `audit --json` on a
 * copy of a fixture must validate against the schemas the tarball shipped, and
 * `optimize --apply --commit` then `undo` on a git repository must put every byte back,
 * the originals the run removed included.
 *
 * Usage: `node tools/packed-install.mjs`, after `pnpm build`. It works in `RUNNER_TEMP` when
 * that is set, as on a CI runner, and in the system's temporary folder otherwise. `npx --no --`
 * never downloads, so a failed install cannot fall through to another version of `upfly`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { missingFromPack, tarPaths } from './pack-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';
const failures = /** @type {string[]} */ ([]);

/**
 * Runs a command, printing it, and returns its output. A non-zero exit is a failure.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} cwd
 * @param {number} [expected] the exit code the step should end with
 */
function run(command, args, cwd, expected = 0) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  // A shell reads the arguments as one line, so one with a space in it is quoted.
  const quoted = WINDOWS ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  const result = spawnSync(command, quoted, {
    cwd,
    encoding: 'utf8',
    // npm, npx and pnpm are command scripts on Windows, which only a shell can start.
    shell: WINDOWS,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== expected) {
    failures.push(`${command} ${args.join(' ')} exited ${result.status}, not ${expected}`);
    process.stdout.write(`${result.stdout}${result.stderr}\n`);
  }
  return result.stdout;
}

/**
 * Every file under `root` with a hash of its bytes, leaving out git's and Upfly's folders.
 *
 * @param {string} root
 * @returns {Map<string, string>}
 */
function fingerprint(root) {
  const files = new Map();
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const posix = entry.split(path.sep).join('/');
    if (/^(?:\.git|\.upfly)(?:\/|$)/.test(posix)) continue;
    try {
      files.set(
        posix,
        createHash('sha256')
          .update(readFileSync(path.join(root, entry)))
          .digest('hex'),
      );
    } catch {
      // A folder, which has no bytes of its own.
    }
  }
  return files;
}

/**
 * The bytes of every file under `root`, links not followed, to say what an install weighs.
 *
 * @param {string} root
 * @returns {number}
 */
function folderBytes(root) {
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) bytes += folderBytes(full);
    else if (entry.isFile()) bytes += statSync(full).size;
  }
  return bytes;
}

/**
 * A copy of the plain HTML fixture at `into`, leaving out any `node_modules`, whose links
 * Windows lets only some users create.
 *
 * @param {string} into
 */
function copyFixture(into) {
  cpSync(path.join(ROOT, 'fixtures', 'plain-html'), into, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });
}

const work = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'upfly-packed-'));
const packs = path.join(work, 'packs');
mkdirSync(packs);

const tarballs = /** @type {string[]} */ ([]);
for (const folder of ['core', 'cli']) {
  const dir = path.join(ROOT, 'packages', folder);
  run('pnpm', ['pack', '--pack-destination', packs], dir);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const tarball = path.join(packs, `${manifest.name}-${manifest.version}.tgz`);
  const missing = missingFromPack(manifest.files ?? [], tarPaths(readFileSync(tarball)));
  if (missing.length > 0) failures.push(`${manifest.name}'s tarball lacks ${missing.join(', ')}`);
  tarballs.push(tarball);
}

const user = path.join(work, 'user');
mkdirSync(user);
run('npm', ['init', '--yes'], user);
run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], user);
const version = run('npx', ['--no', '--', 'upfly', '--version'], user).trim();
const installed = folderBytes(path.join(user, 'node_modules'));
const expectedVersion = JSON.parse(
  readFileSync(path.join(ROOT, 'packages/cli/package.json'), 'utf8'),
).version;
if (version !== expectedVersion)
  failures.push(`upfly --version printed ${version}, not ${expectedVersion}`);

// The audit's JSON, checked against the schemas as installed, which are the ones users get.
const project = path.join(work, 'project');
copyFixture(project);
const lines = run('npx', ['--no', '--', 'upfly', 'audit', project, '--json'], user)
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line));
const { Ajv } = createRequire(path.join(ROOT, 'packages/cli/package.json'))('ajv');
const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addVocabulary(['patternErrorMessage']);
const schemaDir = path.join(user, 'node_modules', 'upfly', 'schema');
for (const file of readdirSync(schemaDir)) {
  ajv.addSchema(JSON.parse(readFileSync(path.join(schemaDir, file), 'utf8')), file);
}
for (const line of lines) {
  const validate = ajv.getSchema(line.type === 'result' ? `${line.command}.json` : 'events.json');
  if (!validate?.(line))
    failures.push(`audit's ${line.type} line: ${ajv.errorsText(validate?.errors)}`);
}
if (lines.at(-1)?.type !== 'result') failures.push('audit --json printed no result');

// `upfly mcp` as installed, through the MCP library's own client: its tools are listed, and
// one answers as its command does, which a dependency missing from the package would stop.
const cliRequire = createRequire(path.join(ROOT, 'packages/cli/package.json'));
const { Client } = await import(
  pathToFileURL(cliRequire.resolve('@modelcontextprotocol/client')).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(cliRequire.resolve('@modelcontextprotocol/client/stdio')).href
);
const installedBin = path.join(user, 'node_modules', 'upfly', 'dist', 'bin.js');
const client = new Client({ name: 'packed-install', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [installedBin, 'mcp', project] }),
);
const tools = (await client.listTools()).tools.map(
  (/** @type {{ name: string }} */ tool) => tool.name,
);
const answer = await client.callTool({ name: 'check', arguments: {} });
await client.close();
const checked = run('npx', ['--no', '--', 'upfly', 'check', project, '--json'], user, 1)
  .trimEnd()
  .split('\n')
  .at(-1);
if (tools.length !== 7) failures.push(`upfly mcp listed ${tools.length} tools, not 7: ${tools}`);
if (answer.content?.[0]?.text !== checked) {
  failures.push(`upfly mcp's check answered ${answer.content?.[0]?.text}, not ${checked}`);
}

// Written, committed, and undone, in a repository of the project's own.
const repo = path.join(work, 'repository');
copyFixture(repo);
for (const args of [
  ['init', '--quiet'],
  ['config', 'user.name', 'Upfly CI'],
  ['config', 'user.email', 'ci@example.com'],
  ['config', 'core.autocrlf', 'false'],
  ['add', '.'],
  ['commit', '--quiet', '--message', 'the project'],
]) {
  run('git', args, repo);
}
const before = fingerprint(repo);
// The policy is named rather than left to the default, and the site is served from the
// project root, so originals are removed and undo has to bring them back.
run(
  'npx',
  ['--no', '--', 'upfly', 'optimize', repo, '--replace', '--public', '.', '--apply', '--commit'],
  user,
);
const commits = run('git', ['rev-list', '--count', 'HEAD'], repo).trim();
if (commits !== '2') failures.push(`optimize --apply --commit left ${commits} commits, not 2`);
const applied = fingerprint(repo);
const written = [...applied].filter(([file, hash]) => before.get(file) !== hash);
const removed = [...before.keys()].filter((file) => !applied.has(file));
if (written.length === 0)
  failures.push('optimize --apply --commit wrote nothing, so undo proves nothing');
if (removed.length === 0)
  failures.push('optimize --apply --commit removed no original, so undo proves nothing of that');
run('npx', ['--no', '--', 'upfly', 'undo', repo], user);
const after = fingerprint(repo);
const different = [...new Set([...before.keys(), ...after.keys()])].filter(
  (file) => before.get(file) !== after.get(file),
);
if (different.length > 0) failures.push(`undo left ${different.join(', ')} different`);

process.stdout.write(
  failures.length === 0
    ? `\npacked install: upfly ${version} installed from its tarball (node_modules ${(installed / 1024 / 1024).toFixed(1)} MB), audit's JSON matches the shipped schemas, and ${written.length} files written, ${removed.length} removed, committed and undone\n`
    : `\npacked install failed:\n${failures.map((failure) => `  ${failure}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
