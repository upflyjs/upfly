import dns from 'node:dns';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_SCHEMA, loadConfig, normaliseServedDir } from './config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'upfly-config-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

/**
 * The v2 extension's kill switch that sits above the pinned validation repositories, copied
 * byte for byte, under a name the extension does not read.
 */
const V2_KILL_SWITCH = readFileSync(
  fileURLToPath(new URL('../test/v2-kill-switch.json', import.meta.url)),
  'utf8',
);

describe('the v2 extension shares the file name, and its file is never read as this CLI config', () => {
  it('refuses the kill switch from the validation corpus, naming the extension', async () => {
    const outcome = await loadConfig(project({ 'upfly.config.json': V2_KILL_SWITCH }));

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.message).toContain('Upfly VS Code extension (v2)');
    expect(outcome.message).toContain('left untouched');
    expect(outcome.message).toContain('create upfly.config.ts');
    expect(outcome.message).toContain(`"$schema": "${CONFIG_SCHEMA}"`);
  });

  it('refuses a v2 file written with comments, as the extension itself reads it', async () => {
    const outcome = await loadConfig(
      project({
        'upfly.config.json':
          '{\n  // off while testing\n  "enabled": false,\n  "format": "webp",\n}\n',
      }),
    );
    expect(outcome.kind).toBe('refused');
  });

  it('leaves the file untouched', async () => {
    const root = project({ 'upfly.config.json': V2_KILL_SWITCH });
    await loadConfig(root);
    expect(readFileSync(join(root, 'upfly.config.json'), 'utf8')).toBe(V2_KILL_SWITCH);
  });

  it('reads a JSON config that carries the v3 schema', async () => {
    const outcome = await loadConfig(
      project({
        'upfly.config.json': JSON.stringify({ $schema: CONFIG_SCHEMA, publicDirs: ['public'] }),
      }),
    );
    expect(outcome).toEqual({
      kind: 'loaded',
      file: 'upfly.config.json',
      config: { $schema: CONFIG_SCHEMA, publicDirs: ['public'] },
    });
  });

  it('reads a JSON config whose keys are all this CLI settings', async () => {
    const outcome = await loadConfig(
      project({ 'upfly.config.json': '{ "publicPolicy": "replace", "format": "avif" }' }),
    );
    expect(outcome).toEqual({
      kind: 'loaded',
      file: 'upfly.config.json',
      config: { publicPolicy: 'replace', format: 'avif' },
    });
  });

  it('rejects a file that mixes both products, rather than half-reading it', async () => {
    const outcome = await loadConfig(
      project({ 'upfly.config.json': '{ "enabled": true, "publicDirs": ["public"] }' }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.message).toContain('`enabled` is a setting of the v2 VS Code extension');
  });

  it('does not treat a shared setting name alone as this CLI config', async () => {
    // `format` is both products' setting, so it cannot mark the file as v3's.
    const outcome = await loadConfig(
      project({ 'upfly.config.json': '{ "watchTargets": [], "format": "webp" }' }),
    );
    expect(outcome.kind).toBe('refused');
  });
});

describe('no network, even for a config that names a remote layer', () => {
  const attempts: string[] = [];
  const restore: (() => void)[] = [];

  function block(target: object, name: string, label: string): void {
    const record = target as Record<string, unknown>;
    const original = record[name];
    record[name] = (..._args: unknown[]) => {
      attempts.push(label);
      throw new Error(`network access attempted: ${label}`);
    };
    restore.push(() => {
      record[name] = original;
    });
  }

  beforeAll(() => {
    block(net.Socket.prototype, 'connect', 'net.Socket.connect');
    block(net, 'connect', 'net.connect');
    block(net, 'createConnection', 'net.createConnection');
    block(tls, 'connect', 'tls.connect');
    block(http, 'request', 'http.request');
    block(http, 'get', 'http.get');
    block(https, 'request', 'https.request');
    block(https, 'get', 'https.get');
    block(dns, 'lookup', 'dns.lookup');
    block(dns.promises, 'lookup', 'dns.promises.lookup');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      attempts.push('fetch');
      throw new Error('network access attempted: fetch');
    };
    restore.push(() => {
      globalThis.fetch = originalFetch;
    });
  });
  afterAll(() => {
    for (const undo of restore.splice(0).reverse()) undo();
  });

  // `node_modules` keeps c12's download directory inside the temporary project.
  const REMOTE = {
    'upfly.config.ts': "export default { extends: 'github:unjs/c12', format: 'avif' };\n",
    'node_modules/.keep': '',
  };

  it('c12 left to its defaults goes to the network for that layer', async () => {
    attempts.length = 0;
    const { loadConfig: loadWithDefaults } = await import('c12');
    await expect(loadWithDefaults({ cwd: project(REMOTE), name: 'upfly' })).rejects.toThrow(
      'network access attempted',
    );
    expect(attempts.length).toBeGreaterThan(0);
  });

  it('through Upfly the same file loads nothing remote and names the setting it rejects', async () => {
    attempts.length = 0;
    const outcome = await loadConfig(project(REMOTE));

    expect(outcome).toEqual({
      kind: 'invalid',
      file: 'upfly.config.ts',
      message:
        'unknown setting `extends`. The settings are `publicDirs`, `publicPolicy`, `format`, `exclude`, `check` and `watch`.',
    });
    expect(attempts).toEqual([]);
  });

  it('reads a TypeScript config through c12, and nothing else beside it', async () => {
    attempts.length = 0;
    const outcome = await loadConfig(
      project({
        'upfly.config.ts': "export default { publicDirs: ['public'], publicPolicy: 'replace' };\n",
        // Everything c12 reads by default and a user did not ask for here.
        '.upflyrc': 'format=avif\n',
        '.env': 'NODE_ENV=production\n',
        'package.json': '{ "upfly": { "exclude": ["everything"] } }\n',
      }),
    );

    expect(outcome).toEqual({
      kind: 'loaded',
      file: 'upfly.config.ts',
      config: { publicDirs: ['public'], publicPolicy: 'replace' },
    });
    expect(attempts).toEqual([]);
  });

  it('rejects a section chosen by NODE_ENV rather than applying it', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const outcome = await loadConfig(
        project({
          'upfly.config.ts':
            "export default { format: 'webp', $production: { format: 'avif' } };\n",
        }),
      );
      // `$production` is not a setting, so c12 applying it would have hidden the error.
      expect(outcome).toMatchObject({
        kind: 'invalid',
        message: expect.stringContaining('unknown setting `$production`'),
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('finding the file', () => {
  it('reports no config when there is none', async () => {
    expect(await loadConfig(project({}))).toEqual({ kind: 'none' });
  });

  it('refuses to choose between two code configs', async () => {
    const outcome = await loadConfig(
      project({ 'upfly.config.ts': 'export default {};', 'upfly.config.js': 'export default {};' }),
    );
    expect(outcome).toEqual({
      kind: 'invalid',
      file: 'upfly.config.ts',
      message: 'found upfly.config.ts and upfly.config.js; keep one configuration file.',
    });
  });

  it('refuses to choose between a code config and a v3 JSON config', async () => {
    const outcome = await loadConfig(
      project({
        'upfly.config.ts': 'export default {};',
        'upfly.config.json': '{ "publicDirs": ["public"] }',
      }),
    );
    expect(outcome.kind).toBe('invalid');
  });
});

describe('what a config may say', () => {
  it('names an unknown setting and lists the real ones', async () => {
    const outcome = await loadConfig(project({ 'upfly.config.json': '{ "publicDir": "public" }' }));
    expect(outcome).toEqual({
      kind: 'invalid',
      file: 'upfly.config.json',
      message:
        'unknown setting `publicDir`. The settings are `publicDirs`, `publicPolicy`, `format`, `exclude`, `check` and `watch`.',
    });
  });

  it('rejects values it cannot use, each with what it expects', async () => {
    const outcome = await loadConfig(
      project({
        'upfly.config.json':
          '{ "publicDirs": ["../site"], "publicPolicy": "delete", "format": "jpeg", "exclude": "dist" }',
      }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.message.split('\n')).toEqual([
      '`publicDirs` must be a list of folders inside the project, such as ["public"], or ["."] for the project root.',
      '`publicPolicy` must be "keep-original" or "replace".',
      '`format` must be "webp" or "avif".',
      '`exclude` must be a list of patterns.',
    ]);
  });

  it('reads the settings an editor watching the project keeps, which no command acts on', async () => {
    const watch = {
      folders: ['public', 'src/assets/'],
      skip: ['./public/vendor'],
      keepOriginals: false,
      outside: 'replace',
    };
    const outcome = await loadConfig(project({ 'upfly.config.json': JSON.stringify({ watch }) }));
    expect(outcome).toEqual({
      kind: 'loaded',
      file: 'upfly.config.json',
      config: { watch: { ...watch, folders: ['public', 'src/assets'], skip: ['public/vendor'] } },
    });
  });

  it('names each watch setting it cannot use, and an unknown one with the real ones', async () => {
    const outcome = await loadConfig(
      project({
        'upfly.config.json':
          '{ "watch": { "folders": ["../site"], "skip": "vendor", "keepOriginals": "no", "outside": "keep", "delay": 2 } }',
      }),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.message.split('\n')).toEqual([
      'unknown setting `watch.delay`. The settings under `watch` are `folders`, `skip`, `keepOriginals` and `outside`.',
    ]);
    const fields = await loadConfig(
      project({
        'upfly.config.json':
          '{ "watch": { "folders": ["../site"], "skip": "vendor", "keepOriginals": "no", "outside": "keep" } }',
      }),
    );
    expect(fields.kind === 'invalid' ? fields.message.split('\n') : []).toEqual([
      '`watch.folders` must be a list of folders inside the project, such as ["public"], or ["."] for the project root.',
      '`watch.skip` must be a list of folders inside the project, such as ["public/vendor"].',
      '`watch.keepOriginals` must be true or false.',
      '`watch.outside` must be "replace", which treats an image that arrives from outside the editor as one pasted in it.',
    ]);
  });

  it('says which file could not be parsed', async () => {
    const outcome = await loadConfig(project({ 'upfly.config.json': '{ "publicDirs": [' }));
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.file).toBe('upfly.config.json');
    expect(outcome.message).toMatch(/^could not be parsed: /);
  });
});

describe('a served folder as a user writes it', () => {
  it.each([
    ['.', ''],
    ['./', ''],
    ['', ''],
    ['public', 'public'],
    ['public/', 'public'],
    ['./public', 'public'],
    ['apps\\web\\public', 'apps/web/public'],
  ])('%j is %j', (written, normalised) => {
    expect(normaliseServedDir(written)).toBe(normalised);
  });

  it.each(['../site', 'public/../../x', '/var/www', 'C:/site'])(
    'refuses %j, which leaves the project',
    (written) => {
      expect(normaliseServedDir(written)).toBeNull();
    },
  );
});
