import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UpflyError } from '../errors.js';
import type { Adapter } from '../types.js';
import { discover, listExcludedFiles } from './discover.js';

/**
 * `discover` is one of the few modules that touch the disk, so it is tested against a
 * real temporary tree rather than a mock. Mocking `fs` here would test our idea of the
 * filesystem instead of the filesystem.
 */

const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    // Permissions are dropped in some tests; restore them so cleanup can succeed.
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Build a temp tree. A key ending in `/` creates an empty directory. */
async function makeTree(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-discover-'));
  createdRoots.push(root);

  for (const [relative, contents] of Object.entries(entries)) {
    const full = join(root, relative);
    if (relative.endsWith('/')) {
      await mkdir(full, { recursive: true });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

/** A stand-in adapter: `discover` only ever reads `id` and `extensions`. */
function fakeAdapter(id: string, extensions: readonly string[]): Adapter {
  return {
    id,
    extensions,
    findReferences: () => [],
    rewrite: ({ text }) => text,
  };
}

const html = fakeAdapter('html', ['.html']);
const css = fakeAdapter('css', ['.css']);
const adapters = [html, css];

/** These tests drop permission bits, which Windows has no equivalent for; root ignores them. */
const cannotDropPermissions = process.platform === 'win32' || process.getuid?.() === 0;

describe('discover', () => {
  it('finds images and adapter-claimed source files, and nothing else', async () => {
    const root = await makeTree({
      'index.html': '<img src="hero.png">',
      'src/app.css': 'body {}',
      'src/hero.png': 'fake-png',
      'src/logo.svg': '<svg/>',
      'src/notes.txt': 'not claimed by any adapter',
      'README.md': 'no markdown adapter is registered in this test',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['src/hero.png', 'src/logo.svg']);
    expect(result.sourceFiles.map((file) => file.relative)).toEqual(['index.html', 'src/app.css']);
    expect(result.skipped).toEqual([]);
  });

  it('records the adapter that claimed each source file', async () => {
    const root = await makeTree({ 'a.html': '', 'b.css': '' });

    const result = await discover({ root, adapters });

    expect(result.sourceFiles.map((file) => [file.relative, file.adapterId])).toEqual([
      ['a.html', 'html'],
      ['b.css', 'css'],
    ]);
  });

  it('reports each asset with its size and lowercase extension', async () => {
    const root = await makeTree({ 'HERO.PNG': 'twelve bytes' });

    const result = await discover({ root, adapters });

    expect(result.assets).toEqual([
      {
        path: join(root, 'HERO.PNG'),
        relative: 'HERO.PNG',
        extension: '.png',
        bytes: 12,
      },
    ]);
  });

  it('prunes the default-ignored directories without descending into them', async () => {
    const root = await makeTree({
      'keep.png': '',
      'node_modules/pkg/dead.png': '',
      'dist/built.png': '',
      '.git/objects/thing.png': '',
      'src/nested/deep/real.png': '',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual([
      'keep.png',
      'src/nested/deep/real.png',
    ]);
    // Three pruned directories, counted once each rather than once per file inside.
    expect(result.ignoredCount).toBe(3);
  });

  it('applies .upflyignore patterns for files, directories and negations', async () => {
    const root = await makeTree({
      '.upflyignore': ['*.png', '!keep.png', 'vendor/', 'docs/draft.css'].join('\n'),
      'drop.png': '',
      'keep.png': '',
      'keep.webp': '',
      'vendor/bundled.png': '',
      'docs/draft.css': '',
      'docs/real.css': '',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['keep.png', 'keep.webp']);
    expect(result.sourceFiles.map((file) => file.relative)).toEqual(['docs/real.css']);
    // drop.png, the vendor/ directory, and docs/draft.css.
    expect(result.ignoredCount).toBe(3);
  });

  it('records each excluded directory with the rule that excluded it', async () => {
    const root = await makeTree({
      '.upflyignore': 'legacy/\n',
      'node_modules/pkg/a.png': '',
      'legacy/old.png': '',
      'keep.png': '',
    });

    const result = await discover({ root, adapters });

    // The likeliest real case is not node_modules but a user who ignores `legacy/`
    // while it is still referenced. Recording the rule is what lets the report say why
    // an asset went missing.
    expect(result.excludedRoots.map((entry) => [entry.relative, entry.reason])).toEqual([
      ['legacy', "the ignore rule 'legacy/'"],
      ['node_modules', "a dependency directory named 'node_modules'"],
    ]);
  });

  it('names what each directory pruned by name holds', async () => {
    const root = await makeTree({
      '.git/objects/a.png': '',
      '.upfly/runs/a.png': '',
      'coverage/lcov/a.png': '',
      'dist/a.png': '',
      'keep.png': '',
    });

    const result = await discover({ root, adapters });

    expect(result.excludedRoots.map((entry) => [entry.relative, entry.reason])).toEqual([
      ['.git', "a version-control directory named '.git'"],
      ['.upfly', "Upfly's own directory named '.upfly'"],
      ['coverage', "a test-coverage directory named 'coverage'"],
      ['dist', "a build-output directory named 'dist'"],
    ]);
  });

  it('prunes the folders a site generator, a builder or a deploy tool writes into a built project', async () => {
    // A site built before Upfly runs holds a second copy of every image and page, which
    // would otherwise be planned as source: on a built eleventy-docs, 444 of 449 conversions.
    const root = await makeTree({
      '_site/index.html': '',
      '_site/img/a.png': '',
      '.docusaurus/registry.js': '',
      'storybook-static/static/media/a.png': '',
      '.vercel/output/static/a.png': '',
      '.netlify/functions/a.png': '',
      '.angular/cache/a.png': '',
      'src/img/a.png': '',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['src/img/a.png']);
    expect(result.excludedRoots.map((entry) => [entry.relative, entry.reason])).toEqual([
      ['.angular', "a cache directory named '.angular'"],
      ['.docusaurus', "a build-output directory named '.docusaurus'"],
      ['.netlify', "a build-output directory named '.netlify'"],
      ['.vercel', "a build-output directory named '.vercel'"],
      ['_site', "a build-output directory named '_site'"],
      ['storybook-static', "a build-output directory named 'storybook-static'"],
    ]);
  });

  it('prunes a Python environment, its installed packages and its compiled modules', async () => {
    // A project's own pages are its sources: a compiled module is read by Python only beside
    // its source, and a package's files are a dependency's, as in node_modules.
    const root = await makeTree({
      'venv/pyvenv.cfg': '',
      'venv/Lib/site-packages/django/contrib/admin/static/admin/img/icon.svg': '',
      '.venv/lib/python3.12/site-packages/pkg/a.png': '',
      'conda/lib/python3.12/site-packages/pkg/b.png': '',
      'app/__pycache__/views.cpython-313.pyc': '',
      'app/views.py': '',
      'static/img/a.png': '',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['static/img/a.png']);
    expect(result.unscannedFiles.map((file) => file.relative)).toEqual(['app/views.py']);
    expect(result.excludedRoots.map((entry) => [entry.relative, entry.reason])).toEqual([
      ['.venv', "a Python environment named '.venv'"],
      ['app/__pycache__', "a cache directory named '__pycache__'"],
      ['conda/lib/python3.12/site-packages', "a dependency directory named 'site-packages'"],
      ['venv', "a Python environment named 'venv'"],
    ]);
  });

  it('prunes the metadata a zip made on macOS holds beside its files', async () => {
    // Each `._` file is the resource fork and attributes of the file of the same name, in
    // binary under a source or image extension: no page loads one.
    const root = await makeTree({
      '__MACOSX/theme/._style.css': '\0\u0005\u0016\u0007\0\u0002\0\0Mac OS X',
      '__MACOSX/theme/._logo.png': '\0\u0005\u0016\u0007\0\u0002\0\0Mac OS X',
      'theme/style.css': 'a { color: red }',
      'theme/logo.png': '',
    });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['theme/logo.png']);
    expect(result.sourceFiles.map((file) => file.relative)).toEqual(['theme/style.css']);
    expect(result.excludedRoots.map((entry) => [entry.relative, entry.reason])).toEqual([
      ['__MACOSX', "a directory of macOS file metadata named '__MACOSX'"],
    ]);
  });

  describe('a site generator that builds into public', () => {
    // Hugo, Gatsby and Hexo build a site into `public`, the name Vite and Next.js give the
    // folder they serve as written, so only the generator's own settings beside it tell the
    // two apart. Read as source, the built copy of an image is the one a post links, and a
    // run would rewrite the post to name a file only the build output holds.
    const BUILT_SITE = {
      'content/post.md': '![The logo](/img/a.png)\n',
      'static/img/a.png': '',
      'public/img/a.png': '',
      'public/index.html': '<img src="/img/a.png" alt="The logo">\n',
    };

    it.each([
      ['hugo.toml', "Hugo's settings file 'hugo.toml'"],
      ['hugo.yaml', "Hugo's settings file 'hugo.yaml'"],
      ['hugo.yml', "Hugo's settings file 'hugo.yml'"],
      ['hugo.json', "Hugo's settings file 'hugo.json'"],
      ['gatsby-config.js', "Gatsby's settings file 'gatsby-config.js'"],
      ['gatsby-config.mjs', "Gatsby's settings file 'gatsby-config.mjs'"],
      ['gatsby-config.ts', "Gatsby's settings file 'gatsby-config.ts'"],
    ])('prunes public beside %s, naming the settings file', async (settings, named) => {
      const root = await makeTree({ ...BUILT_SITE, [settings]: '' });

      const result = await discover({ root, adapters });

      expect(result.assets.map((asset) => asset.relative)).toEqual(['static/img/a.png']);
      expect(result.sourceFiles).toEqual([]);
      expect(result.directories).not.toContain('public');
      expect(result.excludedRoots).toEqual([
        {
          path: join(root, 'public'),
          relative: 'public',
          reason: `a build-output directory named 'public', beside ${named}`,
          byRule: false,
        },
      ]);
    });

    it("prunes public beside a package.json whose hexo field marks a Hexo site, Hexo's own test", async () => {
      const root = await makeTree({
        ...BUILT_SITE,
        '_config.yml': 'public_dir: public\n',
        'package.json': JSON.stringify({ name: 'blog', hexo: { version: '7.3.0' } }),
      });

      const result = await discover({ root, adapters });

      expect(result.assets.map((asset) => asset.relative)).toEqual(['static/img/a.png']);
      expect(result.excludedRoots.map((entry) => [entry.relative, entry.reason])).toEqual([
        [
          'public',
          "a build-output directory named 'public', beside a package.json whose hexo field marks a Hexo site",
        ],
      ]);
    });

    it('keeps reading a public folder that no generator settings sit beside', async () => {
      // Vite's and Next.js's public folders are source. `config.toml` is Hugo's older name and
      // other tools' too, and `_config.yml` is Jekyll's as well as Hexo's, so neither decides.
      const beside: readonly Record<string, string>[] = [
        { 'package.json': '{ "scripts": { "build": "vite build" } }', 'vite.config.ts': '' },
        { 'package.json': '{ "scripts": { "build": "next build" } }', 'next.config.mjs': '' },
        { 'config.toml': '' },
        { '_config.yml': '' },
        { 'package.json': '{ "hexo": "7.3.0" }' },
        { 'package.json': '{ "hexo": ' },
        { 'hugo.toml/': '' },
      ];
      for (const files of beside) {
        const root = await makeTree({ ...BUILT_SITE, ...files });

        const result = await discover({ root, adapters });

        expect(result.excludedRoots, Object.keys(files).join(', ')).toEqual([]);
        expect(result.directories).toContain('public');
        expect(result.assets.map((asset) => asset.relative)).toContain('public/img/a.png');
      }
    });

    it('decides beside each folder, at any depth', async () => {
      // A Vite app at the root and a Hugo site in docs/: only the site's output is pruned.
      const root = await makeTree({
        'package.json': '{ "scripts": { "build": "vite build" } }',
        'public/logo.png': '',
        'docs/hugo.toml': '',
        'docs/static/img/a.png': '',
        'docs/public/img/a.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.assets.map((asset) => asset.relative)).toEqual([
        'docs/static/img/a.png',
        'public/logo.png',
      ]);
      expect(result.excludedRoots.map((entry) => entry.relative)).toEqual(['docs/public']);
    });

    it('names the same generator on every run when the settings of two sit beside public', async () => {
      const root = await makeTree({ ...BUILT_SITE, 'gatsby-config.js': '', 'hugo.toml': '' });

      const reasons = await Promise.all(
        [1, 4, 16].map(async (concurrency) => {
          const result = await discover({ root, adapters, concurrency });
          return result.excludedRoots.map((entry) => entry.reason);
        }),
      );

      expect(reasons).toEqual(
        Array(3).fill([
          "a build-output directory named 'public', beside Hugo's settings file 'hugo.toml'",
        ]),
      );
    });
  });

  it('marks which excluded directories the project rules left out, and which the walk pruned', async () => {
    const root = await makeTree({
      'hugo.toml': '',
      'public/img/a.png': '',
      'legacy/old.png': '',
      'node_modules/pkg/a.png': '',
    });

    const result = await discover({ root, adapters, extraIgnores: ['legacy/'] });

    expect(result.excludedRoots.map((entry) => [entry.relative, entry.byRule])).toEqual([
      ['legacy', true],
      ['node_modules', false],
      ['public', false],
    ]);
  });

  it('records each image an ignore rule excluded by name, apart from the files it reads', async () => {
    const root = await makeTree({
      '.upflyignore': ['public/icons/touch.png', '*.svg', 'drafts/'].join('\n'),
      'public/icons/touch.png': '',
      'public/logo.svg': '',
      'public/og.jpg': '',
      'public/hero.png': '',
      'drafts/old.png': '',
    });

    const result = await discover({ root, adapters, extraIgnores: ['public/og.jpg'] });

    // A reference to one of these points into a file the run was asked to leave out. An
    // image inside an excluded directory is not listed: the walk never looks inside one.
    expect(result.excludedImages).toEqual([
      'public/icons/touch.png',
      'public/logo.svg',
      'public/og.jpg',
    ]);
    expect(result.assets.map((asset) => asset.relative)).toEqual(['public/hero.png']);
  });

  it('leaves excludedRoots empty when nothing was excluded', async () => {
    const root = await makeTree({ 'a.png': '', 'src/b.png': '' });

    expect((await discover({ root, adapters })).excludedRoots).toEqual([]);
  });

  describe('unscanned files', () => {
    it('records every file no adapter claimed, with its path', async () => {
      const root = await makeTree({
        'index.html': '',
        'src/hero.png': '',
        'src/notes.txt': '',
        'config.yaml': '',
        LICENSE: '',
      });

      const result = await discover({ root, adapters });

      // The path, not just the extension: the audit sweeps these files for the
      // filenames of zero-reference assets, and hedges per asset rather than
      // globally. A count alone could not name the file in the report.
      expect(result.unscannedFiles.map((file) => [file.relative, file.extension])).toEqual([
        ['LICENSE', ''],
        ['config.yaml', '.yaml'],
        ['src/notes.txt', '.txt'],
      ]);
      expect(result.unscannedFiles.every((file) => file.reason === 'unclaimed-extension')).toBe(
        true,
      );
    });

    it('records an SVG as an asset and as unscanned', async () => {
      const root = await makeTree({ 'icons/sprite.svg': '<svg/>', 'hero.png': '' });

      const result = await discover({ root, adapters });

      // An SVG is both. `<image href="hero.png">` inside a sprite is a real
      // reference no adapter reads, so an asset mentioned only there must not be
      // reported as confidently dead.
      expect(result.assets.map((asset) => asset.relative)).toEqual([
        'hero.png',
        'icons/sprite.svg',
      ]);
      expect(result.unscannedFiles.map((file) => file.relative)).toEqual(['icons/sprite.svg']);
    });

    it('does not record other image formats as unscanned', async () => {
      const root = await makeTree({ 'a.png': '', 'b.jpg': '', 'c.webp': '' });

      // A PNG cannot reference another asset, so listing one would be noise in the
      // report's coverage statement and cost the audit a pointless read.
      expect((await discover({ root, adapters })).unscannedFiles).toEqual([]);
    });

    it('does not record ignored or excluded entries', async () => {
      const root = await makeTree({
        '.upflyignore': 'legacy/\nsecrets.txt\n',
        'legacy/old.vue': '',
        'node_modules/pkg/index.vue': '',
        'secrets.txt': '',
        'app.vue': '',
      });

      const result = await discover({ root, adapters });

      // An ignore rule is an instruction, not a gap in our coverage: hedging a report
      // on a directory the user told us to skip would mislead in the other direction,
      // and would mean walking a pruned node_modules. `.upflyignore` is absent because
      // we read it; it is not a file we failed on.
      expect(result.unscannedFiles.map((file) => file.relative)).toEqual(['app.vue']);
    });

    it('does not record the ignore file it read, under any name', async () => {
      const root = await makeTree({ '.upflyrc': 'legacy/\n', 'a.png': '' });

      const result = await discover({ root, adapters, ignoreFile: '.upflyrc' });

      expect(result.unscannedFiles).toEqual([]);
    });

    it('leaves unscannedFiles empty when every file was claimed', async () => {
      const root = await makeTree({ 'index.html': '', 'app.css': '', 'hero.png': '' });

      // The case where a `dead` finding can be made confidently.
      expect((await discover({ root, adapters })).unscannedFiles).toEqual([]);
    });
  });

  it('applies extraIgnores as if appended to the ignore file', async () => {
    const root = await makeTree({ 'a.png': '', 'temp/b.png': '' });

    const result = await discover({ root, adapters, extraIgnores: ['temp/'] });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['a.png']);
    expect(result.ignoredCount).toBe(1);
  });

  it('honours a custom ignore-file name', async () => {
    const root = await makeTree({ '.customignore': '*.png', 'a.png': '', 'b.webp': '' });

    const result = await discover({ root, adapters, ignoreFile: '.customignore' });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['b.webp']);
  });

  it('treats a missing ignore file as the normal case, not a skip', async () => {
    const root = await makeTree({ 'a.png': '' });

    const result = await discover({ root, adapters });

    expect(result.skipped).toEqual([]);
    expect(result.assets).toHaveLength(1);
  });

  it('handles non-ASCII filenames', async () => {
    const root = await makeTree({ 'assets/héro-café.png': '', 'assets/日本語.webp': '' });

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual([
      'assets/héro-café.png',
      'assets/日本語.webp',
    ]);
  });

  it('produces identical output across runs and across concurrency settings', async () => {
    const root = await makeTree({
      'z/last.png': '',
      'a/first.png': '',
      'm/middle.html': '',
      'B/upper.png': '',
      'a/b/c/deep.css': '',
    });

    const [first, second, serial] = await Promise.all([
      discover({ root, adapters }),
      discover({ root, adapters }),
      discover({ root, adapters, concurrency: 1 }),
    ]);

    expect(second).toEqual(first);
    expect(serial).toEqual(first);
    expect(first.assets.map((asset) => asset.relative)).toEqual([
      'B/upper.png',
      'a/first.png',
      'z/last.png',
    ]);
  });

  it('does not follow symlinks, and says so', async (ctx) => {
    const root = await makeTree({ 'real/hero.png': '' });
    try {
      await symlink(join(root, 'real'), join(root, 'link'), 'dir');
    } catch {
      // Creating a symlink needs elevation or developer mode on Windows. Without either
      // this case cannot run, so the run counts it as skipped rather than passed.
      ctx.skip();
    }

    const result = await discover({ root, adapters });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['real/hero.png']);
    expect(result.skipped).toEqual([
      { path: join(root, 'link'), relative: 'link', reason: 'symlink', detail: 'not followed' },
    ]);
  });

  it.skipIf(cannotDropPermissions)('records a directory it cannot read', async () => {
    const root = await makeTree({ 'locked/hidden.png': '', 'open.png': '' });
    await chmod(join(root, 'locked'), 0o000);

    const result = await discover({ root, adapters });
    await chmod(join(root, 'locked'), 0o755);

    expect(result.assets.map((asset) => asset.relative)).toEqual(['open.png']);
    expect(result.skipped).toEqual([
      {
        path: join(root, 'locked'),
        relative: 'locked',
        reason: 'unreadable-directory',
        detail: 'EACCES',
      },
    ]);
  });

  it.skipIf(cannotDropPermissions)('records a file it can list but cannot stat', async () => {
    // r without x on a directory: readdir returns the names, stat on them fails.
    const root = await makeTree({ 'listable/hero.png': '' });
    await chmod(join(root, 'listable'), 0o444);

    const result = await discover({ root, adapters });
    await chmod(join(root, 'listable'), 0o755);

    expect(result.assets).toEqual([]);
    expect(result.skipped).toEqual([
      {
        path: join(root, 'listable', 'hero.png'),
        relative: 'listable/hero.png',
        reason: 'unreadable-file',
        detail: 'EACCES',
      },
    ]);
  });

  it.skipIf(cannotDropPermissions)(
    'records an unreadable ignore file rather than failing the run',
    async () => {
      const root = await makeTree({ '.upflyignore': '*.png', 'a.png': '' });
      await chmod(join(root, '.upflyignore'), 0o000);

      const result = await discover({ root, adapters });
      await chmod(join(root, '.upflyignore'), 0o644);

      // The rules could not be read, so nothing is ignored, and the skip says so.
      expect(result.assets.map((asset) => asset.relative)).toEqual(['a.png']);
      expect(result.skipped).toEqual([
        {
          path: join(root, '.upflyignore'),
          relative: '.upflyignore',
          reason: 'unreadable-file',
          detail: 'EACCES',
        },
      ]);
    },
  );

  it.skipIf(cannotDropPermissions)(
    'records an entry that is neither a file nor a directory',
    async () => {
      const root = await makeTree({ 'a.png': '' });
      const socketPath = join(root, 'daemon.sock');
      const server = createServer();
      await new Promise<void>((done) => server.listen(socketPath, done));

      const result = await discover({ root, adapters });
      await new Promise<void>((done) => server.close(() => done()));

      expect(result.assets.map((asset) => asset.relative)).toEqual(['a.png']);
      expect(result.skipped).toEqual([
        {
          path: socketPath,
          relative: 'daemon.sock',
          reason: 'not-a-regular-file',
          detail: 'neither a file nor a directory',
        },
      ]);
    },
  );

  it('rejects two adapters claiming the same extension', async () => {
    const root = await makeTree({ 'a.html': '' });
    const rival = fakeAdapter('other-html', ['.html']);

    await expect(discover({ root, adapters: [html, rival] })).rejects.toMatchObject({
      code: 'ADAPTER_EXTENSION_CONFLICT',
    });
  });

  it('rejects a root that does not exist', async () => {
    const root = join(tmpdir(), 'upfly-does-not-exist-4f2a9c');

    await expect(discover({ root, adapters })).rejects.toBeInstanceOf(UpflyError);
    await expect(discover({ root, adapters })).rejects.toMatchObject({
      code: 'ROOT_NOT_A_DIRECTORY',
    });
  });

  it('rejects a root that is a file', async () => {
    const root = await makeTree({ 'file.txt': '' });

    await expect(discover({ root: join(root, 'file.txt'), adapters })).rejects.toMatchObject({
      code: 'ROOT_NOT_A_DIRECTORY',
    });
  });

  it('returns an absolute, resolved root', async () => {
    const root = await makeTree({ 'a.png': '' });

    const result = await discover({ root: join(root, '.', 'nested', '..'), adapters });

    expect(result.root).toBe(root);
  });

  it('walks an empty project without complaint', async () => {
    const root = await makeTree({ 'empty/': '' });

    const result = await discover({ root, adapters });

    expect(result).toEqual({
      root,
      assets: [],
      sourceFiles: [],
      directories: ['empty'],
      ignoredCount: 0,
      excludedFiles: [],
      excludedImages: [],
      skipped: [],
      excludedRoots: [],
      unscannedFiles: [],
    });
  });

  it('works with no adapters at all, finding only assets', async () => {
    const root = await makeTree({ 'a.png': '', 'b.html': '' });

    const result = await discover({ root, adapters: [] });

    expect(result.assets.map((asset) => asset.relative)).toEqual(['a.png']);
    expect(result.sourceFiles).toEqual([]);
  });

  describe('the walked directories', () => {
    it('lists every directory it descended into, sorted, without the root', async () => {
      const root = await makeTree({
        'index.html': '',
        'public/hero.png': '',
        'src/components/button.css': '',
        'src/hero.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.directories).toEqual(['public', 'src', 'src/components']);
    });

    it('lists a directory holding only files nothing tracks', async () => {
      // Why directories are recorded rather than derived from the paths in `assets` and
      // `sourceFiles`: deriving loses this one. In shadcn-ui, `templates/next-app/public`
      // holds only a `.gitkeep` and is still a serving root.
      const root = await makeTree({
        'public/.gitkeep': '',
        'static/robots.txt': '',
        'src/hero.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.assets.map((asset) => asset.relative)).toEqual(['src/hero.png']);
      expect(result.directories).toEqual(['public', 'src', 'static']);
    });

    it('lists an entirely empty directory', async () => {
      const root = await makeTree({ 'assets/': '', 'a.png': '' });

      const result = await discover({ root, adapters });

      expect(result.directories).toEqual(['assets']);
    });

    it('omits a directory an ignore rule excluded, because the walk never entered it', async () => {
      const root = await makeTree({
        '.upflyignore': 'legacy/\n',
        'legacy/public/old.png': '',
        'public/hero.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.directories).toEqual(['public']);
      expect(result.excludedRoots.map((excluded) => excluded.relative)).toEqual(['legacy']);
    });

    it('omits node_modules, which is where a detector would otherwise find hundreds', async () => {
      const root = await makeTree({
        'node_modules/some-package/public/demo.png': '',
        'public/hero.png': '',
      });

      const result = await discover({ root, adapters });

      expect(result.directories).toEqual(['public']);
    });
  });
});

describe('listExcludedFiles', () => {
  it('lists what the rules kept out, but no raster image and nothing a name prunes', async () => {
    const root = await makeTree({
      'index.html': '',
      'notes.txt': '',
      'drafts.html': '',
      'legacy/old.html': '',
      'legacy/icon.svg': '',
      'legacy/photo.png': '',
      'legacy/node_modules/theme/page.html': '',
      'node_modules/theme/page.html': '',
    });
    const result = await discover({ root, adapters, extraIgnores: ['legacy', 'drafts.html'] });

    const listing = await listExcludedFiles(result);

    expect(listing.files).toEqual(['drafts.html', 'legacy/icon.svg', 'legacy/old.html']);
    expect(listing.unread).toEqual([]);
  });

  it("reads nothing in a site generator's build output, as in other build output", async () => {
    // Generated from the sources the run reads, so a page there that still names an
    // original says nothing about whether that original may go.
    const root = await makeTree({
      'hugo.toml': '',
      'public/index.html': '',
      'public/img/a.svg': '',
      'legacy/old.html': '',
    });
    const result = await discover({ root, adapters, extraIgnores: ['legacy'] });

    const listing = await listExcludedFiles(result);

    expect(listing.files).toEqual(['legacy/old.html']);
  });

  it('names a directory it could not list, and never skips it in silence', async () => {
    const root = await makeTree({ 'index.html': '', 'legacy/old.html': '' });
    const result = await discover({ root, adapters, extraIgnores: ['legacy'] });
    // Replaced by a file after the walk, so listing it fails as an unreadable one would.
    await rm(join(root, 'legacy'), { recursive: true });
    await writeFile(join(root, 'legacy'), '');

    const listing = await listExcludedFiles(result);

    expect(listing.files).toEqual([]);
    expect(listing.unread.map((entry) => entry.file)).toEqual(['legacy']);
  });
});
