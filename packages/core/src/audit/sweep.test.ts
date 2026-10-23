import { describe, expect, it, vi } from 'vitest';
import { javascriptAdapter } from '../adapters/javascript.js';
import { buildGraph } from '../graph/graph.js';
import { scanSources } from '../scan/scan.js';
import type { ReadFilePort } from '../scan/scan.js';
import type { Asset, RawReference, Reference, UnscannedFile } from '../types.js';
import { sweepForMentions } from './sweep.js';

/**
 * The sweep decides `dead` against `possibly-dead`, so every test here is really
 * asking one question: would this asset be reported as confidently dead, and is
 * that true?
 */

const ROOT = '/repo';

function asset(relative: string): Asset {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes: 100,
  };
}

function unscanned(relative: string): UnscannedFile {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    reason: 'unclaimed-extension',
    detail: '',
  };
}

function raw(file: string, rawPath: string, start = 0): RawReference {
  return {
    file: `${ROOT}/${file}`,
    start,
    end: start + rawPath.length,
    rawPath,
    kind: 'attr',
    shape: 'html.img.src',
    ceiling: 'unsafe',
    asserted: true,
  };
}

function unlinked(
  file: string,
  rawPath: string,
  resolution: 'dynamic' | 'broken' | 'discarded' | 'unresolved-alias',
  start = 0,
): Reference {
  return { ...raw(file, rawPath, start), resolution, confidence: 'unsafe', resolvedPath: null };
}

function outOfScope(file: string, rawPath: string): Reference {
  return {
    ...raw(file, rawPath),
    resolution: 'out-of-scope',
    confidence: 'unsafe',
    resolvedPath: `${ROOT}/legacy/hero.png`,
    exclusionReason: "the ignore rule 'legacy/'",
  };
}

function resolved(file: string, rawPath: string, target: string): Reference {
  return {
    ...raw(file, rawPath),
    ceiling: 'high',
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'file',
  };
}

function files(contents: Record<string, string>): ReadFilePort {
  return async (path) => {
    const text = contents[path];
    if (text === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return text;
  };
}

function graphOf(input: {
  assets?: readonly Asset[];
  references?: readonly Reference[];
  unscannedFiles?: readonly UnscannedFile[];
}) {
  return buildGraph({
    root: ROOT,
    assets: input.assets ?? [],
    references: input.references ?? [],
    unscannedFiles: input.unscannedFiles ?? [],
  });
}

describe('sweepForMentions', () => {
  describe('haystack (a): files nobody read', () => {
    it('finds an asset named in an unscanned file, and cites the line', async () => {
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        unscannedFiles: [unscanned('config.yaml')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/config.yaml': 'site:\n  title: Home\n  image: /img/hero.png\n' }),
      });

      expect(result.mentions.get('img/hero.png')).toEqual([
        {
          asset: 'img/hero.png',
          source: 'unscanned-file',
          where: 'config.yaml:3',
          quote: 'hero.png',
        },
      ]);
    });

    it('leaves an asset nothing mentions out of the map entirely', async () => {
      // This is the case that earns a confident `dead`, and it has to stay reachable.
      const graph = graphOf({
        assets: [asset('img/orphan.png')],
        unscannedFiles: [unscanned('config.yaml')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/config.yaml': 'site:\n  title: Home\n' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it('matches case-insensitively, because Windows does', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('page.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/page.vue': '<img src="Hero.PNG">' }),
      });

      expect(result.mentions.get('hero.png')).toHaveLength(1);
    });

    it('hedges both assets when two share a basename', async () => {
      // The evidence genuinely cannot tell them apart: a template says `logo.png`,
      // not where it lives. Hedging both is the safe direction to be wrong in.
      const graph = graphOf({
        assets: [asset('a/logo.png'), asset('b/logo.png')],
        unscannedFiles: [unscanned('page.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/page.vue': '<img src="/a/logo.png">' }),
      });

      expect([...result.mentions.keys()].sort()).toEqual(['a/logo.png', 'b/logo.png']);
    });

    it('does not stop a token at a slash boundary', async () => {
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        unscannedFiles: [unscanned('page.njk')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/page.njk': "{{ '/img/hero.png' | url }}" }),
      });

      expect(result.mentions.get('img/hero.png')?.[0]?.quote).toBe('hero.png');
    });

    it('only sweeps assets that have no references at all', async () => {
      // A referenced asset is not a candidate, so its name in a `.vue` file is not
      // evidence of anything and costs nothing to ignore.
      const graph = graphOf({
        assets: [asset('used.png')],
        references: [resolved('index.html', './used.png', 'used.png')],
        unscannedFiles: [unscanned('page.vue')],
      });
      const readFile = vi.fn(files({ '/repo/page.vue': '<img src="used.png">' }));

      const result = await sweepForMentions({ graph, readFile });

      expect(result.mentions.size).toBe(0);
      // No candidates means no reason to touch a disk at all.
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe('a filename inside an absolute URL', () => {
    it('hedges an asset under a serving root, which the URL could genuinely serve', async () => {
      // astro-docs cites its own published assets as
      // `https://docs.astro.build/assets/arc.webp`. Deleting `public/assets/arc.webp`
      // really would break that URL, so the mention is evidence.
      const graph = graphOf({
        assets: [asset('public/assets/arc.webp')],
        unscannedFiles: [unscanned('guide.njk')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/guide.njk': 'See https://docs.astro.build/assets/arc.webp here' }),
        publicDirs: ['public'],
      });

      expect(result.mentions.has('public/assets/arc.webp')).toBe(true);
    });

    it('ignores it for an asset outside every serving root', async () => {
      // A URL cannot be serving `src/internal/arc.webp`, so the mention is noise. The
      // validation harness likewise treats a filename inside an absolute URL as no reference.
      const graph = graphOf({
        assets: [asset('src/internal/arc.webp')],
        unscannedFiles: [unscanned('guide.njk')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/guide.njk': 'See https://docs.astro.build/assets/arc.webp here' }),
        publicDirs: ['public'],
      });

      expect(result.mentions.size).toBe(0);
    });

    it('still hedges a plain mention of an asset outside a serving root', async () => {
      const graph = graphOf({
        assets: [asset('src/internal/arc.webp')],
        unscannedFiles: [unscanned('guide.njk')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/guide.njk': '<img src="/internal/arc.webp">' }),
        publicDirs: ['public'],
      });

      expect(result.mentions.has('src/internal/arc.webp')).toBe(true);
    });
  });

  describe('haystack (b): paths we read but could not resolve', () => {
    it('rescues an asset named only inside a dynamic reference', async () => {
      // `templated.png` is named by a path in a file we parsed perfectly. The
      // reference is `dynamic`, so it links nothing and the asset looks dead while
      // being demonstrably alive.
      const source =
        '---\ntitle: First\n---\n\nSome prose.\n\n![Templated]({{ site.url }}/img/templated.png)\n';
      const graph = graphOf({
        assets: [asset('img/templated.png')],
        references: [
          unlinked(
            'posts/first.md',
            '{{ site.url }}/img/templated.png',
            'dynamic',
            source.indexOf('{{'),
          ),
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/posts/first.md': source }),
      });

      expect(result.mentions.get('img/templated.png')).toEqual([
        {
          asset: 'img/templated.png',
          source: 'unresolved-reference',
          // File, line and the raw path, so a reader can go straight to it.
          where: 'posts/first.md:7',
          quote: '{{ site.url }}/img/templated.png',
        },
      ]);
    });

    it('cites the line inside a reference that names the asset, and quotes that line alone', async () => {
      // A `<style>` block whose CSS did not parse is one reference from the end of its tag to
      // its closing tag, and the name is two lines below where it starts. The file is CRLF.
      const source = [
        '<style>',
        '.a {',
        '  background: url(img/hero.png);',
        '}',
        '.b { color red }',
        '</style>',
        '',
      ].join('\r\n');
      const start = '<style>'.length;
      const block = source.slice(start, source.indexOf('</style>'));
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        references: [unlinked('index.html', block, 'dynamic', start)],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/index.html': source }),
      });

      expect(result.mentions.get('img/hero.png')).toEqual([
        {
          asset: 'img/hero.png',
          source: 'unresolved-reference',
          where: 'index.html:3',
          quote: 'background: url(img/hero.png);',
        },
      ]);
    });

    it('quotes the line of a reference that spans lines when its file cannot be re-read', async () => {
      // With no text there is no line to cite, so the reference's own text is read instead.
      const block = '\n.a {\n  background: url(img/hero.png);\n}\n';
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        references: [unlinked('index.html', block, 'dynamic', 7)],
      });

      const result = await sweepForMentions({ graph, readFile: files({}) });

      expect(result.mentions.get('img/hero.png')).toEqual([
        {
          asset: 'img/hero.png',
          source: 'unresolved-reference',
          where: 'index.html',
          quote: 'background: url(img/hero.png);',
        },
      ]);
      expect(result.skipped.map((skip) => skip.relative)).toEqual(['index.html']);
    });

    it('sweeps an unresolved alias', async () => {
      const graph = graphOf({
        assets: [asset('src/assets/logo.png')],
        references: [unlinked('App.tsx', '@/assets/logo.png', 'unresolved-alias')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/App.tsx': "import logo from '@/assets/logo.png';\n" }),
      });

      expect(result.mentions.get('src/assets/logo.png')?.[0]?.source).toBe('unresolved-reference');
    });

    it('sweeps a discarded speculative path', async () => {
      const graph = graphOf({
        assets: [asset('icons/app.png')],
        references: [unlinked('manifest.json', 'icons/app.png', 'discarded')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/manifest.json': '{"icons":["icons/app.png"]}' }),
      });

      expect(result.mentions.has('icons/app.png')).toBe(true);
    });

    it('does not sweep a broken reference', async () => {
      // Its target is known: nothing. It is already its own finding, and
      // `hero.png: dead` beside `./wrong-dir/hero.png: broken` tells a reader more
      // than hedging `hero.png` would, which would hide the pair.
      const graph = graphOf({
        assets: [asset('hero.png')],
        references: [unlinked('index.html', './wrong-dir/hero.png', 'broken')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/index.html': '<img src="./wrong-dir/hero.png">' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it('does not sweep an out-of-scope reference', async () => {
      // Target known, and known not to be an indexed asset.
      const graph = graphOf({
        assets: [asset('hero.png')],
        references: [outOfScope('index.html', '../legacy/hero.png')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/index.html': '<img src="../legacy/hero.png">' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it('sweeps a root-relative broken reference that a run with no serving root withholds', async () => {
      // No root-relative path resolves, so the audit withholds their broken findings:
      // `/img/diagram.png` may be served from a directory this run did not find, and its
      // target is unknown rather than missing. Each path starts its own 40-character line.
      const paths = [
        ...Array.from({ length: 19 }, (_, index) => `/missing${index}.png`),
        '/img/diagram.png',
        './wrong-dir/hero.png',
      ];
      const graph = graphOf({
        assets: [asset('src/img/diagram.png'), asset('hero.png')],
        references: paths.map((path, index) => unlinked('index.html', path, 'broken', index * 40)),
      });
      const text = paths.map((path) => path.padEnd(39)).join('\n');

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/index.html': text }),
      });

      expect(result.mentions.get('src/img/diagram.png')).toEqual([
        {
          asset: 'src/img/diagram.png',
          source: 'unresolved-reference',
          where: 'index.html:20',
          quote: '/img/diagram.png',
        },
      ]);
      // A relative path is broken whatever the serving root is, so it keeps its own finding
      // and is no evidence, as in any other run.
      expect(result.mentions.has('hero.png')).toBe(false);
    });

    it('does not sweep a root-relative broken reference once the serving root is found', async () => {
      // Nineteen of twenty root-relative paths resolve, so the one that does not is a
      // finding of its own, and an asset its name matches stays confidently dead beside it.
      const linked = Array.from({ length: 19 }, (_, index) => `public/a${index}.png`);
      const graph = graphOf({
        assets: [...linked.map(asset), asset('src/img/diagram.png')],
        references: [
          ...linked.map((target, index) => resolved('index.html', `/a${index}.png`, target)),
          unlinked('index.html', '/img/diagram.png', 'broken'),
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/index.html': '<img src="/img/diagram.png">' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it('reads a path that did not resolve in every spelling the resolver would look it up in', async () => {
      // Read only as written, `/img/my%20photo.png` holds the token `20photo.png` and
      // `a&amp;b.png` the token `b.png`, so neither asset would be found. The resolver tries
      // each decoded spelling after the written one, and so does the sweep.
      const graph = graphOf({
        assets: [
          asset('src/img/my photo.png'),
          asset('src/img/a&b.png'),
          asset('src/img/unused.png'),
        ],
        references: [
          { ...unlinked('data.json', '/img/my%20photo.png', 'discarded'), kind: 'json' },
          unlinked('page.html', '{{ base }}/img/a&amp;b.png', 'dynamic'),
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({
          '/repo/data.json': '{ "photo": "/img/my%20photo.png" }',
          '/repo/page.html': '<img src="{{ base }}/img/a&amp;b.png">',
        }),
      });

      expect(result.mentions.get('src/img/my photo.png')).toEqual([
        {
          asset: 'src/img/my photo.png',
          source: 'unresolved-reference',
          where: 'data.json:1',
          quote: '/img/my%20photo.png',
        },
      ]);
      expect(result.mentions.get('src/img/a&b.png')?.map((mention) => mention.quote)).toEqual([
        '{{ base }}/img/a&amp;b.png',
      ]);
      expect(result.mentions.has('src/img/unused.png')).toBe(false);
    });

    it('reads a backslash escape as one only in a Markdown destination, as the resolver does', async () => {
      // CommonMark drops a backslash before punctuation in a link destination, so this names
      // `my_photo.png` in Markdown. Anywhere else the resolver leaves a backslash as written.
      const written = '{{ site.url }}/img/my\\_photo.png';
      const sweepAs = (kind: 'md' | 'attr') =>
        sweepForMentions({
          graph: graphOf({
            assets: [asset('src/img/my_photo.png')],
            references: [{ ...unlinked('post.md', written, 'dynamic'), kind }],
          }),
          readFile: files({ '/repo/post.md': written }),
        });

      expect((await sweepAs('md')).mentions.has('src/img/my_photo.png')).toBe(true);
      expect((await sweepAs('attr')).mentions.has('src/img/my_photo.png')).toBe(false);
    });

    it('globs a root-relative pattern as the resolver would, from a serving root the run did not find', async () => {
      // No root-relative path resolves, so the resolver had no base to glob the pattern
      // against and it ended dynamic. Its holes leave no filename token to find, so the sweep
      // globs it from any directory: a hole stays within one segment, and every directory
      // the pattern fixes has to be there. Each missing path starts its own 40-character line.
      const paths = Array.from({ length: 19 }, (_, index) => `/missing${index}.png`);
      const source = 'export const icon = (set, size) => `/img/${set}/icon-${size}.png`;';
      const graph = graphOf({
        assets: [
          asset('src/img/dark/icon-192.png'),
          asset('src/img/icon-192.png'),
          asset('src/icons/dark/icon-192.png'),
        ],
        references: [
          ...paths.map((path, index) => unlinked('index.html', path, 'broken', index * 40)),
          {
            ...unlinked(
              'app.js',
              '/img/${set}/icon-${size}.png',
              'dynamic',
              source.indexOf('/img/'),
            ),
            kind: 'string',
            ceiling: 'medium',
          },
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({
          '/repo/index.html': paths.map((path) => path.padEnd(39)).join('\n'),
          '/repo/app.js': source,
        }),
      });

      expect(result.mentions.get('src/img/dark/icon-192.png')).toEqual([
        {
          asset: 'src/img/dark/icon-192.png',
          source: 'unresolved-reference',
          where: 'app.js:1',
          quote: '/img/${set}/icon-${size}.png',
        },
      ]);
      expect([...result.mentions.keys()]).toEqual(['src/img/dark/icon-192.png']);
    });

    it('does not glob a pattern from other directories once the serving root is found', async () => {
      // Nineteen of twenty root-relative paths resolve, so the resolver globbed the pattern
      // against a serving root it knows, and what it matched there is all it names.
      const linked = Array.from({ length: 19 }, (_, index) => `public/a${index}.png`);
      const graph = graphOf({
        assets: [...linked.map(asset), asset('src/img/pattern-1.png')],
        references: [
          ...linked.map((target, index) => resolved('index.html', `/a${index}.png`, target)),
          {
            ...unlinked('app.js', '/img/pattern-${n}.png', 'dynamic'),
            kind: 'string',
            ceiling: 'medium',
          },
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/app.js': '`/img/pattern-${n}.png`' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it.each([
      ['a Liquid hole', '/img/liquid-{{ n }}.png'],
      ['an EJS hole', '/img/liquid-<%= n %>.png'],
    ])(
      'hedges what %s could name, which the resolver never globs, with the serving root found',
      async (_name, pattern) => {
        const linked = Array.from({ length: 19 }, (_, index) => `public/a${index}.png`);
        const graph = graphOf({
          assets: [
            ...linked.map(asset),
            asset('public/img/liquid-1.png'),
            asset('public/img/liquid-2.png'),
            asset('public/liquid-3.png'),
          ],
          references: [
            ...linked.map((target, index) => resolved('index.html', `/a${index}.png`, target)),
            { ...unlinked('post.md', pattern, 'dynamic'), kind: 'md', ceiling: 'unsafe' },
          ],
        });

        const result = await sweepForMentions({
          graph,
          readFile: files({ '/repo/post.md': pattern }),
        });

        expect([...result.mentions.keys()].sort()).toEqual([
          'public/img/liquid-1.png',
          'public/img/liquid-2.png',
        ]);
      },
    );

    it('hedges what a pattern through an unread alias could name', async () => {
      // No rule maps `@/`, so the resolver could not expand the pattern. What follows the
      // alias is globbed from any directory, and every directory it fixes has to be there.
      const source = 'export const icon = (n) => import(`@/img/alias-${n}.png`);';
      const graph = graphOf({
        assets: [asset('src/img/alias-1.png'), asset('src/icons/alias-1.png')],
        references: [
          {
            ...unlinked('app.js', '@/img/alias-${n}.png', 'unresolved-alias', source.indexOf('@/')),
            kind: 'import',
            ceiling: 'medium',
          },
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/app.js': source }),
      });

      expect(result.mentions.get('src/img/alias-1.png')).toEqual([
        {
          asset: 'src/img/alias-1.png',
          source: 'unresolved-reference',
          where: 'app.js:1',
          quote: '@/img/alias-${n}.png',
        },
      ]);
      expect([...result.mentions.keys()]).toEqual(['src/img/alias-1.png']);
    });

    it('hedges what a + chain through an unread alias could name, reading the path it proves', async () => {
      const source = "export const badge = (n) => import('~/img/badge-' + n + '.png');";
      const graph = graphOf({
        assets: [asset('src/img/badge-1.png')],
        references: [
          {
            ...unlinked(
              'app.js',
              "~/img/badge-' + n + '.png",
              'unresolved-alias',
              source.indexOf('~/'),
            ),
            kind: 'string',
            ceiling: 'medium',
            assembledPath: '~/img/badge-${}.png',
          },
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/app.js': source }),
      });

      expect([...result.mentions.keys()]).toEqual(['src/img/badge-1.png']);
    });

    it('leaves a path that is one hole and nothing else to the mentions', async () => {
      const graph = graphOf({
        assets: [asset('public/img/cover.png')],
        references: [
          { ...unlinked('post.md', '{{ page.image }}', 'dynamic'), kind: 'md', ceiling: 'unsafe' },
        ],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/post.md': '{{ page.image }}' }),
      });

      expect(result.mentions.size).toBe(0);
    });

    it('still cites the file when its source cannot be re-read for a line', async () => {
      const graph = graphOf({
        assets: [asset('img/hero.png')],
        references: [unlinked('gone.md', '{{ x }}/img/hero.png', 'dynamic')],
      });

      const result = await sweepForMentions({ graph, readFile: files({}) });

      expect(result.mentions.get('img/hero.png')?.[0]?.where).toBe('gone.md');
      expect(result.skipped).toEqual([{ relative: 'gone.md', reason: 'ENOENT' }]);
    });
  });

  describe('haystack (c): files we read but did not understand', () => {
    it('rescues an asset named only by a construct no adapter reads', async () => {
      // A name in a file an adapter did read, with no reference that links the asset.
      // Neither other source covers it, so without this one the asset would be
      // reported dead with confidence.
      const graph = graphOf({ assets: [asset('img/hero.png')] });
      const source = ['export const config = {', '  banner: `/img/hero.png`,', '};'].join('\n');

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/gen.ts': source }),
        scannedMentions: [{ basename: 'hero.png', relative: 'gen.ts', line: 2, quote: 'hero.png' }],
      });

      expect(result.mentions.get('img/hero.png')).toEqual([
        {
          asset: 'img/hero.png',
          source: 'scanned-file',
          where: 'gen.ts:2',
          quote: 'hero.png',
        },
      ]);
    });

    /**
     * Drive `scan` for real rather than hand-feeding the sweep. A test that asserts an
     * absence passes just as well when its input never reached the sweep, so these give
     * the sweep whatever `scan`'s mention pass really produces from the source.
     */
    async function sweepAfterScanning(source: string, assetRelative: string) {
      const scanned = await scanSources({
        sourceFiles: [
          { path: '/repo/gen.ts', relative: 'gen.ts', extension: '.ts', adapterId: 'javascript' },
        ],
        adapters: [javascriptAdapter],
        readFile: files({ '/repo/gen.ts': source }),
        assetBasenames: new Set([assetRelative.slice(assetRelative.lastIndexOf('/') + 1)]),
      });

      const result = await sweepForMentions({
        graph: graphOf({ assets: [asset(assetRelative)] }),
        readFile: files({}),
        scannedMentions: scanned.mentions,
      });

      return { scanned, result };
    }

    it('rescues a literal filename through the real scan (the control)', async () => {
      // First, because the test below asserts that a mention is absent, and an absence
      // passes just as well when the pipeline was never connected. This is the same
      // source shape with the name written out, and it must hedge.
      const { scanned, result } = await sweepAfterScanning(
        ['export const x = {', "  path: './img/background-ltr.png',", '};'].join('\n'),
        'img/background-ltr.png',
      );

      expect(scanned.mentions.map((mention) => mention.basename)).toEqual(['background-ltr.png']);
      expect(result.mentions.get('img/background-ltr.png')).toEqual([
        {
          asset: 'img/background-ltr.png',
          source: 'scanned-file',
          where: 'gen.ts:2',
          quote: 'background-ltr.png',
        },
      ]);
    });

    it('cannot rescue a filename that is assembled at runtime: the resolver must', async () => {
      // The limit of every basename sweep: `background-${dir}.png` never contains the
      // string `background-ltr.png`, so there is nothing to find. This asserts what the
      // sweep cannot do, not that the finding is correct. The resolver covers the case:
      // the template's `medium` ceiling makes it a glob, and `resolved-pattern` links
      // every match.
      const { scanned, result } = await sweepAfterScanning(
        ['export const x = {', '  path: `./img/background-${dir}.png`,', '};'].join('\n'),
        'img/background-ltr.png',
      );

      // The zero comes from `scan` finding nothing to offer, which is the claim.
      expect(scanned.mentions).toEqual([]);
      expect(result.mentions.size).toBe(0);
    });

    it('prefers the cheaper haystack when both name the asset', async () => {
      // An unread file is stronger evidence than a mention in a file we understood,
      // and citing both would say the same thing twice.
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('page.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/page.vue': 'hero.png' }),
        scannedMentions: [{ basename: 'hero.png', relative: 'app.ts', line: 3, quote: 'hero.png' }],
      });

      expect(result.mentions.get('hero.png')?.map((m) => m.source)).toEqual(['unscanned-file']);
    });

    it('costs no filesystem read of its own', async () => {
      // `scan` collects these while the text is in memory, so the sweep reads no file twice.
      const graph = graphOf({ assets: [asset('hero.png')] });
      const readFile = vi.fn(files({}));

      const result = await sweepForMentions({
        graph,
        readFile,
        scannedMentions: [{ basename: 'hero.png', relative: 'app.ts', line: 3, quote: 'hero.png' }],
      });

      expect(readFile).not.toHaveBeenCalled();
      expect(result.mentions.get('hero.png')?.[0]?.where).toBe('app.ts:3');
    });
  });

  describe('what it declines to read', () => {
    it('records a file it could not read rather than silently not hedging', async () => {
      // A silent skip here turns a hedge back into a confident `dead`, which is the
      // exact false positive the hedge exists to prevent.
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('locked.yaml')],
      });

      const result = await sweepForMentions({ graph, readFile: files({}) });

      expect(result.skipped).toEqual([{ relative: 'locked.yaml', reason: 'ENOENT' }]);
    });

    it('skips a file past the size limit, with a reason', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('promo.yaml')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/promo.yaml': `${'x'.repeat(500)}hero.png` }),
        maxBytes: 100,
      });

      expect(result.mentions.size).toBe(0);
      expect(result.skipped).toEqual([
        {
          relative: 'promo.yaml',
          reason: "larger than the 100 B limit for searching a file's text",
        },
      ]);
    });

    it("asks a file's size before reading it, and compares bytes with bytes", async () => {
      // 60 accented letters and a name: 69 characters, but 129 bytes, past a 100-byte limit.
      const contents: Record<string, string> = {
        '/repo/big.yaml': 'hero.png',
        '/repo/accents.yaml': `${'é'.repeat(60)} hero.png`,
      };
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('big.yaml'), unscanned('accents.yaml')],
      });
      const read: string[] = [];
      const readFile: ReadFilePort = async (path) => {
        read.push(path);
        return contents[path] ?? '';
      };

      const sized = await sweepForMentions({
        graph,
        readFile,
        sizeOf: async (path) =>
          path === '/repo/big.yaml' ? 1_000_000_000 : Buffer.byteLength(contents[path] ?? ''),
        maxBytes: 100,
      });
      expect(read).toEqual([]);
      expect(sized.skipped.map((skip) => skip.relative)).toEqual(['accents.yaml', 'big.yaml']);

      // With no size to ask, the text is read and its bytes counted.
      const unsized = await sweepForMentions({ graph, readFile, maxBytes: 100 });
      expect(unsized.skipped.map((skip) => skip.relative)).toEqual(['accents.yaml']);
    });

    it('never reads a known binary type, which holds no text to search', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('promo.mp4'), unscanned('font.woff2')],
      });
      const read: string[] = [];

      const result = await sweepForMentions({
        graph,
        readFile: async (path) => {
          read.push(path);
          return 'hero.png';
        },
      });

      expect(read).toEqual([]);
      expect(result.mentions.size).toBe(0);
      expect(result.skipped).toEqual([]);
    });

    it('reads a database and compiled code, which can hold a path a page loads', async () => {
      const names = ['content.db', 'pages.sqlite', 'app.wasm', 'addon.node', 'blob.bin', 'old.swf'];
      const graph = graphOf({ assets: [asset('hero.png')], unscannedFiles: names.map(unscanned) });

      const result = await sweepForMentions({
        graph,
        readFile: async () => '\0\0\0<img src="/hero.png">',
      });

      expect(result.mentions.get('hero.png')?.map((mention) => mention.where)).toEqual(
        names.map((name) => `${name}:1`).sort(),
      );
    });
  });

  describe('determinism and shape', () => {
    it('sorts mentions so two runs agree', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('b.vue'), unscanned('a.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/a.vue': 'hero.png', '/repo/b.vue': 'hero.png' }),
      });

      expect(result.mentions.get('hero.png')?.map((mention) => mention.where)).toEqual([
        'a.vue:1',
        'b.vue:1',
      ]);
    });

    it('records one mention per place, not per occurrence of the same place', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('a.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/a.vue': 'hero.png and again hero.png' }),
      });

      // Two occurrences on one line are one piece of evidence, not two.
      expect(result.mentions.get('hero.png')).toHaveLength(1);
    });

    it('sweeps nothing when there is nothing to sweep', async () => {
      const readFile = vi.fn(files({}));

      const result = await sweepForMentions({ graph: graphOf({}), readFile });

      expect(result).toEqual({ mentions: new Map(), skipped: [] });
      expect(readFile).not.toHaveBeenCalled();
    });

    it('ignores tokens whose extension we do not track', async () => {
      const graph = graphOf({
        assets: [asset('hero.png')],
        unscannedFiles: [unscanned('a.vue')],
      });

      const result = await sweepForMentions({
        graph,
        readFile: files({ '/repo/a.vue': 'import hero from "./hero.ts"; // not hero.png-ish' }),
      });

      // `hero.ts` is not a tracked extension, so it is not a filename token at all;
      // the comment does contain `hero.png` though, and evidence is evidence.
      expect(result.mentions.get('hero.png')?.[0]?.quote).toBe('hero.png');
    });
  });
});
