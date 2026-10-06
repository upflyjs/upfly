import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { toPosix } from './paths.js';
import {
  type PipelineProgress,
  existsAsSpelled,
  reportsMeasuring,
  runPipeline,
  servingRootsFor,
} from './pipeline.js';
import { buildReport } from './report/report.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A small site outside the workspace. The images are never decoded here. */
function site(): string {
  const root = mkdtempSync(join(tmpdir(), 'upfly-pipeline-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': '{ "name": "site", "private": true }\n',
    'index.html': '<img src="/logo.png"><img src="legacy/old.png">\n',
    'public/logo.png': 'logo, never decoded',
    'legacy/old.png': 'an older picture, never decoded',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A project outside the workspace holding exactly these files. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'upfly-pipeline-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('runPipeline reads an extends the way TypeScript does', () => {
  const run = (root: string) =>
    runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

  it('finds a package by its tsconfig.json, never reading the folder as a config', async () => {
    const root = project({
      'tsconfig.json': '{ "extends": "@tsconfig/x" }',
      'node_modules/@tsconfig/x/tsconfig.json':
        '{ "compilerOptions": { "paths": { "@/*": ["${configDir}/src/*"] } } }',
    });

    const { aliases } = await run(root);

    expect(aliases.skipped).toEqual([]);
    expect(aliases.rules.map((rule) => [rule.prefix, rule.targets.length])).toEqual([['@/', 1]]);
    expect(aliases.rules[0]?.targets[0]?.endsWith('/src')).toBe(true);
  });

  it('does not take a relative extends that names a folder for the config inside it', async () => {
    const root = project({
      'web/tsconfig.json': '{ "extends": "./configs" }',
      'web/configs/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    });

    const { aliases } = await run(root);

    expect(aliases.skipped).toEqual([
      {
        what: 'web/tsconfig.json',
        reason: expect.stringContaining('could not be found'),
        scopes: [toPosix(join(root, 'web'))],
      },
    ]);
  });
});

describe('the report of a pipeline run', () => {
  it('names each alias setting it could not read, with its file and line, and no path', async () => {
    const root = project({
      'tsconfig.json': '{ "extends": "@acme/uninstalled" }',
      'vite.config.ts': [
        "import path from 'node:path';",
        'export default {',
        "  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },",
        '};',
      ].join(String.fromCharCode(10)),
    });
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    const report = buildReport({
      graph: output.graph,
      audit: output.audit,
      discovery: output.discovery,
      sweep: output.sweep,
      servingRoots: output.servingRoots,
      aliases: output.aliases,
    });

    expect(report.skipped.filter((item) => item.stage === 'aliases')).toEqual([
      {
        what: 'tsconfig.json',
        stage: 'aliases',
        reason:
          'extends "@acme/uninstalled", which could not be found, so its aliases were not read',
      },
      {
        what: 'vite.config.ts',
        stage: 'aliases',
        reason: 'the alias "@" at line 3 depends on the folder Vite runs in, so it was not read',
      },
    ]);
    expect(JSON.stringify(report.skipped)).not.toContain(root.slice(0, 12));
  });

  const NL = String.fromCharCode(10);

  /** The reason the report gives each unresolved alias, by its file and path. */
  async function aliasReasons(root: string): Promise<Record<string, string>> {
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    const report = buildReport({
      graph: output.graph,
      audit: output.audit,
      discovery: output.discovery,
      sweep: output.sweep,
      servingRoots: output.servingRoots,
      aliases: output.aliases,
    });
    return Object.fromEntries(
      report.references.unsafe
        .filter((entry) => entry.resolution === 'unresolved-alias')
        .map((entry) => [`${entry.file} ${entry.rawPath}`, entry.reason]),
    );
  }

  const unreadIn = (config: string) =>
    `alias-shaped, and no alias Upfly could read maps it; ${config} has aliases Upfly could not read, listed under Skipped`;
  const UNMAPPED =
    "alias-shaped, and no alias Upfly reads maps it; it reads only tsconfig and jsconfig paths and a Vite config's resolve.alias";

  it('names the config Upfly could not read as the reason an alias it covers is unresolved', async () => {
    const root = project({
      'tsconfig.json': '{ "extends": "@acme/tsconfig/base.json" }',
      'src/app.ts': [
        "import hero from '@/assets/hero.png';",
        'export const icon = (n: number) => import(`@/img/icon-${n}.png`);',
        'export { hero };',
        '',
      ].join(NL),
      'src/content/post.md': `![Hero](~/assets/hero.png)${NL}`,
      'src/assets/hero.png': 'never decoded',
    });

    // Not the construct's note ("static import"), which says nothing about the alias.
    expect(await aliasReasons(root)).toEqual({
      'src/app.ts @/assets/hero.png': unreadIn('tsconfig.json'),
      'src/app.ts @/img/icon-${n}.png': unreadIn('tsconfig.json'),
      'src/content/post.md ~/assets/hero.png': unreadIn('tsconfig.json'),
    });
  });

  it('names the config of a SvelteKit clone that has not generated its base yet', async () => {
    const root = project({
      'tsconfig.json': '{ "extends": "./.svelte-kit/tsconfig.json" }',
      'src/routes/+page.ts': `import hero from '$lib/assets/kit-hero.png';${NL}export { hero };${NL}`,
      'src/lib/assets/kit-hero.png': 'never decoded',
    });

    // And what writes the missing config, so the user knows what to run first.
    expect(await aliasReasons(root)).toEqual({
      'src/routes/+page.ts $lib/assets/kit-hero.png': `${unreadIn('tsconfig.json')}. SvelteKit writes \`$lib\` into \`.svelte-kit/tsconfig.json\` when \`svelte-kit sync\` runs, as installing the project does, so run \`npx svelte-kit sync\`, or install the project, then run Upfly again`,
    });
  });

  it('names a Vite config whose alias it could not read', async () => {
    const root = project({
      'vite.config.ts': [
        "import path from 'node:path';",
        'export default {',
        "  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },",
        '};',
      ].join(NL),
      'src/app.ts': `import hero from '@/assets/hero.png';${NL}export { hero };${NL}`,
      'src/assets/hero.png': 'never decoded',
    });

    expect(await aliasReasons(root)).toEqual({
      'src/app.ts @/assets/hero.png': unreadIn('vite.config.ts'),
    });
  });

  it('names no config that does not cover the file', async () => {
    const root = project({
      'configs/base.json': '{ "compilerOptions": { not json',
      'apps/web/tsconfig.json': '{ "extends": "../../configs/base.json" }',
      'apps/web/src/app.ts': `import hero from '@/assets/hero.png';${NL}export { hero };${NL}`,
      'docs/tsconfig.json': '{ "extends": "@acme/docs-config" }',
      'docs/guide.md': `![Logo](~/assets/logo.png)${NL}`,
      'scripts/banner.ts': `import banner from '@/assets/banner.png';${NL}export { banner };${NL}`,
    });

    // The base's own folder holds none of these files: it reaches `apps/web` through
    // `extends`. Nothing covers `scripts/`, so its reason names no config.
    expect(await aliasReasons(root)).toEqual({
      'apps/web/src/app.ts @/assets/hero.png': unreadIn('configs/base.json'),
      'docs/guide.md ~/assets/logo.png': unreadIn('docs/tsconfig.json'),
      'scripts/banner.ts @/assets/banner.png': UNMAPPED,
    });
  });

  it.each([
    [
      'a webpack config',
      'webpack.config.js',
      [
        "const path = require('node:path');",
        "module.exports = { resolve: { alias: { '@': path.resolve(__dirname, 'src') } } };",
      ],
    ],
    [
      "Astro's vite.resolve.alias",
      'astro.config.mjs',
      [
        "import { fileURLToPath } from 'node:url';",
        "const src = fileURLToPath(new URL('./src', import.meta.url));",
        "export default { vite: { resolve: { alias: { '@': src } } } };",
      ],
    ],
  ])(
    'says which configs it reads, and never that the project declares no alias, for %s',
    async (_where, config, lines) => {
      const root = project({
        [config]: [...lines, ''].join(NL),
        'src/app.js': `import hero from '@/assets/hero.png';${NL}export { hero };${NL}`,
        'src/assets/hero.png': 'never decoded',
      });

      // The project does declare this alias, in a file Upfly does not read.
      expect(await aliasReasons(root)).toEqual({ 'src/app.js @/assets/hero.png': UNMAPPED });
    },
  );
});

describe('runPipeline', () => {
  it('reports each stage as it finishes, with what it counted', async () => {
    const events: PipelineProgress[] = [];
    await runPipeline({
      root: site(),
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
      onProgress: (event) => events.push(event),
    });

    expect(events).toEqual([
      { stage: 'discovered', images: 2, files: 2 },
      { stage: 'scanned', references: 2 },
      { stage: 'resolved', linked: 2 },
      { stage: 'audited', findings: 0 },
    ]);
  });

  it('counts the images as it measures them, before saying they are measured', async () => {
    const events: PipelineProgress[] = [];
    await runPipeline({
      root: site(),
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: { formats: ['webp'] },
      onProgress: (event) => events.push(event),
    });

    const measuring = events.filter(({ stage }) => stage === 'measuring' || stage === 'measured');
    expect(measuring).toEqual([
      { stage: 'measuring', done: 1, total: 2 },
      { stage: 'measuring', done: 2, total: 2 },
      { stage: 'measured', images: 2 },
    ]);
  });

  it('counts every image it measures, however many there are', async () => {
    const files: Record<string, string> = {
      'package.json': '{ "name": "site", "private": true }\n',
    };
    for (let index = 0; index < 25; index += 1) files[`img/${index}.png`] = 'not an image';
    const events: PipelineProgress[] = [];
    await runPipeline({
      root: project(files),
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: { formats: [] },
      onProgress: (event) => events.push(event),
    });

    const counts = events.flatMap((event) => (event.stage === 'measuring' ? [event.done] : []));
    expect(counts).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it('reports the count at most once per twentieth of the images, and always the last', () => {
    const reported = (total: number) =>
      Array.from({ length: total }, (_, index) => index + 1).filter((done) =>
        reportsMeasuring(done, total),
      );

    expect(reported(7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reported(1000)).toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) * 50));
    expect(reported(2910).at(-1)).toBe(2910);
    expect(reported(2910)).toHaveLength(20);
  });

  it('decides the serving roots itself unless they are declared', async () => {
    const root = site();
    const decided = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    const declared = await runPipeline({
      root,
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(decided.servingRoots).toEqual({ dirs: ['public'], declared: false });
    expect(declared.servingRoots).toEqual({ dirs: [''], declared: true });
  });

  it('leaves out what extraIgnores names, as .upflyignore would', async () => {
    const output = await runPipeline({
      root: site(),
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
      extraIgnores: ['legacy/'],
    });

    expect(output.discovery.assets.map((asset) => asset.relative)).toEqual(['public/logo.png']);
    expect(output.discovery.excludedRoots.map((excluded) => excluded.relative)).toEqual(['legacy']);
  });
});

describe('a construct Upfly could not read', () => {
  it('reaches the references whatever its text holds, so the report can say why', async () => {
    const root = site();
    // Each text shows something after its last dot that is no image extension, which a
    // test of a path would take as ruling the text out.
    writeFileSync(
      join(root, 'refused.html'),
      '<div style="background: url(/logo.png) no-repeat; color red"></div>\n' +
        '<div style="margin 0.5em"></div>\n' +
        '<div style="margin 0.5em; font-family: &quot;Inter&quot;"></div>\n' +
        '<style>{% if dark %}{% endif %}.a { margin: 0.5em }</style>\n',
    );
    writeFileSync(
      join(root, 'box.ts'),
      "import styled from 'styled-components';\nexport const Box = styled.div`margin: 0.5em; }`;\n",
    );

    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    const refused = output.references
      .filter((reference) => reference.resolution === 'dynamic')
      .map((reference) => reference.rawPath);
    expect(refused).toHaveLength(5);
    expect(refused).toEqual(
      expect.arrayContaining([
        'background: url(/logo.png) no-repeat; color red',
        'margin 0.5em',
        'margin 0.5em; font-family: &quot;Inter&quot;',
        '{% if dark %}{% endif %}.a { margin: 0.5em }',
        'margin: 0.5em; }',
      ]),
    );
  });
});

describe('a glob import', () => {
  const unused = async (root: string) => {
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    return output.audit.findings.flatMap((finding) =>
      finding.kind === 'dead' || finding.kind === 'possibly-dead' ? [finding.asset] : [],
    );
  };

  it('links every image its pattern matches, so none of them is called unused', async () => {
    const root = project({
      'package.json': '{ "name": "gallery", "private": true }\n',
      'src/gallery.js': "export const images = import.meta.glob('./img/*.png', { eager: true });\n",
      'src/img/one.png': 'one, never decoded',
      'src/img/two.png': 'two, never decoded',
      'src/spare.png': 'a picture nothing loads, never decoded',
    });

    expect(await unused(root)).toEqual(['src/spare.png']);
  });

  it('hedges what a glob that matched nothing could name, rather than calling it unused', async () => {
    // Vite reads `/` from the app's own folder, which this run cannot find, so the glob
    // matches nothing from the project root and the image is only possibly unused.
    const root = project({
      'package.json': '{ "name": "workspace", "private": true }\n',
      'apps/web/src/gallery.js': "export const images = import.meta.glob('/src/img/*.png');\n",
      'apps/web/src/img/one.png': 'one, never decoded',
    });
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(
      output.audit.findings.flatMap((finding) =>
        finding.kind === 'dead' || finding.kind === 'possibly-dead'
          ? [[finding.kind, finding.asset]]
          : [],
      ),
    ).toEqual([['possibly-dead', 'apps/web/src/img/one.png']]);
  });
});

describe("webpack's require.context", () => {
  const unusedKinds = async (root: string) => {
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    return output.audit.findings.flatMap((finding) =>
      finding.kind === 'dead' || finding.kind === 'possibly-dead'
        ? [[finding.kind, finding.asset]]
        : [],
    );
  };

  it('links every image a context loads, so none of them is called unused', async () => {
    const root = project({
      'package.json': '{ "name": "icons", "private": true }\n',
      'src/icons.js': "export const icons = require.context('./icons', false, /\\.png$/);\n",
      'src/icons/one.png': 'one, never decoded',
      'src/icons/two.png': 'two, never decoded',
      'src/icons/old/three.png': 'a folder down, which the call does not list, never decoded',
    });

    expect(await unusedKinds(root)).toEqual([['dead', 'src/icons/old/three.png']]);
  });

  it('hedges what a context it cannot read could load, rather than calling it unused', async () => {
    // webpack reads the filter only if the build can work it out, so any image under the
    // folder may be loaded; one outside it is still unused.
    const root = project({
      'package.json': '{ "name": "icons", "private": true }\n',
      'src/icons.js': "export const icons = require.context('./icons', true, filter);\n",
      'src/icons/one.png': 'one, never decoded',
      'src/icons/old/two.png': 'two, never decoded',
      'src/spare.png': 'a picture nothing loads, never decoded',
    });

    expect(await unusedKinds(root)).toEqual([
      ['dead', 'src/spare.png'],
      ['possibly-dead', 'src/icons/old/two.png'],
      ['possibly-dead', 'src/icons/one.png'],
    ]);
  });
});

describe("webpack's import.meta.webpackContext", () => {
  const unusedKinds = async (root: string) => {
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    return output.audit.findings.flatMap((finding) =>
      finding.kind === 'dead' || finding.kind === 'possibly-dead'
        ? [[finding.kind, finding.asset]]
        : [],
    );
  };

  it('links every image the call loads, so none of them is called unused', async () => {
    const root = project({
      'package.json': '{ "name": "icons", "private": true }\n',
      'src/icons.js':
        "export const icons = import.meta.webpackContext('./icons', { recursive: false, regExp: /\\.png$/ });\n",
      'src/icons/one.png': 'one, never decoded',
      'src/icons/two.png': 'two, never decoded',
      'src/icons/old/three.png': 'a folder down, which the call does not list, never decoded',
    });

    expect(await unusedKinds(root)).toEqual([['dead', 'src/icons/old/three.png']]);
  });

  it('hedges what a call it cannot read could load, rather than calling it unused', async () => {
    // webpack tests `exclude` against each file's absolute path, which depends on where the
    // project is built, so any image under the folder may be loaded; one outside it is unused.
    const root = project({
      'package.json': '{ "name": "icons", "private": true }\n',
      'src/icons.js':
        "export const icons = import.meta.webpackContext('./icons', { exclude: /\\.test\\./ });\n",
      'src/icons/one.png': 'one, never decoded',
      'src/icons/old/two.png': 'two, never decoded',
      'src/spare.png': 'a picture nothing loads, never decoded',
    });

    expect(await unusedKinds(root)).toEqual([
      ['dead', 'src/spare.png'],
      ['possibly-dead', 'src/icons/old/two.png'],
      ['possibly-dead', 'src/icons/one.png'],
    ]);
  });
});

describe('the name search', () => {
  const unusedKinds = async (root: string) => {
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    return output.audit.findings.flatMap((finding) =>
      finding.kind === 'dead' || finding.kind === 'possibly-dead'
        ? [[finding.kind, finding.asset]]
        : [],
    );
  };

  it('hedges an image named percent-encoded in a file Upfly does not read', async () => {
    const root = project({
      'package.json': '{ "name": "site", "private": true }\n',
      'App.vue': '<template><img src="/img/vue%20photo.png"></template>\n',
      'img/vue photo.png': 'a photo, never decoded',
    });

    expect(await unusedKinds(root)).toEqual([['possibly-dead', 'img/vue photo.png']]);
  });

  it('hedges an image whose name holds letters beyond ASCII, named in prose', async () => {
    const root = project({
      'package.json': '{ "name": "site", "private": true }\n',
      'notes.md': 'See Zaječar (2).jpg and Poznań cover (3).png in the gallery.\n',
      'img/Zaječar (2).jpg': 'a photo, never decoded',
      'img/Poznań cover (3).png': 'a cover, never decoded',
    });

    expect(await unusedKinds(root)).toEqual([
      ['possibly-dead', 'img/Poznań cover (3).png'],
      ['possibly-dead', 'img/Zaječar (2).jpg'],
    ]);
  });
});

describe('a character reference inside a style attribute', () => {
  // The HTML parser decodes the whole attribute before CSS reads it, so `caf&eacute;.png`
  // names `café.png` in every construct CSS owns there, not only a plain `url()`.
  it.each([
    ['image-set()', 'background: image-set(url(caf&eacute;.png) 1x)'],
    ['a custom property', '--hero: url(caf&eacute;.png)'],
    ['the prefixed image-set()', 'background: -webkit-image-set(url(caf&eacute;.png) 1x)'],
  ])('is decoded in %s, so the image is linked and nothing is broken', async (_name, css) => {
    const output = await runPipeline({
      root: project({
        'package.json': '{ "name": "site", "private": true }\n',
        'index.html': `<div style="${css}"></div>\n`,
        'café.png': 'a cafe, never decoded',
      }),
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(output.references.map(({ resolution }) => resolution)).toEqual(['resolved']);
    expect(output.audit.findings.map((finding) => finding.kind)).not.toContain('broken');
  });
});

describe('a refused path hedges what it could name', () => {
  const unusedKinds = async (files: Record<string, string>) => {
    const output = await runPipeline({
      root: project({ 'package.json': '{ "name": "site", "private": true }\n', ...files }),
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    return output.audit.findings.flatMap((finding) =>
      finding.kind === 'dead' || finding.kind === 'possibly-dead'
        ? [[finding.kind, finding.asset]]
        : [],
    );
  };

  it('a CSS url() written with an escape, by the name the escape decodes to', async () => {
    // `\e9 ` is CSS for é, so the browser asks for `img/café.png`.
    expect(
      await unusedKinds({
        'site.css': '.a { background: url(img/caf\\e9 .png); }\n',
        'img/café.png': 'a cafe, never decoded',
      }),
    ).toEqual([['possibly-dead', 'img/café.png']]);
  });

  it('an HTML path refused for a character reference, by the value the browser reads', async () => {
    // parse5 decodes the legacy `&copy` written without its semicolon; Upfly's decoder does not.
    expect(
      await unusedKinds({
        'index.html': '<img src="img/caf&eacute;&copy.png">\n',
        'img/café©.png': 'a cafe, never decoded',
      }),
    ).toEqual([['possibly-dead', 'img/café©.png']]);
  });

  it("a guessed JavaScript string holding another language's hole, by its fixed parts", async () => {
    expect(
      await unusedKinds({
        'app.js': "export const photos = { first: '/img/photo-{{ n }}.png' };\n",
        'img/photo-1.png': 'a photo, never decoded',
      }),
    ).toEqual([['possibly-dead', 'img/photo-1.png']]);
  });
});

describe('a <style> element inside Markdown', () => {
  const cafe = `caf${String.fromCodePoint(0xe9)}.png`;
  const findings = async (images: Record<string, string>) => {
    const output = await runPipeline({
      root: project({
        'package.json': '{ "name": "site", "private": true }\n',
        'note.md': '# A note\n\n<style>.a { background: url(caf&eacute;.png) }</style>\n',
        ...images,
      }),
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });
    return output.audit.findings.flatMap((finding) =>
      finding.kind === 'broken'
        ? [[finding.kind, finding.rawPath]]
        : finding.kind === 'dead' || finding.kind === 'possibly-dead'
          ? [[finding.kind, finding.asset]]
          : [],
    );
  };

  it('asks for a name spelled with a character reference as written, as in an HTML page', async () => {
    // A browser decodes no character reference inside `<style>`, wherever the element sits,
    // while it decodes the CSS of a style attribute.
    expect(
      await findings({ 'caf&eacute;.png': 'the name as written', [cafe]: 'the decoded name' }),
    ).toEqual([['dead', cafe]]);
    expect(await findings({ [cafe]: 'the decoded name' })).toEqual([
      ['broken', 'caf&eacute;.png'],
      ['dead', cafe],
    ]);
  });
});

describe('a backslash as a folder separator', () => {
  it('refuses one Markdown keeps and an encoded one, and hedges the images they name', async () => {
    // Most Markdown renderers write `img\team.png` as `img%5Cteam.png`, and a browser keeps
    // `%5C` as written, so only some renderers and Windows servers load these images.
    const root = project({
      'package.json': '{ "name": "site", "private": true }\n',
      'docs/page.md': '![Team](img\\team.png)\n',
      'docs/index.html': '<img src="img%5Clogo.png">\n',
      'docs/img/team.png': 'a team photo, never decoded',
      'docs/img/logo.png': 'a logo, never decoded',
    });
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(
      output.references.map(({ rawPath, resolution, note }) => [rawPath, resolution, note]),
    ).toEqual([
      ['img%5Clogo.png', 'dynamic', expect.stringContaining('%5C, an encoded backslash')],
      ['img\\team.png', 'dynamic', expect.stringContaining('Markdown renderers')],
    ]);
    expect(
      output.audit.findings.flatMap((finding) =>
        finding.kind === 'dead' || finding.kind === 'possibly-dead'
          ? [[finding.kind, finding.asset]]
          : [],
      ),
    ).toEqual([
      ['possibly-dead', 'docs/img/logo.png'],
      ['possibly-dead', 'docs/img/team.png'],
    ]);
  });
});

describe('an escaped string where a path is asserted', () => {
  it('stays dynamic and hedges the image its decoded text names', async () => {
    const root = project({
      'package.json': '{ "name": "app", "private": true }\n',
      'src/App.jsx':
        "import hero from './img/h\\u00e9ro.png';\n" +
        "export const A = () => <img src={'./img/caf\\u00e9.png'} alt={hero} />;\n",
      'src/img/café.png': 'a cafe, never decoded',
      'src/img/héro.png': 'a hero, never decoded',
    });
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(output.references.map(({ rawPath, resolution }) => [rawPath, resolution])).toEqual([
      ['./img/h\\u00e9ro.png', 'dynamic'],
      ['./img/caf\\u00e9.png', 'dynamic'],
    ]);
    expect(
      output.audit.findings.flatMap((finding) =>
        finding.kind === 'dead' || finding.kind === 'possibly-dead'
          ? [[finding.kind, finding.asset]]
          : [],
      ),
    ).toEqual([
      ['possibly-dead', 'src/img/café.png'],
      ['possibly-dead', 'src/img/héro.png'],
    ]);
  });

  it('hedges what an escaped glob pattern could name once decoded', async () => {
    const root = project({
      'package.json': '{ "name": "app", "private": true }\n',
      'src/gallery.js':
        "export const a = import.meta.glob('./img/caf\\u00e9-*.png');\n" +
        "export const b = import.meta.glob('./art/h\\u00e9ro-*.{png,jpg}');\n",
      'src/img/café-1.png': 'a cafe, never decoded',
      'src/art/héro-1.jpg': 'a hero, never decoded',
    });
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(output.references.map(({ resolution }) => resolution)).toEqual(['dynamic', 'dynamic']);
    expect(
      output.audit.findings.flatMap((finding) =>
        finding.kind === 'dead' || finding.kind === 'possibly-dead'
          ? [[finding.kind, finding.asset]]
          : [],
      ),
    ).toEqual([
      ['possibly-dead', 'src/art/héro-1.jpg'],
      ['possibly-dead', 'src/img/café-1.png'],
    ]);
  });
});

describe('a page read in the wrong encoding', () => {
  it('hedges each image its path could spell, one character for each U+FFFD', async () => {
    const root = project({
      'package.json': '{ "name": "site", "private": true }\n',
      'img/café.png': 'a cafe, never decoded',
      'img/cafés.png': 'two cafes, never decoded',
      'photos/café.png': 'another cafe, never decoded',
    });
    // Latin-1 bytes: 0xE9 is not UTF-8, so the name reads `caf\uFFFD.png`.
    writeFileSync(
      join(root, 'latin1.html'),
      Buffer.from('<img src="img/caf\xE9.png">\n', 'latin1'),
    );
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(output.references.map(({ resolution }) => resolution)).toEqual(['dynamic']);
    expect(
      output.audit.findings.flatMap((finding) =>
        finding.kind === 'dead' || finding.kind === 'possibly-dead'
          ? [[finding.kind, finding.asset]]
          : [],
      ),
    ).toEqual([
      ['dead', 'img/cafés.png'],
      ['dead', 'photos/café.png'],
      ['possibly-dead', 'img/café.png'],
    ]);
  });
});

describe('a relative pattern a script builds for the page that loads it', () => {
  it('hedges each image whose path ends with its fixed segments when it matches nothing', async () => {
    // The browser reads the path from the page's folder, `pages/`, which a script does not know.
    const root = project({
      'package.json': '{ "name": "site", "private": true }\n',
      'pages/index.html': '<script src="../js/app.js"></script>\n',
      'js/app.js': "export const show = (el, n) => { el.src = 'img/icon-' + n + '.png'; };\n",
      'pages/img/icon-1.png': 'one, never decoded',
      'pages/img/icon-2.png': 'two, never decoded',
      'pages/icon-3.png': 'three, outside the pattern, never decoded',
    });
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(
      output.references.filter((reference) => reference.file.endsWith('app.js')),
    ).toMatchObject([{ resolution: 'dynamic', ceiling: 'medium' }]);
    expect(
      output.audit.findings.flatMap((finding) =>
        finding.kind === 'dead' || finding.kind === 'possibly-dead'
          ? [[finding.kind, finding.asset]]
          : [],
      ),
    ).toEqual([
      ['dead', 'pages/icon-3.png'],
      ['possibly-dead', 'pages/img/icon-1.png'],
      ['possibly-dead', 'pages/img/icon-2.png'],
    ]);
  });
});

describe("a template hole of another language in a component's path", () => {
  it('is dynamic, not broken, and hedges the images it could name', async () => {
    const root = project({
      'package.json': '{ "name": "template", "private": true }\n',
      'src/App.jsx': 'export const A = () => <img src="./img/{{ name }}.png" />;\n',
      'src/img/logo.png': 'a logo, never decoded',
    });
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(output.references.map(({ resolution }) => resolution)).toEqual(['dynamic']);
    expect(output.audit.findings.map((finding) => finding.kind)).toEqual(['possibly-dead']);
  });

  it('still looks up a quoted `${`, which JavaScript never fills in', async () => {
    const root = project({
      'package.json': '{ "name": "app", "private": true }\n',
      'src/App.jsx': "export const A = () => <img src='./img/${name}.png' />;\n",
    });
    const output = await runPipeline({
      root,
      servingRoots: servingRootsFor(),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

    expect(output.references.map(({ resolution }) => resolution)).toEqual(['broken']);
  });
});

describe('the encode cap', () => {
  const partialPattern = fileURLToPath(
    new URL('../../../fixtures/partial-pattern', import.meta.url),
  );

  it.each([
    [2, ['public/banner.png', 'src/inline-logo.jpg']],
    [3, ['public/banner.png', 'public/theme-sepia.png', 'src/inline-logo.jpg']],
  ])(
    'measures the %i largest images, whether a pattern names them or not',
    async (cap, largest) => {
      const output = await runPipeline({
        root: partialPattern,
        servingRoots: servingRootsFor({ dirs: ['public'], declared: true }),
        publicDirs: (servingRoots) => servingRoots.dirs,
        probeOptions: { formats: ['webp'], maxEncodedAssets: cap },
      });

      const measured = (output.probes ?? [])
        .filter((probe) => probe.encoded.length > 0)
        .map((probe) => probe.relative);
      expect(measured).toEqual(largest);
    },
  );
});

describe('a reference that reaches an image only in another letter case', () => {
  // Windows and macOS find `img/lvm.jpg` when the file is `img/LVM.jpg`; a Linux server does
  // not. The report gives the Linux answer on every machine, and says why.
  const run = (root: string) =>
    runPipeline({
      root,
      servingRoots: servingRootsFor({ dirs: [''], declared: true }),
      publicDirs: (servingRoots) => servingRoots.dirs,
      probeOptions: null,
    });

  function broken(output: Awaited<ReturnType<typeof run>>) {
    return output.audit.findings.flatMap((finding) =>
      finding.kind === 'broken' ? [[finding.where, finding.rawPath, finding.note]] : [],
    );
  }

  it('is one broken finding, worded the same on every platform', async () => {
    const root = project({
      'index.html': '<img src="img/LVM.jpg">\n',
      'about.html': '<img src="img/lvm.jpg">\n',
      'img/LVM.jpg': 'a photo, never decoded',
    });

    const output = await run(root);

    expect(output.references.map(({ rawPath, resolution }) => [rawPath, resolution])).toEqual([
      ['img/lvm.jpg', 'broken'],
      ['img/LVM.jpg', 'resolved'],
    ]);
    expect(broken(output)).toEqual([
      [
        'about.html:1',
        'img/lvm.jpg',
        'names `img/LVM.jpg` as `img/lvm.jpg`: it loads on Windows and macOS and breaks on a Linux server; fix the letter case',
      ],
    ]);
  });

  it('says so for a folder named in another case, in a stylesheet', async () => {
    const root = project({
      'index.html': '<link rel="stylesheet" href="css/site.css">\n',
      'css/site.css': '.hero { background: url(../Img/LVM.jpg); }\n',
      'img/LVM.jpg': 'a photo, never decoded',
    });

    expect(broken(await run(root))).toEqual([
      [
        'css/site.css:1',
        '../Img/LVM.jpg',
        'names `img/LVM.jpg` as `../Img/LVM.jpg`: it loads on Windows and macOS and breaks on a Linux server; fix the letter case',
      ],
    ]);
  });

  it('asks the disk for every name below the root as spelled, outside the root too', () => {
    const outer = project({ 'site/img/LVM.jpg': 'a photo', 'shared/Pic.png': 'a picture' });
    const exists = existsAsSpelled(join(outer, 'site'));

    expect(exists(join(outer, 'site/img/LVM.jpg'))).toBe(true);
    expect(exists(join(outer, 'site/img/lvm.jpg'))).toBe(false);
    expect(exists(join(outer, 'site/IMG/LVM.jpg'))).toBe(false);
    expect(exists(join(outer, 'site/../shared/Pic.png'))).toBe(true);
    expect(exists(join(outer, 'site/../Shared/Pic.png'))).toBe(false);
    expect(exists(join(outer, 'site/img/missing.jpg'))).toBe(false);
  });

  it('is broken for a file the walk left out, named in another case, and out of scope as spelled', async () => {
    const root = project({
      '.upflyignore': 'old/*.png\n',
      'index.html': '<img src="old/Photo.png"><img src="old/photo.png">\n',
      'old/Photo.png': 'an older picture, never decoded',
    });

    const output = await run(root);

    expect(output.references.map(({ rawPath, resolution }) => [rawPath, resolution])).toEqual([
      ['old/Photo.png', 'out-of-scope'],
      ['old/photo.png', 'broken'],
    ]);
  });
});
