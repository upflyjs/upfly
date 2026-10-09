/**
 * The README promises no network, ever, and the server keeps it: `upfly-mcp` and every command
 * its tools run, on a fixture copy, with every way Node offers to reach the network replaced
 * by one that throws and writes down the attempt. The replacement and its own controls are the
 * CLI's, in `packages/cli/test/no-network.test.ts`.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MODULE_LOG,
  NO_NETWORK,
  commandEnvironment,
  commitAll,
  copyFixture,
  tempFolder,
} from '../../cli/test/helpers.js';

const SERVER = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('no tool reaches the network', () => {
  it('upfly-mcp, and every command its tools run', async () => {
    const root = copyFixture('vite-react', tempFolder(roots, 'upfly-net-mcp-'));
    commitAll(root);
    const logs = tempFolder(roots, 'upfly-net-mcp-log-');
    const log = join(logs, 'attempts.log');
    const modules = join(logs, 'modules.log');
    const client = new Client({ name: 'upfly-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          ...['--import', pathToFileURL(NO_NETWORK).href],
          ...['--import', pathToFileURL(MODULE_LOG).href],
          ...[SERVER, root],
        ],
        env: commandEnvironment({ UPFLY_NETWORK_LOG: log, UPFLY_MODULE_LOG: modules }),
        stderr: 'pipe',
      }),
    );
    try {
      for (const [name, args] of [
        ['audit', {}],
        ['check', {}],
        ['refs', { image: 'src/assets/logo.png' }],
        ['dedupe', {}],
        ['move', { from: 'public/screenshot.png', to: 'public/images/screenshot.png' }],
        ['optimize', { apply: true, commit: true }],
        ['undo', { apply: true }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
        expect(existsSync(log), `${name} tried the network`).toBe(false);
      }
    } finally {
      await client.close();
    }
    // The control: sharp is loaded only by a command that measures, never by the server, so
    // its name in the log shows the commands ran with the server's preloads, this one included.
    expect(readFileSync(modules, 'utf8')).toMatch(/[/]sharp[/]/);
  }, 120_000);
});
