import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findBundledCli, projectCliVersion, versionNotice } from './bundled-cli.js';

const made: string[] = [];

function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-cli-'));
  made.push(dir);
  return dir;
}

function writePackage(dir: string, name: string, version: string): void {
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(path.join(dir, 'bin', 'upfly.cjs'), '');
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('findBundledCli', () => {
  it('finds the CLI a package carries in its engine folder', () => {
    const extension = folder();
    const cli = path.join(extension, 'engine', 'node_modules', 'upfly');
    writePackage(cli, 'upfly', '3.1.0');
    expect(findBundledCli(extension)).toEqual({
      version: '3.1.0',
      bin: path.join(cli, 'bin', 'upfly.cjs'),
    });
  });

  it('falls back to the workspace link a development checkout has', () => {
    const extension = folder();
    writePackage(path.join(extension, 'node_modules', 'upfly'), 'upfly', '3.2.0');
    expect(findBundledCli(extension)?.version).toBe('3.2.0');
  });

  it('prefers the engine folder when both are there', () => {
    const extension = folder();
    writePackage(path.join(extension, 'engine', 'node_modules', 'upfly'), 'upfly', '3.1.0');
    writePackage(path.join(extension, 'node_modules', 'upfly'), 'upfly', '3.2.0');
    expect(findBundledCli(extension)?.version).toBe('3.1.0');
  });

  it('finds nothing in a folder that carries no CLI', () => {
    expect(findBundledCli(folder())).toBeNull();
  });
});

/** A folder git would take for a repository's top. */
function repository(): string {
  const dir = folder();
  mkdirSync(path.join(dir, '.git'));
  return dir;
}

describe('projectCliVersion', () => {
  it("reads the version of the project's own installed upfly", () => {
    const project = repository();
    writePackage(path.join(project, 'node_modules', 'upfly'), 'upfly', '3.0.0');
    expect(projectCliVersion(project)).toBe('3.0.0');
  });

  it("finds an upfly installed at the top of the project's repository", () => {
    const top = repository();
    writePackage(path.join(top, 'node_modules', 'upfly'), 'upfly', '3.0.0');
    const project = path.join(top, 'apps', 'site');
    mkdirSync(project, { recursive: true });
    expect(projectCliVersion(project)).toBe('3.0.0');
  });

  it("does not look above the top of the project's repository", () => {
    const outer = folder();
    writePackage(path.join(outer, 'node_modules', 'upfly'), 'upfly', '3.0.0');
    const project = path.join(outer, 'site');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    expect(projectCliVersion(project)).toBeNull();
  });

  it('gives null when the project has no upfly installed', () => {
    expect(projectCliVersion(repository())).toBeNull();
  });
});

describe('versionNotice', () => {
  it('says which version runs when the project installs another Upfly 3', () => {
    expect(versionNotice('3.0.0', '3.1.0')).toBe(
      'This project has upfly 3.0.0 installed. The editor runs the upfly 3.1.0 it carries, so a terminal run of npx upfly can answer differently.',
    );
  });

  it('says nothing when the versions match', () => {
    expect(versionNotice('3.1.0', '3.1.0')).toBeNull();
  });

  it('says nothing about upfly 2, the upload middleware, which is another product', () => {
    expect(versionNotice('2.0.7', '3.1.0')).toBeNull();
  });

  it('says nothing when the project has no upfly', () => {
    expect(versionNotice(null, '3.1.0')).toBeNull();
  });
});
