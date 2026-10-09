/**
 * `upfly-mcp` as an MCP client meets it: the library's own client, over stdio, on a copy of a
 * fixture. Every tool is listed with whether it writes; each answers exactly what its command
 * prints last with `--json`; a tool that writes does nothing without `apply`, and refuses a
 * folder with uncommitted changes as its command does. The commands are those of the `upfly`
 * this package depends on, which in the workspace is `packages/cli`, the one `upfly()` runs.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commandEnvironment,
  commitAll,
  copyFixture,
  git,
  jsonLines,
  snapshot,
  tempFolder,
  upfly,
} from '../../cli/test/helpers.js';

const SERVER = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

const roots: string[] = [];
let root: string;
let client: Client;

const READ_ONLY = ['audit', 'check', 'refs'];
const MOVE = { from: 'public/screenshot.png', to: 'public/images/screenshot.png' };

beforeAll(async () => {
  root = copyFixture('vite-react', tempFolder(roots, 'upfly-mcp-'));
  commitAll(root);
  client = new Client({ name: 'upfly-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER, root],
      env: commandEnvironment(),
      stderr: 'pipe',
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  for (const folder of roots.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A tool's answer: the JSON line it carries, parsed, and whether it was marked an error. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text?: string }[];
  return { line: JSON.parse(first?.text ?? 'null'), isError: result.isError === true };
}

/** The last line `upfly <args> --json` prints, run from the project folder. */
function cli(...args: string[]): Record<string, unknown> | undefined {
  return jsonLines(upfly([...args, '--json'], { cwd: root }).stdout).at(-1);
}

/** Every file of the project but git's and Upfly's own. */
const files = () => snapshot(root, ['.git', '.upfly']);

describe('upfly-mcp', () => {
  it('lists one tool for each command it serves, each saying whether it writes', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'audit',
      'check',
      'dedupe',
      'move',
      'optimize',
      'refs',
      'undo',
    ]);
    for (const tool of tools) {
      const reads = READ_ONLY.includes(tool.name);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(reads);
      // Unset on a tool that only reads, where the protocol ignores it.
      expect(tool.annotations?.destructiveHint ?? false, tool.name).toBe(!reads);
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
      expect(tool.description, tool.name).toMatch(reads ? /Changes no file/ : /apply/);
    }
  });

  it.each([
    ['audit', {}, ['audit']],
    ['check', {}, ['check']],
    ['refs', { image: 'src/assets/logo.png' }, ['refs', 'src/assets/logo.png']],
    ['optimize', {}, ['optimize']],
    ['dedupe', {}, ['dedupe']],
    ['move', MOVE, ['move', MOVE.from, MOVE.to]],
  ] as const)(
    'answers %s with what the command prints with --json',
    async (name, args, command) => {
      const before = files();
      const { line, isError } = await call(name, args);

      expect(line).toEqual(cli(...command));
      expect(line).toMatchObject({ type: 'result', command: name });
      expect(isError).toBe(false);
      expect(files()).toEqual(before);
    },
  );

  it("reads the folder a call names, and gives the command's own error for one that is not there", async () => {
    expect((await call('check', { dir: root })).line).toEqual(cli('check'));

    const missing = join(root, 'missing');
    const { line, isError } = await call('audit', { dir: missing });
    expect(line).toEqual(cli('audit', missing));
    expect(line).toMatchObject({ type: 'error', exitCode: 2 });
    expect(isError).toBe(true);
  });

  it('refuses an argument its command has no flag for', async () => {
    const result = await client.callTool({
      name: 'optimize',
      arguments: { apply: true, allowDirty: true },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('allowDirty');
  });

  it('undoes nothing unless the call says apply', async () => {
    const before = files();
    const result = await client.callTool({ name: 'undo', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('apply');
    expect(files()).toEqual(before);
  });

  it('refuses to write over uncommitted changes, as the command does, and writes nothing', async () => {
    const app = join(root, 'src/App.jsx');
    appendFileSync(app, '\n');
    const before = files();
    try {
      const { line, isError } = await call('optimize', { apply: true });

      expect(line).toMatchObject({ type: 'error', exitCode: 3, reason: 'UNCOMMITTED_CHANGES' });
      expect(line).toEqual(cli('optimize', '--apply'));
      expect(isError).toBe(true);
      expect(files()).toEqual(before);
    } finally {
      git(root, 'checkout', '--', 'src/App.jsx');
    }
  });

  it('reports progress to a client that asks for it', async () => {
    const stages: unknown[] = [];
    await client.callTool(
      { name: 'audit', arguments: {} },
      { onprogress: (progress) => stages.push(progress.message) },
    );

    expect(stages).toContain('discovered');
  });

  it('writes with apply, commits with commit, and undo with apply puts every file back', async () => {
    const before = files();
    const commits = git(root, 'rev-list', '--count', 'HEAD').trim();

    const applied = await call('optimize', { apply: true, commit: true });
    expect(applied.line).toMatchObject({ type: 'result', command: 'optimize', apply: true });
    expect(files()).not.toEqual(before);
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe(String(Number(commits) + 1));

    const undone = await call('undo', { apply: true });
    expect(undone.line).toMatchObject({ type: 'result', command: 'undo' });
    expect(files()).toEqual(before);
  });
});

describe('a client that opens the 2026-07-28 way', () => {
  it('is served the same tools and answers, with nothing to fall back on', async () => {
    const project = copyFixture('vite-react', tempFolder(roots, 'upfly-mcp-modern-'));
    commitAll(project);
    const modern = new Client(
      { name: 'upfly-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await modern.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, project],
        env: commandEnvironment(),
        stderr: 'pipe',
      }),
    );
    try {
      const { tools } = await modern.listTools();
      const answer = await modern.callTool({ name: 'check', arguments: {} });
      const [first] = answer.content as { type: string; text?: string }[];

      expect(tools).toHaveLength(7);
      expect(JSON.parse(first?.text ?? 'null')).toEqual(
        jsonLines(upfly(['check', '--json'], { cwd: project }).stdout).at(-1),
      );
    } finally {
      await modern.close();
    }
  });
});

describe('the upfly a tool runs', () => {
  it('is the one installed with this package, never one on PATH or in the project', async () => {
    const project = copyFixture('vite-react', tempFolder(roots, 'upfly-mcp-decoy-'));
    // Another `upfly` on PATH, where a global install puts one, and in the project's own
    // `node_modules`, where a project that depends on another version has one; each answers
    // every command with a line of its own.
    const onPath = tempFolder(roots, 'upfly-mcp-path-');
    for (const folder of [onPath, join(project, 'node_modules', '.bin')]) decoy(folder);
    const env = commandEnvironment();
    const path = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[path] = `${onPath}${delimiter}${env[path] ?? ''}`;
    const decoyed = new Client({ name: 'upfly-test', version: '1.0.0' });
    await decoyed.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, project],
        env,
        cwd: project,
        stderr: 'pipe',
      }),
    );
    try {
      const answer = await decoyed.callTool({ name: 'check', arguments: {} });
      const [first] = answer.content as { type: string; text?: string }[];

      expect(JSON.parse(first?.text ?? 'null')).toEqual(
        jsonLines(upfly(['check', '--json'], { cwd: project }).stdout).at(-1),
      );
    } finally {
      await decoyed.close();
    }
  });
});

describe('upfly-mcp on the command line', () => {
  /** Runs the server with no client: an empty input closes the connection at once. */
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [SERVER, ...args], { input: '', encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('prints its help, and the version in its package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(run('--version')).toEqual({ status: 0, stdout: `${manifest.version}\n`, stderr: '' });
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^Usage: upfly-mcp \[dir\]\n/);
  });

  it('serves the current folder when none is named, until the client closes the connection', () => {
    expect(run()).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it.each([
    [['--json'], 'unknown option `--json`'],
    [['--apply'], 'unknown option `--apply`'],
    [['a', 'b'], 'expected one directory, got 2: a b'],
  ])('exits 2 on %j, naming the usage error', (args, message) => {
    expect(run(...args)).toEqual({
      status: 2,
      stdout: '',
      stderr: `upfly-mcp: ${message}\nSee \`upfly-mcp --help\`.\n`,
    });
  });

  it('exits 2 for a folder that is not there, serving nothing', () => {
    const missing = join(tempFolder(roots, 'upfly-mcp-cli-'), 'missing');
    expect(run(missing)).toEqual({
      status: 2,
      stdout: '',
      stderr: `upfly-mcp: ${missing} is not a directory\n`,
    });
  });
});

/** An `upfly` in `folder`, for a shell on any platform, that answers with a line of its own. */
function decoy(folder: string): void {
  const line = '{"type":"result","command":"check","decoy":true}';
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'upfly'), `#!/bin/sh\necho '${line}'\n`, { mode: 0o755 });
  writeFileSync(join(folder, 'upfly.cmd'), `@echo ${line}\r\n`);
}
