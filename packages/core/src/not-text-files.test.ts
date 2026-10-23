/**
 * A path written in a file that is not text, such as a site's database or a compiled module,
 * through the three commands that search for it: `optimize`, which keeps an original a line
 * still names, and `refs` and `move`, which list the line among those Upfly does not follow.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MEGABYTE } from '../test/heap-held.js';
import { moveProject } from './move-project.js';
import { optimizeProject } from './optimize-project.js';
import { runPipeline, servingRootsFor } from './pipeline.js';
import { unfollowedLines } from './project-search.js';

const LOGO = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/plain-html/images/logo.png',
);

const SERVED = { declared: true, dirs: ['public'] } as const;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A project outside the workspace; `IMAGE` is written as a real PNG that converts. */
async function project(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-not-text-'));
  roots.push(root);
  const logo = await readFile(LOGO);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content === 'IMAGE' ? logo : content);
  }
  return root;
}

/**
 * A database's first page as SQLite writes one: its header, a NUL among the first bytes as in
 * every database, and a row whose text is the page a site renders from it.
 */
function sqlite(row: string): Buffer {
  return Buffer.concat([
    Buffer.from('SQLite format 3\0', 'latin1'),
    Buffer.from([0x10, 0x00, 0x01, 0x01, 0x00, 0x40, 0x20, 0x20]),
    Buffer.alloc(3_976),
    Buffer.from([0x0d, 0x00, 0x00, 0x00, 0x01, 0x0f, 0xc3, 0x00, 0x81, 0x3a, 0x01, 0x03, 0x00]),
    Buffer.from(row),
  ]);
}

/**
 * The bytes Python 3.13 compiles `ICON = "/screenshot.png"` and `LOGO = "assets/logo.png"` to:
 * each string a type byte and a length before it, and the next value's type byte, a letter,
 * right after it, where text would have a quote.
 */
const COMPILED_MODULE = Buffer.from(
  [
    'f3 0d 0d 0a 00 00 00 00 12 9b ca 6a 85 00 00 00 e3 00 00 00 00 00 00 00 00 00 00 00 00 01',
    '00 00 00 00 00 00 00 f3 16 00 00 00 95 00 53 00 72 00 53 01 72 01 53 02 72 02 53 03 1a 00',
    '72 03 67 04 29 05 fa 0f 2f 73 63 72 65 65 6e 73 68 6f 74 2e 70 6e 67 7a 0f 61 73 73 65 74',
    '73 2f 6c 6f 67 6f 2e 70 6e 67 29 02 72 02 00 00 00 e9 03 00 00 00 4e 29 04 da 04 49 43 4f',
    '4e da 04 4c 4f 47 4f 72 08 00 00 00',
  ]
    .join(' ')
    .split(' ')
    .map((byte) => Number.parseInt(byte, 16)),
);

/** The same project three ways: the plan `optimize` makes, and the lines `refs` and `move` list. */
async function throughEachCommand(root: string, image: string) {
  const { optimize } = await optimizeProject({
    root,
    declared: SERVED,
    format: 'webp',
    publicPolicy: 'replace',
    apply: false,
  });
  const pipeline = await runPipeline({
    root,
    servingRoots: servingRootsFor(SERVED),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: null,
  });
  const refs = await unfollowedLines(pipeline, [image]);
  const move = await moveProject({
    root,
    declared: SERVED,
    apply: false,
    moves: [{ from: image, to: image.replace('public/', 'public/moved/') }],
  });
  return {
    conversion: optimize.plan.conversions.find((conversion) => conversion.asset === image),
    declined: optimize.plan.declined.find((entry) => entry.path === image)?.reason,
    refs: refs.lines.map((line) => `${line.file}:${line.line}`),
    refsText: refs.lines.map((line) => line.text),
    refsWhy: refs.lines.map((line) => line.why),
    move: move.plan.unfollowed
      .filter((line) => line.loads)
      .map((line) => `${line.file}:${line.line}`),
    unsearchable: [...refs.unsearchable, ...move.unsearchable],
  };
}

describe('a path written in a file that is not text keeps the original, in refs and move as in optimize', () => {
  it('converts the image and removes the original when no file names it but its reference', async () => {
    const root = await project({
      'public/screenshot.png': 'IMAGE',
      'index.html': '<img src="/screenshot.png" alt="">\n',
    });

    const seen = await throughEachCommand(root, 'public/screenshot.png');

    expect(seen.conversion?.replacesOriginal).toBe(true);
    expect(seen.refs).toEqual([]);
  });

  it.each([
    [
      'a SQLite database under .sqlite3, as Django names one',
      'db.sqlite3',
      sqlite('<p>Our office</p><img src="/screenshot.png" alt="">'),
      'db.sqlite3:1',
      '/screenshot.png',
      'in a .sqlite3 file, a type Upfly does not read',
    ],
    [
      'a SQLite database under .db, a name Upfly once left unread as binary',
      'content.db',
      sqlite('<p>Our office</p><img src="/screenshot.png" alt="">'),
      'content.db:1',
      '/screenshot.png',
      'in a .db file, a type Upfly does not read',
    ],
    [
      'a database naming the image in another letter case, which Windows and macOS still load',
      'pages.sqlite',
      sqlite('<img src="/SCREENSHOT.PNG">'),
      'pages.sqlite:1',
      '/SCREENSHOT.PNG',
      'in a .sqlite file, a type Upfly does not read',
    ],
    [
      'a compiled module whose source is gone, a type letter right after the path',
      'app/__pycache__/views.cpython-313.pyc',
      COMPILED_MODULE,
      // The compiled module's magic number ends in a line break.
      'app/__pycache__/views.cpython-313.pyc:2',
      '/screenshot.png',
      'in a .pyc file, a type Upfly does not read',
    ],
  ])('%s', async (_, file, bytes, where, text, why) => {
    const root = await project({
      'public/screenshot.png': 'IMAGE',
      'index.html': '<img src="/screenshot.png" alt="">\n',
      [file]: bytes,
    });

    const seen = await throughEachCommand(root, 'public/screenshot.png');

    expect(seen.conversion).toBeUndefined();
    expect(seen.declined).toContain(`converting it would delete the original, and ${where}`);
    expect(seen.refs).toEqual([where]);
    expect(seen.refsText).toEqual([text]);
    expect(seen.refsWhy).toEqual([why]);
    expect(seen.move).toEqual([where]);
    expect(seen.unsearchable).toEqual([]);
  });

  it.each([
    ['percent-encoded, as a URL writes a space', 'public/our office.png', '/our%20office.png'],
    ['as its UTF-8 bytes, a name beyond ASCII', 'public/café.png', '/café.png'],
    ['as the UTF-8 escapes of a name beyond ASCII', 'public/café.png', '/caf%C3%A9.png'],
    ['a name beyond ASCII in capitals', 'public/café.png', '/CAFÉ.PNG'],
  ])('a path written %s', async (_, image, written) => {
    const root = await project({
      [image]: 'IMAGE',
      'index.html': `<img src="${image.slice('public'.length)}" alt="">\n`,
      'site.sqlite3': sqlite(`<img src="${written}">`),
    });

    const seen = await throughEachCommand(root, image);

    expect(seen.conversion).toBeUndefined();
    expect(seen.declined).toContain('site.sqlite3:1');
    expect(seen.refs).toEqual(['site.sqlite3:1']);
    expect(seen.move).toEqual(['site.sqlite3:1']);
  });

  it.each(['content.db', 'pages.sqlite', 'site.sqlite3'])(
    'calls an image that only %s names possibly unused, as the search before a delete finds it',
    async (file) => {
      const root = await project({
        'public/old-banner.png': 'IMAGE',
        'index.html': '<p>Our office</p>\n',
        [file]: sqlite('<img src="/old-banner.png" alt="">'),
      });

      const pipeline = await runPipeline({
        root,
        servingRoots: servingRootsFor(SERVED),
        publicDirs: (servingRoots) => servingRoots.dirs,
        probeOptions: null,
      });
      const refs = await unfollowedLines(pipeline, ['public/old-banner.png']);

      expect(refs.lines.map((line) => `${line.file}:${line.line}`)).toEqual([`${file}:1`]);
      expect(
        pipeline.audit.findings.filter(
          (finding) => 'asset' in finding && finding.asset === 'public/old-banner.png',
        ),
      ).toMatchObject([{ kind: 'possibly-dead', evidence: [{ where: `${file}:1` }] }]);
    },
  );

  it('finds a path in a library of 24 megabytes once, across the place one read of it ends and the next begins', async () => {
    // Random bytes, as compiled code reads; the path straddles the first megabyte.
    const library = randomBytes(24 * MEGABYTE);
    library.write('"/screenshot.png"', MEGABYTE - 7, 'latin1');
    const root = await project({
      'public/screenshot.png': 'IMAGE',
      'index.html': '<img src="/screenshot.png" alt="">\n',
      'venv/torch/lib/torch_cpu.dll': library,
    });
    const breaks = library.subarray(0, MEGABYTE - 7).filter((byte) => byte === 0x0a).length;

    const seen = await throughEachCommand(root, 'public/screenshot.png');

    const where = `venv/torch/lib/torch_cpu.dll:${breaks + 1}`;
    expect(seen.declined).toContain(where);
    expect(seen.refs).toEqual([where]);
    expect(seen.move).toEqual([where]);
  });
});
