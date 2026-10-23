#!/usr/bin/env node
// @ts-check
/**
 * Holds source files to the comment standard: one finding in any scanned file fails the check.
 * The documents a package ships for people and agents to read, its `AGENTS.md`, its skills and
 * its JSON schemas, are held to the rules for printed text, line by line.
 *
 * Comments and strings come from the TypeScript parser, so a `//` inside a string or a
 * regular expression is never read as a comment.
 *
 * Usage: `node tools/comment-check.mjs [--root <dir>]`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * @typedef {'internal-reference' | 'em-dash' | 'emphasis' | 'emoji' | 'long-comment'
 *   | 'output-reference' | 'output-em-dash' | 'output-emoji'} Rule
 * @typedef {{ rule: Rule, line: number, count: number, text: string }} Finding
 * @typedef {Partial<Record<Rule, number>>} Counts
 * @typedef {{ pos: number, end: number, kind: ts.CommentKind }} CommentRange
 */

/** What each rule catches, printed beside every failure. */
export const RULES = /** @type {const} */ ({
  'internal-reference':
    'a ruling number, plan section, phase, chat name or notes/ path in a comment. Write the fact itself; where it came from belongs in the commit message',
  'em-dash': 'an em dash in a comment. Use a comma, a colon, or two sentences',
  emphasis:
    'markdown bold or italics in a comment. Comments are plain text; backticks around code are fine',
  emoji: 'an emoji in a comment',
  'long-comment':
    'lines past the tenth in one comment block, not counting @param, @returns, @throws or @example sections. A design note belongs in ARCHITECTURE.md with a one-line pointer',
  'output-reference':
    'an internal reference in a string or document a package ships, or a string a bench tool prints. People read these; write the fact itself',
  'output-em-dash':
    'an em dash in a string or document a package ships, or a string a bench tool prints. Use a comma, a colon, or two sentences',
  'output-emoji':
    'an emoji in a string or document a package ships, or a string a bench tool prints',
});

/** @type {readonly Rule[]} */
const RULE_ORDER = /** @type {Rule[]} */ (Object.keys(RULES));

export const MAX_COMMENT_LINES = 10;

// Scanned directories, relative to the root. Each package under `packages/` adds its own.
const PACKAGE_DIRS = ['src', 'test'];
const OTHER_DIRS = ['bench/src', 'accuracy-suite/tools', 'tools'];
const SOURCE_EXTENSION = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '__snapshots__']);
// A package's own documents, relative to its folder. A README a package copies in from the
// repository's root when it is packed is not its own, so it is not here.
const DOCUMENT = /^packages\/[^/]+\/(?:AGENTS\.md|skill\/.+\.md|schema\/.+\.json)$/;

// URLs are removed before looking for references, so nothing inside a link counts as one.
export const URL_PATTERN = /\bhttps?:\/\/[^\s)>\]'"`]+/g;
export const INTERNAL_REFERENCE = new RegExp(
  [
    // A ruling number may end in a letter, or a hyphen and a letter; one that runs on into more
    // digits after the letter is a name.
    String.raw`\bR\d+(?:-?[a-z])?\b`,
    '§',
    // A stage name, but not Unicode's C1 controls (U+0080 to U+009F), which prose names.
    String.raw`\b(?:B\d{1,2}|C[1-4][ab]?)\b(?!\s+controls?\b)`,
    String.raw`\bnotes\/`,
    String.raw`\bparent chat\b`,
    String.raw`\b6a-[a-z]+\b`,
    String.raw`\bPhase \d+\b`,
  ].join('|'),
  'g',
);
const EM_DASH = /—/g;
// Arrows that Unicode also counts as pictographs are text unless written in emoji form, with
// U+FE0F after them; a keycap is a digit, `#` or `*` with U+20E3. U+FFFD is no pictograph.
const ARROWS = String.raw`\u{2190}-\u{21FF}\u{27A1}\u{2934}\u{2935}\u{2B05}-\u{2B07}`;
const EMOJI = new RegExp(
  String.raw`(?![${ARROWS}])\p{Extended_Pictographic}|[${ARROWS}]\u{FE0F}|[0-9#*]\u{FE0F}?\u{20E3}`,
  'gu',
);
// Bold and italics with either marker. A marker touching a word character, a slash or
// another marker does not count, which keeps `a*b`, `src/**/*.ts` and `snake_case` out.
const EMPHASIS = [
  /(?<![\w*/])\*\*(?![\s*/])[^\n]*?(?<![\s*/])\*\*(?![\w*/])/g,
  /(?<![\w_])__(?![\s_])[^\n]*?(?<![\s_])__(?![\w_])/g,
  /(?<![\w*/])\*(?![\s*/.])[^*\n]*?(?<![\s*/])\*(?![\w*/])/g,
  /(?<![\w_])_(?![\s_])[^_\n]*?(?<![\s_])_(?![\w_])/g,
];
const CODE_SPAN = /`[^`\n]*`/g;
// JSDoc sections that document an API rather than explain code. Their lines are exempt
// from the length rule until the next tag or the end of the block.
const API_TAG =
  /^@(?:param|typeParam|template|returns?|throws|example|see|default|defaultValue|deprecated|since)\b/;

/**
 * Finds every rule violation in one file's text.
 *
 * @param {string} text the file's contents
 * @param {string} file the path relative to the root, with POSIX separators
 * @returns {Finding[]} in source order; `count` says how many times the rule matched there
 */
export function analyseSource(text, file) {
  if (DOCUMENT.test(file)) return analyseDocument(text);
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const lineOf = (/** @type {number} */ pos) =>
    sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  /** @type {Finding[]} */
  const findings = [];
  /** @param {Rule} rule @param {number} line @param {number} count @param {string} content */
  const add = (rule, line, count, content) => {
    if (count > 0) findings.push({ rule, line, count, text: content });
  };

  const comments = commentRanges(sourceFile);
  for (const comment of comments) {
    const lines = commentLines(text.slice(comment.pos, comment.end), comment.kind);
    const firstLine = lineOf(comment.pos);
    lines.forEach((content, index) => {
      const line = firstLine + index;
      add(
        'internal-reference',
        line,
        matches(content.replace(URL_PATTERN, ' '), INTERNAL_REFERENCE),
        content,
      );
      add('em-dash', line, matches(content, EM_DASH), content);
      add('emoji', line, matches(content, EMOJI), content);
      const withoutCode = content.replace(CODE_SPAN, "'");
      const emphasis = EMPHASIS.reduce((sum, pattern) => sum + matches(withoutCode, pattern), 0);
      add('emphasis', line, emphasis, content);
    });
  }
  for (const block of commentBlocks(sourceFile, comments)) {
    const prose = proseLineCount(block.lines);
    add(
      'long-comment',
      block.line,
      prose - MAX_COMMENT_LINES,
      `a comment block of ${prose} lines, ${prose - MAX_COMMENT_LINES} past the limit`,
    );
  }
  if (printsText(file)) {
    for (const literal of stringLiterals(sourceFile)) {
      const line = lineOf(literal.getStart(sourceFile));
      add(
        'output-reference',
        line,
        matches(literal.text.replace(URL_PATTERN, ' '), INTERNAL_REFERENCE),
        literal.text,
      );
      add('output-em-dash', line, matches(literal.text, EM_DASH), literal.text);
      add('output-emoji', line, matches(literal.text, EMOJI), literal.text);
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Finds the printed-text findings in a document a package ships, line by line.
 *
 * @param {string} text the document's contents
 * @returns {Finding[]} in line order
 */
function analyseDocument(text) {
  /** @type {Finding[]} */
  const findings = [];
  text.split('\n').forEach((content, index) => {
    /** @type {[Rule, number][]} */
    const counts = [
      ['output-reference', matches(content.replace(URL_PATTERN, ' '), INTERNAL_REFERENCE)],
      ['output-em-dash', matches(content, EM_DASH)],
      ['output-emoji', matches(content, EMOJI)],
    ];
    for (const [rule, count] of counts) {
      if (count > 0) findings.push({ rule, line: index + 1, count, text: content });
    }
  });
  return findings;
}

/**
 * Totals findings per rule, leaving out rules with none.
 *
 * @param {readonly Finding[]} findings
 * @returns {Counts}
 */
export function countFindings(findings) {
  /** @type {Counts} */
  const counts = {};
  for (const { rule, count } of findings) counts[rule] = (counts[rule] ?? 0) + count;
  return counts;
}

/**
 * Lists the files in scope under `root`, as sorted POSIX-relative paths: the source files at
 * the root itself, such as `vitest.config.ts`, and every source file under the scanned
 * directories.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function filesInScope(root) {
  const configs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSION.test(entry.name))
    .map((entry) => entry.name);
  const files = scannedDirs(root).flatMap((dir) => {
    const absolute = path.join(root, dir);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
      .map((entry) => `${dir}/${entry.split(path.sep).join('/')}`)
      .filter(
        (relative) =>
          SOURCE_EXTENSION.test(relative) &&
          !relative.split('/').some((segment) => SKIPPED_DIRS.has(segment)),
      );
  });
  return [...configs, ...files, ...documentsIn(root)].sort(byCodeUnit);
}

/**
 * The documents each package ships for people and agents to read.
 *
 * @param {string} root
 * @returns {string[]}
 */
function documentsIn(root) {
  const packages = path.join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const base = `packages/${entry.name}`;
      const found = [`${base}/AGENTS.md`].filter((file) => existsSync(path.join(root, file)));
      for (const dir of ['skill', 'schema']) {
        const absolute = path.join(root, base, dir);
        if (!existsSync(absolute)) continue;
        for (const file of readdirSync(absolute, { recursive: true, encoding: 'utf8' })) {
          found.push(`${base}/${dir}/${file.split(path.sep).join('/')}`);
        }
      }
      return found.filter((relative) => DOCUMENT.test(relative));
    });
}

/**
 * Runs the check over a tree.
 *
 * @param {{ root: string }} options
 * @returns {{ exitCode: number, output: string }}
 */
export function run({ root }) {
  const files = filesInScope(root);
  /** @type {{ file: string, findings: Finding[] }[]} */
  const failing = [];
  for (const file of files) {
    const findings = analyseSource(readFileSync(path.join(root, file), 'utf8'), file);
    if (findings.length > 0) failing.push({ file, findings });
  }
  if (failing.length === 0) {
    return {
      exitCode: 0,
      output: `Comment check: ${plural(files.length, 'file')} checked, no findings.\n`,
    };
  }
  return { exitCode: 1, output: describeFindings(failing) };
}

/**
 * Each failing file's findings, grouped by rule, with the lines they are on.
 *
 * @param {readonly { file: string, findings: Finding[] }[]} failing
 */
function describeFindings(failing) {
  const lines = [`Comment check: ${plural(failing.length, 'file')} with findings.`];
  for (const { file, findings } of failing) {
    for (const rule of RULE_ORDER) {
      const found = findings.filter((finding) => finding.rule === rule);
      if (found.length === 0) continue;
      const count = found.reduce((sum, finding) => sum + finding.count, 0);
      lines.push('', `  ${file}: ${rule}, ${count}. ${RULES[rule]}.`);
      for (const finding of found.slice(0, 20)) {
        lines.push(`    line ${finding.line}: ${finding.text.trim().slice(0, 120)}`);
      }
      if (found.length > 20) lines.push(`    and ${found.length - 20} more`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The directories scanned: each package's `src` and `test`, then the fixed list.
 *
 * @param {string} root
 * @returns {string[]}
 */
function scannedDirs(root) {
  const packages = path.join(root, 'packages');
  if (!existsSync(packages)) return [...OTHER_DIRS];
  const perPackage = readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => PACKAGE_DIRS.map((dir) => `packages/${entry.name}/${dir}`));
  return [...perPackage, ...OTHER_DIRS];
}

/**
 * @param {readonly string[]} argv the arguments after the script's path
 * @returns {{ root: string } | string} the options, or a usage error
 */
export function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) return `${arg} needs a value`;
      root = path.resolve(value);
      i += 1;
    } else {
      return `unknown argument: ${arg}`;
    }
  }
  return { root };
}

/**
 * Every comment in a file. The ranges come from the trivia around each token the parser
 * produced, so text inside strings, template literals and regular expressions never counts.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {CommentRange[]}
 */
function commentRanges(sourceFile) {
  const text = sourceFile.text;
  /** @type {Map<number, CommentRange>} */
  const found = new Map();
  /** @type {(pos: number, end: number, kind: ts.CommentKind) => void} */
  const collect = (pos, end, kind) => {
    if (!found.has(pos)) found.set(pos, { pos, end, kind });
  };
  for (const token of tokensOf(sourceFile)) {
    if (token.kind !== ts.SyntaxKind.JsxText) {
      const start = token.pos === 0 ? (ts.getShebang(text) ?? '').length : token.pos;
      ts.forEachLeadingCommentRange(text, start, collect);
    }
    ts.forEachTrailingCommentRange(text, token.end, collect);
  }
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

/**
 * Every token of a file in source order, found without recursion so deep nesting cannot
 * overflow the stack. JSDoc nodes are skipped: their children are the comment's contents.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {ts.Node[]}
 */
function tokensOf(sourceFile) {
  /** @type {ts.Node[]} */
  const tokens = [];
  /** @type {ts.Node[]} */
  const stack = [sourceFile];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const kind = node.kind;
    if (kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode) continue;
    if (kind > ts.SyntaxKind.LastToken) {
      // A copy: `getChildren` returns the parser's cached array.
      stack.push(...[...node.getChildren(sourceFile)].reverse());
    } else if (node.pos !== node.end || kind === ts.SyntaxKind.EndOfFileToken) {
      tokens.push(node);
    }
  }
  return tokens;
}

/**
 * The text of each line of a comment, without its delimiters or the JSDoc gutter.
 *
 * @param {string} raw
 * @param {ts.CommentKind} kind
 * @returns {string[]}
 */
function commentLines(raw, kind) {
  if (kind === ts.SyntaxKind.SingleLineCommentTrivia) return [raw.replace(/^\/\/\/?/, '')];
  return raw
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*(?=\s|$)/, ''));
}

/**
 * Groups comments into blocks: each block comment alone, and each run of line comments on
 * consecutive lines that hold no code.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {readonly CommentRange[]} comments
 * @returns {{ line: number, lines: string[] }[]}
 */
function commentBlocks(sourceFile, comments) {
  const text = sourceFile.text;
  /** @type {{ line: number, lines: string[] }[]} */
  const blocks = [];
  /** @type {{ line: number, lines: string[] } | undefined} */
  let run;
  let runEndsOn = -1;
  for (const comment of comments) {
    const first = sourceFile.getLineAndCharacterOfPosition(comment.pos).line;
    const lines = commentLines(text.slice(comment.pos, comment.end), comment.kind);
    const lineStart = text.lastIndexOf('\n', comment.pos - 1) + 1;
    const alone = text.slice(lineStart, comment.pos).trim() === '';
    if (comment.kind === ts.SyntaxKind.SingleLineCommentTrivia && alone) {
      if (run && first === runEndsOn + 1) run.lines.push(...lines);
      else {
        run = { line: first + 1, lines: [...lines] };
        blocks.push(run);
      }
      runEndsOn = first;
      continue;
    }
    run = undefined;
    blocks.push({ line: first + 1, lines });
  }
  return blocks;
}

/**
 * Non-blank lines, leaving out the API sections of a JSDoc block.
 *
 * @param {readonly string[]} lines
 */
function proseLineCount(lines) {
  let inApiSection = false;
  let count = 0;
  for (const line of lines) {
    const content = line.trim();
    if (content.startsWith('@')) inApiSection = API_TAG.test(content);
    if (!inApiSection && content !== '') count += 1;
  }
  return count;
}

/**
 * @param {ts.SourceFile} sourceFile
 * @returns {(ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode)[]}
 */
function stringLiterals(sourceFile) {
  /** @type {(ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode)[]} */
  const literals = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literals.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

/** @param {string} text @param {RegExp} pattern a global pattern */
function matches(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

/**
 * A file whose strings people read: a package's own source, which ships, and a bench tool's,
 * which prints and writes the measurements. A test's strings are its data. @param {string} file
 */
function printsText(file) {
  return /^(?:packages\/[^/]+\/src|bench\/src)\//.test(file) && !/\.test\.[cm]?[jt]s$/.test(file);
}

/** @param {number} n @param {string} noun */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** @param {string} a @param {string} b */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`comment-check: ${options}\n`);
    process.exit(2);
  }
  const result = run(options);
  (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
  process.exit(result.exitCode);
}
