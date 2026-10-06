/**
 * The JavaScript, TypeScript and JSX adapter.
 *
 * Finds static `import`s, `require()`, dynamic `import()`, the bundler forms
 * `new URL('./x.png', import.meta.url)`, `import.meta.glob('./img/*.png')`,
 * `require.context('./img')` and `import.meta.webpackContext('./img')`, JSX `src`/`srcSet`/`poster`
 * on any element and every attribute position the HTML adapter reads (`url-attributes.ts`), and
 * `url()` inside CSS-in-JS template literals. Path-shaped strings, templates and `+` chains outside
 * those constructs become speculative candidates. One that a construct declines, such as the value
 * of a JSX attribute that names no file, is returned marked `declined` with the reason.
 *
 * It parses with `@babel/parser`, never a regular expression: a regex would find
 * `'./logo.png'` inside a comment or an unrelated string, and the rewrite would then edit it.
 */

import { parse } from '@babel/parser';
import type {
  Node as BabelNode,
  BinaryExpression,
  CallExpression,
  File,
  ImportDeclaration,
  ImportExpression,
  JSXAttribute,
  JSXOpeningElement,
  Program,
  StringLiteral,
  TaggedTemplateExpression,
  TemplateLiteral,
} from '@babel/types';
import { UpflyError } from '../errors.js';
import { extensionOf, isImageExtension } from '../paths.js';
import type {
  Adapter,
  BundlerContext,
  BundlerGlob,
  Confidence,
  RawReference,
  ReferenceKind,
} from '../types.js';
import { findCssReferences } from './css.js';
import { defineAdapter } from './define.js';
import { parseFailure } from './parse-failure.js';
import {
  ENCODED_BACKSLASH_REASON,
  NOT_GLOBBABLE_REASON,
  TEMPLATE_HOLE_PATTERN,
  URL_LINE_BREAK_REASON,
  assembledPathIsGlobbable,
  foreignTemplateExpressionReason,
  holdsEncodedBackslash,
  interpolationChunks,
  isDrivePath,
  isExternalUrl,
  parseSrcset,
  plausiblePathShape,
  provablyNotAFile,
  splitPathSuffix,
  staticExtensionOf,
  urlWithin,
} from './reference-path.js';
import { type ShapeId, whyFormatKept } from './shapes.js';
import { urlPosition } from './url-attributes.js';

/**
 * Which Babel plugins each extension needs.
 *
 * `.ts` and `.tsx` differ: in a `.ts` file `<string>value` is a type assertion, and in a
 * `.tsx` file it opens a JSX element. Enabling `jsx` everywhere would make valid
 * TypeScript unparseable.
 */
const TYPESCRIPT_PLUGINS: readonly string[] = ['typescript', 'decorators-legacy'];
const JAVASCRIPT_PLUGINS: readonly string[] = ['jsx', 'decorators-legacy'];

const PLUGINS_BY_EXTENSION: ReadonlyMap<string, readonly string[]> = new Map([
  ['.js', JAVASCRIPT_PLUGINS],
  ['.jsx', JAVASCRIPT_PLUGINS],
  ['.mjs', JAVASCRIPT_PLUGINS],
  ['.cjs', JAVASCRIPT_PLUGINS],
  ['.ts', TYPESCRIPT_PLUGINS],
  ['.mts', TYPESCRIPT_PLUGINS],
  ['.cts', TYPESCRIPT_PLUGINS],
  ['.tsx', [...TYPESCRIPT_PLUGINS, 'jsx']],
]);

/**
 * JSX attributes read on any element whatever its tag, matched case-insensitively, with the
 * shape each gives: a component such as `<Image>` hands them on to an `<img>`, so its name
 * says nothing. Every other position comes from the list the HTML adapter reads.
 */
const COMPONENT_URL_ATTRIBUTES: ReadonlyMap<string, ShapeId> = new Map([
  ['src', 'js.jsx.attribute'],
  ['srcset', 'js.jsx.srcset'],
  ['poster', 'js.jsx.attribute'],
]);

/**
 * React's spellings, lowercased, of attributes whose markup name differs. `xlinkHref` is
 * SVG 1.1's `xlink:href`, which shipped markup still commonly uses; written as markup
 * writes it, it arrives as a namespaced name and needs no entry.
 */
const REACT_SPELLINGS: ReadonlyMap<string, string> = new Map([['xlinkhref', 'xlink:href']]);

/**
 * Tag functions whose template literal contains CSS.
 *
 * Matched on the root identifier, so `styled.div`, `styled(Button)` and
 * `styled.div.attrs({})` all resolve to `styled`.
 */
const CSS_IN_JS_TAGS: ReadonlySet<string> = new Set([
  'styled',
  'css',
  'createGlobalStyle',
  'keyframes',
  'injectGlobal',
]);

export const javascriptAdapter: Adapter = defineAdapter({
  id: 'javascript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],

  findReferences({ file, text }): RawReference[] {
    return findJavaScriptReferences({ file, text, extension: extensionOf(file) });
  },
});

/**
 * Parse JavaScript or TypeScript and collect its image references.
 *
 * Exported for adapters that hold JavaScript inside another format, such as an `.astro`
 * frontmatter fence or the `import`/`export` blocks of an `.mdx` file. `file` stays the
 * host file's path, so every reference cites where a reader will find it, and `extension`
 * names the dialect to parse. Offsets index `text`, so a caller that blanks the rest of the
 * file with spaces, rather than slicing out the region, gets offsets into the original file.
 *
 * @throws {UpflyError} `ADAPTER_PARSE_FAILED` when `extension` is not a JavaScript
 * dialect or the text does not parse.
 */
export function findJavaScriptReferences(input: {
  readonly file: string;
  readonly text: string;
  /** Dialect to parse as, as a dotted extension. */
  readonly extension: string;
}): RawReference[] {
  {
    const { file, text, extension } = input;
    const plugins = PLUGINS_BY_EXTENSION.get(extension);
    if (plugins === undefined) {
      throw new UpflyError(
        'ADAPTER_PARSE_FAILED',
        `The javascript adapter does not handle ${extension || 'files without an extension'} (${file}).`,
      );
    }

    let ast: BabelNode;
    try {
      ast = parseWith(text, plugins);
    } catch (error) {
      // Returning [] would report a file we could not read as having no references, a
      // silent skip. The template sentence comes first because it says what a position
      // cannot: the file is not JavaScript at all. Otherwise the sentence is ours with
      // Babel's position, and Babel's own wording goes to the diagnostic, never the report.
      const template = templateSourceReason(text);
      const failure = parseFailure({ error, dialect: 'JavaScript', position: 'babel' });
      throw new UpflyError(
        'ADAPTER_PARSE_FAILED',
        // No file name: the report already prints the path before this message.
        template === null ? failure.message : `Could not parse: ${template}`,
        [],
        failure.diagnostic,
      );
    }

    const context: Context = {
      file,
      text,
      references: [],
      speculative: [],
      handled: new Map(),
      constantNamed: sameFileConstants((ast as File).program),
      chainParts: new Map(),
      attributeValues: [],
    };
    walk(ast, (node) => collectFromNode(node, context));

    // A guess whose range a construct already claimed is that construct's reference,
    // not a second one. Filtering after the walk keeps this independent of visit order.
    // A decline is read during the walk instead: the construct that declines a literal
    // contains it, and `walk` visits a node before its children.
    const claimed = new Set(context.references.map((reference) => reference.start));
    const guesses = context.speculative.filter((reference) => !claimed.has(reference.start));

    return [...context.references, ...guesses]
      .map((reference) => withPositionShape(reference, context))
      .sort((a, b) => a.start - b.start);
  }
}

/**
 * The one Babel call. `findJavaScriptReferences` and `javaScriptParseOutcome` both go
 * through it, so the question "does this parse?" can never be asked with different
 * options from the parse that then reads the references.
 */
function parseWith(text: string, plugins: readonly string[]): BabelNode {
  return parse(text, {
    // `unambiguous` reads both ESM and CommonJS without being told which a file is,
    // which no build config reliably says.
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: [...plugins] as never,
  });
}

/**
 * Where the comments are in JavaScript or TypeScript text, as `[start, end)` offsets, from
 * the same parse that reads the references.
 *
 * @param extension the dialect, as a dotted extension such as `.tsx`
 * @returns the ranges, or `null` when the extension is not a JavaScript dialect or the text
 * does not parse
 */
export function javaScriptCommentRanges(
  text: string,
  extension: string,
): readonly (readonly [number, number])[] | null {
  const plugins = PLUGINS_BY_EXTENSION.get(extension);
  if (plugins === undefined) return null;
  let ast: BabelNode;
  try {
    ast = parseWith(text, plugins);
  } catch {
    return null;
  }
  return ((ast as File).comments ?? []).map(
    (comment) => [comment.start ?? 0, comment.end ?? 0] as const,
  );
}

/**
 * Whether `text` parses, and when it does not, whether it stopped early rather than
 * being wrong.
 *
 * MDX ends a top-level `import`/`export` block at the first blank line, unless the code so
 * far is an unfinished prefix, in which case it swallows the blank line and carries on
 * (`micromark-extension-mdxjs-esm`). MDX parses with acorn, which reports an unfinished
 * template, comment or JSX body at the end of the input. Babel reports those where the
 * construct starts, so two signals are read: an unexpected token at the very end, or one
 * of `UNFINISHED_REASON_CODES`. An unterminated string is not among them: a string cannot
 * cross a line, so no further text completes it.
 */
export function javaScriptParseOutcome(
  text: string,
  extension: string,
): 'parses' | 'incomplete' | 'invalid' {
  const plugins = PLUGINS_BY_EXTENSION.get(extension);
  if (plugins === undefined) return 'invalid';
  try {
    parseWith(text, plugins);
    return 'parses';
  } catch (error) {
    const { pos, reasonCode } = error as { pos?: unknown; reasonCode?: unknown };
    if (typeof reasonCode === 'string' && UNFINISHED_REASON_CODES.has(reasonCode)) {
      return 'incomplete';
    }
    return typeof pos === 'number' && pos >= text.trimEnd().length ? 'incomplete' : 'invalid';
  }
}

/** Babel's names for a construct the input ended inside of. See `javaScriptParseOutcome`. */
const UNFINISHED_REASON_CODES: ReadonlySet<string> = new Set([
  'UnterminatedTemplate',
  'UnterminatedComment',
  'UnterminatedJsxContent',
]);

/**
 * Whether a file that will not parse is template source wearing a code extension: the
 * sentence saying so, or `null`.
 *
 * Eleventy includes snippets as text, so a `.js` file can hold Nunjucks that opens with
 * `{% raw %}`. Failing to parse it is correct, but "Unexpected token (1:1)" would tell the
 * reader their JavaScript is broken when the file was never JavaScript.
 *
 * Asked only after the parse has failed, and only of the first non-blank line: a `.js`
 * file that parses may legitimately hold `{%` in a string.
 */
function templateSourceReason(text: string): string | null {
  const firstLine =
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? '';

  for (const [opener, syntax] of TEMPLATE_OPENERS) {
    if (firstLine.startsWith(opener)) {
      return `this looks like ${syntax} template source rather than JavaScript (it begins with \`${opener}\`)`;
    }
  }
  return null;
}

/** Openers that mark a file as template source, and what to call each. */
const TEMPLATE_OPENERS: readonly (readonly [string, string])[] = [
  ['{%', 'Nunjucks, Jinja or Liquid'],
  ['{{', 'Handlebars, Mustache or Vue'],
  ['<%', 'EJS or ERB'],
  ['---', 'a frontmatter-prefixed'],
];

interface Context {
  readonly file: string;
  readonly text: string;
  readonly references: RawReference[];
  /**
   * Guesses: path-shaped strings, templates and `+` chains that no construct claimed.
   *
   * Kept apart until the walk finishes, so `findJavaScriptReferences` can drop any whose
   * range a construct claimed.
   */
  readonly speculative: RawReference[];
  /**
   * Literals a construct has examined, by the offset after the opening quote or backtick,
   * where a guess about the literal starts: `null` when the construct read the literal
   * itself, as the CSS reader reads a `styled.div` template, and the `Decline` when it
   * declined it. A decline is a decision, not an absence: `alt="/not.png"` is display text,
   * and the speculative rules must not overturn it.
   */
  readonly handled: Map<number, Decline | null>;
  /**
   * The value of a same-file constant a path is assembled from, or `null`. See
   * `sameFileConstants` for the one condition under which a name is read through.
   */
  readonly constantNamed: (name: string) => string | null;
  /**
   * The `+` nodes the chain rule must not read as chains of their own, and the chains a
   * construct declined. A chain nests down its left side, so the walk meets each inner node
   * after its outer one, and must not read it again as a second, shorter chain (`null`). A
   * chain in an attribute that names no file is here with its `Decline`.
   */
  readonly chainParts: Map<BabelNode, Decline | null>;
  /** Every JSX attribute value, so a path found inside one can take its shape. */
  readonly attributeValues: AttributeValue[];
}

/**
 * Why a construct declined a value it examined. A path-shaped value it declines is still
 * returned, marked `declined`, so the report can count it rather than lose it.
 */
interface Decline {
  /** What the report says of it: one wording per construct and name, so counts stay few. */
  readonly reason: string;
  /** The shape it is reported under, when not the one it would have as a guess. */
  readonly shape?: ShapeId;
}

/** The reason a path-shaped string written with escape sequences is declined. */
const ESCAPED_STRING: Decline = {
  reason: 'string written with escape sequences, whose text is not the path it spells',
};

/** A type-only import or re-export, which TypeScript erases, so the file it names never loads. */
const TYPE_ONLY: Decline = {
  reason: 'type-only import or export, which TypeScript erases, so it loads no file',
  shape: 'js.import.type',
};

/** Where one JSX attribute's value sits, and what it makes of a path found inside it. */
interface AttributeValue {
  readonly start: number;
  readonly end: number;
  /**
   * The attribute's shape when it keeps the file's format for a path with this text, or
   * `null` when a path found here keeps the shape it was found with.
   */
  readonly keptShape: (text: string) => ShapeId | null;
}

/** Keys that hold position or comment data rather than child nodes. */
const NON_CHILD_KEYS: ReadonlySet<string> = new Set([
  'loc',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra',
]);

function walk(node: unknown, visit: (node: BabelNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  if (typeof record.type === 'string') visit(node as BabelNode);

  for (const key of Object.keys(record)) {
    if (NON_CHILD_KEYS.has(key)) continue;
    walk(record[key], visit);
  }
}

function collectFromNode(node: BabelNode, context: Context): void {
  switch (node.type) {
    case 'ImportDeclaration':
      collectFromImportDeclaration(node, context);
      return;
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      if (node.exportKind === 'type' && node.source) declineValue(node.source, context, TYPE_ONLY);
      return;
    case 'ImportExpression':
      collectFromImportExpression(node, context);
      return;
    case 'CallExpression':
      if (isRequireCall(node)) {
        collectFromModuleSource(
          node.arguments[0],
          context,
          'certain',
          moduleSourceShape(node.arguments[0], 'js.require'),
          'require()',
          'import',
        );
      } else if (isImportMetaCall(node, 'glob')) {
        collectFromImportMetaGlob(node, context);
      } else if (isRequireContext(node)) {
        collectFromRequireContext(node, context);
      } else if (isImportMetaCall(node, 'webpackContext')) {
        collectFromWebpackContext(node, context);
      }
      return;
    case 'NewExpression':
      if (isBundlerUrlConstruction(node)) {
        // A URL, not a module specifier: the URL constructor resolves it against the module's
        // own URL, so a bare `hero.png` is the file beside the module. It takes an attribute's
        // kind, and the resolver reads it as Vite does (rungs 4a and 5b).
        // `import.meta.resolve(x)` follows module resolution instead.
        collectFromModuleSource(
          node.arguments[0],
          context,
          'high',
          'js.new-url',
          'new URL(…, import.meta.url)',
          'attr',
        );
      }
      return;
    case 'JSXOpeningElement':
      collectFromJsxElement(node, context);
      return;
    case 'TaggedTemplateExpression':
      collectFromTaggedTemplate(node, context);
      return;
    case 'StringLiteral':
      collectSpeculativeString(node, context);
      return;
    case 'TemplateLiteral':
      collectSpeculativeTemplate(node, context);
      return;
    case 'BinaryExpression':
      if (node.operator === '+') collectFromChain(node, context);
      return;
    default:
  }
}

/**
 * A path-shaped string literal that no construct above claimed, such as
 * `path: './_images/logo.png'` in an object literal. Emitted as a guess, as the JSON adapter
 * emits its strings: one that resolves becomes a link, and one that does not is discarded
 * and counted in the report. See "The six that exist" in ARCHITECTURE.md.
 */
function collectSpeculativeString(node: StringLiteral, context: Context): void {
  if (node.start === null || node.start === undefined) return;
  const decline = context.handled.get(node.start + 1);
  if (decline === null) return;
  const candidate = speculativeStringPath(node, context.text);
  if (candidate === null) {
    if (collectTemplatedString(node, context, decline)) return;
    collectEscapedString(node, context, decline);
    return;
  }
  const { start, path } = candidate;

  context.speculative.push(
    filed(
      {
        file: context.file,
        start,
        end: start + path.length,
        rawPath: path,
        kind: 'string',
        // Not `path.bare-specifier`, even for a bare string. Inside `import` or `require()` a
        // bare string is module-resolution syntax, but in an ordinary string
        // `src/assets/hero.png` is a relative path written without `./`, and a prefix test
        // would call `v2.0.0` and `bs.button` packages. Telling `some-ui-kit/dist/x.png` from
        // `src/assets/x.png` needs to know what is installed, which an adapter cannot see, so
        // `path.bare-specifier` lists this shape in `adapterEmitsAs`.
        shape: 'js.string.literal',
        ceiling: 'high',
        asserted: false,
        note: 'a path-shaped string literal, guessed rather than asserted',
      },
      decline,
    ),
  );
}

/**
 * A guessed string holding a hole another language's template fills in, such as
 * `'/img/photo-{{ n }}.png'`, returned unsafe with the hole's reason. No file has that name, so it
 * is never looked up, but the name search globs its fixed parts, and an image it could name is
 * hedged rather than called unused. Returns whether the string was one.
 */
function collectTemplatedString(
  node: StringLiteral,
  context: Context,
  decline: Decline | undefined,
): boolean {
  if (node.start === null || node.start === undefined) return false;
  if (node.end === null || node.end === undefined) return false;
  const start = node.start + 1;
  const raw = context.text.slice(start, node.end - 1);
  const reason = raw === node.value ? foreignTemplateExpressionReason(raw) : null;
  if (reason === null) return false;
  const { path } = splitPathSuffix(raw);
  const fixed = path.replace(new RegExp(TEMPLATE_HOLE_PATTERN, 'g'), '*');
  if (staticExtensionOf(path) === '' || !plausiblePathShape(fixed)) return false;

  context.speculative.push(
    filed(
      {
        file: context.file,
        start,
        end: start + path.length,
        rawPath: path,
        kind: 'string',
        shape: 'js.string.literal',
        ceiling: 'unsafe',
        asserted: false,
        note: `a path-shaped string literal, guessed rather than asserted: ${reason}`,
      },
      decline,
    ),
  );
  return true;
}

/**
 * A path-shaped string written with escape sequences, returned declined. Its decoded value
 * differs in length from its text, so no range would point at the path, and a guess is not
 * worth a reference no rewrite could edit. The range covers the text, and the decoded path
 * travels as `assembledPath`.
 */
function collectEscapedString(
  node: StringLiteral,
  context: Context,
  decline: Decline | undefined,
): void {
  if (node.start === null || node.start === undefined) return;
  if (node.end === null || node.end === undefined) return;
  const start = node.start + 1;
  const raw = context.text.slice(start, node.end - 1);
  if (raw === node.value) return;
  const path = stringCandidate(node.value);
  if (path === null) return;

  context.speculative.push(
    filed(
      {
        file: context.file,
        start,
        end: node.end - 1,
        rawPath: raw,
        assembledPath: path,
        kind: 'string',
        shape: 'js.string.literal',
        ceiling: 'unsafe',
        asserted: false,
      },
      decline ?? ESCAPED_STRING,
    ),
  );
}

/**
 * Where a string literal names a complete path on its own, or `null`.
 *
 * Shared with the chain reader, which leaves a `+` chain to any literal in it that is
 * already a complete path, so "complete path" means the same thing in both.
 */
function speculativeStringPath(
  node: StringLiteral,
  text: string,
): { readonly start: number; readonly path: string } | null {
  if (node.start === null || node.start === undefined) return null;
  if (node.end === null || node.end === undefined) return null;

  const start = node.start + 1;
  const raw = text.slice(start, node.end - 1);
  // An escaped string has no range that spells its path; `collectEscapedString` reports it.
  if (raw !== node.value) return null;

  const path = stringCandidate(raw);
  return path === null ? null : { start, path };
}

/**
 * The path a string's value names, its query or fragment left off, when the value is a
 * candidate at all, or `null`. Anything with a file extension is a candidate, the same bound
 * the JSON adapter uses: which extensions are assets is decided in one place, the resolver.
 */
function stringCandidate(value: string): string | null {
  const { path } = splitPathSuffix(value);
  if (path === '' || extensionOf(path) === '' || isExternalUrl(value, 'string')) return null;
  return plausiblePathShape(path) ? path : null;
}

/**
 * A guess as it is filed: unchanged, or, when a construct declined the literal it was read
 * from, marked `declined` under that construct's reason and shape. The `unsafe` ceiling
 * means nothing could glob or rewrite it even past the resolver's first rung.
 */
function filed(reference: RawReference, decline: Decline | undefined): RawReference {
  if (decline === undefined) return reference;
  return {
    ...reference,
    shape: decline.shape ?? reference.shape,
    ceiling: 'unsafe',
    note: decline.reason,
    declined: true,
  };
}

/**
 * A path-shaped template literal that no construct above claimed, emitted as a guess.
 *
 * Like any template it can carry a `medium` ceiling, so the resolver globs
 * `` `./_images/background-${dir}.png` `` and links every file it matches. No basename
 * sweep could find those files, because their names never appear in the source.
 */
function collectSpeculativeTemplate(node: TemplateLiteral, context: Context): void {
  if (node.start === null || node.start === undefined) return;
  const decline = context.handled.get(node.start + 1);
  if (decline === null) return;
  if (!pathShaped(templateChunks(node, context).chunks)) return;

  addTemplateReference(
    node,
    context,
    'string',
    templateShape(node, context),
    'a path-shaped template literal',
    false,
    decline,
  );
}

/**
 * Whether assembled static text looks like a path with a file extension: the bound on
 * every guess about a template or a `+` chain. `${x} items` is not a candidate.
 *
 * The extension must be in the static text. In `report.${type}` the hole is the
 * extension, and guessing there admits version strings and translation keys rather than
 * images. An asserting position such as `` <img src={`hero.${ext}`}> `` is not held to
 * this bound. For the shape test each hole is written `*`, which `plausiblePathShape`
 * accepts inside a path. See "Assembled paths in JavaScript" in ARCHITECTURE.md.
 */
function pathShaped(chunks: readonly string[]): boolean {
  return staticExtensionOf(chunks.join(HOLE)) !== '' && plausiblePathShape(chunks.join('*'));
}

/**
 * A template literal's static chunks (the text between its unknown segments), with every
 * hole a same-file constant fills written in.
 *
 * `traced` is whether any hole was filled, which is when the path the text proves differs
 * from the text itself, and so when a reference needs an `assembledPath`.
 */
function templateChunks(
  template: TemplateLiteral,
  context: Context,
): { readonly chunks: readonly string[]; readonly traced: boolean } {
  const chunks: string[] = [];
  let current = '';
  let traced = false;
  for (const [index, quasi] of template.quasis.entries()) {
    current += quasi.value.raw;
    const hole = template.expressions[index];
    if (hole === undefined) break;
    const value = hole.type === 'Identifier' ? context.constantNamed(hole.name) : null;
    if (value === null) {
      chunks.push(current);
      current = '';
    } else {
      current += value;
      traced = true;
    }
  }
  chunks.push(current);
  return { chunks, traced };
}

/**
 * A path assembled with `+`, read as its template twin is read, every test asked of the
 * assembled text. A complete path as the first operand (`'/img/hero.jpg' + '?v=' + v`) stays
 * the reference, so a rewrite can still edit it; one after it ends a longer path whose start
 * may be another host (`liveSite + '/img/hero.png'`), so the chain claims it. A template with
 * an unknown part is read on its own, as a pattern. A chain is a guess wherever it is read,
 * and one a construct declined is returned declined. The range runs from the first operand to
 * the last without their outer quotes, so `rawPath` is source text and the assembled path
 * travels as `assembledPath`. See "Assembled paths in JavaScript" in ARCHITECTURE.md.
 */
function collectFromChain(node: BinaryExpression, context: Context): void {
  const decline = context.chainParts.get(node);
  if (decline === null) return;
  const operands = chainOperands(node, context.chainParts);
  const [head, ...rest] = operands;
  if (head === undefined || standsAlone(head, context)) return;
  if (rest.some((operand) => isPatternOperand(operand, context))) return;
  const alone = rest.filter((operand) => standsAlone(operand, context));
  const claimed = alone.filter((operand) => namesAnImage(operand, context));
  // A path that names no image is read on its own by the string rule, so the chain is not.
  if (claimed.length === 0 && alone.length > 0) return;

  const chunks = chainChunks(operands, context);
  // A claimed literal is a path by itself, so the chain is a reference whatever its shape.
  if (claimed.length === 0 && !pathShaped(chunks)) return;

  const first = operands[0];
  const last = operands[operands.length - 1];
  if (first?.start === null || first?.start === undefined) return;
  if (last?.end === null || last?.end === undefined) return;
  const start = first.start + (isQuoted(first) ? 1 : 0);
  const end = last.end - (isQuoted(last) ? 1 : 0);
  const globbable = assembledPathIsGlobbable(chunks);

  addReference({
    context,
    start,
    end,
    rawPath: context.text.slice(start, end),
    assembledPath: chunks.join(HOLE),
    kind: 'string',
    shape: globbable ? 'js.concat.pattern' : 'js.concat.dynamic',
    ceiling: globbable ? 'medium' : 'unsafe',
    note: globbable
      ? 'a path assembled with +, with a static prefix; the resolver decides which assets it names'
      : `a path assembled with +: ${NOT_GLOBBABLE_REASON}`,
    skipPathChecks: true,
    asserted: false,
    decline,
  });
  // The chain holds these, so the string and template rules do not read them again alone.
  for (const operand of claimed) {
    if (typeof operand.start === 'number') context.handled.set(operand.start + 1, null);
  }
}

/** A chain's static text between its unknown operands, as `templateChunks` gives a template's. */
function chainChunks(operands: readonly BabelNode[], context: Context): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const operand of operands) {
    const value = operandText(operand, context);
    if (value === null) {
      chunks.push(current);
      current = '';
    } else {
      current += value;
    }
  }
  chunks.push(current);
  return chunks;
}

/**
 * Whether an operand's text names an image. Only such a path, after the first operand, is
 * claimed by its chain: one naming no image, such as `').callback('` in code built from
 * strings, is never rewritten, so it stays with the string rule.
 */
function namesAnImage(operand: BabelNode, context: Context): boolean {
  const text = operandText(operand, context);
  return text !== null && isImageExtension(extensionOf(splitPathSuffix(text).path));
}

/** Whether an operand is a template with an unknown part that is a path by itself: a pattern. */
function isPatternOperand(operand: BabelNode, context: Context): boolean {
  if (operand.type !== 'TemplateLiteral') return false;
  const { chunks } = templateChunks(operand, context);
  return chunks.length > 1 && pathShaped(chunks);
}

/**
 * How an unknown segment is written in an `assembledPath`. It must match one of
 * `INTERPOLATIONS`, which is how the resolver finds the unknown segments to glob.
 */
const HOLE = '${}';

/**
 * A chain's operands, left to right.
 *
 * `a + b + c` nests down its left side, so only that side is followed. A parenthesised
 * `+` is one operand, not more of the chain: in `'/img/' + (i + 1) + '.png'` the brackets
 * may be adding numbers.
 */
function chainOperands(node: BinaryExpression, parts: Map<BabelNode, Decline | null>): BabelNode[] {
  const operands: BabelNode[] = [node.right];
  let left: BabelNode = node.left;
  while (left.type === 'BinaryExpression' && left.operator === '+' && !isParenthesized(left)) {
    parts.set(left, null);
    operands.unshift(left.right);
    left = left.left;
  }
  operands.unshift(left);
  return operands;
}

function isParenthesized(node: BabelNode): boolean {
  return (node.extra as { parenthesized?: unknown } | undefined)?.parenthesized === true;
}

/** Whether an operand is, by itself, a path one of the other rules already reads. */
function standsAlone(operand: BabelNode, context: Context): boolean {
  if (operand.type === 'StringLiteral') {
    return speculativeStringPath(operand, context.text) !== null;
  }
  return operand.type === 'TemplateLiteral' && pathShaped(templateChunks(operand, context).chunks);
}

/**
 * What an operand contributes to the path's static text, or `null` for an unknown.
 *
 * A template with holes is one unknown here. The template rule reads it on its own, and
 * splitting it again inside the chain could only make the chain more globbable than its
 * template twin.
 */
function operandText(operand: BabelNode, context: Context): string | null {
  if (operand.type === 'StringLiteral') return operand.value;
  if (operand.type === 'TemplateLiteral') {
    return operand.expressions.length === 0
      ? operand.quasis.map((quasi) => quasi.value.raw).join('')
      : null;
  }
  return operand.type === 'Identifier' ? context.constantNamed(operand.name) : null;
}

function isQuoted(node: BabelNode): boolean {
  return node.type === 'StringLiteral' || node.type === 'TemplateLiteral';
}

/**
 * Same-file string constants a path may be read through, looked up on first use:
 * `const ASSET_BASE = '/gallery'` makes `` `${ASSET_BASE}/${name}.png` `` a pattern.
 *
 * A name is read only if it has exactly one binding anywhere in the file and that binding
 * is a top-level `const` initialised with a string. A top-level binding is visible
 * throughout the module, so with no other binding every use of the name is that constant,
 * and no scope analysis is needed. `let` and `var` are never read: their first value
 * proves nothing about a later use. See "Assembled paths in JavaScript" in ARCHITECTURE.md.
 *
 * Both lookups are lazy, because most files never ask: the top-level scan runs only when a
 * hole or operand is an identifier, the binding count only when it names such a constant.
 */
function sameFileConstants(program: Program): (name: string) => string | null {
  let declared: ReadonlyMap<string, string> | undefined;
  let bindings: ReadonlyMap<string, number> | undefined;
  return (name) => {
    declared ??= topLevelStringConstants(program);
    const value = declared.get(name);
    if (value === undefined) return null;
    bindings ??= bindingCounts(program);
    return bindings.get(name) === 1 ? value : null;
  };
}

function topLevelStringConstants(program: Program): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const { id, init } of declaration.declarations) {
      if (id.type === 'Identifier' && init?.type === 'StringLiteral') {
        constants.set(id.name, init.value);
      }
    }
  }
  return constants;
}

/**
 * How many times each name is bound anywhere in the file.
 *
 * Over-counting can only refuse a trace, so bindings in every scope count. Imports are not
 * visited: an imported name cannot also be a top-level `const`, which the parser rejects
 * as a redeclaration.
 */
function bindingCounts(program: Program): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  walk(program, (node) => {
    for (const name of boundNames(node)) counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  return counts;
}

function boundNames(node: BabelNode): readonly string[] {
  switch (node.type) {
    case 'VariableDeclarator':
      return patternNames(node.id);
    case 'CatchClause':
      return node.param === null || node.param === undefined ? [] : patternNames(node.param);
    case 'ClassDeclaration':
    case 'ClassExpression':
      return node.id === null || node.id === undefined ? [] : [node.id.name];
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      return [
        ...(node.id === null || node.id === undefined ? [] : [node.id.name]),
        ...node.params.flatMap(patternNames),
      ];
    case 'ArrowFunctionExpression':
    case 'ObjectMethod':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
      return node.params.flatMap(patternNames);
    default:
      return [];
  }
}

/** The names a declaration pattern or a parameter binds. */
function patternNames(pattern: BabelNode): readonly string[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        patternNames(property.type === 'RestElement' ? property.argument : property.value),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap((element) => (element === null ? [] : patternNames(element)));
    case 'AssignmentPattern':
      return patternNames(pattern.left);
    case 'RestElement':
      return patternNames(pattern.argument);
    case 'TSParameterProperty':
      return patternNames(pattern.parameter);
    default:
      return [];
  }
}

function collectFromImportDeclaration(node: ImportDeclaration, context: Context): void {
  // `import type { X } from './x'` is erased at compile time and never loads a file. Declined,
  // so the guessing rule neither links nor rewrites its path, and the report counts it.
  if (node.importKind === 'type') {
    declineValue(node.source, context, TYPE_ONLY);
    return;
  }
  collectFromModuleSource(
    node.source,
    context,
    'certain',
    moduleSourceShape(node.source, 'js.import.static'),
    'static import',
    'import',
  );
}

function collectFromImportExpression(node: ImportExpression, context: Context): void {
  collectFromModuleSource(
    node.source,
    context,
    'certain',
    moduleSourceShape(node.source, 'js.import.dynamic'),
    'dynamic import()',
    'import',
  );
}

function isRequireCall(node: BabelNode): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    node.arguments.length > 0
  );
}

/**
 * Whether this calls `import.meta.<name>(...)`, such as Vite's `import.meta.glob`, with type
 * arguments or without.
 */
function isImportMetaCall(node: CallExpression, name: 'glob' | 'webpackContext'): boolean {
  const { callee } = node;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'MetaProperty' &&
    callee.object.meta.name === 'import' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === name
  );
}

/**
 * Each pattern of an `import.meta.glob` call, read as Vite reads the call: one string or an
 * array of them, where a `!` pattern takes files out of every other. Vite refuses a call that
 * holds anything else, so such a call loads nothing and its strings are read as any string is.
 */
function collectFromImportMetaGlob(node: CallExpression, context: Context): void {
  const [first, options] = node.arguments;
  if (first === undefined) return;
  const patterns: BundlerLiteral[] = [];
  for (const element of first.type === 'ArrayExpression' ? first.elements : [first]) {
    // Vite skips an array's empty slot.
    if (element === null) continue;
    const pattern = bundlerLiteral(element, context.text);
    if (pattern === null) return;
    patterns.push(pattern);
  }

  const glob: BundlerGlob = {
    exclude: patterns.flatMap(({ value }) => (value.startsWith('!') ? [value.slice(1)] : [])),
    dot: optionIsTrue(options, 'exhaustive'),
  };
  for (const { start, end, text, value } of patterns) {
    context.handled.set(start, null);
    if (value.startsWith('!')) continue;
    // Vite globs the decoded value, which no range spells, so an escaped pattern is refused;
    // the decoded pattern still travels, so what it could name is hedged.
    const escaped = text !== value;
    context.references.push({
      file: context.file,
      start,
      end,
      rawPath: text,
      ...(escaped ? { assembledPath: value } : {}),
      kind: 'import',
      shape: 'js.import.meta.glob',
      ceiling: escaped ? 'unsafe' : 'medium',
      asserted: true,
      note: escaped
        ? 'import.meta.glob(): the pattern contains escape sequences, so its text cannot be located exactly'
        : 'import.meta.glob(): a glob the bundler expands when it builds; the resolver decides which assets it names',
      glob,
    });
  }
}

interface BundlerLiteral {
  readonly start: number;
  readonly end: number;
  /** The text as the file spells it. */
  readonly text: string;
  /** The text the bundler reads: a string's decoded value, a template's raw text. */
  readonly value: string;
}

/**
 * A string a bundler reads as it builds, a glob pattern or a context's directory: a string
 * literal, or a template literal with no expression.
 */
function bundlerLiteral(element: BabelNode, text: string): BundlerLiteral | null {
  if (typeof element.start !== 'number' || typeof element.end !== 'number') return null;
  const start = element.start + 1;
  const end = element.end - 1;
  const written = text.slice(start, end);
  if (element.type === 'StringLiteral') return { start, end, text: written, value: element.value };
  if (element.type === 'TemplateLiteral' && element.expressions.length === 0) {
    return { start, end, text: written, value: written };
  }
  return null;
}

/** Whether an options object literal sets `name` to the literal `true`. */
function optionIsTrue(options: BabelNode | undefined, name: string): boolean {
  if (options?.type !== 'ObjectExpression') return false;
  return options.properties.some(
    (property) =>
      property.type === 'ObjectProperty' &&
      !property.computed &&
      ((property.key.type === 'Identifier' && property.key.name === name) ||
        (property.key.type === 'StringLiteral' && property.key.value === name)) &&
      property.value.type === 'BooleanLiteral' &&
      property.value.value,
  );
}

/** Whether this is webpack's `require.context(...)`. */
function isRequireContext(node: CallExpression): boolean {
  const { callee } = node;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'require' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'context'
  );
}

/** Why a context call written with anything but literals is refused. */
const UNKNOWN_UNTIL_BUILT = 'so which files the bundler loads is known only when it builds';

/** Why an `import.meta.webpackContext` call whose options webpack cannot parse is refused. */
const OPTIONS_NOT_READ =
  'the options are not written as an object literal of plain names and values, the only form webpack reads';

/** What a call to one of webpack's context forms says about the files under its directory. */
interface ContextCall {
  readonly shape: 'js.require.context' | 'js.import.meta.webpackContext';
  /** The call as a reference's note names it. */
  readonly callee: string;
  readonly bundlerContext: BundlerContext;
  /** Why the call is refused for anything but its directory, or `null` when it is read whole. */
  readonly refusal: string | null;
}

/**
 * webpack's `require.context(directory, recursive, filter)`, read as webpack reads it: only
 * when it can work out a string, a boolean and a regular expression as it builds. The fourth
 * argument changes how the files load, not which.
 */
function collectFromRequireContext(node: CallExpression, context: Context): void {
  const [directory, recursive, filter] = node.arguments;
  collectFromContextCall(directory, context, {
    shape: 'js.require.context',
    callee: 'require.context()',
    bundlerContext: {
      recursive: recursive?.type === 'BooleanLiteral' ? recursive.value : true,
      ...(filter?.type === 'RegExpLiteral'
        ? { filter: { source: filter.pattern, flags: filter.flags } }
        : {}),
    },
    refusal:
      recursive !== undefined && recursive.type !== 'BooleanLiteral'
        ? `the second argument is not written as true or false, ${UNKNOWN_UNTIL_BUILT}`
        : filter !== undefined && filter.type !== 'RegExpLiteral'
          ? `the filter is not written as a regular expression literal, ${UNKNOWN_UNTIL_BUILT}`
          : null,
  });
}

/**
 * webpack's `import.meta.webpackContext(directory, options)`, the ES module form of
 * `require.context`: its `recursive` and `regExp` options decide the files as that call's
 * second and third arguments do, and the others change how the files load, not which.
 */
function collectFromWebpackContext(node: CallExpression, context: Context): void {
  const [directory, options] = node.arguments;
  collectFromContextCall(directory, context, {
    shape: 'js.import.meta.webpackContext',
    callee: 'import.meta.webpackContext()',
    ...webpackContextOptions(options),
  });
}

/**
 * What `import.meta.webpackContext`'s options say about the files it takes. An option not
 * read takes its widest reading, as a refused `require.context` argument does, and options
 * webpack cannot parse at all are read as none: every folder below, and every file.
 */
function webpackContextOptions(
  options: BabelNode | undefined,
): Pick<ContextCall, 'bundlerContext' | 'refusal'> {
  const named = options === undefined ? [] : namedOptions(options);
  if (named === null) return { bundlerContext: { recursive: true }, refusal: OPTIONS_NOT_READ };
  let recursive = true;
  let filter: BundlerContext['filter'];
  let refusal: string | null = null;
  for (const { name, value } of named) {
    if (name === 'recursive') recursive = value.type === 'BooleanLiteral' ? value.value : true;
    if (name === 'regExp') {
      filter =
        value.type === 'RegExpLiteral' ? { source: value.pattern, flags: value.flags } : undefined;
    }
    refusal ??= contextOptionRefusal(name, value);
  }
  return { bundlerContext: { recursive, ...(filter === undefined ? {} : { filter }) }, refusal };
}

/**
 * An options object literal as its `name: value` pairs, or `null` when it is anything else,
 * which webpack does not parse: a spread or a computed name could set any option.
 */
function namedOptions(
  options: BabelNode,
): readonly { readonly name: string; readonly value: BabelNode }[] | null {
  if (options.type !== 'ObjectExpression') return null;
  const named = options.properties.flatMap((property) =>
    property.type === 'ObjectProperty' && !property.computed && property.key.type === 'Identifier'
      ? [{ name: property.key.name, value: property.value }]
      : [],
  );
  return named.length === options.properties.length ? named : null;
}

/**
 * Why one of `import.meta.webpackContext`'s options refuses the call, or `null`. webpack
 * matches `include` and `exclude` against each file's absolute path as the system writes it,
 * so what they keep changes with where and on which system the project is built.
 */
function contextOptionRefusal(name: string, value: BabelNode): string | null {
  switch (name) {
    case 'recursive':
      return value.type === 'BooleanLiteral'
        ? null
        : `the \`recursive\` option is not written as true or false, ${UNKNOWN_UNTIL_BUILT}`;
    case 'regExp':
      return value.type === 'RegExpLiteral'
        ? null
        : `the \`regExp\` option is not written as a regular expression literal, ${UNKNOWN_UNTIL_BUILT}`;
    case 'include':
    case 'exclude':
      return `the \`${name}\` option is matched against each file's absolute path, which depends on where the project is built, ${UNKNOWN_UNTIL_BUILT}`;
    default:
      return null;
  }
}

/**
 * A context call's directory, as a reference. A call written with literals is a directory the
 * resolver lists. Any other is refused, and a literal directory travels with what the call
 * could read, so what it could take is hedged.
 */
function collectFromContextCall(
  directory: BabelNode | undefined,
  context: Context,
  call: ContextCall,
): void {
  if (directory === undefined) return;
  const written = bundlerLiteral(directory, context.text);
  if (written === null) {
    collectUnreadContextDirectory(directory, context, call);
    return;
  }

  context.handled.set(written.start, null);
  // webpack reads the decoded directory, which no range spells, as Vite reads a glob.
  const escaped = written.text !== written.value;
  const refusal = escaped
    ? 'the directory contains escape sequences, so its text cannot be located exactly'
    : call.refusal;
  context.references.push({
    file: context.file,
    start: written.start,
    end: written.end,
    rawPath: written.text,
    ...(escaped ? { assembledPath: written.value } : {}),
    kind: 'import',
    shape: call.shape,
    ceiling: refusal === null ? 'medium' : 'unsafe',
    asserted: true,
    note: `${call.callee}: ${refusal ?? 'a directory the bundler loads files from when it builds; the resolver decides which assets it names'}`,
    bundlerContext: call.bundlerContext,
  });
}

/**
 * A context whose directory is not a literal, reported as the argument's text. No one
 * directory stands for it, so it is refused whole and no folder's images are hedged by it.
 */
function collectUnreadContextDirectory(
  directory: BabelNode,
  context: Context,
  call: ContextCall,
): void {
  if (typeof directory.start !== 'number' || typeof directory.end !== 'number') return;
  // The template is the call's argument, not a guess of its own.
  if (directory.type === 'TemplateLiteral') context.handled.set(directory.start + 1, null);
  context.references.push({
    file: context.file,
    start: directory.start,
    end: directory.end,
    rawPath: context.text.slice(directory.start, directory.end),
    kind: 'import',
    shape: call.shape,
    ceiling: 'unsafe',
    asserted: true,
    unread: true,
    note: `${call.callee}: the directory is not written as a string, ${UNKNOWN_UNTIL_BUILT}`,
  });
}

/**
 * Whether this is `new URL('./x.png', import.meta.url)`.
 *
 * The second argument is required rather than optional: with it, this is the
 * bundler-resolved asset pattern that Vite and webpack 5 both document. Without it,
 * `new URL('/x.png')` is an ordinary runtime URL and not a build-time reference.
 */
function isBundlerUrlConstruction(node: BabelNode): boolean {
  if (node.type !== 'NewExpression') return false;
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'URL') return false;

  const [, second] = node.arguments;
  return (
    second !== undefined &&
    second.type === 'MemberExpression' &&
    second.object.type === 'MetaProperty' &&
    second.property.type === 'Identifier' &&
    second.property.name === 'url'
  );
}

/**
 * Read or decline every attribute of one JSX element.
 *
 * An attribute is read when the component rule or a position in `url-attributes.ts` claims
 * it, the list the HTML adapter reads, so a component names a file exactly where a page
 * does. Every other value is recorded as examined, however it is written:
 * `` alt={`/hero.png`} `` is display text as much as `alt="/hero.png"` is. Decided at the
 * element, because a claim such as a `<link>`'s `rel` reads the attributes beside the one
 * it judges. Each value is also noted with the same claim, for `withPositionShape`, which
 * judges path by path a value that a claim reading the value's text cannot judge whole.
 */
function collectFromJsxElement(node: JSXOpeningElement, context: Context): void {
  const tag = node.name.type === 'JSXIdentifier' ? node.name.name.toLowerCase() : '';
  const attributes = node.attributes.filter(
    (attribute): attribute is JSXAttribute => attribute.type === 'JSXAttribute',
  );
  const other = (name: string): string | undefined => {
    const found = attributes.find((attribute) => markupName(attribute) === name);
    return found === undefined ? undefined : jsxStringValue(found.value);
  };

  for (const attribute of attributes) {
    const name = markupName(attribute);
    const component = COMPONENT_URL_ATTRIBUTES.get(name);
    // The shape this attribute gives a path whose text `valueText` reads: the value's own
    // text here, or later the text of a path found inside the value.
    const shapeFor = (valueText: () => string | null): ShapeId | undefined =>
      component ?? urlPosition(tag, name, { attribute: other, valueText })?.jsx;
    noteAttributeValue(attribute, shapeFor, context);

    let askedForText = false;
    const shape = shapeFor(() => {
      askedForText = true;
      return jsxValueText(attribute.value, context);
    });
    if (shape === undefined) {
      // A claim that reads the value's text, such as a link's, cannot judge a value with no
      // text of its own, such as a choice between two links. Each path found inside it is
      // judged by the claim after the walk, as a call's argument is.
      if (askedForText && jsxValueText(attribute.value, context) === null) continue;
      const value = attribute.value;
      declineValue(value?.type === 'JSXExpressionContainer' ? value.expression : value, context, {
        reason: `JSX attribute ${jsxAttributeName(attribute)}, which Upfly does not read as a file path on this element`,
        shape: 'js.jsx.attribute.other',
      });
      continue;
    }

    const written = jsxAttributeName(attribute);
    addJsxAttributeValue(
      attribute.value,
      context,
      shape,
      component === undefined ? `JSX <${tag}> ${written}` : `JSX ${written}`,
      // `srcSet` holds a candidate list, not a path. Left unsplit it produces two false
      // positives at once: the whole string resolves to nothing, and every image in it but
      // the first gains no reference and looks dead.
      shape === 'js.jsx.srcset',
    );
  }
}

/** Note where an attribute's value sits and what it makes of a path found inside it. */
function noteAttributeValue(
  attribute: JSXAttribute,
  shapeFor: (valueText: () => string | null) => ShapeId | undefined,
  context: Context,
): void {
  const { value } = attribute;
  if (typeof value?.start !== 'number' || typeof value.end !== 'number') return;
  context.attributeValues.push({
    start: value.start,
    end: value.end,
    keptShape: (text) => {
      const shape = shapeFor(() => text);
      return shape !== undefined && whyFormatKept(shape) !== null ? shape : null;
    },
  });
}

/**
 * A reference found inside an attribute value that keeps the file's format, given that
 * attribute's shape: in `content={absolute('/og.png')}` the path is a guess inside a call,
 * and under a guess's shape `optimize` could repoint a link preview. The innermost value
 * decides, so a nested `<img src>` keeps its own shape, and a link asks its claim of each
 * path found, so a document inside one keeps the shape it was found with.
 */
function withPositionShape(reference: RawReference, context: Context): RawReference {
  // A declined value keeps the shape of the construct that declined it.
  if (reference.declined === true) return reference;
  let innermost: AttributeValue | undefined;
  for (const value of context.attributeValues) {
    const inside = value.start <= reference.start && reference.end <= value.end;
    if (inside && (innermost === undefined || value.start > innermost.start)) innermost = value;
  }
  const shape = innermost?.keptShape(reference.assembledPath ?? reference.rawPath) ?? null;
  return shape === null ? reference : { ...reference, shape };
}

/** An attribute's name as markup spells it, lowercased, with React's spellings mapped. */
function markupName(attribute: JSXAttribute): string {
  const name = jsxAttributeName(attribute).toLowerCase();
  return REACT_SPELLINGS.get(name) ?? name;
}

/** A JSX attribute's value when it is a plain string, written bare or in braces. */
function jsxStringValue(value: JSXAttribute['value']): string | undefined {
  if (value?.type === 'StringLiteral') return value.value;
  if (value?.type === 'JSXExpressionContainer' && value.expression.type === 'StringLiteral') {
    return value.expression.value;
  }
  return undefined;
}

/**
 * A JSX value as the static text a claim reads, each unknown part written `${}`: a string,
 * or a template literal. `null` for anything else, a `+` chain or a choice included, since
 * no one text stands for it. The text leaves out the whitespace around the value, as the URL
 * parser does (`urlWithin`), so a line break before the closing quote hides no extension.
 */
function jsxValueText(value: JSXAttribute['value'], context: Context): string | null {
  const text = jsxStringValue(value);
  if (text !== undefined) return urlWithin(text, 0).text;
  if (value?.type === 'JSXExpressionContainer' && value.expression.type === 'TemplateLiteral') {
    return urlWithin(templateChunks(value.expression, context).chunks.join(HOLE), 0).text;
  }
  return null;
}

/**
 * Emit a reference for a JSX attribute value, whatever shape it takes.
 *
 * Every position the element pass reads comes through here, so each kind of value is read
 * the same way wherever it sits.
 */
function addJsxAttributeValue(
  value: JSXAttribute['value'],
  context: Context,
  shape: ShapeId,
  label: string,
  isSrcSet: boolean,
): void {
  if (value === null || value === undefined) return;

  if (value.type === 'StringLiteral') {
    addLiteralReference(value, context, 'high', 'attr', shape, label, isSrcSet);
    return;
  }

  if (value.type === 'JSXExpressionContainer') {
    const expression = value.expression;
    if (expression.type === 'StringLiteral') {
      addLiteralReference(expression, context, 'high', 'attr', shape, label, isSrcSet);
      return;
    }
    // A position that keeps the file's format keeps its shape on a template too: the shape
    // is where the planner reads that the reference is never rewritten, and a template's
    // own shape says nothing of it.
    const formatKept = whyFormatKept(shape) !== null;
    if (expression.type === 'TemplateLiteral') {
      const templated = formatKept ? shape : templateShape(expression, context);
      addTemplateReference(expression, context, 'attr', templated, label);
      return;
    }
    // Anything else (an identifier, a call, a choice, a `+` chain) is not read as a path
    // here. Literals inside it still reach the speculative rules, and an import behind it
    // is read on its own. Where the format is kept, each path found inside takes this
    // position's shape after the walk (`withPositionShape`), so none is rewritten.
  }
}

/** The attribute's written name, including a namespace such as `xlink:href`. */
function jsxAttributeName(attribute: JSXAttribute): string {
  const name = attribute.name;
  if (name.type === 'JSXIdentifier') return name.name;
  return `${name.namespace.name}:${name.name.name}`;
}

/**
 * Record a value's string and template literals and its `+` chains as declined, through any
 * choice between values, so the speculative rules return each path-shaped one declined
 * rather than as a guess. A function, call, object or array ends the search: a component
 * can pass it on as data, as `images={['/img/a.png']}` does.
 */
function declineValue(
  node: BabelNode | null | undefined,
  context: Context,
  decline: Decline,
): void {
  if (node === null || node === undefined || typeof node.start !== 'number') return;
  switch (node.type) {
    case 'StringLiteral':
    case 'TemplateLiteral':
      context.handled.set(node.start + 1, decline);
      return;
    case 'BinaryExpression':
      if (node.operator !== '+') return;
      context.chainParts.set(node, decline);
      declineValue(node.left, context, decline);
      declineValue(node.right, context, decline);
      return;
    case 'ConditionalExpression':
      declineValue(node.consequent, context, decline);
      declineValue(node.alternate, context, decline);
      return;
    case 'LogicalExpression':
      declineValue(node.left, context, decline);
      declineValue(node.right, context, decline);
      return;
    default:
  }
}

/**
 * Handle an import/require/URL argument, which may be a string or a template.
 *
 * @param kind `import` for a module specifier, `attr` for a URL. Required, because the two
 *   read a bare name and a leading `#` differently.
 */
function collectFromModuleSource(
  source: BabelNode | null | undefined,
  context: Context,
  ceiling: Confidence,
  shape: ShapeId,
  description: string,
  kind: ReferenceKind,
): void {
  if (source === null || source === undefined) return;
  if (source.type === 'StringLiteral') {
    addLiteralReference(source, context, ceiling, kind, shape, description);
    return;
  }
  if (source.type === 'TemplateLiteral') {
    addTemplateReference(source, context, kind, shape, description);
  }
}

function collectFromTaggedTemplate(node: TaggedTemplateExpression, context: Context): void {
  // The body is the tag's input, not a path, whatever the tag. A CSS tag's body is read
  // below; any other tag's is declined, and returned declined if it is path-shaped.
  const css = CSS_IN_JS_TAGS.has(rootIdentifierName(node.tag) ?? '');
  if (typeof node.quasi.start === 'number') {
    context.handled.set(node.quasi.start + 1, css ? null : taggedTemplateDecline(node, context));
  }
  if (!css) return;

  const flattened = flattenTemplate(node.quasi, context.text);
  if (flattened === null) return;

  try {
    context.references.push(
      ...findCssReferences({
        file: context.file,
        text: flattened.text,
        baseOffset: flattened.start,
        // SCSS rather than plain CSS, because styled-components nest rules as SCSS does.
        extension: '.scss',
        // The host shape wins over the dialect: what would break these is the template
        // flattening, not SCSS parsing.
        hostShape: 'js.cssinjs',
      }).map((reference) => withInterpolationRestored(reference, context.text)),
    );
  } catch {
    // A template whose CSS does not parse is usually one built from fragments.
    // Report it rather than dropping it, and never rewrite it.
    context.references.push({
      file: context.file,
      start: flattened.start,
      end: flattened.start + flattened.text.length,
      rawPath: flattened.text,
      kind: 'css-url',
      shape: 'js.cssinjs',
      ceiling: 'unsafe',
      asserted: false,
      unread: true,
      note: 'CSS-in-JS template could not be parsed as CSS, so it was left alone',
    });
  }
}

/** Why a template given to a tag other than a CSS one is declined, naming the tag as written. */
function taggedTemplateDecline(node: TaggedTemplateExpression, context: Context): Decline {
  const { start, end } = node.tag;
  const written =
    typeof start === 'number' && typeof end === 'number' ? context.text.slice(start, end) : '';
  // A plain or dotted name, such as `t` or `String.raw`; anything longer is not quoted.
  return /^[\w$]+(?:\.[\w$]+)*$/.test(written)
    ? { reason: `template literal tagged ${written}, whose text Upfly leaves to that function` }
    : {
        reason:
          'template literal given to a tag function, whose text Upfly leaves to that function',
      };
}

/**
 * Give a CSS-in-JS `url()` back the path the file holds, and let the shared glob rule
 * decide what an interpolated one is.
 *
 * The CSS pass reads the flattened template, where each `${…}` is a comment, and calls
 * such a `url()` dynamic. Only this adapter knows which comments are its own placeholders,
 * so it puts the source text back as `rawPath` whether or not the path globs: that keeps
 * `source.slice(start, end) === rawPath` and lets the resolver read the `${…}`. It then
 * asks `assembledPathIsGlobbable`, as for every template literal in the file.
 */
function withInterpolationRestored(reference: RawReference, text: string): RawReference {
  const source = text.slice(reference.start, reference.end);
  if (source === reference.rawPath) return reference;

  const restored = { ...reference, rawPath: source };
  const chunks = interpolationChunks(source);
  if (chunks.length < 2 || !assembledPathIsGlobbable(chunks)) return restored;
  return {
    ...restored,
    // Shaped as a template pattern: the glob rule is what can fail here, as for any
    // template literal in the file.
    shape: 'js.template.pattern',
    ceiling: 'medium',
    note: 'CSS-in-JS url() with a static prefix; the resolver decides which assets it names',
  };
}

/** Walk down `styled.div.attrs({})` and friends to the identifier at the root. */
function rootIdentifierName(node: BabelNode): string | null {
  let current: BabelNode = node;
  for (;;) {
    if (current.type === 'Identifier') return current.name;
    if (current.type === 'MemberExpression') {
      current = current.object;
      continue;
    }
    if (
      (current.type === 'CallExpression' || current.type === 'NewExpression') &&
      current.callee.type !== 'V8IntrinsicIdentifier'
    ) {
      current = current.callee;
      continue;
    }
    return null;
  }
}

/**
 * Turn a template literal into one run of text whose offsets still line up with the file.
 *
 * Every `${…}` becomes a CSS comment of the same length, so the CSS stays parseable and
 * every offset after it is unchanged. The shortest expression, `${x}`, is four characters,
 * and so is the shortest comment, so nothing ever has to shrink. A comment rather than a
 * SCSS interpolation, because a mixin such as `${baseStyles}` at statement level is common
 * and `#{…}` fails to parse there. The CSS adapter treats a `url()` holding `/*` as
 * dynamic, so an interpolated path is never taken for a literal one, and
 * `withInterpolationRestored` then decides whether it globs. See "The six that exist" in
 * ARCHITECTURE.md.
 */
function flattenTemplate(
  template: TemplateLiteral,
  text: string,
): { text: string; start: number } | null {
  const first = template.quasis[0];
  const last = template.quasis[template.quasis.length - 1];
  if (first?.start === null || first?.start === undefined) return null;
  if (last?.end === null || last?.end === undefined) return null;

  const start = first.start;
  const end = last.end;
  let flattened = '';
  let cursor = start;

  for (const quasi of template.quasis) {
    if (quasi.start === null || quasi.start === undefined) return null;
    if (quasi.end === null || quasi.end === undefined) return null;

    if (quasi.start > cursor) {
      // The gap between two quasis is exactly the `${…}` span.
      flattened += placeholderOfLength(quasi.start - cursor);
    }
    flattened += text.slice(quasi.start, quasi.end);
    cursor = quasi.end;
  }

  return flattened.length === end - start ? { text: flattened, start } : null;
}

function placeholderOfLength(length: number): string {
  if (length < 4) return ' '.repeat(length);
  return `/*${'-'.repeat(length - 4)}*/`;
}

/**
 * The shape of a module specifier: `path.bare-specifier` for a package, otherwise the
 * construct it was written in.
 *
 * It cannot tell a mapped alias from an unmapped one: whether `~/img/hero.png` resolves
 * depends on the `tsconfig` paths table, which only the resolver has. Both alias shapes
 * list the construct shapes in `adapterEmitsAs` instead.
 */
function moduleSourceShape(source: BabelNode | null | undefined, construct: ShapeId): ShapeId {
  const value =
    source !== null && source !== undefined && source.type === 'StringLiteral' ? source.value : '';
  return isBareSpecifier(value) ? 'path.bare-specifier' : construct;
}

/**
 * Whether a module specifier names a package rather than a file in this project.
 *
 * This beats the construct: `some-ui-kit/dist/logo.png` is a file inside a dependency, out
 * of scope and not ours to rewrite, whether it was imported or required. `@` stays
 * alias-shaped, because `@scope/pkg/x.png` and an `@img/*` tsconfig alias are the same
 * syntax and only the resolver has the table that separates them. It is not applied to
 * `new URL(x, import.meta.url)`, where a bare `'img.png'` is relative to the module.
 */
function isBareSpecifier(value: string): boolean {
  if (value === '') return false;
  // Relative, root-relative or on a Windows drive: a reference to a file, not a package.
  if (value.startsWith('.') || value.startsWith('/') || isDrivePath(value)) return false;
  // Alias-shaped: which alias it is depends on a table only the resolver has. No npm package
  // name starts with `$`, so SvelteKit's `$lib/…` is one.
  if (['~', '@', '#', '$'].some((prefix) => value.startsWith(prefix))) return false;
  return true;
}

/**
 * The shape of a template literal: `js.template.pattern` while `assembledPathIsGlobbable`
 * accepts it, `js.template.dynamic` otherwise.
 *
 * A pattern needs a fixed directory before its first unknown segment, because location is
 * what makes an asset unique, and at most one unknown segment in the file name, or the glob
 * sweeps in strangers. `/theme-${mode}.png` is a pattern; `${base}/hero.png` and
 * `/icons/${theme}-${size}.png` are dynamic. Only the file name's unknowns count, so
 * `/img/${dir}/${name}.png` is a pattern.
 */
function templateShape(template: TemplateLiteral, context: Context): ShapeId {
  return assembledPathIsGlobbable(templateChunks(template, context).chunks)
    ? 'js.template.pattern'
    : 'js.template.dynamic';
}

function addLiteralReference(
  literal: StringLiteral,
  context: Context,
  ceiling: Confidence,
  kind: ReferenceKind,
  shape: ShapeId,
  description: string,
  /** Treat the value as a `srcset` candidate list rather than a single path. */
  isSrcSet = false,
): void {
  if (literal.start === null || literal.start === undefined) return;
  if (literal.end === null || literal.end === undefined) return;

  // The literal's range includes its quotes; the path is what sits between them.
  const start = literal.start + 1;
  const end = literal.end - 1;
  const raw = context.text.slice(start, end);

  if (raw !== literal.value) {
    // The source contains escape sequences, so the decoded value is a different
    // length from the text and no range would point at the path correctly. The decoded
    // path still travels, so what it names is hedged rather than called unused.
    const decoded = kind === 'attr' ? urlWithin(literal.value, 0).text : literal.value;
    addReference({
      context,
      start,
      end,
      rawPath: raw,
      assembledPath: splitPathSuffix(decoded).path,
      kind,
      shape,
      ceiling: 'unsafe',
      note: `${description}: the string contains escape sequences, so its path text cannot be located exactly`,
      skipPathChecks: true,
    });
    return;
  }

  // A hole another language's template fills in, such as a project generator's
  // `{{ cookiecutter.logo }}`, names no file until that tool runs, so the path is refused as
  // every other adapter refuses one, never looked up as a file.
  const templated = foreignTemplateExpressionReason(raw);
  if (templated !== null) {
    const url = kind === 'attr' ? urlWithin(raw, start) : { text: raw, start, end };
    addReference({
      context,
      start: url.start,
      end: url.end,
      rawPath: url.text,
      kind,
      shape,
      ceiling: 'unsafe',
      note: `${description}: ${templated}`,
      skipPathChecks: true,
    });
    return;
  }

  if (isSrcSet) {
    for (const candidate of parseSrcset(raw)) {
      addReference({
        context,
        start: start + candidate.offset,
        end: start + candidate.offset + candidate.url.length,
        rawPath: candidate.url,
        kind,
        shape,
        ceiling,
        note: description,
      });
    }
    return;
  }

  // A URL, in a JSX attribute or given to `new URL`, is read as the URL parser reads it: the
  // range covers the URL without the whitespace around it, which a rewrite leaves in place. A
  // module specifier is not a URL, and module resolution strips nothing.
  const url = kind === 'attr' ? urlWithin(raw, start) : { text: raw, start, end };
  // The parser also removes a tab or line break inside a URL, so no range spells what it reads.
  if (kind === 'attr' && /[\t\n\r]/.test(url.text)) {
    addReference({
      context,
      start: url.start,
      end: url.end,
      rawPath: url.text,
      kind,
      shape,
      ceiling: 'unsafe',
      note: `${description}: ${URL_LINE_BREAK_REASON}`,
      skipPathChecks: true,
    });
    return;
  }
  addReference({
    context,
    start: url.start,
    end: url.end,
    rawPath: url.text,
    kind,
    shape,
    ceiling,
    note: description,
  });
}

/**
 * A template literal used as a path.
 *
 * With no expressions it is just a string. With expressions it is `medium` when
 * `assembledPathIsGlobbable` accepts it, so the resolver globs it and links every match,
 * and `unsafe` otherwise. A template that matches nothing is `dynamic`, never `broken`:
 * nobody typed a path that points at nothing.
 */
function addTemplateReference(
  template: TemplateLiteral,
  context: Context,
  kind: ReferenceKind,
  shape: ShapeId,
  description: string,
  asserted = true,
  decline?: Decline,
): void {
  const flattened = flattenTemplate(template, context.text);
  if (flattened === null) return;

  const hasExpressions = template.expressions.length > 0;
  // A URL is read as `addLiteralReference` reads one. The flattened text writes each hole as a
  // comment, so a line break inside `${…}` is not one inside the URL.
  const isUrl = kind === 'attr';
  const url = isUrl
    ? urlWithin(flattened.text, flattened.start)
    : {
        text: flattened.text,
        start: flattened.start,
        end: flattened.start + flattened.text.length,
      };
  const raw = context.text.slice(url.start, url.end);
  // The ceiling is what the resolver reads: it globs `medium`, refuses `unsafe`, and never
  // looks at `shape`. So the glob rule has to set the ceiling here; `templateShape` alone
  // would change only the label. The chunks are the traced ones, so
  // `${ASSET_BASE}/${name}.png` is judged as the `/gallery/${name}.png` the text proves,
  // and that path travels as `assembledPath` because `rawPath` must stay the source text.
  const { chunks, traced } = templateChunks(template, context);
  const assembled = isUrl ? urlWithin(chunks.join(HOLE), 0).text : chunks.join(HOLE);
  const proven = traced ? { assembledPath: assembled } : {};
  if (isUrl && /[\t\n\r]/.test(url.text)) {
    addReference({
      context,
      start: url.start,
      end: url.end,
      rawPath: raw,
      ...proven,
      kind,
      shape,
      ceiling: 'unsafe',
      note: `${description}: ${URL_LINE_BREAK_REASON}`,
      skipPathChecks: true,
      asserted,
      decline,
    });
    return;
  }
  // As for a string: a hole of another language's template is not globbed as if it were text.
  const templated = asserted ? foreignTemplateExpressionReason(raw) : null;
  if (templated !== null) {
    addReference({
      context,
      start: url.start,
      end: url.end,
      rawPath: raw,
      ...proven,
      kind,
      shape,
      ceiling: 'unsafe',
      note: `${description}: ${templated}`,
      skipPathChecks: true,
      asserted,
      decline,
    });
    return;
  }
  const globbable = hasExpressions && assembledPathIsGlobbable(chunks);

  addReference({
    context,
    start: url.start,
    end: url.end,
    rawPath: raw,
    ...proven,
    kind,
    shape,
    ceiling: globbable ? 'medium' : hasExpressions ? 'unsafe' : 'high',
    note: globbable
      ? `${description}: a template literal with a static prefix; the resolver decides which assets it names`
      : hasExpressions
        ? `${description}: ${NOT_GLOBBABLE_REASON}`
        : description,
    skipPathChecks: hasExpressions,
    asserted,
    decline,
  });
}

function addReference(input: {
  context: Context;
  start: number;
  end: number;
  rawPath: string;
  /**
   * What the text proves the path is, when that is not `rawPath` itself: a `+` chain, or a
   * template with a same-file constant written in. Every test below that asks what the
   * path is reads this; the range stays on `rawPath`.
   */
  assembledPath?: string;
  kind: ReferenceKind;
  shape: ShapeId;
  ceiling: Confidence;
  note: string;
  /** Set when the text is not a plain path, so suffix splitting would be wrong. */
  skipPathChecks?: boolean;
  /** `false` for a path-shaped guess, which can never become a `broken` finding. */
  asserted?: boolean;
  /** Set when a construct declined the literal this guess is read from. */
  decline?: Decline | undefined;
}): void {
  const {
    context,
    start,
    rawPath,
    assembledPath,
    kind,
    shape,
    ceiling,
    note,
    skipPathChecks = false,
    asserted = true,
    decline,
  } = input;
  if (rawPath === '') return;
  const into = asserted ? context.references : context.speculative;
  const provenPath = assembledPath ?? rawPath;

  // Above the `skipPathChecks` branch, which means only that suffix splitting would be
  // wrong on this text. A URL is external whatever its holes hold: `https://${branch}.x.com/`
  // is hosted elsewhere, while `${base}/hero.png` starts with a hole, not a scheme. Asked
  // of the assembled path, so `CDN + '/hero.png'` with `const CDN = 'https://…'` is external.
  if (isExternalUrl(provenPath, kind)) return;

  // Beside the external-URL test for the same reason: a path that ends in `/` names a
  // directory whether or not its middle is a hole.
  if (provablyNotAFile(provenPath) !== null) return;

  if (skipPathChecks) {
    into.push(
      filed(
        {
          file: context.file,
          start,
          end: input.end,
          rawPath,
          ...(assembledPath === undefined ? {} : { assembledPath }),
          kind,
          shape,
          ceiling,
          asserted,
          note,
        },
        decline,
      ),
    );
    return;
  }

  const { path, suffix } = splitPathSuffix(rawPath);
  if (path === '') return;
  // A URL holding `%5C` loads a file only a Windows server finds, so it is refused.
  const encodedBackslash = kind === 'attr' && holdsEncodedBackslash(path);

  into.push(
    filed(
      {
        file: context.file,
        start,
        // The range covers the path alone, so a rewrite preserves any `?raw` or `?v=2`
        // suffix, which in a Vite project changes what the import returns.
        end: start + path.length,
        rawPath: path,
        kind,
        shape,
        ceiling: encodedBackslash ? 'unsafe' : ceiling,
        asserted,
        note: encodedBackslash
          ? `${note}: ${ENCODED_BACKSLASH_REASON}`
          : suffix === ''
            ? note
            : `${note}; query or fragment preserved: ${suffix}`,
      },
      decline,
    ),
  );
}
