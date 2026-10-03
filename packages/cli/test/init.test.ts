/**
 * `upfly init` through the built binary, on small projects written outside the workspace:
 * the file it writes, the reason it gives for each folder, and its refusal to touch a
 * configuration that already exists.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BIN, jsonLines, snapshot, tempFolder, upfly, write } from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const KILL_SWITCH = readFileSync(new URL('./v2-kill-switch.json', import.meta.url));

function project(files: Record<string, string | Buffer>): string {
  const root = tempFolder(roots, 'upfly-init-');
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
}

/** A framework project: a `public` folder beside `package.json`, which a page's URL reaches. */
function framework(): string {
  return project({
    'package.json': '{ "name": "site" }\n',
    'public/logo.png': Buffer.alloc(100, 1),
    'src/page.html': '<img src="/logo.png">\n',
  });
}

describe('upfly init', () => {
  it('writes the schema, the folder it found and the format, and says why it chose the folder', () => {
    const root = framework();
    const before = snapshot(root);

    const run = upfly(['init', root]);
    const written = readFileSync(join(root, 'upfly.config.json'), 'utf8');

    expect(run.status).toBe(0);
    expect(written).toBe(
      `${JSON.stringify(
        {
          $schema: './node_modules/upfly/schema/config.json',
          publicDirs: ['public'],
          format: 'webp',
        },
        null,
        2,
      )}\n`,
    );
    expect(run.stdout.slice(1, -1)).toBe(
      [
        'Upfly init',
        '',
        'Wrote upfly.config.json:',
        '',
        ...written
          .trimEnd()
          .split('\n')
          .map((line) => `  ${line}`),
        '',
        'Why:',
        '  public: a folder named public beside package.json, where a site built with a framework serves files from',
        '  format: webp, the default; "avif" is the other choice, which some older browsers cannot show',
        '',
        'Every Upfly command in this folder now reads it. Edit it to change what Upfly treats as the site.',
        '',
      ].join('\n'),
    );
    expect(Object.keys(snapshot(root))).toEqual(
      [...Object.keys(before), 'upfly.config.json'].sort(),
    );
  });

  it('writes a config the other commands read as declared', () => {
    const root = framework();
    upfly(['init', root]);

    const audit = upfly(['audit', root, '--no-probe', '--json']);
    const report = jsonLines(audit.stdout).at(-1)?.report as {
      coverage: { servingRoots: unknown };
    };

    expect(audit.status).toBe(0);
    expect(report.coverage.servingRoots).toMatchObject({ dirs: ['public'], declared: true });
  });

  it('names a folder that root-relative paths resolve against, with the count that chose it', () => {
    const root = project({
      'src/index.html': '<img src="/img/a.png">\n<img src="/img/b.png">\n<img src="/img/c.png">\n',
      'src/img/a.png': Buffer.alloc(10, 1),
      'src/img/b.png': Buffer.alloc(20, 2),
      'src/img/c.png': Buffer.alloc(30, 3),
    });

    const run = upfly(['init', root]);

    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'upfly.config.json'), 'utf8')).publicDirs).toEqual([
      'src',
    ]);
    expect(run.stdout).toContain(
      '  src: 3 of 3 root-relative image paths tested against it resolve to an image under it',
    );
  });

  it('leaves the folders out when it finds none, and says what to write for the project root', () => {
    const root = project({
      'index.html': '<img src="img/a.png">\n',
      'img/a.png': Buffer.alloc(10, 1),
    });

    const run = upfly(['init', root]);

    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'upfly.config.json'), 'utf8'))).toEqual({
      $schema: './node_modules/upfly/schema/config.json',
      format: 'webp',
    });
    expect(run.stdout).toContain(
      '  publicDirs: left out, since no folder was found that the site is served from, so each run works it out again; if the site is served from this folder itself, add "publicDirs": ["."]',
    );
  });

  it('refuses with exit 3, naming the file, when a configuration exists, and changes nothing', () => {
    const code = project({ 'upfly.config.ts': 'export default {};\n', 'index.html': '' });
    const before = snapshot(code);

    const run = upfly(['init', code]);
    const json = upfly(['init', code, '--json']);

    expect(run.status).toBe(3);
    expect(run.stderr).toBe(
      'upfly: upfly.config.ts already exists, and init never changes a configuration file. Edit it instead.\n',
    );
    expect(jsonLines(json.stdout).at(-1)).toMatchObject({
      type: 'error',
      command: 'init',
      exitCode: 3,
      reason: 'CONFIG_EXISTS',
    });
    expect(snapshot(code)).toEqual(before);
  });

  it('refuses the v2 extension file too, and says to create upfly.config.ts beside it', () => {
    const root = project({ 'upfly.config.json': KILL_SWITCH, 'index.html': '' });

    const run = upfly(['init', root]);

    expect(run.status).toBe(3);
    expect(run.stderr).toContain(
      'upfly.config.json already exists, and holds the settings of the Upfly VS Code extension (v2)',
    );
    expect(run.stderr).toContain('create upfly.config.ts');
    expect(readFileSync(join(root, 'upfly.config.json'))).toEqual(KILL_SWITCH);
  });

  it('gives the file, the settings and each reason as one JSON result under --json', () => {
    const root = framework();

    const run = upfly(['init', root, '--json']);

    expect(run.status).toBe(0);
    expect(jsonLines(run.stdout).at(-1)).toEqual({
      type: 'result',
      command: 'init',
      exitCode: 0,
      file: 'upfly.config.json',
      config: {
        $schema: './node_modules/upfly/schema/config.json',
        publicDirs: ['public'],
        format: 'webp',
      },
      reasons: [
        {
          setting: 'publicDirs',
          value: 'public',
          why: 'a folder named public beside package.json, where a site built with a framework serves files from',
        },
        {
          setting: 'format',
          value: 'webp',
          why: 'the default; "avif" is the other choice, which some older browsers cannot show',
        },
      ],
    });
  });
});
