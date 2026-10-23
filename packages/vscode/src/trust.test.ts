import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILES } from '../../cli/src/config.js';
import { CODE_CONFIG_FILES, untrustedRefusal } from './trust.js';

const made: string[] = [];

function project(...files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-trust-'));
  made.push(dir);
  for (const file of files) writeFileSync(path.join(dir, file), '');
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CODE_CONFIG_FILES', () => {
  it('names every config file the CLI loads by running it, and no other', () => {
    expect(CODE_CONFIG_FILES).toEqual(CONFIG_FILES.filter((file) => file !== 'upfly.config.json'));
  });
});

describe('untrustedRefusal', () => {
  it('lets a trusted workspace run whatever config it has', () => {
    expect(untrustedRefusal(project('upfly.config.ts'), true)).toBeNull();
  });

  it('lets an untrusted folder run when its only config is JSON, which is data', () => {
    expect(untrustedRefusal(project('upfly.config.json'), false)).toBeNull();
  });

  it('lets an untrusted folder with no config run', () => {
    expect(untrustedRefusal(project(), false)).toBeNull();
  });

  it('refuses an untrusted folder whose config would run its code, and names the file', () => {
    expect(untrustedRefusal(project('upfly.config.mjs'), false)).toBe(
      'This workspace is not trusted, and reading upfly.config.mjs would run code from the project. Trust the workspace to let Upfly read this folder.',
    );
  });
});
