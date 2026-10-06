import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { upflyCommand } from './invocation.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder outside the workspace holding these files. */
function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'upfly-invocation-'));
  folders.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

/** The line npm's Windows shim runs, naming the script relative to the shim's own folder. */
function shim(script: string): string {
  return `@ECHO off\r\nendLocal & "%_prog%"  "%dp0%\\${script}" %*\r\n`;
}

const SCRIPT = join('node_modules', 'upfly', 'dist', 'bin.js');

describe('how a printed command is typed', () => {
  it('is upfly for a global install whose shim on PATH runs this script, as npm makes on Windows', () => {
    const global = folder({ [SCRIPT]: '', 'upfly.cmd': shim(SCRIPT) });

    expect(upflyCommand({ PATH: global }, join(global, SCRIPT))).toBe('upfly');
  });

  it('is upfly for a global install whose command on PATH is this script, as npm links on Linux and macOS', () => {
    const global = folder({ 'bin/upfly': '' });

    expect(upflyCommand({ PATH: join(global, 'bin') }, join(global, 'bin', 'upfly'))).toBe('upfly');
  });

  it('is npx upfly whenever a package manager started the run, global install or not', () => {
    const global = folder({ [SCRIPT]: '', 'upfly.cmd': shim(SCRIPT) });

    for (const agent of ['npm/11.1.0 node/v22.14.0 win32 x64', 'pnpm/10.12.1', 'yarn/1.22.22']) {
      expect(
        upflyCommand({ PATH: global, npm_config_user_agent: agent }, join(global, SCRIPT)),
      ).toBe('npx upfly');
    }
  });

  it('is npx upfly for a project install, though its own .bin folder is on PATH', () => {
    const project = folder({ [SCRIPT]: '', 'node_modules/.bin/upfly.cmd': shim(`..\\${SCRIPT}`) });

    expect(
      upflyCommand({ PATH: join(project, 'node_modules', '.bin') }, join(project, SCRIPT)),
    ).toBe('npx upfly');
  });

  it('is npx upfly when it cannot be told: no script, a script that is gone, or nothing on PATH', () => {
    const global = folder({ [SCRIPT]: '', 'upfly.cmd': shim(SCRIPT) });

    expect(upflyCommand({ PATH: global }, undefined)).toBe('npx upfly');
    expect(upflyCommand({ PATH: global }, join(global, 'gone.js'))).toBe('npx upfly');
    expect(upflyCommand({}, join(global, SCRIPT))).toBe('npx upfly');
  });
});
