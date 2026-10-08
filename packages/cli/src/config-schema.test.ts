/**
 * The published config schema against the reader it describes. Editors check a user's
 * `upfly.config.json` with the schema, so if the two drifted apart an editor would mark a
 * file Upfly reads as wrong, or pass a file Upfly refuses.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_SCHEMA, loadConfig, normaliseServedDir } from './config.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_PATH = join(PACKAGE_ROOT, 'schema', 'config.json');

function compileSchema() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  // The message VS Code shows when a pattern fails. Other editors ignore the keyword.
  ajv.addVocabulary(['patternErrorMessage']);
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** What the reader makes of `value` written as `upfly.config.json`. */
async function read(value: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'upfly-schema-'));
  roots.push(root);
  writeFileSync(join(root, 'upfly.config.json'), JSON.stringify(value));
  return loadConfig(root);
}

const ACCEPTED: readonly unknown[] = [
  {},
  { $schema: CONFIG_SCHEMA },
  { $schema: 'https://unpkg.com/upfly/schema/config.json' },
  { publicDirs: ['public'] },
  { publicDirs: ['.'] },
  { publicDirs: [] },
  { publicDirs: ['public', 'static', 'src/assets'] },
  { publicDirs: ['./public/', 'site\\static', '.well-known', '...'] },
  // A path of slashes alone is read as the project root.
  { publicDirs: ['/'] },
  { publicPolicy: 'keep-original' },
  { publicPolicy: 'replace' },
  { format: 'webp' },
  { format: 'avif' },
  { exclude: [] },
  { exclude: ['drafts/**', '!drafts/keep.png', 'legacy/'] },
  { check: {} },
  { check: { maxImageBytes: 1 } },
  { check: { maxImageBytes: 500000 } },
  { check: { failOn: [] } },
  { check: { failOn: ['broken'] } },
  { check: { failOn: ['possibly-broken', 'broken', 'broken'] } },
  { check: { maxImageBytes: 500000, failOn: ['too-large'] } },
  {
    $schema: CONFIG_SCHEMA,
    publicDirs: ['public'],
    publicPolicy: 'replace',
    format: 'avif',
    exclude: ['drafts/'],
    check: { maxImageBytes: 250000 },
  },
];

const REFUSED: readonly unknown[] = [
  [],
  'public',
  1,
  null,
  { publicDir: ['public'] },
  { formats: 'webp' },
  // A setting of the v2 editor extension, alone and beside this CLI's settings.
  { enabled: true },
  { watchTargets: ['public'], format: 'webp' },
  { publicDirs: ['public'], storageMode: 'in-place' },
  { $schema: 1 },
  { publicDirs: 'public' },
  { publicDirs: [1] },
  { publicDirs: [null] },
  { publicDirs: ['/public'] },
  { publicDirs: ['\\public'] },
  { publicDirs: ['C:/site'] },
  { publicDirs: ['c:'] },
  { publicDirs: ['../site'] },
  { publicDirs: ['site/../..'] },
  { publicDirs: ['./..'] },
  { publicDirs: ['.//public'] },
  { publicDirs: ['./D:/site'] },
  { publicDirs: ['public', '../other'] },
  { publicPolicy: 'delete' },
  { publicPolicy: null },
  { format: 'png' },
  { format: 'WEBP' },
  { format: null },
  { exclude: 'drafts' },
  { exclude: [1] },
  { check: null },
  { check: [] },
  { check: 500000 },
  { check: { maxBytes: 500000 } },
  { check: { maxImageBytes: 0 } },
  { check: { maxImageBytes: -1 } },
  { check: { maxImageBytes: 1.5 } },
  { check: { maxImageBytes: '500000' } },
  { check: { maxImageBytes: true } },
  { check: { maxImageBytes: null } },
  { check: { failOn: 'broken' } },
  { check: { failOn: null } },
  { check: { failOn: [1] } },
  { check: { failOn: ['unused'] } },
  { check: { failOn: ['broken', 'too-large'] } },
];

describe('the config schema and the config reader agree', () => {
  it('is the file the $schema that init writes names, inside the package', () => {
    expect(CONFIG_SCHEMA).toBe('./node_modules/upfly/schema/config.json');
    expect(existsSync(SCHEMA_PATH)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(manifest.files).toContain('schema/');
  });

  it('validates every file the reader accepts', async () => {
    const validate = compileSchema();
    for (const value of ACCEPTED) {
      expect((await read(value)).kind, JSON.stringify(value)).toBe('loaded');
      expect(validate(value), `${JSON.stringify(value)}: ${JSON.stringify(validate.errors)}`).toBe(
        true,
      );
    }
  });

  it('fails every file the reader refuses', async () => {
    const validate = compileSchema();
    for (const value of REFUSED) {
      expect((await read(value)).kind, JSON.stringify(value)).not.toBe('loaded');
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('names exactly the settings the reader lists when it meets an unknown one', async () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const top = await read({ nothing: true });
    const nested = await read({ check: { nothing: true } });
    if (top.kind !== 'invalid' || nested.kind !== 'invalid') throw new Error('not refused');

    expect(Object.keys(schema.properties).sort()).toEqual(
      ['$schema', ...settingsNamed(top.message, 'The settings are')].sort(),
    );
    expect(Object.keys(schema.properties.check.properties).sort()).toEqual(
      settingsNamed(nested.message, 'The settings under `check` are').sort(),
    );
  });

  it('accepts a served folder exactly when the reader does, for every short path', () => {
    const validate = compileSchema();
    const symbols = ['.', '/', '\\', 'a', 'C', ':', '\n'];
    let paths = [''];
    let checked = 0;
    for (let length = 0; length <= 6; length += 1) {
      for (const path of paths) {
        const reader = normaliseServedDir(path) !== null;
        if (validate({ publicDirs: [path] }) !== reader) {
          throw new Error(`${JSON.stringify(path)}: the reader says ${reader}, the schema not`);
        }
        checked += 1;
      }
      paths = paths.flatMap((path) => symbols.map((symbol) => path + symbol));
    }
    expect(checked).toBe(137257);
  });
});

/** The backticked names that follow `lead` in `message`. */
function settingsNamed(message: string, lead: string): string[] {
  const start = message.indexOf(lead);
  if (start === -1) throw new Error(`no "${lead}" in: ${message}`);
  const rest = message.slice(start + lead.length);
  return [...rest.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}
