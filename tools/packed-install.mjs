#!/usr/bin/env node
// @ts-check
/**
 * Proves the packages work as npm will publish them: packs all three, checks each tarball holds
 * every file its `files` list names, and installs them into an empty folder outside the
 * checkout, `upfly` alone and then `upfly-mcp` beside it, printing what each install weighs.
 * There `upfly` must hold no MCP library, audit a fixture copy with JSON its shipped schemas
 * accept, and write, commit and undo a run byte for byte; `upfly-mcp`, started through npx as
 * a client starts it, must list its seven tools and answer `check` as `upfly` does.
 *
 * Usage: `node tools/packed-install.mjs`, after `pnpm build`. It works in `RUNNER_TEMP` when
 * that is set, as on a CI runner, and in the system's temporary folder otherwise. `npx --no --`
 * never downloads, so a failed install cannot fall through to another version of `upfly`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { missingFromPack, tarPaths } from './pack-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';
const failures = /** @type {string[]} */ ([]);

/** The libraries only `upfly-mcp` needs, which an install of `upfly` alone must not hold. */
const MCP_LIBRARIES = ['@modelcontextprotocol', 'zod'];

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

/** @param {number} bytes */
function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

const tarballs = { core: '', cli: '', mcp: '' };
const versions = new Set();
for (const folder of /** @type {const} */ (['core', 'cli', 'mcp'])) {
  const dir = path.join(ROOT, 'packages', folder);
  run('pnpm', ['pack', '--pack-destination', packs], dir);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const tarball = path.join(packs, `${manifest.name}-${manifest.version}.tgz`);
  const missing = missingFromPack(manifest.files ?? [], tarPaths(readFileSync(tarball)));
  if (missing.length > 0) failures.push(`${manifest.name}'s tarball lacks ${missing.join(', ')}`);
  tarballs[folder] = tarball;
  versions.add(manifest.version);
}
if (versions.size !== 1) failures.push(`the packages have ${versions.size} versions, not one`);

// `upfly` alone, as most people install it.
const user = path.join(work, 'user');
mkdirSync(user);
run('npm', ['init', '--yes'], user);
run('npm', ['install', '--no-audit', '--no-fund', tarballs.core, tarballs.cli], user);
const alone = folderBytes(path.join(user, 'node_modules'));
const brought = MCP_LIBRARIES.filter((name) => existsSync(path.join(user, 'node_modules', name)));
if (brought.length > 0) failures.push(`upfly alone installs ${brought.join(' and ')}`);
const version = run('npx', ['--no', '--', 'upfly', '--version'], user).trim();
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

// `upfly-mcp` beside it. npm takes the `upfly` it depends on from the tarball already
// installed, which has its exact version; one from the registry would answer for another build.
run('npm', ['install', '--no-audit', '--no-fund', tarballs.mcp], user);
const withMcp = folderBytes(path.join(user, 'node_modules'));
const lock = JSON.parse(readFileSync(path.join(user, 'package-lock.json'), 'utf8'));
for (const name of ['upfly-core', 'upfly']) {
  const copies = Object.entries(lock.packages ?? {}).filter(
    ([at]) => at === `node_modules/${name}` || at.endsWith(`/node_modules/${name}`),
  );
  const resolved = copies.map(([, entry]) => String(entry.resolved));
  if (copies.length !== 1 || !resolved[0]?.startsWith('file:')) {
    failures.push(`the install holds ${name} from ${resolved.join(', ')}, not its tarball alone`);
  }
}

// The installed `upfly-mcp` through the MCP library's own client, started as a client starts
// it: through npx, and on Windows through cmd, as its README says. Its tools are listed, and one
// answers as its command does, which a dependency missing from a package would stop.
const mcpRequire = createRequire(path.join(ROOT, 'packages/mcp/package.json'));
const { Client } = await import(
  pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/client')).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/client/stdio')).href
);
const server = ['--no', '--', 'upfly-mcp', project];
const client = new Client({ name: 'packed-install', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: WINDOWS ? 'cmd' : 'npx',
    args: WINDOWS ? ['/c', 'npx', ...server] : server,
    cwd: user,
  }),
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
if (tools.length !== 7) failures.push(`upfly-mcp listed ${tools.length} tools, not 7: ${tools}`);
if (answer.content?.[0]?.text !== checked) {
  failures.push(`upfly-mcp's check answered ${answer.content?.[0]?.text}, not ${checked}`);
}

process.stdout.write(
  failures.length === 0
    ? `\npacked install: upfly ${version} installed from its tarball, audit's JSON matches the shipped schemas, and ${written.length} files written, ${removed.length} removed, committed and undone; upfly-mcp's ${tools.length} tools answer as upfly does. node_modules: upfly alone ${megabytes(alone)}, with upfly-mcp ${megabytes(withMcp)}\n`
    : `\npacked install failed:\n${failures.map((failure) => `  ${failure}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
