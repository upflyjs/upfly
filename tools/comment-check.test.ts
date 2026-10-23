import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyseSource, countFindings } from './comment-check.mjs';

const SCRIPT = fileURLToPath(new URL('./comment-check.mjs', import.meta.url));
const SHIPPED = 'packages/demo/src/demo.ts';
const BENCH = 'bench/src/demo.ts';
// A test's strings are its data, so only its comments are read.
const TEST_FILE = 'packages/demo/src/demo.test.ts';
const EM_DASH = '—';

function countsOf(text: string, file = TEST_FILE) {
  return countFindings(analyseSource(text, file));
}

function lineComments(count: number) {
  return Array.from({ length: count }, (_, i) => `// line ${i + 1} of the note`).join('\n');
}

describe('each rule catches what it names', () => {
  it.each([
    ['a ruling number', '// fixed in R184'],
    ['a ruling number with a letter', '// fixed in R76b'],
    ['a ruling number with a hyphen and a letter', '// fixed in R71-b'],
    ['a plan section', '// see §5.1'],
    ['a chat name', '// measured by B15'],
    ['a chat name with a part', '// owned by C2a'],
    ['a notes path', '// the reasoning is in notes/STATE.md'],
    ['the parent chat', '// raised with the parent chat'],
    ['a lesson label', '// the same trap as 6a-septies'],
    ['a plan phase', '// arrives in Phase 2'],
  ])('%s is an internal reference', (_, comment) => {
    expect(countsOf(comment)).toEqual({ 'internal-reference': 1 });
  });

  it('an em dash', () => {
    expect(countsOf(`// one ${EM_DASH} two`)).toEqual({ 'em-dash': 1 });
  });

  it.each([
    ['bold', '// this is **important**'],
    ['bold with underscores', '// this is __important__'],
    ['italics', '// this is *important*'],
    ['italics with underscores', '// this is _important_'],
  ])('markdown %s', (_, comment) => {
    expect(countsOf(comment)).toEqual({ emphasis: 1 });
  });

  it.each([
    ['a warning sign', '// ⚠️ careful'],
    ['a red circle', '// \u{1f534} careful'],
    ['a check mark', '// ✅ done'],
    ['an arrow in emoji form', '// \u{27a1}\u{fe0f} next'],
    ['a keycap', '// 1\u{fe0f}\u{20e3} first'],
  ])('an emoji: %s', (_, comment) => {
    expect(countsOf(comment)).toEqual({ emoji: 1 });
  });

  it('counts each line past the tenth in a block of line comments', () => {
    expect(countsOf(lineComments(10))).toEqual({});
    expect(countsOf(lineComments(11))).toEqual({ 'long-comment': 1 });
    expect(countsOf(lineComments(14))).toEqual({ 'long-comment': 4 });
  });

  it('counts a long block comment the same way', () => {
    const body = Array.from({ length: 12 }, (_, i) => ` * sentence ${i + 1}`).join('\n');
    expect(countsOf(`/**\n${body}\n */\nexport const x = 1;`)).toEqual({ 'long-comment': 2 });
  });

  it('reports the line each finding is on', () => {
    const findings = analyseSource(`const a = 1;\n\n// one ${EM_DASH} two\n`, TEST_FILE);
    expect(findings.map(({ rule, line }) => ({ rule, line }))).toEqual([
      { rule: 'em-dash', line: 3 },
    ]);
  });
});

describe('the text a shipped package or a bench tool holds', () => {
  it.each([
    ['a shipped string', SHIPPED, "export const reason = 'too little is fixed (R80)';"],
    ['a shipped template literal', SHIPPED, 'export const reason = `${1}: see notes/STATE.md`;'],
    ['a string bench prints', BENCH, "console.log('unscanned (R141)');"],
  ])('an internal reference in %s', (_, file, source) => {
    expect(countsOf(source, file)).toEqual({ 'output-reference': 1 });
  });

  it.each([
    ['a shipped string', SHIPPED, `export const label = 'before ${EM_DASH} after';`],
    ['a shipped string, written as an escape', SHIPPED, "export const a = 'before \\u2014 after';"],
    ['a template literal bench prints', BENCH, `console.log(\`\${n} ${EM_DASH} \${m}\`);`],
  ])('an em dash in %s', (_, file, source) => {
    expect(countsOf(source, file)).toEqual({ 'output-em-dash': 1 });
  });

  it.each([
    ['a shipped string', SHIPPED, "export const label = '✅ done';"],
    ['a shipped string, written as escapes', SHIPPED, "export const a = '\\u26a0\\ufe0f careful';"],
    ['a string bench prints', BENCH, "console.log('\u{1f534} slow');"],
  ])('an emoji in %s', (_, file, source) => {
    expect(countsOf(source, file)).toEqual({ 'output-emoji': 1 });
  });
});

describe('what must not trip it', () => {
  it('a JSDoc opener and its gutter, including a bulleted list', () => {
    const source = '/**\n * Lists what it holds:\n * - one\n * * two\n */\nexport const x = 1;';
    expect(countsOf(source)).toEqual({});
  });

  it('a ruling-shaped name inside a URL', () => {
    const comment = '// https://developers.cloudflare.com/R2/ and https://example.com/issues/B15';
    expect(countsOf(comment)).toEqual({});
    const source = "export const docs = 'https://example.com/R2/ or https://example.com/R76b';";
    expect(countsOf(source, SHIPPED)).toEqual({});
  });

  it('names that only look like a ruling number', () => {
    const comment = '// RGB, sRGB and ARGB32, R/W access, and the droids R2D2 and R2d2';
    expect(countsOf(comment)).toEqual({});
  });

  it('an arrow, even one Unicode also counts as a pictograph, and the replacement character', () => {
    expect(countsOf('// a → b, c ↔ d, e ⬅ f, and a bad byte reads as \u{fffd}')).toEqual({});
    const source = "export const a = 'a → b ← c ↔ d ⇒ e, 3 × 4, 17–22%, \u{fffd} and so on…';";
    expect(countsOf(source, SHIPPED)).toEqual({});
  });

  it('a backticked identifier holding underscores or asterisks', () => {
    expect(countsOf('// `__dirname`, `**/*.test.ts` and `_private_` are code')).toEqual({});
  });

  it.each([
    [TEST_FILE],
    ['bench/src/demo.test.ts'],
    ['packages/demo/test/helpers.ts'],
    ['tools/demo.mjs'],
  ])('a dash, a ruling number or an emoji in a string or template literal of %s', (file) => {
    const source = [
      `const label = 'before ${EM_DASH} after';`,
      "const note = 'fixed in R184 ⚠';",
      `const text = \`\${label} ${EM_DASH} \${note}\`;`,
    ].join('\n');
    expect(countsOf(source, file)).toEqual({});
  });

  it('comment markers inside a string, a template literal or a regular expression', () => {
    const source = [
      "const url = 'http://example.com // **not** a comment R184';",
      `const pattern = /\\/\\/ also not ${EM_DASH} a comment R184/;`,
      'const text = `/* nor ${1 + 1} **this** */`;',
      `const ratio = 4 / 2; // a real comment ${EM_DASH} after division`,
    ].join('\n');
    expect(countsOf(source)).toEqual({ 'em-dash': 1 });
  });

  it('multiplication and globs written without backticks', () => {
    expect(countsOf('// width * height * 2, and src/**/*.ts beside lib/**/*.js')).toEqual({});
  });

  it('JSDoc API sections, however long', () => {
    const params = Array.from({ length: 8 }, (_, i) => ` * @param p${i} the value ${i}`);
    const example = [' * @example', ...Array.from({ length: 6 }, (_, i) => ` * run(${i});`)];
    const source = ['/**', ' * Runs it.', ...params, ...example, ' */'].join('\n');
    expect(countsOf(`${source}\nexport function run() {}`)).toEqual({});
  });
});

describe('the script itself', () => {
  const trees: string[] = [];
  afterEach(() => {
    for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
  });

  function tree(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'upfly-comment-check-'));
    trees.push(root);
    for (const [file, text] of Object.entries(files)) write(root, file, text);
    return root;
  }

  function write(root: string, file: string, text: string) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }

  function run(root: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it.each([
    ['internal-reference', BENCH, '// fixed in R184\nexport {};\n'],
    ['em-dash', BENCH, `// one ${EM_DASH} two\nexport {};\n`],
    ['emphasis', BENCH, '// this is **important**\nexport {};\n'],
    ['emoji', BENCH, '// \u{1f534} careful\nexport {};\n'],
    ['long-comment', BENCH, `${lineComments(11)}\nexport {};\n`],
    ['output-reference', SHIPPED, "export const reason = 'too open (R80)';\n"],
    ['output-reference', BENCH, "console.log('unscanned (R141)');\n"],
    ['output-em-dash', SHIPPED, `export const label = 'one ${EM_DASH} two';\n`],
    ['output-emoji', BENCH, "console.log('\u{1f534} slow');\n"],
    ['output-em-dash', 'packages/demo/AGENTS.md', `Run it ${EM_DASH} then stop.\n`],
    ['output-reference', 'packages/demo/skill/demo/SKILL.md', 'As ruled in R80.\n'],
    ['output-emoji', 'packages/demo/schema/demo.json', '{ "description": "\u{1f534} careful" }\n'],
  ])(
    'fails on one planted %s in %s, naming the rule, the file and the line',
    (rule, file, text) => {
      const { status, output } = run(tree({ [file]: text }));
      expect(status).toBe(1);
      expect(output).toContain('Comment check: 1 file with findings.');
      expect(output).toContain(`${file}: ${rule}, 1.`);
      expect(output).toMatch(/line \d+:/);
    },
  );

  it('reads the source files at the root, such as vitest.config.ts, but no other folder', () => {
    const planted = `// one ${EM_DASH} two\nexport {};\n`;
    const root = tree({
      'vitest.config.ts': planted,
      'docs/demo.ts': planted,
      'fixtures/site/demo.js': planted,
      'folder.mjs/notes.txt': 'a folder named like a source file\n',
    });
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('Comment check: 1 file with findings.');
    expect(output).toContain('vitest.config.ts: em-dash, 1.');
  });

  it("reads a package's own documents, but not a README it copies in when packed", () => {
    const root = tree({
      'packages/demo/AGENTS.md': 'Run **this** first, see https://example.com/R2/.\n',
      'packages/demo/README.md': `Copied from the root ${EM_DASH} not this package's.\n`,
      'packages/demo/schema/demo.json': '{ "pattern": "^[A-Z]:" }\n',
    });
    expect(run(root)).toEqual({
      status: 0,
      output: 'Comment check: 2 files checked, no findings.\n',
    });
  });

  it('passes a clean tree, and the inputs that must not trip it', () => {
    const root = tree({
      [SHIPPED]: [
        '/** Says what it is for. */',
        "export const label = 'a → b ↔ c, 17–22%, \u{fffd}, https://developers.cloudflare.com/R2/';",
        '// See https://developers.cloudflare.com/R2/ for `__dirname` and `**/*.ts`.',
        'export const x = 1;',
      ].join('\n'),
      'bench/src/demo.test.ts': `it('keeps R80 ${EM_DASH} as data', () => {});\n`,
    });
    expect(run(root)).toEqual({
      status: 0,
      output: 'Comment check: 2 files checked, no findings.\n',
    });
  });

  it('counts every finding of a rule in a file, and reads no baseline that excuses them', () => {
    const file = 'bench/src/old.ts';
    const root = tree({
      [file]: `// a ${EM_DASH} b ${EM_DASH} c\nexport {};\n`,
      'tools/comment-baseline.json': JSON.stringify({ files: { [file]: { 'em-dash': 2 } } }),
    });
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain(`${file}: em-dash, 2.`);
  });

  it.each([['--nope'], ['--update'], ['--baseline']])(
    'exits 2 on %s, which it does not know',
    (arg) => {
      expect(run(tree({}), arg)).toEqual({
        status: 2,
        output: `comment-check: unknown argument: ${arg}\n`,
      });
    },
  );
});
