import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { moveProject } from './move-project.js';
import { createNodeFileStore } from './write/file-store-node.js';
import { revert } from './write/transaction.js';

const LOGO = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/plain-html/images/logo.png',
);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A project outside the workspace; `IMAGE` is written as a real PNG. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-move-'));
  roots.push(root);
  const logo = await readFile(LOGO);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content === 'IMAGE' ? logo : content);
  }
  return root;
}

/** Every file under `root` but Upfly's own folder, with a hash of its bytes. */
async function snapshot(root: string, folder = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (path === '.upfly') continue;
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, path));
    else {
      files[path] = createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex');
    }
  }
  return files;
}

const SERVED = { declared: true, dirs: ['public'] } as const;

describe('moveProject', () => {
  it('moves the image, points each reference at it, and undo puts every byte back', async () => {
    const root = await project({
      'public/hero.png': 'IMAGE',
      'index.html': '<img src="/hero.png" alt="">\n',
      'about/index.html': '<img src="../public/hero.png" alt="">\n',
    });
    const before = await snapshot(root);

    const { plan, manifest } = await moveProject({
      root,
      declared: SERVED,
      apply: true,
      moves: [{ from: 'public/hero.png', to: 'public/img/hero.png' }],
    });

    expect(plan.moves).toEqual([{ from: 'public/hero.png', to: 'public/img/hero.png' }]);
    expect(plan.refused).toEqual([]);
    expect(manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe(
      '<img src="/img/hero.png" alt="">\n',
    );
    expect(await readFile(join(root, 'about/index.html'), 'utf8')).toBe(
      '<img src="../public/img/hero.png" alt="">\n',
    );
    expect(Object.keys(await snapshot(root))).toContain('public/img/hero.png');
    expect(Object.keys(await snapshot(root))).not.toContain('public/hero.png');

    if (manifest === null) throw new Error('the run wrote nothing');
    await revert(manifest, createNodeFileStore(root));
    expect(await snapshot(root)).toEqual(before);
  });

  it('moves every image under a folder to the same place under the destination', async () => {
    const root = await project({
      'public/img/a.png': 'IMAGE',
      'public/img/icons/b.png': 'IMAGE',
      'index.html': '<img src="/img/a.png" alt=""><img src="/img/icons/b.png" alt="">\n',
    });

    const { plan } = await moveProject({
      root,
      declared: SERVED,
      apply: false,
      moves: [{ from: 'public/img', to: 'public/images' }],
    });

    expect(plan.moves).toEqual([
      { from: 'public/img/a.png', to: 'public/images/a.png' },
      { from: 'public/img/icons/b.png', to: 'public/images/icons/b.png' },
    ]);
    expect(plan.rewrites[0]?.edits.map((edit) => edit.replacement)).toEqual([
      '/images/a.png',
      '/images/icons/b.png',
    ]);
  });

  it('lists every line still naming the old path, an excluded page among them', async () => {
    const root = await project({
      'public/hero.png': 'IMAGE',
      'index.html': '<img src="/hero.png" alt="">\n',
      'src/seo.ts': "export const image = 'https://example.com/hero.png';\n",
      'legacy/old.html': '<img src="/hero.png" alt="">\n',
    });

    const { plan } = await moveProject({
      root,
      declared: SERVED,
      apply: false,
      moves: [{ from: 'public/hero.png', to: 'public/img/hero.png' }],
      extraIgnores: ['legacy'],
    });

    expect(plan.unfollowed.map((line) => [`${line.file}:${line.line}`, line.reason])).toEqual([
      ['legacy/old.html:1', 'other'],
      ['src/seo.ts:1', 'full-address'],
    ]);
  });

  it('rewrites the path inside a comment, and leaves it out of the lines it lists', async () => {
    // Nothing loads a comment, so a path in one never makes an image move; once the image
    // moves, the path in the comment names nothing, so it moves too.
    const root = await project({
      'public/hero.png': 'IMAGE',
      'index.html': `<img src="/hero.png" alt="">\n`,
      'src/app.js': `const hero = '/hero.png';\n// const old = '/hero.png';\n`,
      'src/site.css': '/* background: url(/hero.png); */\n',
    });

    const { plan, manifest } = await moveProject({
      root,
      declared: SERVED,
      apply: true,
      moves: [{ from: 'public/hero.png', to: 'public/img/hero.png' }],
    });

    expect(plan.unfollowed).toEqual([]);
    expect(await readFile(join(root, 'src/app.js'), 'utf8')).toBe(
      `const hero = '/img/hero.png';\n// const old = '/img/hero.png';\n`,
    );
    expect(await readFile(join(root, 'src/site.css'), 'utf8')).toBe(
      '/* background: url(/img/hero.png); */\n',
    );
    // In the run's record, so `undo` puts the comment back with everything else.
    expect(
      manifest?.operations.some(
        (operation) => operation.kind === 'edit' && operation.path === 'src/site.css',
      ),
    ).toBe(true);
  });

  it("rewrites a path a comment writes percent-encoded, in the destination's encoded spelling", async () => {
    const root = await project({
      'public/img/a b.png': 'IMAGE',
      'index.html':
        '<img src="/img/a%20b.png" alt="">\n<!-- <img src="/img/a%20b.png" alt=""> -->\n',
    });

    const { plan } = await moveProject({
      root,
      declared: SERVED,
      apply: true,
      moves: [{ from: 'public/img/a b.png', to: 'public/my pics/a b.png' }],
    });

    expect(plan.unfollowed).toEqual([]);
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe(
      '<img src="/my%20pics/a%20b.png" alt="">\n<!-- <img src="/my%20pics/a%20b.png" alt=""> -->\n',
    );
  });

  it('lists a line that names a moved folder percent-encoded', async () => {
    // The folder's URL is written the way a browser asks for it, so the rule still names the
    // folder after it has gone.
    const root = await project({
      'public/my img/hero.png': 'IMAGE',
      'index.html': '<img src="/my%20img/hero.png" alt="">\n',
      'netlify.toml': '[[headers]]\n  for = "/my%20img/*"\n',
    });

    const { plan } = await moveProject({
      root,
      declared: SERVED,
      apply: false,
      moves: [{ from: 'public/my img', to: 'public/pictures' }],
    });

    expect(plan.unfollowed.map((line) => [`${line.file}:${line.line}`, line.reason])).toEqual([
      ['netlify.toml:2', 'folder'],
    ]);
  });

  it('lists the lines that name a moved folder itself, and not the page of that name', async () => {
    // A rule that copies the folder, a pattern that matches inside it and a path built from
    // it name no image, so nothing rewrites them and each points at a folder that is not
    // there after the move. The link to the page of the same name is not one of them.
    const root = await project({
      'public/img/hero.png': 'IMAGE',
      'index.html': `<img src="/img/hero.png" alt=""><a href="/img">Gallery</a>
`,
      'build.config.js': `copy('public/img');
const glob = 'public/img/**';
`,
      'src/gallery.js': `const src = '/img/' + name + '.png';
`,
      'src/other.js': `import x from './images/x.js';
`,
    });

    const { plan } = await moveProject({
      root,
      declared: SERVED,
      apply: false,
      moves: [{ from: 'public/img', to: 'public/pictures' }],
    });

    expect(plan.unfollowed.map((line) => [`${line.file}:${line.line}`, line.reason])).toEqual([
      ['build.config.js:1', 'folder'],
      ['build.config.js:2', 'folder'],
    ]);
    // Only beyond what the plan already says: the path built at runtime is already cited as
    // a reference that cannot follow, and the link to the page of that name names no folder.
    expect(plan.declined.map((entry) => `${entry.file}:${entry.line}`)).toEqual([
      'src/gallery.js:1',
    ]);
    expect(plan.unfollowed.every((line) => line.loads)).toBe(true);
  });

  it('takes whether a line naming the folder loads from where it sits, and says when it names a path inside', async () => {
    // Documentation that writes the folder in an example or in prose loads nothing through it,
    // and a link to a file a build writes into the folder names that file, not the folder.
    const root = await project({
      'public/img/hero.png': 'IMAGE',
      'index.html': '<img src="/img/hero.png" alt="">\n',
      'build.config.js': "copy('public/img');\n// copy('public/img');\n",
      'docs/setup.md': [
        'Put images in `public/img` before you build.',
        '',
        'The build copies public/img to the site.',
        '',
        '```js',
        "copy('public/img');",
        '```',
        '',
      ].join('\n'),
      'layout.njk': '<link rel="icon" href="/img/favicon.png">\n',
    });

    const { plan } = await moveProject({
      root,
      declared: SERVED,
      apply: false,
      moves: [{ from: 'public/img', to: 'public/pictures' }],
    });

    const lines = Object.fromEntries(
      plan.unfollowed.map((line) => [`${line.file}:${line.line}`, line]),
    );
    expect(Object.keys(lines).sort()).toEqual([
      'build.config.js:1',
      'build.config.js:2',
      'docs/setup.md:1',
      'docs/setup.md:3',
      'docs/setup.md:6',
      'layout.njk:1',
    ]);
    expect(lines).toMatchObject({
      'build.config.js:1': { loads: true, why: expect.stringContaining('the folder itself') },
      'build.config.js:2': { loads: false, why: expect.stringContaining('in a comment') },
      'docs/setup.md:1': { loads: false, why: expect.stringContaining('code example') },
      'docs/setup.md:3': { loads: false, why: expect.stringContaining('text of a page') },
      'docs/setup.md:6': { loads: false, why: expect.stringContaining('code example') },
      'layout.njk:1': {
        loads: true,
        why: expect.stringContaining('a path inside the moved folder'),
      },
    });
    expect(plan.unfollowed.every((line) => line.reason === 'folder')).toBe(true);
  });

  it('cites a reference that cannot follow, and writes nothing for a refused move', async () => {
    const root = await project({
      'public/a.png': 'IMAGE',
      'public/b.png': 'IMAGE',
      'index.html': '<img src="/a.png" alt="">\n',
    });
    const before = await snapshot(root);

    const { plan, manifest } = await moveProject({
      root,
      declared: SERVED,
      apply: true,
      moves: [{ from: 'public/a.png', to: 'public/b.png' }],
    });

    expect(plan.refused.map((refusal) => refusal.code)).toEqual(['destination-occupied']);
    expect(manifest).toBeNull();
    expect(await snapshot(root)).toEqual(before);
  });
});
