/**
 * The CSS, SCSS and Less adapter: finds `url()` and `image-set()` references.
 *
 * Two parsers do the work rather than a regex. PostCSS says which ranges of the text are
 * real declarations, so a `url()` in a comment or a selector is never taken for one, and
 * `postcss-value-parser` splits a value into typed tokens with source offsets, so quoting,
 * nesting and escapes are handled for us.
 */

import postcss, { type AtRule, type Declaration, type Root } from 'postcss';
import lessParser from 'postcss-less';
import scssParser from 'postcss-scss';
import valueParser, { type Node as ValueNode } from 'postcss-value-parser';
import { UpflyError } from '../errors.js';
import { extensionOf } from '../paths.js';
import type { Adapter, RawReference } from '../types.js';
import { defineAdapter } from './define.js';
import { parseFailure } from './parse-failure.js';
import {
  ENCODED_BACKSLASH_REASON,
  NOT_GLOBBABLE_REASON,
  assembledPathIsGlobbable,
  holdsEncodedBackslash,
  interpolationChunks,
  isExternalUrl,
  plausiblePathShape,
  splitPathSuffix,
  templateExpressionReason,
} from './reference-path.js';
import type { ShapeId } from './shapes.js';

/**
 * Dialect parsers, by extension.
 *
 * SCSS and Less need their own parsers mainly for `//` line comments, which plain CSS
 * does not have: a `// url(old.png)` taken for a live reference would be rewritten inside
 * a comment. `.sass`, the indented syntax, is left out: its only parser is unmaintained,
 * and claiming support we cannot test is worse than not claiming it.
 */
const PARSERS: ReadonlyMap<string, (css: string) => Root> = new Map([
  ['.css', (css: string) => postcss.parse(css, { from: undefined })],
  ['.scss', (css: string) => scssParser.parse(css, { from: undefined })],
  ['.less', (css: string) => lessParser.parse(css, { from: undefined })],
]);

/**
 * Where the comments are in a stylesheet, as `[start, end)` offsets into `text`, read by the
 * same parser the adapter uses, so a `//` line counts as a comment only in SCSS and Less.
 *
 * @param extension the dialect, `.css`, `.scss` or `.less`
 * @returns the ranges, or `null` when the dialect is not one of those or the text does not
 * parse
 */
export function cssCommentRanges(
  text: string,
  extension: string,
): readonly (readonly [number, number])[] | null {
  const parse = PARSERS.get(extension);
  if (parse === undefined) return null;
  let root: Root;
  try {
    root = parse(text);
  } catch {
    return null;
  }
  const ranges: (readonly [number, number])[] = [];
  root.walkComments((comment) => {
    const start = comment.source?.start?.offset;
    const end = comment.source?.end?.offset;
    if (start !== undefined && end !== undefined) ranges.push([start, end]);
  });
  return ranges;
}

/** Function names whose direct string arguments are themselves image paths. */
function isImageSet(functionName: string): boolean {
  // `image-set`, plus the vendor-prefixed `-webkit-image-set` and `-ms-image-set`.
  return functionName === 'image-set' || functionName.endsWith('-image-set');
}

/**
 * Find the references in a run of stylesheet text.
 *
 * CSS also appears inside other formats (an HTML `<style>` element or `style=""`
 * attribute, an `.astro` style block, a CSS-in-JS template), and each gets the same
 * comment-aware, interpolation-aware reading as a `.css` file. PostCSS parses a bare
 * declaration list such as `background: url(a.png)` as readily as a stylesheet, so a
 * `style` attribute needs no wrapping.
 *
 * @throws {UpflyError} `ADAPTER_PARSE_FAILED` when the text does not parse, or when
 * `extension` is not `.css`, `.scss` or `.less`.
 */
export function findCssReferences(input: {
  readonly file: string;
  readonly text: string;
  /** Absolute offset of `text[0]` within the file. Defaults to 0. */
  readonly baseOffset?: number;
  /** Dialect to parse as. Defaults to plain CSS. */
  readonly extension?: string;
  /**
   * The shape a plain `url()` gets when this CSS is embedded in something else. Omitted
   * for a real stylesheet, where the dialect decides.
   *
   * A default, not an override: an `image-set()` or `@font-face` in the same block keeps
   * its own `css.*` shape, because it breaks the same way in every host.
   */
  readonly hostShape?: ShapeId;
  /**
   * Where `text` starts in its file, 1-based, when it is embedded in another file, so that a
   * parse failure names the file's line and column. Defaults to the start of the file.
   */
  readonly startsAt?: { readonly line: number; readonly column: number };
}): RawReference[] {
  const { file, text, baseOffset = 0, extension = '.css', hostShape, startsAt } = input;

  const parse = PARSERS.get(extension);
  if (parse === undefined) {
    throw new UpflyError(
      'ADAPTER_PARSE_FAILED',
      `The css adapter does not handle ${extension || 'files without an extension'} (${file}).`,
    );
  }

  let root: Root;
  try {
    root = parse(text);
  } catch (error) {
    // Returning [] would claim the file has no references, so the failure is thrown for
    // `scan` to report. The message leaves out the file name, which the report prints
    // beside it, and keeps PostCSS's position but not its wording.
    const failure = parseFailure({
      error,
      // What we tried to read it as, which is the dialect the extension claimed.
      dialect: extension.replace(/^\./, '') || 'css',
      position: 'postcss',
      ...(startsAt === undefined ? {} : { origin: startsAt }),
    });
    throw new UpflyError('ADAPTER_PARSE_FAILED', failure.message, [], failure.diagnostic);
  }

  const references: RawReference[] = [];
  const run: CssRun = { file, baseOffset, extension, hostShape, references };
  root.walkDecls((declaration) => {
    collectFromDeclaration(declaration, run);
  });
  // A second walk for Less variables. postcss-scss parses `$hero: '…'` as a declaration,
  // but postcss-less parses `@hero: '…'` as an at-rule, which `walkDecls` never visits.
  if (extension === '.less') {
    root.walkAtRules((atRule) => {
      collectFromVariableAtRule(atRule, run);
    });
  }

  // Document order already, but sorting makes determinism a property of the code
  // rather than of PostCSS's traversal order.
  return references.sort((a, b) => a.start - b.start);
}

export const cssAdapter: Adapter = defineAdapter({
  id: 'css',
  extensions: ['.css', '.scss', '.less'],

  findReferences({ file, text }): RawReference[] {
    return findCssReferences({ file, text, extension: extensionOf(file) });
  },
});

/**
 * PostCSS keeps the author's original text in `raws.<field>.raw` whenever it differs from
 * the cleaned-up value (a value containing a comment, for instance). The source offsets
 * are built from the original's length, so that is the one we want.
 */
function rawTextOf(raw: unknown, fallback: string): string {
  if (typeof raw === 'object' && raw !== null && 'raw' in raw) {
    const { raw: original } = raw as { raw: unknown };
    if (typeof original === 'string') return original;
  }
  return fallback;
}

/** What every emission in one stylesheet shares. */
interface CssRun {
  readonly file: string;
  readonly baseOffset: number;
  readonly extension: string;
  readonly hostShape: ShapeId | undefined;
  readonly references: RawReference[];
}

/** What one declaration adds: the things that decide a shape on their own. */
interface DeclarationContext {
  /** `--brand-image` means the url is reached through a custom property. */
  readonly property: string;
  /** `@font-face` bodies hold fonts, which are real files the engine never indexes. */
  readonly inFontFace: boolean;
  /**
   * A preprocessor variable declaration, `$hero: '/img/hero.jpg'` or
   * `@hero: "/img/hero.jpg"`. A bare quoted string is a path here, while in an ordinary
   * declaration such as `content: "note.png"` it is text. See
   * `collectVariableDeclarationString`.
   */
  readonly isVariableDeclaration: boolean;
}

function collectFromDeclaration(declaration: Declaration, run: CssRun): void {
  const { file } = run;
  const declarationStart = declaration.source?.start?.offset;
  if (declarationStart === undefined) {
    throw new UpflyError(
      'ADAPTER_PARSE_FAILED',
      `PostCSS returned a declaration without a source position in ${file}.`,
    );
  }

  // A declaration is laid out as `prop` + `between` + `value`, where `between` is
  // the colon and any surrounding whitespace or comments. Adding those lengths to
  // the declaration's own offset lands exactly on the first character of the value.
  const property = rawTextOf(declaration.raws.prop, declaration.prop);
  const between = declaration.raws.between ?? ':';
  const value = rawTextOf(declaration.raws.value, declaration.value);
  const valueStart = run.baseOffset + declarationStart + property.length + between.length;

  const parent = declaration.parent;
  const declarationContext: DeclarationContext = {
    property,
    inFontFace:
      parent !== undefined &&
      parent.type === 'atrule' &&
      (parent as { name?: string }).name?.toLowerCase() === 'font-face',
    // `$hero: '…'` reaches `walkDecls` as a declaration whose property starts with `$`.
    // Less's `@hero: '…'` is an at-rule instead, handled by `collectFromVariableAtRule`.
    isVariableDeclaration: run.extension === '.scss' && property.startsWith('$'),
  };

  collectFromValueNodes(valueParser(value).nodes, valueStart, run, declarationContext, {
    imageSet: 'none',
    nested: false,
  });
}

/**
 * Less's `@hero: '/img/hero.jpg'`, which the declaration walk never sees.
 *
 * postcss-less marks these `variable: true` and puts the text in both `params` and
 * `value`. The flag is checked rather than the shape of the name, so `@media`, `@import`
 * and `@font-face` cannot pass for one. The value starts after `@`, the name and
 * `afterName`, where postcss-less keeps the colon and the spacing around it; a test with
 * extra spacing checks that `source.slice(start, end) === rawPath` still holds.
 */
function collectFromVariableAtRule(atRule: AtRule, run: CssRun): void {
  const { variable, name, params } = atRule as AtRule & { variable?: boolean };
  if (variable !== true || params === '') return;

  const atRuleStart = atRule.source?.start?.offset;
  if (atRuleStart === undefined) {
    throw new UpflyError(
      'ADAPTER_PARSE_FAILED',
      `PostCSS returned an at-rule without a source position in ${run.file}.`,
    );
  }

  const afterName = atRule.raws.afterName ?? ':';
  const valueStart = run.baseOffset + atRuleStart + 1 + name.length + afterName.length;

  collectFromValueNodes(
    valueParser(params).nodes,
    valueStart,
    run,
    { property: `@${name}`, inFontFace: false, isVariableDeclaration: true },
    { imageSet: 'none', nested: false },
  );
}

/** Where in a value the url() sits, which the shape needs and the resolver does not. */
interface ValuePosition {
  /** Inside `image-set()`, and whether it was the vendor-prefixed spelling. */
  readonly imageSet: 'none' | 'standard' | 'webkit';
  /** Inside some other function, as in `linear-gradient(url(...))`. */
  readonly nested: boolean;
}

/**
 * Walk the token tree of one declaration value.
 *
 * A bare string is an image path inside `image-set("a.png" 1x, "b.png" 2x)` and, outside
 * any function, in a preprocessor variable declaration. Anywhere else it is just a string.
 */
function collectFromValueNodes(
  nodes: readonly ValueNode[],
  base: number,
  run: CssRun,
  declaration: DeclarationContext,
  position: ValuePosition,
): void {
  for (const node of nodes) {
    if (node.type === 'function') {
      const name = node.value.toLowerCase();
      if (name === 'url') {
        collectFromUrlFunction(node.nodes, base, run, declaration, position);
        continue;
      }
      // Recurse so that a `url()` inside, say, `linear-gradient()` is still found. Any
      // function but image-set counts as nesting, a shape of its own, because what breaks
      // there is the recursion itself.
      collectFromValueNodes(node.nodes, base, run, declaration, {
        imageSet: isImageSet(name) ? (name.startsWith('-') ? 'webkit' : 'standard') : 'none',
        nested: position.nested || !isImageSet(name),
      });
      continue;
    }

    if (node.type === 'string' && position.imageSet !== 'none') {
      // `sourceIndex` sits on the opening quote; the path starts one after it.
      addReference({
        text: node.value,
        start: base + node.sourceIndex + 1,
        run,
        declaration,
        position,
        quote: node.quote ?? '"',
      });
      continue;
    }

    if (node.type === 'string' && declaration.isVariableDeclaration && !position.nested) {
      collectVariableDeclarationString(node, base, run, declaration, position);
    }
  }
}

/**
 * A quoted path parked in a preprocessor variable, which is a reference to that file.
 *
 * Without this, `$hero: '/img/hero.jpg'` goes unread and only `url($hero)` is seen, which
 * is rightly `dynamic`. That protects the reference but not the file: named nowhere else,
 * it looks dead, and converting it would leave the variable naming a missing file. Like the
 * JavaScript adapter's path-shaped string literals, it is a guess (`asserted: false`), so
 * one that names nothing is `discarded` rather than reported `broken`.
 *
 * Only in variable declarations: elsewhere a quoted string is text (`content: "note.png"`).
 * Inside a function it is an argument, and the functions that take a path (`url`,
 * `image-set`) are read separately. See "The six that exist" in ARCHITECTURE.md.
 */
function collectVariableDeclarationString(
  node: ValueNode & { readonly sourceIndex: number; readonly quote?: string },
  base: number,
  run: CssRun,
  declaration: DeclarationContext,
  position: ValuePosition,
): void {
  const { path, suffix } = splitPathSuffix(node.value);
  // As in the JavaScript and JSON adapters, any file extension makes a candidate, and the
  // resolver decides which extensions are assets. `$dir: '/gallery'` has none.
  if (path === '' || extensionOf(path) === '' || isExternalUrl(node.value, 'string')) return;
  if (!plausiblePathShape(path)) return;

  addReference({
    text: path,
    suffix,
    // `sourceIndex` sits on the opening quote; the path starts one after it.
    start: base + node.sourceIndex + 1,
    run,
    declaration,
    position,
    quote: node.quote ?? '"',
    asserted: false,
  });
}

function collectFromUrlFunction(
  nodes: readonly ValueNode[],
  base: number,
  run: CssRun,
  declaration: DeclarationContext,
  position: ValuePosition,
): void {
  const argument = nodes.find((node) => node.type === 'string' || node.type === 'word');
  if (argument === undefined) return; // `url()` with nothing in it.

  addReference({
    text: argument.value,
    start: base + argument.sourceIndex + (argument.type === 'string' ? 1 : 0),
    run,
    declaration,
    position,
    // The quote character, not just whether there was one: `url('x')` and `url("x")`
    // are different shapes because they are different tokens to the parser.
    quote: argument.type === 'string' ? (argument.quote ?? '"') : '',
  });
}

/**
 * Which shape this url() is.
 *
 * The order follows the rule in `shapes.ts`: a shape names the narrowest thing whose
 * breakage would take out this reference alone. A mechanism CSS owns (interpolation,
 * image-set, a custom property, a nested function) wins over the host it is embedded in,
 * because it breaks the same way in a `.css` file and inside a `<style>` element. The host
 * decides only what is left.
 */
function shapeOf(input: {
  readonly rawPath: string;
  readonly run: CssRun;
  readonly declaration: DeclarationContext;
  readonly position: ValuePosition;
  readonly quote: string;
}): ShapeId {
  const { rawPath, run, declaration, position, quote } = input;
  const scss = run.extension === '.scss';

  // 1. Interpolation: the path is assembled, whatever host holds it. A leading
  //    interpolation varies the directory and a trailing one the name, so they are
  //    separate shapes.
  if (rawPath.includes('#{')) {
    return rawPath.startsWith('#{') ? 'scss.interpolation.leading' : 'scss.interpolation.trailing';
  }
  if (rawPath.includes('@{')) return 'less.interpolation';
  //    No `${}` rung. In CSS-in-JS the JavaScript adapter replaces each `${…}` with a
  //    same-length comment (`/theme-/*---*/.png`) before passing it here, then restores the
  //    text and applies `assembledPathIsGlobbable` itself (`withInterpolationRestored`),
  //    because only it knows which comments it wrote. In a stylesheet, `dynamicReason`
  //    reports a `${…}` as a template engine's.
  if (rawPath.startsWith('$')) return 'scss.variable';
  if (rawPath.startsWith('@')) return 'less.variable';

  // 2. Constructs CSS itself owns, in every host and every dialect.
  if (position.imageSet === 'webkit') return 'css.image-set.webkit';
  if (position.imageSet === 'standard') return 'css.image-set';
  if (declaration.inFontFace) return 'css.font-face';
  if (declaration.property.startsWith('--')) return 'css.var';
  if (position.nested) return 'css.url.nested';

  // 3. Embedded in something else: the host decides what is left.
  if (run.hostShape !== undefined) return run.hostShape;

  // 4. A real stylesheet: the dialect, then the quoting.
  if (scss) return 'scss.url';
  if (run.extension === '.less') return 'less.url';
  if (quote === "'") return 'css.url.single';
  if (quote === '"') return 'css.url.double';
  return 'css.url.bare';
}

/**
 * Whether a `#{…}` or `@{…}` path fixes enough to be globbed rather than given up on.
 *
 * A trailing interpolation varies the name inside a fixed directory and can be globbed; a
 * leading one varies the directory, and a glob would sweep in assets nobody referenced.
 * The rule is `assembledPathIsGlobbable`, shared with the JavaScript adapter.
 */
function interpolationIsGlobbable(rawPath: string): boolean {
  return assembledPathIsGlobbable(interpolationChunks(rawPath));
}

/** Whether a path carries a SCSS or Less interpolation. */
function isInterpolated(text: string): boolean {
  return text.includes('#{') || text.includes('@{');
}

/**
 * Why a path cannot be read as written, or `null` when it can be looked up or globbed.
 *
 * `quoted` matters because inside quotes a `(` is an ordinary character:
 * `url("/images/quote (blue).svg")` is a literal path, and reading it as a function call
 * would leave the file with no reference, reported dead. Spaces and parentheses are common
 * in the names non-developers give files. The other markers apply inside quotes too,
 * because interpolations and CSS-in-JS placeholders appear there routinely.
 */
function dynamicReason(rawPath: string, quoted: boolean): string | null {
  // Globbable interpolations return `null` so that `addReference` gives them a `medium`
  // ceiling rather than `unsafe`. `matchPattern` still decides whether the pattern names
  // any file, so this can add links but never turn a dynamic reference into a broken one.
  if (rawPath.includes('#{')) {
    return interpolationIsGlobbable(rawPath) ? null : `SCSS interpolation: ${NOT_GLOBBABLE_REASON}`;
  }
  if (rawPath.includes('@{')) {
    return interpolationIsGlobbable(rawPath) ? null : `Less interpolation: ${NOT_GLOBBABLE_REASON}`;
  }
  if (rawPath.startsWith('$')) return 'SCSS variable: the path is not known statically';
  if (rawPath.startsWith('@')) return 'Less variable: the path is not known statically';
  if (!quoted && rawPath.includes('(')) {
    return 'contains a function call: the path is not known statically';
  }
  // A comment inside a url token is never a literal path. It also stands in for a
  // CSS-in-JS interpolation: the JS adapter replaces every `${...}` with a comment
  // of exactly the same length, so `url(${bg})` arrives here as `url(/*-*/)`.
  if (rawPath.includes('/*')) return 'contains a comment or interpolation, not a literal path';
  if (rawPath.includes('\\')) return 'contains a CSS escape sequence';
  if (holdsEncodedBackslash(splitPathSuffix(rawPath).path)) return ENCODED_BACKSLASH_REASON;
  // A hole the dialect does not write, such as the Liquid `{{ site.baseurl }}` that Jekyll
  // fills in before Sass runs. Only SCSS and Less interpolations, above, can be globbed.
  return templateExpressionReason(rawPath);
}

/**
 * Text as CSS reads its escapes (CSS Syntax Level 3, "consume an escaped code point"): a
 * backslash and one to six hex digits, with one white space after them, is that code point, and
 * a backslash before any other character is that character, so `caf\e9 .png` names `café.png`.
 * Zero, a surrogate and a number past the last code point read as U+FFFD.
 */
function decodeCssEscapes(text: string): string {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|([^\n\r\f]))/g,
    (_match, hex: string | undefined, other: string | undefined) => {
      if (hex === undefined) return other ?? '';
      const code = Number.parseInt(hex, 16);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return String.fromCodePoint(valid ? code : 0xfffd);
    },
  );
}

function addReference(input: {
  text: string;
  start: number;
  run: CssRun;
  declaration: DeclarationContext;
  position: ValuePosition;
  /** The quote character the author used, or `''` for an unquoted url token. */
  quote: string;
  /**
   * Whether the author said this is an asset, as a `url()` does. A quoted string parked in
   * a preprocessor variable only looks like one, so `collectVariableDeclarationString`
   * passes `false`; every other caller takes the default, `true`. An unasserted path that
   * names nothing is `discarded`, while an asserted one is reported `broken`.
   */
  asserted?: boolean;
  /**
   * The `?query` or `#fragment` the caller already split off `text`, which a rewrite keeps.
   * Absent, `text` is split here.
   */
  suffix?: string;
}): void {
  const { text, start, run, declaration, position, quote } = input;
  const asserted = input.asserted ?? true;
  const { file, references } = run;
  if (text === '') return;
  if (isExternalUrl(text, 'css-url')) return;

  const shape = shapeOf({ rawPath: text, run, declaration, position, quote });
  // A construct CSS owns names the shape; the markup around it still decides the decoding.
  const hosted =
    run.hostShape !== undefined && shape !== run.hostShape ? { host: run.hostShape } : {};

  const reason = dynamicReason(text, quote !== '');
  if (reason !== null) {
    // Reported with its reason and never rewritten: guessing here could corrupt a file. A path
    // spelled with CSS escapes still names a file, so the path they decode to travels for the
    // name search to hedge by, as an escaped JavaScript string's does.
    const decoded = text.includes('\\') ? splitPathSuffix(decodeCssEscapes(text)).path : null;
    references.push({
      file,
      start,
      end: start + text.length,
      rawPath: text,
      ...(decoded === null ? {} : { assembledPath: decoded }),
      kind: 'css-url',
      shape,
      ...hosted,
      ceiling: 'unsafe',
      asserted,
      note: reason,
    });
    return;
  }

  // An interpolated path is kept whole, including any `?query` or `#fragment`;
  // `matchPattern` removes the suffix before globbing.
  const interpolated = isInterpolated(text);
  const split = interpolated ? { path: text, suffix: '' } : splitPathSuffix(text);
  const { path } = split;
  const suffix = input.suffix ?? split.suffix;
  if (path === '') return; // A bare `?query` names no file.

  // Every note that applies, in a fixed order, so that one never replaces another.
  const notes = [
    ...(asserted ? [] : ['a path-shaped string literal, guessed rather than asserted']),
    ...(suffix === '' ? [] : [`query or fragment preserved: ${suffix}`]),
  ];

  references.push({
    file,
    start,
    // The range covers the path only, so a rewrite keeps the author's `?v=2`.
    end: start + path.length,
    rawPath: path,
    kind: 'css-url',
    shape,
    ...hosted,
    // An interpolated path is `medium`, never `high`: at `high` the resolver would look
    // `/theme-#{$mode}.png` up verbatim and report a broken reference nobody wrote.
    ceiling: interpolated ? 'medium' : 'high',
    asserted,
    ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
  });
}
