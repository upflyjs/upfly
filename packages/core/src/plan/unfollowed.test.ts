import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runPipeline, servingRootsFor } from '../pipeline.js';
import { unfollowedLines } from '../project-search.js';
import { findPathOccurrences } from './old-path-search.js';
import type { UnfollowedLine } from './unfollowed.js';

const LOGO = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/plain-html/images/logo.png',
);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A project outside the workspace; `IMAGE` is written as a real PNG. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-unfollowed-'));
  roots.push(root);
  const logo = await readFile(LOGO);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content === 'IMAGE' ? logo : content);
  }
  return root;
}

/** The lines naming `image` that Upfly does not follow, keyed `file:line`. */
async function linesFor(
  root: string,
  image: string,
  servedFrom: readonly string[] | null = ['public'],
): Promise<Record<string, UnfollowedLine>> {
  const pipeline = await runPipeline({
    root,
    servingRoots: servingRootsFor(
      servedFrom === null ? undefined : { declared: true, dirs: servedFrom },
    ),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: null,
  });
  const { lines } = await unfollowedLines(pipeline, [image]);
  return Object.fromEntries(lines.map((line) => [`${line.file}:${line.line}`, line]));
}

describe('full addresses', () => {
  it('lists one whose path ends with the image URL or its path in the repository', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'site.json': [
        '{',
        '  "a": "https://example.com/img/a.png",',
        '  "b": "//cdn.example.com/v2/img/a.png?w=40",',
        '  "c": "https://raw.githubusercontent.com/o/r/main/public/img/a.png",',
        '  "d": "https://example.com/img/a.png.webp",',
        '  "e": "https://example.com/other/a.png"',
        '}',
      ].join('\n'),
    });

    const lines = await linesFor(root, 'public/img/a.png');

    expect(lines).toMatchObject({
      'site.json:2': { reason: 'full-address', host: 'example.com' },
      'site.json:3': { reason: 'full-address', host: 'cdn.example.com' },
      'site.json:4': { reason: 'full-address', host: 'raw.githubusercontent.com' },
    });
    // A longer file name is another file, and a path that does not end with the image's is
    // another image.
    expect(Object.keys(lines).sort()).toEqual(['site.json:2', 'site.json:3', 'site.json:4']);
  });

  it('gives an address that names another image to that image alone', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'public/blog/img/a.png': 'IMAGE',
      'src/img/a.png': 'IMAGE',
      'links.md': 'See https://example.com/blog/img/a.png and https://example.com/img/a.png.\n',
    });

    expect(await linesFor(root, 'public/img/a.png')).toMatchObject({
      'links.md:1': { text: 'https://example.com/img/a.png' },
    });
    expect(await linesFor(root, 'public/blog/img/a.png')).toMatchObject({
      'links.md:1': { text: 'https://example.com/blog/img/a.png' },
    });
    // Nothing serves src/, so no address on a site names it.
    expect(await linesFor(root, 'src/img/a.png')).toEqual({});
  });
});

describe('a place inside a reference Upfly read', () => {
  it('says why each kind of reference is not followed', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'index.html': [
        '<!doctype html>',
        '<img src="/IMG/A.png" alt="">',
        '<style>.x { background: url(/img/a.png) </style>',
        '',
      ].join('\n'),
      'src/Card.tsx': 'export const card = <Card logo="/img/a.png" />;\n',
      'src/alias.ts': "import a from '~/img/a.png';\nexport { a };\n",
      'data/team.json': '{ "photo": "staff/img/a.png" }\n',
    });

    const lines = await linesFor(root, 'public/img/a.png');

    expect(lines).toMatchObject({
      'index.html:2': { reason: 'other', why: expect.stringContaining('letter case') },
      'index.html:3': { reason: 'other', why: expect.stringContaining('could not read the code') },
      'src/Card.tsx:1': {
        reason: 'data-or-props',
        why: expect.stringContaining('JSX attribute logo'),
      },
      'src/alias.ts:1': { reason: 'other', why: expect.stringContaining('alias') },
      'data/team.json:1': {
        reason: 'data-or-props',
        why: expect.stringContaining('names no file'),
      },
    });
  });

  it('names no command in a reason, since only the CLI knows how its commands are typed', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'index.html': '<!doctype html>\n<img src="/IMG/A.png" alt="">\n',
    });

    const lines = await linesFor(root, 'public/img/a.png');

    expect(lines['index.html:2']?.why).toContain('letter case');
    for (const line of Object.values(lines)) expect(line.why).not.toMatch(/\bupfly [a-z]/);
  });

  it('leaves out a path into a folder the walk does not read, which names a file there', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'node_modules/pkg/img/a.png': 'IMAGE',
      'index.html': '<img src="node_modules/pkg/img/a.png" alt="">\n',
    });

    expect(await linesFor(root, 'public/img/a.png')).toEqual({});
  });

  it('lists a path from the site root that no folder could place when none is known', async () => {
    // Ten paths from the site root that resolve nowhere leave the serving folder unknown.
    const pages = Array.from({ length: 10 }, (_, n) => `<img src="/pics/${n}.png">`);
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'index.html': `${pages.join('\n')}\n<img src="/img/a.png">\n`,
    });

    const lines = await linesFor(root, 'public/img/a.png', null);

    expect(lines['index.html:11']).toMatchObject({
      reason: 'other',
      why: expect.stringContaining('the folder the site is served from'),
    });
  });
});

describe('a place outside every reference', () => {
  it("says where it sits: a comment, code, frontmatter, a page's text, a file not read or not parsed", async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'styles/site.css': '/* url(/img/a.png) */\n.x { color: red; }\n',
      'styles/site.scss': '// url(/img/a.png)\n.x { color: red; }\n',
      'docs/guide.md': [
        '---',
        'image: /img/a.png',
        '---',
        '',
        '```html',
        '<img src="/img/a.png">',
        '```',
        '',
        '<!-- /img/a.png -->',
        '',
        'The file /img/a.png is the logo.',
        '',
      ].join('\n'),
      'public/icon.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="/img/a.png"/></svg>\n',
      'src/broken.js': "export const = '/img/a.png';\n",
      'data/links.json': '{ "logo": "see /img/a.png" }\n',
    });

    const lines = await linesFor(root, 'public/img/a.png');

    expect(lines).toMatchObject({
      'styles/site.css:1': { reason: 'comment' },
      'styles/site.scss:1': { reason: 'comment' },
      'docs/guide.md:2': { reason: 'data-or-props', why: expect.stringContaining('frontmatter') },
      'docs/guide.md:6': { reason: 'other', why: expect.stringContaining('code example') },
      'docs/guide.md:9': { reason: 'comment' },
      'docs/guide.md:11': { reason: 'other', why: expect.stringContaining('text of a page') },
      'public/icon.svg:1': { reason: 'unread-file-type', why: expect.stringContaining('.svg') },
      'src/broken.js:1': { reason: 'other', why: expect.stringContaining('could not parse') },
      'data/links.json:1': { reason: 'data-or-props' },
    });
  });

  it('reads a path built by a template engine as built at runtime', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'views/page.erb': '<img src="<%= base %>/img/a.png">\n',
      'views/page.liquid': '<img src="{{ site.url }}/img/a.png">\n',
    });

    expect(await linesFor(root, 'public/img/a.png')).toMatchObject({
      'views/page.erb:1': { reason: 'built-at-runtime' },
      'views/page.liquid:1': { reason: 'built-at-runtime' },
    });
  });

  it('leaves out a longer name and a folder whose name only ends like the image', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'notes.txt': 'old-img/a.png\n/img/a.png.bak\nimg/a.png@2x\n',
    });

    expect(await linesFor(root, 'public/img/a.png')).toEqual({});
  });

  it('lists a line naming two files by the place that names this image', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'src/img/a.png': 'IMAGE',
      'src/both.vue': '<img src="./img/a.png"> <img src="/img/a.png">\n',
    });

    expect(await linesFor(root, 'public/img/a.png')).toMatchObject({
      'src/both.vue:1': { reason: 'unread-file-type', text: '/img/a.png' },
    });
    expect(await linesFor(root, 'src/img/a.png')).toMatchObject({
      'src/both.vue:1': { reason: 'unread-file-type', text: './img/a.png' },
    });
  });
});

describe('a path written the way a browser reads it', () => {
  it('lists a comment, a file type Upfly does not read and a template that name it encoded', async () => {
    // Each line writes the path the way a URL or a page spells it, and a browser decodes it to
    // this image, so each names it as surely as the plain spelling would.
    const root = await project({
      'public/img/a b.png': 'IMAGE',
      'index.html': [
        '<!doctype html>',
        '<img src="/img/a%20b.png" alt="">',
        '<!-- <img src="/img/a%20b.png" alt=""> -->',
        '',
      ].join('\n'),
      'src/Team.vue': '<template>\n  <img src="/img/a%20b.png">\n</template>\n',
      'src/_includes/team.njk': '<img src="/img/a&#32;b.png">\n',
      'src/site.css': '/* url(/img/a%20b.png) */\n.x { color: red; }\n',
    });

    const lines = await linesFor(root, 'public/img/a b.png');

    expect(Object.keys(lines).sort()).toEqual([
      'index.html:3',
      'src/Team.vue:2',
      'src/_includes/team.njk:1',
      'src/site.css:1',
    ]);
    expect(lines).toMatchObject({
      'index.html:3': { reason: 'comment', loads: false, text: '/img/a%20b.png' },
      'src/Team.vue:2': { reason: 'unread-file-type', loads: true, text: '/img/a%20b.png' },
      'src/_includes/team.njk:1': { reason: 'unread-file-type', loads: true },
      'src/site.css:1': { reason: 'comment', loads: false },
    });
  });

  it('lists a name beyond ASCII written as its escapes, and one encoded in part', async () => {
    const root = await project({
      'public/img/café au lait.png': 'IMAGE',
      'src/Team.vue': [
        '<template>',
        '  <img src="/img/caf%C3%A9%20au%20lait.png">',
        '  <img src="/img/caf%c3%a9 au lait.png">',
        '</template>',
        '',
      ].join('\n'),
    });

    expect(Object.keys(await linesFor(root, 'public/img/café au lait.png')).sort()).toEqual([
      'src/Team.vue:2',
      'src/Team.vue:3',
    ]);
  });

  it('lists nothing for a path that decodes to another file', async () => {
    const root = await project({
      'public/img/a b.png': 'IMAGE',
      'src/Team.vue': '<template>\n  <img src="/img/a%2520b.png">\n</template>\n',
    });

    expect(await linesFor(root, 'public/img/a b.png')).toEqual({});
  });
});

describe('whether a page still loads the image through a line', () => {
  it('counts a value no reader takes a path from as loading, such as HTML inside a string', async () => {
    // A shortcode returns this HTML for a page to show, so the image loads through it, and a
    // move that leaves the line breaks every page it is on.
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'site.config.js':
        'const avatar = `<img src="/img/a.png" alt="" loading="lazy">`;\nexport default { avatar };\n',
    });

    expect(await linesFor(root, 'public/img/a.png')).toMatchObject({
      'site.config.js:1': { reason: 'other', loads: true },
    });
  });

  it('counts an HTML attribute Upfly does not read as loading, and names the attribute', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'index.html': [
        '<!doctype html>',
        '<img class="lazy" data-src="/img/a.png" alt="">',
        `<img class="lazy" data-src="{{ '/img/a.png' | url }}" alt="">`,
        '',
      ].join('\n'),
    });

    expect(await linesFor(root, 'public/img/a.png')).toMatchObject({
      'index.html:2': {
        reason: 'data-or-props',
        why: expect.stringContaining('data-src'),
        loads: true,
      },
      'index.html:3': { loads: true },
    });
  });

  it('counts a line as loading nothing only where Upfly read it: a comment, a code example, prose', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'docs/guide.md': [
        'The logo is /img/a.png, kept small.',
        '',
        'Copy it with `cp /img/a.png out/`.',
        '',
        '```js',
        "load('/img/a.png');",
        '```',
        '',
      ].join('\n'),
      'about.html': '<!doctype html>\n<p>Our logo lives at /img/a.png.</p>\n<!-- /img/a.png -->\n',
      'src/app.js': "// '/img/a.png'\nexport {};\n",
    });

    expect(await linesFor(root, 'public/img/a.png')).toMatchObject({
      'docs/guide.md:1': { why: expect.stringContaining('text of a page'), loads: false },
      'docs/guide.md:3': { why: expect.stringContaining('code example'), loads: false },
      'docs/guide.md:6': { why: expect.stringContaining('code example'), loads: false },
      'about.html:2': { why: expect.stringContaining('text of a page'), loads: false },
      'about.html:3': { reason: 'comment', loads: false },
      'src/app.js:1': { reason: 'comment', loads: false },
    });
  });

  it("counts a script or a template engine's tag inside a page as loading", async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'index.html': '<!doctype html>\n<script>\n  hero.src = "/img/a.png";\n</script>\n',
      'docs/page.md': 'The logo:\n\n{% image "/img/a.png", "The logo" %}\n',
    });

    expect(await linesFor(root, 'public/img/a.png')).toMatchObject({
      'index.html:3': { reason: 'other', loads: true },
      'docs/page.md:3': { reason: 'other', why: expect.stringContaining('Nunjucks'), loads: true },
    });
  });
});

describe('the search behind the list', () => {
  it('returns every match, the spellings that overlap at one place included', async () => {
    const texts: Record<string, string> = {
      'a.html': '<img src="/img/a.png"> <img src="../img/a.png">\n',
      'b.txt': 'nothing here\n',
    };

    const found = await findPathOccurrences({
      paths: ['public/img/a.png'],
      files: [...Object.keys(texts), 'gone.txt'],
      readFile: async (file) => {
        const text = texts[file];
        if (text === undefined) throw new Error('ENOENT');
        return text;
      },
      servingDirs: ['public'],
    });

    expect(found.occurrences.map((occurrence) => [occurrence.offset, occurrence.spelling])).toEqual(
      [
        [10, '/img/a.png'],
        [11, 'img/a.png'],
        [35, '/img/a.png'],
        [36, 'img/a.png'],
      ],
    );
    expect([...found.texts.keys()]).toEqual(['a.html']);
    expect(found.unsearchable).toEqual([{ file: 'gone.txt', reason: 'ENOENT' }]);
    expect(found.filesSearched).toBe(2);
  });
});
