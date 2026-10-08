import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { animatedPng, gradientFrames } from '../test/animated-png.js';
import { optimizeProject } from './optimize-project.js';
import { relativePath } from './paths.js';
import {
  type PipelineOutput,
  type PipelineProgress,
  runPipeline,
  servingRootsFor,
} from './pipeline.js';
import { MANIFEST_PATH } from './write/manifest.js';
import type { OptimizeProgress } from './write/optimize.js';

/** The plain HTML fixture: real images, relative references, no build step. */
const PLAIN_HTML = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/plain-html');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A copy of the fixture outside the workspace. */
async function copy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-optimize-project-'));
  roots.push(root);
  await cp(PLAIN_HTML, root, { recursive: true });
  return root;
}

async function files(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await files(root, path)));
    else found.push(path);
  }
  return found.sort();
}

describe('optimizeProject', () => {
  it('plans without writing, reports each stage, and leaves out what it is told to', async () => {
    const root = await copy();
    const before = await files(root);
    const stages: (PipelineProgress | OptimizeProgress)['stage'][] = [];

    const { pipeline, optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: false,
      extraIgnores: ['about.html'],
      onProgress: (event) => stages.push(event.stage),
      runId: 'run-fixed',
      now: () => '2026-09-26T00:00:00.000Z',
    });

    // One `measuring` event per image here, so repeats are collapsed to the order alone.
    expect(stages.filter((stage, index) => stage !== stages[index - 1])).toEqual([
      'discovered',
      'scanned',
      'resolved',
      'measuring',
      'measured',
      'audited',
      'planned',
    ]);
    expect(pipeline.servingRoots).toEqual({ dirs: [''], declared: true });
    expect(pipeline.discovery.sourceFiles.map((file) => file.relative)).not.toContain('about.html');
    expect(optimize.runId).toBe('run-fixed');
    expect(optimize.plan.conversions.length).toBeGreaterThan(0);
    expect(optimize.manifest).toBeNull();
    expect(await files(root)).toEqual(before);
  });

  it('writes nothing when the check before writing says no', async () => {
    const root = await copy();
    const before = await files(root);
    const asked: number[] = [];

    const { optimize } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
      beforeWrite: (plan) => {
        asked.push(plan.conversions.length);
        return false;
      },
    });

    expect(asked).toHaveLength(1);
    expect(optimize.manifest).toBeNull();
    expect(await files(root)).toEqual(before);
  });

  it('writes the plan and its record, taking the lock as the process it is told it is', async () => {
    const root = await copy();

    const { optimize } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
      lock: { pid: process.pid, isAlive: () => true },
    });

    expect(optimize.manifest?.state).toBe('committed');
    const written = await files(root);
    expect(written).toContain(MANIFEST_PATH);
    expect(written).toContain('images/logo.webp');
    expect(written).not.toContain('.upfly/lock');
  });
});

describe('a source file saved after the scan read it', () => {
  it('is refused, not edited at offsets counted in its old text', async () => {
    const root = await copy();
    const page = join(root, 'index.html');
    // Every reference after this line moves, which is what an editor's save does.
    const saved = `<!-- saved while the images were converting -->\n${await readFile(page, 'utf8')}`;
    const planned: string[] = [];

    const run = optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
      beforeWrite: async (plan) => {
        planned.push(...plan.rewrites.map((rewrite) => rewrite.file));
        await writeFile(page, saved);
        return true;
      },
    });

    await expect(run).rejects.toMatchObject({ code: 'TRANSACTION_FOREIGN_CHANGE' });
    expect(planned).toContain('index.html');
    expect(await readFile(page, 'utf8')).toBe(saved);
  });
});

describe('a converted name an excluded file already holds', () => {
  it('declines that image and converts the rest', async () => {
    const root = await copy();
    await writeFile(join(root, 'images/logo.webp'), 'not ours to replace');
    await writeFile(join(root, '.upflyignore'), 'images/logo.webp\n');

    const { optimize } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
    });

    expect(await readFile(join(root, 'images/logo.webp'), 'utf8')).toBe('not ours to replace');
    expect(optimize.plan.declined).toContainEqual({
      path: 'images/logo.png',
      line: null,
      reason: expect.stringContaining('images/logo.webp already exists and this run excludes it'),
    });
    expect(optimize.plan.conversions.length).toBeGreaterThan(0);
  });
});

describe('an original that a page created during the run names', () => {
  it('stays, and the rest of the run is written', async () => {
    const root = await copy();

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
      // Between the first search for mentions and the second, which the encodes put minutes
      // apart.
      beforeWrite: async () => {
        await writeFile(join(root, 'notes.html'), '<img src="images/logo.png">\n');
        return true;
      },
    });

    expect(await files(root)).toContain('images/logo.png');
    expect(await files(root)).toContain('images/logo.webp');
    expect(optimize.plan.keptOriginals).toContainEqual({
      asset: 'images/logo.png',
      reason: expect.stringContaining('notes.html:1'),
    });
  });
});

describe('an original that a page the run excludes still shows', () => {
  // `--exclude` and `.upflyignore` limit what a run changes. The search a delete makes
  // first reads past them, or the page they left out loses its picture while the run
  // reports that every reference to it moved.
  const OLD_PAGE = '<!doctype html>\n<img src="../images/logo.png" alt="Logo" />\n';

  async function replaceIn(root: string, extraIgnores?: readonly string[]) {
    return optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
      ...(extraIgnores === undefined ? {} : { extraIgnores }),
    });
  }

  it.each([
    ['a directory left out with --exclude', ['legacy'], null],
    ['a directory listed in .upflyignore', undefined, 'legacy/\n'],
    ['one file left out with --exclude', ['legacy/old.html'], null],
  ] as const)('stays when %s names it', async (_how, extraIgnores, ignoreFile) => {
    const root = await copy();
    await mkdir(join(root, 'legacy'));
    await writeFile(join(root, 'legacy/old.html'), OLD_PAGE);
    if (ignoreFile !== null) await writeFile(join(root, '.upflyignore'), ignoreFile);

    const { optimize } = await replaceIn(root, extraIgnores);

    expect(await readFile(join(root, 'legacy/old.html'), 'utf8')).toBe(OLD_PAGE);
    expect(await files(root)).toContain('images/logo.png');
    const declined = optimize.plan.declined.find((entry) => entry.path === 'images/logo.png');
    expect(declined?.reason).toContain(
      'legacy/old.html:2 still names its path, in a file this run excluded',
    );
    expect(declined?.reason).not.toContain('cannot rewrite');
  });

  it('is still deleted when only a directory pruned by name, such as node_modules, names it', async () => {
    // Dependencies, caches and build output hold none of the project's own pages, and build
    // output is made again from the sources the run reads, so the search leaves them out.
    const root = await copy();
    await mkdir(join(root, 'node_modules/theme'), { recursive: true });
    await writeFile(join(root, 'node_modules/theme/old.html'), OLD_PAGE);

    const { optimize } = await replaceIn(root);

    expect(optimize.plan.conversions.map((conversion) => conversion.asset)).toContain(
      'images/logo.png',
    );
    expect(await files(root)).not.toContain('images/logo.png');
  });
});

describe('an image nothing links to, which something names', () => {
  // The reason says where the name is and what kind of place holds it, so a reader can tell
  // a comment, or another image's path holding the same file name, from a place a page may
  // load the image by.
  it('says what kind of place names it, read from the file, and whether a page could load it there', async () => {
    const root = await copy();
    const png = await readFile(join(root, 'images/logo.png'));
    for (const image of [
      'images/retired-banner.png',
      'images/old/team.png',
      'images/new/team.png',
      'images/card-art.png',
      'images/vue-hero.png',
    ]) {
      await mkdir(dirname(join(root, image)), { recursive: true });
      await writeFile(join(root, image), png);
    }
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'gallery.html'),
      '<!doctype html>\n<img src="images/new/team.png">\n',
    );
    await writeFile(
      join(root, 'src/legacy.js'),
      "export const keep = 1;\n// const banner = '/images/retired-banner.png';\n",
    );
    await writeFile(
      join(root, 'src/card.js'),
      `export const card = '<img src="/images/card-art.png">';\n`,
    );
    await writeFile(
      join(root, 'src/App.vue'),
      '<template><img src="/images/vue-hero.png"></template>\n',
    );

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: false,
    });

    const reasons = Object.fromEntries(
      optimize.plan.declined.map((entry) => [entry.path, entry.reason]),
    );
    expect(reasons).toMatchObject({
      'images/retired-banner.png':
        'nothing links to it, and src/legacy.js:2 names it in a comment, which no page loads, so converting it would rewrite no reference and gain only bytes',
      'images/old/team.png':
        'nothing links to it, and gallery.html:2 names only its file name, in `images/new/team.png`, a path to images/new/team.png, so converting it would rewrite no reference and gain only bytes',
      'images/card-art.png':
        'nothing links to it that Upfly can follow, and src/card.js:1 names it in a value Upfly takes no path from, such as HTML written inside a string, so converting it would change a file whose references Upfly cannot see',
      'images/vue-hero.png':
        'nothing links to it that Upfly can follow, and src/App.vue:1 names it in a .vue file, a type Upfly does not read, so converting it would change a file whose references Upfly cannot see',
    });
  });
});

describe('only some images', () => {
  it('measures and converts only the images a pattern or a path names, and says what named none', async () => {
    const root = await copy();

    const byPattern = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: false,
      only: { patterns: ['images/logo.png', '*.jpg', 'images/nope.png'] },
    });
    const byPath = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: false,
      only: { paths: ['images/inline.png', 'images/missing.png', 'hero.jpg'] },
    });

    const named = ['images/hero.jpg', 'images/hero@2x.jpg', 'images/logo.png', 'images/team.jpg'];
    // team.jpg is measured, and its saving is too small to count, so it stays as it is.
    expect(byPattern.optimize.plan.conversions.map((c) => c.asset)).toEqual(named.slice(0, 3));
    expect(byPattern.pipeline.probes?.map((probe) => probe.relative).sort()).toEqual(named);
    expect(byPattern.only).toEqual({ images: named, unmatched: ['images/nope.png'] });
    // A path is a path: `hero.jpg` names the file at the project root, which does not exist.
    expect(byPath.optimize.plan.conversions.map((c) => c.asset)).toEqual(['images/inline.png']);
    expect(byPath.only).toEqual({
      images: ['images/inline.png'],
      unmatched: ['images/missing.png', 'hero.jpg'],
    });
  });

  it('removes an original under replace only when every reference to it moved, as without it', async () => {
    const root = await copy();
    await writeFile(join(root, 'notes.md'), '[the logo, as a download](images/logo.png)\n');

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: false,
      only: { patterns: ['images/logo.png', 'images/inline.png'] },
    });

    const conversions = optimize.plan.conversions.map((c) => [c.asset, c.replacesOriginal]);
    expect(conversions).toEqual([
      ['images/inline.png', true],
      ['images/logo.png', false],
    ]);
  });

  it('reads the whole project all the same, so every reference is known', async () => {
    const root = await copy();

    const { pipeline } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: false,
      only: { paths: ['images/logo.png'] },
    });

    expect(pipeline.graph.assets).toHaveLength(11);
    expect(pipeline.references.some((reference) => reference.rawPath.includes('texture'))).toBe(
      true,
    );
  });
});

describe('a path that ends in a slash', () => {
  // A browser asks for `images/team.jpg/`, which a static server does not serve as the
  // picture. `path.extname` reads `.jpg` there all the same, ignoring the slash.
  const planned = async () => {
    const root = await copy();
    await writeFile(join(root, 'notes.md'), '![Team](images/team.jpg/)\n');
    await writeFile(join(root, 'wide.css'), '.team { background: url(images/team.jpg/); }\n');
    return optimizeProject({ root, format: 'webp', publicPolicy: 'keep-original', apply: false });
  };

  it('names a folder, so it links nothing', async () => {
    const { pipeline } = await planned();

    const slashed = pipeline.references.filter((reference) => reference.rawPath.endsWith('/'));
    expect(slashed.map((reference) => reference.resolution)).toEqual([]);
  });

  it('is never planned as a name with two dots before its new extension', async () => {
    // Read as a picture, the path would be declined as becoming `images/team..webp`, and would
    // decline the picture with it.
    const { optimize } = await planned();

    expect(JSON.stringify(optimize.plan)).not.toContain('..webp');
  });
});

describe('a page that is not UTF-8', () => {
  it('keeps its bytes: its reference is declined with the reason, and the rest of the run goes on', async () => {
    const root = await copy();
    // "Café" in Latin-1: 0xE9 is not UTF-8, so it reads as U+FFFD, and writing the page
    // back as UTF-8 would turn that one byte into three.
    const latin1 = Buffer.from('<p>Caf\xE9</p>\n<img src="images/logo.png" alt="">\n', 'latin1');
    await writeFile(join(root, 'latin1.html'), latin1);

    const { optimize } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(optimize.plan.rewrites.map((rewrite) => rewrite.file)).toEqual(
      expect.arrayContaining(['index.html']),
    );
    expect(optimize.plan.rewrites.map((rewrite) => rewrite.file)).not.toContain('latin1.html');
    expect(optimize.plan.declined).toContainEqual({
      path: 'latin1.html',
      line: null,
      reason: expect.stringContaining('not valid UTF-8'),
    });
    expect(await readFile(join(root, 'latin1.html'))).toEqual(latin1);
  });

  it('reads a name its bytes cannot spell as unknown, never as broken', async () => {
    const root = await copy();
    // `images/café.png` exists. The page spells é as the Latin-1 byte 0xE9, which reads as
    // U+FFFD in UTF-8, so the path the text holds names no file: whether it meant this one
    // cannot be known.
    await cp(join(root, 'images/logo.png'), join(root, 'images/café.png'));
    const page = Buffer.from('<img src="images/caf\xE9.png" alt="">\n', 'latin1');
    await writeFile(join(root, 'latin1.html'), page);

    const { pipeline } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: false,
    });

    const replacement = String.fromCodePoint(0xfffd);
    const broken = pipeline.audit.findings.filter(
      (finding) => finding.kind === 'broken' && finding.rawPath.includes(replacement),
    );
    expect(broken).toEqual([]);
    const reference = pipeline.graph.references.find((entry) => entry.file.endsWith('latin1.html'));
    expect(reference?.resolution).toBe('dynamic');
    expect(reference?.note).toContain('not valid UTF-8');
  });
});

describe('an image a link preview or a download link names', () => {
  it('keeps that text and its original, while the img beside it moves to the converted file', async () => {
    const root = await copy();
    // `images/logo.png` is shown here and named by the page's link preview; `images/hero.jpg`
    // is shown by index.html and offered for download here.
    const page = [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta property="og:image" content="images/logo.png" />',
      '  </head>',
      '  <body>',
      '    <img src="images/logo.png" alt="Logo" />',
      '    <a href="images/hero.jpg" download>Download the picture</a>',
      '  </body>',
      '</html>',
      '',
    ].join('\n');
    await writeFile(join(root, 'share.html'), page);

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'share.html'), 'utf8')).toBe(
      page.replace('<img src="images/logo.png"', '<img src="images/logo.webp"'),
    );
    const after = await files(root);
    for (const kept of ['images/logo.png', 'images/hero.jpg']) {
      expect(after).toContain(kept);
      expect(optimize.plan.keptOriginals.map((entry) => entry.asset)).toContain(kept);
    }
    // Both images did convert: the originals stay because of the two references alone.
    expect(after).toEqual(expect.arrayContaining(['images/logo.webp', 'images/hero.webp']));
    expect(optimize.plan.declined.filter((entry) => entry.path === 'share.html')).toEqual([
      { path: 'share.html', line: null, reason: expect.stringContaining('follows') },
      { path: 'share.html', line: null, reason: expect.stringContaining('link preview') },
    ]);
  });

  it('keeps a Markdown link to an image as it keeps an HTML one, while an embed moves', async () => {
    const root = await copy();
    // `images/logo.png` is shown; `images/hero.jpg` is linked, so a reader saves the file.
    const page = '![Logo](images/logo.png)\n\n[Download the picture](images/hero.jpg)\n';
    await writeFile(join(root, 'notes.md'), page);

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(
      page.replace('](images/logo.png)', '](images/logo.webp)'),
    );
    expect(await files(root)).toContain('images/hero.jpg');
    expect(optimize.plan.keptOriginals.map((entry) => entry.asset)).toContain('images/hero.jpg');
  });

  it('keeps a preview path a component passes through a helper, as it keeps a plain one', async () => {
    const root = await copy();
    // The helper makes the address absolute, as crawlers require. The path inside the call
    // is found as a guess, which must still carry the rule against rewriting a preview.
    const component = [
      "const absolute = (path) => new URL(path, 'https://example.com').href;",
      '',
      'export function ShareImage() {',
      '  return <meta property="og:image" content={absolute(\'/images/logo.png\')} />;',
      '}',
      '',
    ].join('\n');
    await writeFile(join(root, 'ShareImage.jsx'), component);

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'ShareImage.jsx'), 'utf8')).toBe(component);
    // index.html's <img src> still moves to the converted file; the preview keeps the original.
    expect(await readFile(join(root, 'index.html'), 'utf8')).toContain('src="images/logo.webp"');
    expect(await files(root)).toEqual(
      expect.arrayContaining(['images/logo.png', 'images/logo.webp']),
    );
    expect(optimize.plan.keptOriginals.map((entry) => entry.asset)).toContain('images/logo.png');
    expect(optimize.plan.declined.filter((entry) => entry.path === 'ShareImage.jsx')).toEqual([
      { path: 'ShareImage.jsx', line: null, reason: expect.stringContaining('link preview') },
    ]);
  });
});

describe('the saving a run counts', () => {
  const VITE_REACT = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/vite-react');

  it('is one figure: the plan converts exactly the savings the report counts', async () => {
    // vite-react holds images whose conversion saves under 1 KB, which the report does not
    // count as a saving. Converted all the same, they made the plan's total larger than
    // the report's.
    const root = await mkdtemp(join(tmpdir(), 'upfly-optimize-project-'));
    roots.push(root);
    await cp(VITE_REACT, root, {
      recursive: true,
      filter: (source) => !source.includes('node_modules'),
    });

    const { pipeline, optimize } = await optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: false,
    });

    const reported = pipeline.audit.findings.flatMap((finding) =>
      finding.kind === 'format-opportunity' ? [finding.savedBytes] : [],
    );
    const planned = optimize.plan.conversions.map((conversion) => conversion.savedBytes);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.reduce((a, b) => a + b, 0)).toBe(reported.reduce((a, b) => a + b, 0));
  });
});

describe('an image removed after the scan read it', () => {
  it('is a refusal with a code and a sentence, not a crash', async () => {
    const root = await copy();
    const page = await readFile(join(root, 'index.html'), 'utf8');
    const converting: string[] = [];

    const run = optimizeProject({
      root,
      format: 'webp',
      publicPolicy: 'keep-original',
      apply: true,
      beforeWrite: async (plan) => {
        converting.push(...plan.conversions.map((conversion) => conversion.asset));
        await rm(join(root, 'images/logo.png'));
        return true;
      },
    });

    await expect(run).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('images/logo.png was removed'),
    });
    expect(converting).toContain('images/logo.png');
    expect(await readFile(join(root, 'index.html'), 'utf8')).toBe(page);
  });
});

describe('a phone photo its camera tagged to be turned', () => {
  it('converts it the way it is shown, while the page moves to it and the original goes', async () => {
    const { default: sharp } = await import('sharp');
    const root = await copy();
    // Stored 400 by 200 with the red half on the left and tagged a quarter turn clockwise,
    // as a phone stores a portrait: every viewer shows it 200 by 400, the red half on top.
    const width = 400;
    const height = 200;
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index++) {
      pixels.set(index % width < width / 2 ? [220, 30, 20] : [20, 30, 220], index * 3);
    }
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6 })
      .toFile(join(root, 'images/phone.jpg'));
    await writeFile(join(root, 'phone.html'), '<img src="images/phone.jpg" alt="A portrait" />\n');

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'phone.html'), 'utf8')).toContain('src="images/phone.webp"');
    expect(await files(root)).not.toContain('images/phone.jpg');
    // Read as a viewer reads it, honouring a tag if the file kept one.
    const { data, info } = await sharp(join(root, 'images/phone.webp'), { autoOrient: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([200, 400]);
    const top = (100 * info.width + 100) * info.channels;
    expect(data[top] ?? 0).toBeGreaterThan(150);
    expect(data[top + 2] ?? 255).toBeLessThan(100);
  });
});

/**
 * AVIF is the slowest encode. Alone this test takes about four seconds, but in a full run on a
 * loaded machine it can pass the shared 30-second limit, so it gets its own. The limit only has
 * to catch a hung test.
 */
const AVIF_LIMIT_MS = 120_000;

describe('an animated GIF, when the run converts to AVIF', { timeout: AVIF_LIMIT_MS }, () => {
  it('stays, with its page as written, since AVIF would hold one still picture of its frames', async () => {
    const { default: sharp } = await import('sharp');
    const root = await copy();
    // Six frames of a moving gradient. A single AVIF image of them all is a quarter of the
    // GIF's size, so measuring it would pass for a saving.
    const size = 64;
    const frames = await Promise.all(
      Array.from({ length: 6 }, (_, frame) => {
        const pixels = Buffer.alloc(size * size * 3);
        for (let pixel = 0; pixel < size * size; pixel++) {
          const x = pixel % size;
          const y = Math.floor(pixel / size);
          pixels.set(
            [(x * 4 + frame * 20) % 256, (y * 4) % 256, ((x + y) * 2 + frame * 10) % 256],
            pixel * 3,
          );
        }
        return sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
          .png()
          .toBuffer();
      }),
    );
    await sharp(frames, { join: { animated: true } })
      .gif()
      .toFile(join(root, 'images/loop.gif'));
    const page = '<img src="images/loop.gif" alt="A loop" />\n';
    await writeFile(join(root, 'loop.html'), page);

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'avif',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'loop.html'), 'utf8')).toBe(page);
    const after = await files(root);
    expect(after).toContain('images/loop.gif');
    expect(after).not.toContain('images/loop.avif');
  });
});

describe('a reference whose converted name reaches another file first', () => {
  // A rewrite changes only the extension, and from the file that holds it the new name can
  // reach a file the old name never did: one in a nearer website folder, or one an alias rule
  // tried earlier maps to. Repointed there, the reference would show that other picture.

  /** A project outside the workspace holding these text files. */
  async function project(texts: Readonly<Record<string, string>>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'upfly-optimize-project-'));
    roots.push(root);
    for (const [relative, text] of Object.entries(texts)) {
      await mkdir(dirname(join(root, relative)), { recursive: true });
      await writeFile(join(root, relative), text);
    }
    return root;
  }

  /** A fixture image that converts to a smaller WebP, copied to `relative`. */
  async function picture(root: string, relative: string, fixture = 'logo.png'): Promise<void> {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await cp(join(PLAIN_HTML, 'images', fixture), join(root, relative));
  }

  /** A WebP of a different picture from any `picture` writes. */
  async function anotherPicture(root: string, relative: string): Promise<void> {
    const { default: sharp } = await import('sharp');
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await sharp(join(PLAIN_HTML, 'images/team.jpg')).webp().toFile(join(root, relative));
  }

  /** The project-relative asset a reference with this text links, or null. */
  function linkedBy(pipeline: PipelineOutput, rawPath: string): string | null {
    const reference = pipeline.graph.references.find((entry) => entry.rawPath === rawPath);
    return reference?.resolution === 'resolved'
      ? relativePath(pipeline.graph.root, reference.resolvedPath)
      : null;
  }

  it('keeps the page and the original when a nearer website folder already serves the new name', async () => {
    const page = [
      'export const App = () => (',
      '  <>',
      '    <img src="/img/logo.png" alt="" />',
      '    <img src="/img/texture.png" alt="" />',
      '  </>',
      ');',
      '',
    ].join('\n');
    const root = await project({ 'apps/web/src/App.tsx': page });
    await picture(root, 'public/img/logo.png');
    await picture(root, 'public/img/texture.png', 'texture.png');
    // The page belongs to apps/web, so its URLs are served from apps/web/public first, and
    // from public only for a file apps/web/public does not hold.
    await anotherPicture(root, 'apps/web/public/img/logo.webp');
    const other = await readFile(join(root, 'apps/web/public/img/logo.webp'));

    const { pipeline, optimize } = await optimizeProject({
      root,
      declared: { dirs: ['public', 'apps/web/public'], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(linkedBy(pipeline, '/img/logo.png')).toBe('public/img/logo.png');
    const after = await files(root);
    // One comparison, so a failure shows the page and the files together. The picture beside
    // the logo, whose new name nothing nearer holds, still moves.
    expect({
      page: await readFile(join(root, 'apps/web/src/App.tsx'), 'utf8'),
      logo: after.filter((path) => path.startsWith('public/img/logo.')),
      texture: after.filter((path) => path.startsWith('public/img/texture.')),
    }).toEqual({
      page: page.replace('/img/texture.png', '/img/texture.webp'),
      logo: ['public/img/logo.png'],
      texture: ['public/img/texture.webp'],
    });
    expect(await readFile(join(root, 'apps/web/public/img/logo.webp'))).toEqual(other);
    expect(optimize.plan.declined).toContainEqual({
      path: 'public/img/logo.png',
      line: null,
      reason: expect.stringContaining('reaches apps/web/public/img/logo.webp first'),
    });
  });

  const IMPORT = `import hero from '@/img/hero.png';\nexport const App = () => <img src={hero} alt="" />;\n`;

  /** A Vite project's manifest: the build that loads these imports, known to load WebP. */
  const VITE_PACKAGE = '{ "private": true, "scripts": { "build": "vite build" } }\n';

  it.each([
    [
      'an exact alias key',
      {
        'package.json': VITE_PACKAGE,
        'tsconfig.json':
          '{ "compilerOptions": { "paths": { "@/*": ["./src/*"], "@/img/hero.webp": ["./assets/img/hero.webp"] } } }\n',
        'src/App.tsx': IMPORT,
      },
      'src/App.tsx',
      'src/img/hero.png',
      'assets/img/hero.webp',
    ],
    [
      "an alias's earlier target",
      {
        'package.json': VITE_PACKAGE,
        'tsconfig.json':
          '{ "compilerOptions": { "paths": { "@/*": ["./src/*", "./shared/*"] } } }\n',
        'src/App.tsx': IMPORT,
      },
      'src/App.tsx',
      'shared/img/hero.png',
      'src/img/hero.webp',
    ],
  ] as const)(
    'keeps an import as written when %s maps its new name to another file',
    async (_how, texts, page, image, other) => {
      const root = await project(texts);
      await picture(root, image);
      await anotherPicture(root, other);

      const { pipeline, optimize } = await optimizeProject({
        root,
        format: 'webp',
        publicPolicy: 'keep-original',
        apply: false,
      });

      expect(linkedBy(pipeline, '@/img/hero.png')).toBe(image);
      expect(optimize.plan.rewrites.map((rewrite) => rewrite.file)).not.toContain(page);
      expect(optimize.plan.conversions.map((conversion) => conversion.asset)).not.toContain(image);
      expect(optimize.plan.declined).toContainEqual({
        path: image,
        line: null,
        reason: expect.stringContaining(`reaches ${other} first`),
      });
    },
  );

  const TWO_ROOTS = { dirs: ['public', 'apps/web/public'], declared: true };

  describe('a file the run excluded', () => {
    // An ignore rule keeps a file out of the walk, not off the disk, so a page can still load
    // it. A rewritten path that reaches it first would show that picture.
    const page = [
      'export const App = () => (',
      '  <>',
      '    <img src="/img/logo.png" alt="" />',
      '    <img src="/img/texture.png" alt="" />',
      '  </>',
      ');',
      '',
    ].join('\n');

    it.each([
      ['named in .upflyignore', { '.upflyignore': 'apps/web/public/img/logo.webp\n' }, []],
      ['in a folder an exclude names', {}, ['apps/web/public/img/']],
    ] as const)(
      'keeps the page and the original when a nearer file %s already has the new name',
      async (_how, texts, extraIgnores) => {
        const root = await project({ 'apps/web/src/App.tsx': page, ...texts });
        await picture(root, 'public/img/logo.png');
        await picture(root, 'public/img/texture.png', 'texture.png');
        await anotherPicture(root, 'apps/web/public/img/logo.webp');
        const other = await readFile(join(root, 'apps/web/public/img/logo.webp'));

        const { pipeline, optimize } = await optimizeProject({
          root,
          declared: TWO_ROOTS,
          format: 'webp',
          publicPolicy: 'replace',
          apply: true,
          extraIgnores,
        });

        expect(pipeline.graph.assets.map((node) => node.asset.relative)).toEqual([
          'public/img/logo.png',
          'public/img/texture.png',
        ]);
        const after = await files(root);
        expect({
          page: await readFile(join(root, 'apps/web/src/App.tsx'), 'utf8'),
          logo: after.filter((path) => path.startsWith('public/img/logo.')),
          texture: after.filter((path) => path.startsWith('public/img/texture.')),
        }).toEqual({
          page: page.replace('/img/texture.png', '/img/texture.webp'),
          logo: ['public/img/logo.png'],
          texture: ['public/img/texture.webp'],
        });
        expect(await readFile(join(root, 'apps/web/public/img/logo.webp'))).toEqual(other);
        expect(optimize.plan.declined).toContainEqual({
          path: 'public/img/logo.png',
          line: null,
          reason: expect.stringContaining('reaches apps/web/public/img/logo.webp first'),
        });
      },
    );
  });

  describe('a file whose name differs from the new one only in case', () => {
    // Windows and macOS find a file whatever the case of its name, so on either a page asking
    // for /img/logo.webp loads apps/web/public/img/Logo.webp. The plan must not depend on the
    // platform it runs on, so it counts that file as the one the path reaches everywhere.
    const page = [
      'export const App = () => (',
      '  <>',
      '    <img src="/img/logo.png" alt="" />',
      '    <img src="/img/texture.png" alt="" />',
      '  </>',
      ');',
      '',
    ].join('\n');

    it.each([
      ['its own name', 'apps/web/public/img/Logo.webp'],
      ["its folder's name", 'apps/web/public/IMG/logo.webp'],
    ])(
      'keeps the page and the original when a nearer file differs only in %s',
      async (_how, nearer) => {
        const root = await project({ 'apps/web/src/App.tsx': page });
        await picture(root, 'public/img/logo.png');
        await picture(root, 'public/img/texture.png', 'texture.png');
        await anotherPicture(root, nearer);

        const { optimize } = await optimizeProject({
          root,
          declared: TWO_ROOTS,
          format: 'webp',
          publicPolicy: 'replace',
          apply: true,
        });

        const after = await files(root);
        expect({
          page: await readFile(join(root, 'apps/web/src/App.tsx'), 'utf8'),
          logo: after.filter((path) => path.startsWith('public/img/logo.')),
          texture: after.filter((path) => path.startsWith('public/img/texture.')),
        }).toEqual({
          page: page.replace('/img/texture.png', '/img/texture.webp'),
          logo: ['public/img/logo.png'],
          texture: ['public/img/texture.webp'],
        });
        expect(optimize.plan.declined).toContainEqual({
          path: 'public/img/logo.png',
          line: null,
          reason: expect.stringContaining(`reaches ${nearer} first`),
        });
      },
    );
  });

  describe('a reference the plan leaves as written', () => {
    // A converted file is new, so a page that goes on naming another image can find it
    // first: in a nearer website folder, or where an alias looks first.

    /** The project-relative asset the reference with this text in `file` links, or null. */
    function linkedFrom(pipeline: PipelineOutput, file: string, rawPath: string): string | null {
      const reference = pipeline.graph.references.find(
        (entry) =>
          entry.rawPath === rawPath && relativePath(pipeline.graph.root, entry.file) === file,
      );
      return reference?.resolution === 'resolved'
        ? relativePath(pipeline.graph.root, reference.resolvedPath)
        : null;
    }

    it('still shows its picture after a run that would have converted another image to a nearer file of its name', async () => {
      const other = [
        'export const Other = () => (',
        '  <>',
        '    <img src="/img/banner.png" alt="" />',
        '    <img src="/img/texture.png" alt="" />',
        '  </>',
        ');',
        '',
      ].join('\n');
      const root = await project({
        'apps/web/src/App.tsx': 'export const App = () => <img src="/img/banner.webp" alt="" />;\n',
        'apps/web/src/Other.tsx': other,
      });
      await anotherPicture(root, 'public/img/banner.webp');
      await picture(root, 'apps/web/public/img/banner.png');
      await picture(root, 'apps/web/public/img/texture.png', 'texture.png');

      const { pipeline, optimize } = await optimizeProject({
        root,
        declared: TWO_ROOTS,
        format: 'webp',
        publicPolicy: 'keep-original',
        apply: true,
      });

      expect(linkedFrom(pipeline, 'apps/web/src/App.tsx', '/img/banner.webp')).toBe(
        'public/img/banner.webp',
      );
      // Read back through the engine, as the next run would read it.
      const after = await runPipeline({
        root,
        servingRoots: servingRootsFor(TWO_ROOTS),
        publicDirs: (servingRoots) => servingRoots.dirs,
        probeOptions: null,
      });
      expect({
        page: linkedFrom(after, 'apps/web/src/App.tsx', '/img/banner.webp'),
        other: await readFile(join(root, 'apps/web/src/Other.tsx'), 'utf8'),
        served: (await files(root)).filter((path) => path.startsWith('apps/web/public/')),
      }).toEqual({
        page: 'public/img/banner.webp',
        other: other.replace('/img/texture.png', '/img/texture.webp'),
        served: [
          'apps/web/public/img/banner.png',
          'apps/web/public/img/texture.png',
          'apps/web/public/img/texture.webp',
        ],
      });
      expect(optimize.plan.declined).toContainEqual({
        path: 'apps/web/public/img/banner.png',
        line: null,
        reason: expect.stringContaining(
          'reaches public/img/banner.webp, and once this image converts it would reach apps/web/public/img/banner.webp first',
        ),
      });
    });

    it('keeps leading where it does when an alias would find the converted file of another import first', async () => {
      const root = await project({
        'package.json': VITE_PACKAGE,
        'tsconfig.json':
          '{ "compilerOptions": { "paths": { "@/*": ["./src/*", "./shared/*"] } } }\n',
        'src/App.tsx': `import hero from '@/img/hero.webp';\nexport const App = () => <img src={hero} alt="" />;\n`,
        'src/Other.tsx': IMPORT,
      });
      await anotherPicture(root, 'shared/img/hero.webp');
      await picture(root, 'src/img/hero.png');

      const { pipeline, optimize } = await optimizeProject({
        root,
        format: 'webp',
        publicPolicy: 'keep-original',
        apply: false,
      });

      expect(linkedBy(pipeline, '@/img/hero.webp')).toBe('shared/img/hero.webp');
      expect(optimize.plan.conversions).toEqual([]);
      expect(optimize.plan.rewrites).toEqual([]);
      expect(optimize.plan.declined).toContainEqual({
        path: 'src/img/hero.png',
        line: null,
        reason: expect.stringContaining(
          'reaches shared/img/hero.webp, and once this image converts it would reach src/img/hero.webp first',
        ),
      });
    });
  });
});

describe('an animated PNG', () => {
  it('stays, with its page as written, since a conversion would keep one still frame', async () => {
    const root = await copy();
    // A WebP of the first frame alone is far smaller than the file, so measuring it would
    // pass for a saving.
    await writeFile(join(root, 'images/loop.png'), animatedPng(128, 128, gradientFrames(128, 4)));
    const page = '<img src="images/loop.png" alt="A loop" />\n';
    await writeFile(join(root, 'loop.html'), page);

    const { optimize } = await optimizeProject({
      root,
      declared: { dirs: [''], declared: true },
      format: 'webp',
      publicPolicy: 'replace',
      apply: true,
    });

    expect(optimize.manifest?.state).toBe('committed');
    expect(await readFile(join(root, 'loop.html'), 'utf8')).toBe(page);
    const after = await files(root);
    expect(after).toContain('images/loop.png');
    expect(after).not.toContain('images/loop.webp');
  });
});
