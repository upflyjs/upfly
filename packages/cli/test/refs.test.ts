/**
 * `upfly refs` through the built binary, on copies of the plain HTML fixture outside the
 * workspace: every reference to one image, whether each can be rewritten, and what `optimize`
 * would do with the image.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  FIXTURES,
  copyFixture,
  jsonLines,
  snapshot,
  tempFolder,
  upfly,
  write,
} from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOGO = readFileSync(join(FIXTURES, 'plain-html/images/logo.png'));

/** The plain HTML site, with a download link to the logo and a folder only a template reaches. */
function site(): string {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-refs-'));
  write(root, 'notes.md', '[the logo, as a download](images/logo.png)\n');
  write(root, 'app.js', 'export const icon = (name) => `images/icons/${name}.png`;\n');
  write(root, 'images/icons/star.png', LOGO);
  return root;
}

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

interface Answer {
  readonly references: readonly { readonly file: string; readonly line: number }[];
  readonly unfollowed: readonly {
    readonly file: string;
    readonly line: number;
    readonly text: string;
    readonly reason: string;
    readonly why: string;
    readonly host?: string;
  }[];
}

/** The JSON answer, read as the fields these tests look at. */
function answerOf(stdout: string): Answer {
  return result(stdout) as unknown as Answer;
}

/**
 * The spellings a search for `public/img/logo.png` looks for in a site served from `public`:
 * its path, with a slash, as a URL, its folder and name, and with backslashes.
 */
const LOGO_SPELLINGS = [
  'public/img/logo.png',
  '/public/img/logo.png',
  '/img/logo.png',
  'img/logo.png',
  'public\\img\\logo.png',
];

/**
 * A site where `public/img/logo.png` is named in every way a line can name an image, and a
 * second `logo.png`, in `src/img`, is imported by one file.
 */
function namedEveryWay(): string {
  const root = tempFolder(roots, 'upfly-refs-lines-');
  write(root, 'public/img/logo.png', LOGO);
  write(root, 'src/img/logo.png', readFileSync(join(FIXTURES, 'plain-html/images/texture.png')));
  write(
    root,
    'index.html',
    '<!doctype html>\n<img src="/img/logo.png" alt="">\n<!-- <img src="/img/logo.png" alt=""> -->\n',
  );
  write(
    root,
    'src/seo.ts',
    "export const organization = { logo: 'https://example.com/img/logo.png' };\n",
  );
  write(
    root,
    'src/mirror.ts',
    "export const mirror = 'https://cdn.example.org/site/img/logo.png';\n",
  );
  write(root, 'src/other.ts', "import other from './img/logo.png';\nexport { other };\n");
  write(root, 'src/note.ts', '// The header used to load /img/logo.png directly.\nexport {};\n');
  write(root, 'src/App.vue', '<template>\n  <img src="/img/logo.png" alt="">\n</template>\n');
  write(root, 'src/team.ts', 'export const team = { logo: "/img/logo.png" };\n');
  write(root, 'src/theme.ts', 'export const themed = (base: string) => `${base}/img/logo.png`;\n');
  write(root, 'yarn.lock', '"site-logo@file:./public/img/logo.png":\n  version "1.0.0"\n');
  write(root, 'README.md', 'The logo is `public/img/logo.png`.\n');
  write(root, 'legacy/old.html', '<img src="/img/logo.png" alt="">\n');
  return root;
}

/** Each `file:line` of the site's text files that holds a spelling, in any letter case. */
function searched(root: string, spellings: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (folder: string) => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== '.upfly') visit(path);
        continue;
      }
      if (path.endsWith('.png')) continue;
      readFileSync(join(root, path), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const folded = line.toLowerCase();
          if (spellings.some((spelling) => folded.includes(spelling.toLowerCase()))) {
            found.push(`${path}:${index + 1}`);
          }
        });
    }
  };
  visit('');
  return found.sort();
}

describe('upfly refs', () => {
  it('lists every reference, says which stays as written and why, and gives the verdict', () => {
    const root = site();
    const before = snapshot(root);

    const run = upfly(['refs', join(root, 'images/logo.png'), root]);

    expect(run.status).toBe(0);
    const lines = run.stdout.split('\n');
    expect(lines.slice(1, 8)).toEqual([
      'Upfly refs',
      '',
      'images/logo.png  7.2 KB',
      '',
      'References (2)',
      '    index.html:10  images/logo.png',
      '    notes.md:1  images/logo.png',
    ]);
    expect(lines[8]).toMatch(/^ {6}stays as written: .+/);
    expect(run.stdout).toContain(
      'Verdict: converts to images/logo.webp, 7.2 KB to 850 B. 1 of its 2 references moves to the new file; the original stays beside it.',
    );
    expect(snapshot(root)).toEqual(before);
  });

  it('answers under --json with a small object: the image, each reference, the verdict', () => {
    const root = site();

    const run = upfly(['refs', join(root, 'images/logo.png'), root, '--json']);

    expect(run.status).toBe(0);
    expect(result(run.stdout)).toEqual({
      type: 'result',
      command: 'refs',
      exitCode: 0,
      image: 'images/logo.png',
      bytes: LOGO.length,
      references: [
        { file: 'index.html', line: 10, text: 'images/logo.png', rewritable: true },
        {
          file: 'notes.md',
          line: 1,
          text: 'images/logo.png',
          rewritable: false,
          why: expect.any(String),
        },
      ],
      unfollowed: [],
      verdict: {
        kind: 'converts',
        to: 'images/logo.webp',
        savedBytes: expect.any(Number),
        removesOriginal: false,
      },
    });
  });

  it('reads the image path from the current folder, and the project from it by default', () => {
    const root = site();

    const run = upfly(['refs', 'images/logo.png'], { cwd: root });

    expect(run.status).toBe(0);
    expect(run.stdout.split('\n')[3]).toBe('images/logo.png  7.2 KB');
  });

  it('says an image nothing names is unused, and that Upfly leaves it where it is', () => {
    const root = site();

    const run = upfly(['refs', join(root, 'images/never-referenced.png'), root]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('No reference Upfly can read reaches it.');
    expect(run.stdout).toContain(
      'Verdict: unused. Nothing names it, not even by file name in a file Upfly could not read; Upfly never deletes an image that nothing uses, and `upfly audit` lists it with its size.',
    );
  });

  it('says where the name of a possibly unused image appears', () => {
    const root = site();

    const run = upfly(['refs', join(root, 'images/removed.png'), root, '--json']);

    expect(result(run.stdout)).toMatchObject({
      references: [],
      verdict: {
        kind: 'possibly-unused',
        mentions: [expect.objectContaining({ where: 'index.html:17' })],
      },
    });
  });

  it('gives the reason an image only a template reaches is not converted', () => {
    const root = site();

    const run = upfly(['refs', join(root, 'images/icons/star.png'), root, '--json']);
    const answer = result(run.stdout) as {
      references: { rewritable: boolean; why: string }[];
      verdict: { kind: string; why: string };
    };

    expect(answer.references).toEqual([
      expect.objectContaining({
        file: 'app.js',
        rewritable: false,
        why: 'a template reference is assembled at runtime, so its text cannot be repointed',
      }),
    ]);
    expect(answer.verdict.kind).toBe('not-converted');
    expect(answer.verdict.why).toContain(
      'Upfly converts an image only when a reference moves to the new file',
    );
  });

  describe('every line that names the image', () => {
    it('lists each line a search for its path finds, in its references or apart, once', () => {
      const root = namedEveryWay();

      const run = upfly(
        ['refs', 'public/img/logo.png', '--public', 'public', '--exclude', 'legacy', '--json'],
        {
          cwd: root,
        },
      );

      expect(run.status, run.stderr).toBe(0);
      const answer = answerOf(run.stdout);
      const references = answer.references.map(
        (reference) => `${reference.file}:${reference.line}`,
      );
      const unfollowed = answer.unfollowed.map((line) => `${line.file}:${line.line}`);
      expect(new Set([...references, ...unfollowed]).size).toBe(
        references.length + unfollowed.length,
      );
      // The one line the search finds that is in neither: it imports the other logo.png.
      expect(
        searched(root, LOGO_SPELLINGS).filter(
          (line) => !references.includes(line) && !unfollowed.includes(line),
        ),
      ).toEqual(['src/other.ts:1']);
    });

    it('says why Upfly does not follow each one', () => {
      const root = namedEveryWay();

      const run = upfly(
        ['refs', 'public/img/logo.png', '--public', 'public', '--exclude', 'legacy', '--json'],
        {
          cwd: root,
        },
      );

      const lines = Object.fromEntries(
        answerOf(run.stdout).unfollowed.map((line) => [`${line.file}:${line.line}`, line]),
      );
      expect(lines).toMatchObject({
        'index.html:3': { reason: 'comment', text: '/img/logo.png' },
        'src/seo.ts:1': {
          reason: 'full-address',
          text: 'https://example.com/img/logo.png',
          host: 'example.com',
        },
        'src/mirror.ts:1': { reason: 'full-address', host: 'cdn.example.org' },
        'src/note.ts:1': { reason: 'comment' },
        'src/App.vue:2': { reason: 'unread-file-type', why: expect.stringContaining('.vue') },
        'yarn.lock:1': { reason: 'unread-file-type' },
        'README.md:1': { reason: 'other', why: expect.stringContaining('code example') },
        'legacy/old.html:1': { reason: 'other', why: expect.stringContaining('leaves out') },
      });
      for (const line of Object.values(lines)) expect(line.why).not.toBe('');
    });

    it('never gives another image of the same name the lines that name this one', () => {
      const root = namedEveryWay();

      const run = upfly(
        ['refs', 'src/img/logo.png', '--public', 'public', '--exclude', 'legacy', '--json'],
        {
          cwd: root,
        },
      );

      const answer = answerOf(run.stdout);
      expect(answer.references.map((reference) => `${reference.file}:${reference.line}`)).toContain(
        'src/other.ts:1',
      );
      // Only a path built at runtime can stand for either image; every other line names the
      // logo in public/.
      const named = [
        ...answer.references.map((reference) => `${reference.file}:${reference.line}`),
        ...answer.unfollowed.map((line) => `${line.file}:${line.line}`),
      ];
      expect(
        named.filter((line) => line !== 'src/other.ts:1' && line !== 'src/theme.ts:1'),
      ).toEqual([]);
    });

    it('prints the lines it does not follow after the references, grouped by why', () => {
      const root = namedEveryWay();

      const run = upfly(
        ['refs', 'public/img/logo.png', '--public', 'public', '--exclude', 'legacy'],
        {
          cwd: root,
        },
      );

      expect(run.status, run.stderr).toBe(0);
      const text = run.stdout;
      const heading = text.indexOf('Not followed (');
      expect(heading).toBeGreaterThan(text.indexOf('References ('));
      expect(heading).toBeLessThan(text.indexOf('Verdict:'));
      expect(text).toContain(
        "  a full address, which Upfly never rewrites: it cannot tell which host is the site's own\n",
      );
      expect(text).toContain('    src/seo.ts:1  https://example.com/img/logo.png\n');
    });
  });

  it('exits 2 with a plain message for no such file, a file outside the project, and a page', () => {
    const root = site();
    const elsewhere = tempFolder(roots, 'upfly-refs-elsewhere-');
    write(elsewhere, 'outside.png', LOGO);

    const missing = upfly(['refs', join(root, 'images/nope.png'), root]);
    const outside = upfly(['refs', join(elsewhere, 'outside.png'), root]);
    const page = upfly(['refs', join(root, 'index.html'), root]);
    const none = upfly(['refs']);

    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('there is no file at');
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain('is outside the project');
    expect(page.status).toBe(2);
    expect(page.stderr).toContain('index.html is not an image Upfly found in the project');
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('refs needs the path of an image');
  });
});
