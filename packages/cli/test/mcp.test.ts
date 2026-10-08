/**
 * `upfly mcp` as an MCP client meets it: the library's own client, over stdio, on a copy of a
 * fixture. Every tool is listed with whether it writes; each answers exactly what its command
 * prints last with `--json`; a tool that writes does nothing without `apply`, and refuses a
 * folder with uncommitted changes as its command does.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  MODULE_LOG,
  commandEnvironment,
  commitAll,
  copyFixture,
  git,
  jsonLines,
  snapshot,
  tempFolder,
  upfly,
} from './helpers.js';

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
      args: [BIN, 'mcp', root],
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

describe('upfly mcp', () => {
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

describe('the MCP library', () => {
  it('is loaded by upfly mcp and by no other command', () => {
    const log = (args: readonly string[]) => {
      const file = join(tempFolder(roots, 'upfly-modules-'), 'modules.log');
      spawnSync(process.execPath, ['--import', pathToFileURL(MODULE_LOG).href, BIN, ...args], {
        env: commandEnvironment({ UPFLY_MODULE_LOG: file }),
        // An empty input ends `upfly mcp` at once, as a client closing the connection does.
        input: '',
        encoding: 'utf8',
      });
      return existsSync(file) ? readFileSync(file, 'utf8') : '';
    };
    const project = copyFixture('vite-react', tempFolder(roots, 'upfly-modules-project-'));

    for (const args of [['audit', project], ['check', project], ['--version']]) {
      const loaded = log(args);
      // The control: the log holds what was loaded, the CLI's own entry among it.
      expect(loaded, args.join(' ')).toContain('/dist/main.js');
      expect(loaded, args.join(' ')).not.toContain('@modelcontextprotocol');
    }
    expect(log(['mcp', project])).toContain('@modelcontextprotocol');
  });
});
