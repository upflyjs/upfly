/**
 * What the `upfly` package's entry gives a library user, and that each name is documented.
 * A change to either is a change a user sees, so the list is written down here.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');

describe("the upfly package's entry", () => {
  it('exports as values only the config helper and the exit codes', () => {
    expect(Object.keys(entry).sort()).toEqual(['EXIT_CODES', 'defineConfig']);
  });

  it('documents every name it exports, as its declaration', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
    const types = join(PACKAGE, manifest.exports['.'].types);
    const program = ts.createProgram([types], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const file = program.getSourceFile(types);
    const module = file === undefined ? undefined : checker.getSymbolAtLocation(file);
    const names = module === undefined ? [] : checker.getExportsOfModule(module);
    const undocumented = names
      .filter((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        return ts.displayPartsToString(target.getDocumentationComment(checker)).trim() === '';
      })
      .map((symbol) => symbol.getName());

    expect(names.map((symbol) => symbol.getName()).sort()).toEqual([
      'EXIT_CODES',
      'ExitCode',
      'UpflyConfig',
      'defineConfig',
    ]);
    expect(undocumented).toEqual([]);
  });
});

describe('the Node.js versions the upfly package says it runs on', () => {
  const manifest = (folder: string) =>
    JSON.parse(readFileSync(join(PACKAGE, '..', folder, 'package.json'), 'utf8'));
  const { tooOld } = createRequire(import.meta.url)('../bin/upfly.cjs') as {
    tooOld(version: string): string | null;
  };

  it('include every Node.js the Upfly 2 line names, so npm never picks Upfly 2 over Upfly 3', () => {
    // npm installs the newest version whose engines admit the running Node.js before it falls
    // back to the latest tag, and every 1.x and 2.x release says ">=18".
    expect(manifest('cli').engines).toEqual({ node: '>=18' });
  });

  it("turn away, at the command's first file, each Node.js older than 22.0.0", () => {
    // Every Node.js 22 runs the suite but for a test helper's zlib.crc32, and Node.js 20 is
    // past its end of life. upfly-core's own range stays its dependencies' narrower one.
    expect(tooOld('22.0.0')).toBeNull();
    expect(tooOld('21.99.99')).toBe(
      'Upfly needs Node.js 22.0.0 or later, and this is Node.js 21.99.99.',
    );
    expect(manifest('cli').bin).toEqual({ upfly: './bin/upfly.cjs' });
  });

  it.each(['24.11.1', '26.0.0', '22.14.0', '22.17.1'])('lets Node.js %s run Upfly', (version) => {
    expect(tooOld(version)).toBeNull();
  });

  it.each(['20.20.2', '18.20.8', '16.0.0', '4.9.1'])(
    'turns Node.js %s away in one line',
    (version) => {
      expect(tooOld(version)).toMatch(
        /^Upfly needs Node\.js \d+\.\d+\.\d+ or later, and this is Node\.js /,
      );
    },
  );

  it('runs the command through that file on this Node.js', () => {
    const run = spawnSync(process.execPath, [join(PACKAGE, 'bin/upfly.cjs'), '--version'], {
      encoding: 'utf8',
    });

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(manifest('cli').version);
  });
});
