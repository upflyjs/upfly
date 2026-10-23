import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as source from './index.js';
import * as internal from './internal.js';

const run = promisify(execFile);

/** The package's own folder, where `package.json` and the built `dist/` live. */
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Manifest {
  readonly name: string;
  readonly files: readonly string[];
  readonly exports: Record<string, { readonly types: string; readonly import: string }>;
  readonly engines: { readonly node: string };
  readonly dependencies?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Manifest;

/**
 * A project outside the repository with the package in its `node_modules`, as an install
 * leaves it. A junction on Windows, which needs no special rights; a symlink elsewhere.
 */
let project = '';
beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'upfly-package-entry-'));
  await mkdir(join(project, 'node_modules'));
  await symlink(PACKAGE, join(project, 'node_modules', manifest.name), 'junction');
});
afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

/** Runs a module script in the outside project and returns what it prints. */
async function inProject(script: string): Promise<string> {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project,
  });
  return stdout.trim();
}

describe('the package entry, imported the way a user imports it', () => {
  it('gives an import from outside the repository everything the source index exports', async () => {
    const names = await inProject(
      `const m = await import('${manifest.name}'); console.log(JSON.stringify(Object.keys(m).sort()));`,
    );

    expect(JSON.parse(names)).toEqual(Object.keys(source).sort());
  }, 30_000);

  it('gives an import of the internal entry everything the internal index exports', async () => {
    const names = await inProject(
      `const m = await import('${manifest.name}/internal'); console.log(JSON.stringify(Object.keys(m).sort()));`,
    );

    expect(JSON.parse(names)).toEqual(Object.keys(internal).sort());
  }, 30_000);

  it('exports as values only what the documented tasks need, so any change to them is seen', () => {
    // Running the audit and reading its report, optimizeProject, dedupeProject, undo of a
    // whole run or part of one and the list of what a run changed, the errors they throw,
    // and writing an adapter. Everything else is in upfly-core/internal.
    expect(Object.keys(source).sort()).toEqual([
      'REPORT_SCHEMA_VERSION',
      'UpflyError',
      'buildReport',
      'createNodeFileStore',
      'dedupeProject',
      'defineAdapter',
      'describeRun',
      'inspect',
      'optimizeProject',
      'readManifest',
      'renderReport',
      'revert',
      'rewriteByEdits',
      'runPipeline',
      'servingRootsFor',
      'undoPart',
    ]);
    const shared = Object.keys(internal).filter((name) => name in source);
    expect(shared).toEqual([]);
  });

  it('documents every name the public entry exports, as its declaration', () => {
    const entry = join(PACKAGE, manifest.exports['.']?.types ?? '');
    const program = ts.createProgram([entry], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const file = program.getSourceFile(entry);
    const module = file === undefined ? undefined : checker.getSymbolAtLocation(file);
    const undocumented = (module === undefined ? [] : checker.getExportsOfModule(module))
      .filter((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        return ts.displayPartsToString(target.getDocumentationComment(checker)).trim() === '';
      })
      .map((symbol) => symbol.getName());

    expect(module).toBeDefined();
    expect(undocumented).toEqual([]);
  });

  it('refuses a path inside the package that the map does not name', async () => {
    const outcome = await inProject(
      `try { await import('${manifest.name}/dist/index.js'); console.log('imported'); } catch (e) { console.log(e.code); }`,
    );

    expect(outcome).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  }, 30_000);

  it('names only files that exist and that the package publishes', () => {
    for (const entry of Object.values(manifest.exports)) {
      // The declarations a TypeScript user gets are the ones beside the module they import.
      expect(entry.types).toBe(`${entry.import.slice(0, -'.js'.length)}.d.ts`);
      for (const target of [entry.types, entry.import]) {
        expect(existsSync(join(PACKAGE, target))).toBe(true);
        const published = manifest.files.some((folder) =>
          target.replace(/^\.\//, '').startsWith(folder),
        );
        expect(published).toBe(true);
      }
    }
  });
});

type Version = readonly [number, number, number];

/**
 * A Node.js range as `||`-separated alternatives, each `^a.b.c` or `>=a.b.c` with the minor
 * and patch optional, as each `[from, below]`. Any other form throws, so a dependency that
 * starts writing one is noticed rather than passed.
 */
function alternatives(range: string): (readonly [Version, Version | null])[] {
  return range.split('||').map((part) => {
    const match = /^\s*(\^|>=\s*)(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(part);
    if (match === null) throw new Error(`a Node.js range this test cannot read: ${range}`);
    const from: Version = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
    return [from, match[1] === '^' ? [from[0] + 1, 0, 0] : null];
  });
}

/** Whether `a` comes before `b`. */
function below(a: Version, b: Version): boolean {
  for (const index of [0, 1, 2] as const) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

function satisfies(version: Version, range: string): boolean {
  return alternatives(range).some(
    ([from, until]) => !below(version, from) && (until === null || below(version, until)),
  );
}

/** Versions a range admits: each alternative's first, its last, and later majors. */
function admitted(range: string): Version[] {
  return alternatives(range).flatMap(([from, until]): Version[] =>
    until === null
      ? [from, ...[1, 2, 3, 4].map((step): Version => [from[0] + step, 0, 0])]
      : [from, [until[0] - 1, 99, 99]],
  );
}

describe('the Node.js versions the package says it runs on', () => {
  it('are ones every dependency runs on, so npm warns no one the package accepts', () => {
    const versions = admitted(manifest.engines.node);
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const dependency = JSON.parse(
        readFileSync(join(PACKAGE, 'node_modules', name, 'package.json'), 'utf8'),
      ) as { readonly engines?: { readonly node?: string } };
      const range = dependency.engines?.node;
      if (range === undefined) continue;
      for (const version of versions) {
        expect(
          satisfies(version, range),
          `${name} needs Node.js ${range}, and the package admits ${version.join('.')}`,
        ).toBe(true);
      }
    }
  });

  it('reads the forms the dependencies write, and fails on a version below one', () => {
    expect(satisfies([22, 18, 0], '^22.18.0 || >=24.11.0')).toBe(true);
    expect(satisfies([23, 0, 0], '^22.18.0 || >=24.11.0')).toBe(false);
    expect(satisfies([20, 0, 0], '>=20.9.0')).toBe(false);
    expect(satisfies([26, 0, 0], '^10 || ^12 || >=14')).toBe(true);
    expect(satisfies([4, 0, 0], '>= 4')).toBe(true);
    expect(() => satisfies([22, 0, 0], '22.x')).toThrow('cannot read');
  });
});
