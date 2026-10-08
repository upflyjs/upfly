/**
 * The Markdown / MDX adapter.
 *
 * Finds `![alt](path)` images, ordinary `[text](path)` links, link reference definitions,
 * and any raw HTML the document contains. Its scanners run only over masked
 * text, where code fences, code spans and HTML comments are blanked to spaces of the same
 * length. Raw HTML goes to the HTML adapter, and an MDX document's top-level
 * `import`/`export` blocks to the JavaScript adapter (`readMdxEsm` finds where MDX starts
 * and ends one). See "The six that exist" in ARCHITECTURE.md.
 */

import { UpflyError } from '../errors.js';
import { extensionOf } from '../paths.js';
import type { Adapter, RawReference } from '../types.js';
import { defineAdapter } from './define.js';
import { htmlAdapter, htmlRegions } from './html.js';
import { findJavaScriptReferences, javaScriptParseOutcome } from './javascript.js';
import {
  ENCODED_BACKSLASH_REASON,
  MARKDOWN_BACKSLASH_REASON,
  TEMPLATE_HOLES,
  TEMPLATE_HOLE_PATTERN,
  holdsEncodedBackslash,
  holdsUndecodableMarkdownEscape,
  isAsciiPunctuation,
  isDrivePath,
  isExternalUrl,
  markdownDestinationCouldNameAnImage,
  markdownReadingHoldsBackslash,
  splitPathSuffix,
  templateExpressionReason,
} from './reference-path.js';
import { type ShapeId, whyFormatKept } from './shapes.js';

/**
 * Where a template hole starts, in any syntax in `TEMPLATE_HOLES`, tested at one position.
 *
 * A hole is the one thing a bare destination may hold that would otherwise end it:
 * `![Logo]({{ site.baseurl }}/logo.png)` is how Jekyll and Eleventy both write a path,
 * and stopping at its first space would find nothing at all. Missing it entirely is the
 * worse failure: the image then looks unreferenced, and a later rewrite breaks the page with
 * nothing reported. A hole is only ever read whole, so a run of holes stays linear.
 */
const HOLE_AT = new RegExp(TEMPLATE_HOLE_PATTERN, 'y');

/** The first character of every hole's opener, so most positions skip the pattern test. */
const HOLE_STARTS: ReadonlySet<string> = new Set(
  TEMPLATE_HOLES.map((hole) => hole.opener.charAt(0)),
);

/**
 * How deep parentheses may nest in a bare destination. CommonMark asks for at least three
 * levels; past this many the text is no path, and the scan stops there.
 */
const MAX_PAREN_DEPTH = 32;

/**
 * Does this document contain anything parse5 could find a reference in?
 *
 * `<` followed by an ASCII letter is what starts a tag in the HTML spec's tag open state,
 * so this is the boundary the parser uses rather than a guess at one. `< img` is text to
 * parse5 and text to this test; `<IMG` is a tag to both.
 */
const MARKUP_OPENER = /<[a-zA-Z]/;

/** `[label]:` at the start of a line, where a CommonMark link reference definition begins. */
const DEFINITION_OPENER = /^ {0,3}\[[^\]]+\]:/gm;

export const markdownAdapter: Adapter = defineAdapter({
  id: 'markdown',
  extensions: ['.md', '.mdx', '.markdown'],

  findReferences({ file, text }): RawReference[] {
    const isMdx = extensionOf(file) === '.mdx';
    const inactive = maskInactiveRegions(text, { indentedCode: !isMdx });

    // MDX's top-level `import`/`export` blocks are JavaScript, and name assets
    // (`import hero from './hero.png'`). They go to the JavaScript adapter as an Astro
    // fence does, and are then blanked from what the Markdown and HTML readers see, so no
    // line is read by two languages.
    const esm = isMdx ? readMdxEsm(file, text, inactive) : null;
    const masked = esm === null ? inactive : blankRanges(inactive, esm.blocks);
    const references: RawReference[] = [...(esm?.references ?? [])];

    // A use site and a definition are different shapes. In `![alt][label]` the path lives
    // in the `[label]: x.png` definition, reported once as `md.reference-definition`, so
    // the use site itself (`md.image.reference-style`) emits nothing.
    collectLinks(masked, file, references);
    collectDefinitions(masked, file, references, labelsLinksUse(masked));

    // Markdown permits arbitrary HTML, so the HTML adapter reads the same masked
    // text. Its offsets are absolute, and the masked regions hold no tags.
    //
    // parse5 is most of this adapter's cost, and every reference the HTML adapter finds
    // sits in a tag, so the pass is skipped when the masked text holds no tag opener.
    // Testing the masked text is what makes this pay: Markdown keeps most of its tags in
    // code fences, which masking has already blanked. The test is coarser than the question
    // on purpose: it matches any tag, known or not, and narrowing it to `img` or `src`
    // would risk skipping a real reference.
    if (MARKUP_OPENER.test(masked)) {
      // If the HTML reader throws, everything collected above is still correct, so it rides
      // along with the failure, and `scan` still reports the file as unparseable.
      try {
        references.push(
          ...htmlAdapter
            .findReferences({ file, text: masked })
            .map((reference) => asMarkdownShape(reference, isMdx))
            .map((reference) => (isMdx ? readMdxExpression(reference, text) : reference)),
        );
      } catch (error) {
        throw withPartial(error, references);
      }
    }

    // An ESM block MDX itself would refuse is reported only now, so every reference the
    // rest of the document holds rides along with it rather than being lost to it.
    if (esm?.failure) throw withPartial(esm.failure, references);

    return references.sort((a, b) => a.start - b.start);
  },
});

/**
 * An adapter failure rebuilt to carry everything already found beside it, for the caller
 * to throw. The diagnostic is kept, so the parser's own text still reaches the diagnostic
 * channel.
 */
function withPartial(error: unknown, references: readonly RawReference[]): unknown {
  if (!(error instanceof UpflyError)) return error;
  return new UpflyError(
    error.code,
    error.message,
    [...references, ...(error.partial as RawReference[])],
    error.diagnostic,
  );
}

/**
 * YAML frontmatter at the very start of the document, which is not Markdown and not ESM.
 *
 * The same shape `astro.ts` anchors its fence with: offset 0, and a closing `---` alone
 * on its line. Kept separate rather than shared because the two formats agree on it by
 * convention, not by specification, and one changing should not silently move the other.
 */
const FRONTMATTER = /^---[^\S\n]*\r?\n[\s\S]*?\r?\n---[^\S\n]*(?:\r?\n|$)/;

/** MDX's own opener: `import` or `export` at column 1, followed by exactly one space. */
const ESM_OPENER = /^(?:import|export) /;
const ESM_ANYWHERE = /^(?:import|export) /m;

/** A blank line as MDX means it: nothing but spaces and tabs before the line ending. */
const BLANK_LINE = /^[ \t]*\r?$/;

interface Line {
  readonly start: number;
  /** Exclusive, and before the `\n`. */
  readonly end: number;
}

interface MdxEsm {
  /** Where each block sits, so the Markdown and HTML readers can be kept out of it. */
  readonly blocks: readonly Line[];
  readonly references: readonly RawReference[];
  /** The first block MDX itself could not parse, deferred so it cannot take the rest. */
  readonly failure: unknown;
}

/**
 * Every top-level `import`/`export` block of an MDX document, read as JavaScript.
 *
 * The boundaries are MDX's own, from `micromark-extension-mdxjs-esm`. An opener is `import`
 * or `export` and one space at column 1 (so never in a list or block quote), at the start
 * of the body or after a blank line: ESM cannot interrupt a paragraph, so a prose line that
 * begins "export and option." stays text. A block ends at a blank line unless the code so
 * far is an unfinished prefix (`javaScriptParseOutcome`), in which case MDX reads on. An
 * opener straight after a heading or a JSX line, which MDX accepts, is not recognised here,
 * because telling those from a paragraph line needs a block parser.
 *
 * Openers are found in the masked text, so an `import` in a code fence stays inert; blocks
 * are read from the source, where a template literal is not blanked as a code span.
 */
function readMdxEsm(file: string, text: string, masked: string): MdxEsm | null {
  // One regex over the document before any per-line work: most `.mdx` in the bench tree,
  // and plenty in real repositories, have no ESM at all and should pay nothing for it.
  if (!ESM_ANYWHERE.test(masked)) return null;
  const lines = linesOf(text);
  const bodyStart = FRONTMATTER.exec(text)?.[0].length ?? 0;
  const isBlank = (source: string, line: Line | undefined) =>
    line !== undefined && BLANK_LINE.test(source.slice(line.start, line.end));

  const blocks: Line[] = [];
  const references: RawReference[] = [];
  let failure: unknown = null;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as Line;
    const opens =
      line.start >= bodyStart &&
      ESM_OPENER.test(masked.slice(line.start, line.end)) &&
      (line.start === bodyStart || isBlank(masked, lines[index - 1]));
    if (!opens) {
      index += 1;
      continue;
    }

    const read = readEsmBlock(file, text, lines, index, isBlank);
    blocks.push({ start: line.start, end: (lines[read.last] as Line).end });
    references.push(...read.references);
    if (read.failure !== null && failure === null) failure = read.failure;
    index = read.last + 1;
  }

  return blocks.length === 0 ? null : { blocks, references, failure };
}

/**
 * One ESM block, from its opener to its end as MDX would find it.
 *
 * Handed to the JavaScript adapter as the file up to the block's end, with everything
 * before the block blanked (the Astro adapter's device), so every offset it returns is
 * already an offset into the `.mdx` file, and a parse error names the file's own line.
 */
function readEsmBlock(
  file: string,
  text: string,
  lines: readonly Line[],
  first: number,
  isBlank: (source: string, line: Line | undefined) => boolean,
): { last: number; references: RawReference[]; failure: unknown } {
  const start = (lines[first] as Line).start;
  const chunkEnd = (from: number) => {
    let last = from;
    while (last + 1 < lines.length && !isBlank(text, lines[last + 1])) last += 1;
    return last;
  };

  const firstChunk = chunkEnd(first);
  let last = firstChunk;
  for (;;) {
    const end = (lines[last] as Line).end;
    try {
      const found = findJavaScriptReferences({
        file,
        text: blank(text.slice(0, start)) + text.slice(start, end),
        // MDX parses its ESM with acorn and acorn-jsx: JavaScript with JSX, never TypeScript.
        extension: '.jsx',
      });
      return { last, references: found.map(asEsmShape), failure: null };
    } catch (error) {
      // Swallow the blank line only where MDX would: the code stopped early.
      let next = last + 1;
      while (next < lines.length && isBlank(text, lines[next])) next += 1;
      const unfinished = javaScriptParseOutcome(text.slice(start, end), '.jsx') === 'incomplete';
      if (!unfinished || next >= lines.length) {
        // MDX would refuse this document here. The block is still kept away from the
        // Markdown readers (it is code, however broken), and the failure is reported.
        return { last: firstChunk, references: [], failure: error };
      }
      last = chunkEnd(next);
    }
  }
}

/**
 * Re-stamp what the JavaScript adapter found in an ESM block.
 *
 * The same selection the Astro fence makes, for the same reason: what would take an
 * `import` here out is MDX's block extraction, which no `.js` file exercises, so it is
 * MDX's row. A path-shaped string in an `export const` stays `js.string.literal`: the
 * speculative-string rule finds it, and that rule fails identically wherever it runs.
 */
function asEsmShape(reference: RawReference): RawReference {
  return reference.shape.startsWith('js.import.')
    ? { ...reference, shape: 'mdx.import' }
    : reference;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ start, end: text.length });
      return lines;
    }
    lines.push({ start, end: newline });
    start = newline + 1;
  }
}

/** Blank each range, keeping every offset and every newline exactly where it was. */
function blankRanges(text: string, ranges: readonly Line[]): string {
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start) + blank(text.slice(range.start, range.end));
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

/** Why a braced value in MDX gives no path. */
const MDX_EXPRESSION_DECLINED = 'an expression in an MDX attribute, which Upfly does not evaluate';

/**
 * A reference the HTML reader found in an MDX attribute written in braces,
 * `src={'/img/x.png'}`, read as MDX reads it: the braces hold JavaScript, not text, and the
 * HTML reader would keep them as part of the path. One string literal is that string.
 * Anything else is a value Upfly does not evaluate, declined with its reason, so the report
 * counts it rather than losing it. A quoted value, `src="{x}.png"`, is text in MDX too.
 * It reads the unmasked text: the mask takes a template literal's backticks for a code span.
 */
function readMdxExpression(reference: RawReference, text: string): RawReference {
  const open = reference.start;
  if (text.charAt(open) !== '{' || text.charAt(previousNonSpace(text, open)) !== '=') {
    return reference;
  }
  const close = closingBrace(text, open);
  if (close === -1) return reference;

  const first = nextNonSpace(text, open + 1);
  const last = previousNonSpace(text, close);
  const quote = text.charAt(first);
  const content = text.slice(first + 1, last);
  const isLiteral =
    last > first &&
    (quote === "'" || quote === '"' || quote === '`') &&
    text.charAt(last) === quote &&
    !content.includes(quote) &&
    !content.includes('\\') &&
    !content.includes('\n') &&
    !(quote === '`' && content.includes('${'));
  if (isLiteral) {
    const { path } = splitPathSuffix(content);
    return { ...reference, rawPath: path, start: first + 1, end: first + 1 + path.length };
  }
  return {
    ...reference,
    rawPath: text.slice(open, close + 1),
    end: close + 1,
    ceiling: 'unsafe',
    declined: true,
    note: MDX_EXPRESSION_DECLINED,
  };
}

/** The `}` that closes the brace at `open`, past any string inside, or -1 if none does. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === "'" || char === '"' || char === '`') {
      index = stringEnd(text, index);
      if (index === -1) return -1;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The quote that closes the string opened at `open`, or -1 if none does. */
function stringEnd(text: string, open: number): number {
  const quote = text.charAt(open);
  for (let index = open + 1; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === '\\') index++;
    else if (char === quote) return index;
    else if (quote !== '`' && char === '\n') return -1;
  }
  return -1;
}

/** The first index at or after `at` that is not whitespace, or `text.length` if none is. */
function nextNonSpace(text: string, at: number): number {
  let index = at;
  while (index < text.length && text.charAt(index).trim() === '') index++;
  return index;
}

/** The last character before `at` that is not whitespace, or -1. */
function previousNonSpace(text: string, at: number): number {
  let index = at - 1;
  while (index >= 0 && text.charAt(index).trim() === '') index--;
  return index;
}

/**
 * Re-stamp a reference the HTML adapter found inside Markdown.
 *
 * The host decides the shape. What would break these references is Markdown handing its
 * raw HTML over and masking the inactive regions, not `<img src>` parsing, which the HTML
 * adapter's own shapes cover. CSS from a `<style>` element keeps a shape apart from a style
 * attribute's, because the shape picks the decoder, and a browser decodes character
 * references only in the attribute.
 */
function asMarkdownShape(reference: RawReference, isMdx: boolean): RawReference {
  // A link preview or a link to an image keeps its shape in any host, because the shape is
  // where the planner reads that it is never rewritten.
  if (whyFormatKept(reference.shape) !== null) return reference;
  if (reference.shape === 'html.style.attribute') {
    return { ...reference, shape: 'md.style-attribute' };
  }
  if (reference.host === 'html.style.attribute') {
    return { ...reference, host: 'md.style-attribute' };
  }
  if (reference.shape === 'html.style.element') {
    return { ...reference, shape: 'md.style-element' };
  }
  // MDX's components are JSX, not raw HTML, even though the same scanner finds them:
  // what would take them out is MDX's own handling, and `.md` has no JSX to lose.
  return { ...reference, shape: isMdx ? 'mdx.jsx' : 'md.raw-html' };
}

/** A destination's path, and where the text after it resumes. */
interface Destination {
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

/** An inline link or image whose text and destination both read as CommonMark reads them. */
interface InlineLink {
  readonly open: number;
  readonly close: number;
  readonly image: boolean;
  readonly destination: Destination;
}

/**
 * Every `![alt](destination "title")`, and the same without the `!` for a plain link, found
 * as CommonMark finds them.
 *
 * A pattern nests parentheses only to a fixed depth, by repeating itself, and each level
 * multiplies its backtracking, so the brackets are paired in one pass and each destination
 * is read forward once. A link to an image file is as real a reference as an embed
 * (following it fetches the file), and the resolver drops anything that is not a tracked
 * asset, so both are read. A link is `md.link`, which is never rewritten: whoever follows it
 * saves the file in the format the link names.
 */
function collectLinks(masked: string, file: string, references: RawReference[]): void {
  const links: InlineLink[] = [];
  for (const [open, close] of pairBrackets(masked)) {
    if (masked.charAt(close + 1) !== '(') continue;
    const destination = readDestination(masked, skipBlanks(masked, close + 2));
    if (destination === null || !endsLink(masked, destination.next)) continue;
    const image = masked.charAt(open - 1) === '!' && masked.charAt(open - 2) !== '\\';
    links.push({ open, close, image, destination });
  }
  links.sort((a, b) => a.open - b.open);

  // A link cannot hold another link: the inner one wins and the outer is plain text. An
  // image may sit inside a link, as a linked thumbnail does.
  const plainOpens = links.filter((link) => !link.image).map((link) => link.open);
  for (const link of links) {
    if (!link.image && holdsBetween(plainOpens, link.open, link.close)) continue;
    const { start, end } = link.destination;
    const shape = link.image ? 'md.image' : 'md.link';
    addReference(masked.slice(start, end), start, file, references, shape);
  }
}

/**
 * Every `[label]: destination`, a link reference definition. One whose label a plain link
 * uses keeps its format, as the link does: following it hands over the file itself.
 */
function collectDefinitions(
  masked: string,
  file: string,
  references: RawReference[],
  linked: ReadonlySet<string>,
): void {
  for (const match of masked.matchAll(DEFINITION_OPENER)) {
    // The destination may start on the next line. What follows it is not checked, so a
    // definition with a malformed title is still read.
    const at = skipBlanks(masked, (match.index ?? 0) + match[0].length);
    const destination = readDestination(masked, at);
    if (destination === null) continue;
    const { start, end } = destination;
    const label = match[0].slice(match[0].indexOf('[') + 1, match[0].lastIndexOf(']'));
    const shape = linked.has(matchingLabel(label))
      ? 'md.reference-definition.link'
      : 'md.reference-definition';
    addReference(masked.slice(start, end), start, file, references, shape);
  }
}

/**
 * The labels plain reference links use: `[text][label]`, `[label][]` and `[label]`. An
 * image's `![alt][label]` is not a link, the second bracket of a full or collapsed
 * reference is its label rather than a link of its own, and a definition's `[label]:` is
 * not a use.
 */
function labelsLinksUse(masked: string): ReadonlySet<string> {
  const definitions = new Set(
    [...masked.matchAll(DEFINITION_OPENER)].map(
      (match) => (match.index ?? 0) + match[0].indexOf('['),
    ),
  );
  const pairs = pairBrackets(masked);
  const labelBrackets = new Set<number>();
  const used = new Set<string>();
  for (const [open, close] of [...pairs].sort((a, b) => a[0] - b[0])) {
    if (labelBrackets.has(open) || definitions.has(open)) continue;
    const image = masked.charAt(open - 1) === '!' && masked.charAt(open - 2) !== '\\';
    const next = masked.charAt(close + 1);
    if (next === '(') continue;
    const labelClose = next === '[' ? pairs.get(close + 1) : undefined;
    const label =
      labelClose === undefined
        ? masked.slice(open + 1, close)
        : masked.slice(close + 2, labelClose) || masked.slice(open + 1, close);
    if (labelClose !== undefined) labelBrackets.add(close + 1);
    if (!image) used.add(matchingLabel(label));
  }
  return used;
}

/** A label as a reference matches it: letter case and runs of whitespace do not count. */
function matchingLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Each `[` paired with the `]` that closes it: brackets nest, a backslash escapes one, and a
 * blank line leaves every bracket still open unpaired, as it ends the paragraph they sit in.
 */
function pairBrackets(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === '\\' && isAsciiPunctuation(text.charAt(index + 1))) {
      index++;
    } else if (char === '[') {
      open.push(index);
    } else if (char === ']') {
      const start = open.pop();
      if (start !== undefined) pairs.set(start, index);
    } else if (char === '\n' && isBlankLineAt(text, index + 1)) {
      open.length = 0;
    }
  }
  return pairs;
}

/** Whether a sorted list holds a value strictly between `from` and `to`. */
function holdsBetween(sorted: readonly number[], from: number, to: number): boolean {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? to) <= from) low = middle + 1;
    else high = middle;
  }
  return (sorted[low] ?? to) < to;
}

/**
 * The destination starting at `at`: `<...>`, or a bare run ended by a space, a control
 * character or a `)` that closes no `(`. `null` where CommonMark reads no destination. An EJS
 * `<%= logo %>` is a template hole, not brackets.
 */
function readDestination(text: string, at: number): Destination | null {
  if (text.charAt(at) === '<' && holeEndAt(text, at) === -1) return readBracketed(text, at);
  return readBare(text, at);
}

/** `<...>`: anything but a line ending or an unescaped `<`, ended by the first unescaped `>`. */
function readBracketed(text: string, at: number): Destination | null {
  for (let index = at + 1; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === '\\' && isAsciiPunctuation(text.charAt(index + 1))) index++;
    else if (char === '>') return { start: at + 1, end: index, next: index + 1 };
    else if (char === '<' || char === '\n' || char === '\r') return null;
  }
  return null;
}

/**
 * A bare destination: parentheses only in balanced pairs or escaped, and a template hole
 * read whole, since one may hold spaces and parentheses of its own.
 */
function readBare(text: string, at: number): Destination | null {
  let depth = 0;
  let index = at;
  while (index < text.length) {
    const hole = holeEndAt(text, index);
    if (hole !== -1) {
      index = hole;
      continue;
    }
    const char = text.charAt(index);
    if (char === '\\' && isAsciiPunctuation(text.charAt(index + 1))) {
      index += 2;
      continue;
    }
    if (char === '(') {
      depth++;
      if (depth > MAX_PAREN_DEPTH) return null;
    } else if (char === ')') {
      if (depth === 0) break;
      depth--;
    } else if (char <= ' ' || char === '\u007f') {
      break;
    }
    index++;
  }
  return depth === 0 ? { start: at, end: index, next: index } : null;
}

/** Where the template hole starting at `at` ends, or -1 when none starts there. */
function holeEndAt(text: string, at: number): number {
  if (!HOLE_STARTS.has(text.charAt(at))) return -1;
  HOLE_AT.lastIndex = at;
  return HOLE_AT.test(text) ? HOLE_AT.lastIndex : -1;
}

/** Whether a link ends at `at`: an optional title in any of its three forms, then `)`. */
function endsLink(text: string, at: number): boolean {
  let index = skipBlanks(text, at);
  const opener = text.charAt(index);
  if (index > at && (opener === '"' || opener === "'" || opener === '(')) {
    index = readTitle(text, index + 1, opener === '(' ? ')' : opener);
    if (index === -1) return false;
    index = skipBlanks(text, index);
  }
  return text.charAt(index) === ')';
}

/**
 * Past a title's closing character, or -1 if it never closes: a blank line ends it, and so
 * does an unescaped `(` in a title opened by `(`.
 */
function readTitle(text: string, at: number, closer: string): number {
  for (let index = at; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === '\\' && isAsciiPunctuation(text.charAt(index + 1))) index++;
    else if (char === closer) return index + 1;
    else if (closer === ')' && char === '(') return -1;
    else if (char === '\n' && isBlankLineAt(text, index + 1)) return -1;
  }
  return -1;
}

/** Past spaces and tabs, and at most one line ending with the spaces and tabs after it. */
function skipBlanks(text: string, at: number): number {
  const index = skipSpaces(text, at);
  if (text.startsWith('\r\n', index)) return skipSpaces(text, index + 2);
  if (text.charAt(index) === '\n' || text.charAt(index) === '\r')
    return skipSpaces(text, index + 1);
  return index;
}

function skipSpaces(text: string, at: number): number {
  let index = at;
  while (text.charAt(index) === ' ' || text.charAt(index) === '\t') index++;
  return index;
}

/** Whether the line starting at `at` holds nothing but spaces and tabs. */
function isBlankLineAt(text: string, at: number): boolean {
  let index = skipSpaces(text, at);
  if (text.charAt(index) === '\r') index++;
  return index >= text.length || text.charAt(index) === '\n';
}

function addReference(
  raw: string,
  start: number,
  file: string,
  references: RawReference[],
  shape: ShapeId,
): void {
  if (raw === '') return;
  if (isExternalUrl(raw, 'md')) return;

  const reason = templateExpressionReason(raw);
  if (reason !== null) {
    // Jekyll, Hugo and Eleventy all build paths in Markdown this way.
    references.push({
      file,
      start,
      end: start + raw.length,
      rawPath: raw,
      kind: 'md',
      shape,
      ceiling: 'unsafe',
      asserted: true,
      note: reason,
    });
    return;
  }

  const { path, suffix } = splitPathSuffix(raw);
  if (path === '') return;

  // CommonMark decodes backslash escapes and character references in a destination, and
  // the resolver tries that reading. When no spelling decodes them all the file is unknown,
  // and looking up the text as written would report a miss as broken. A destination none of
  // whose readings ends in an image extension, such as `/wiki/AT&T;`, names no image either
  // way, so it is kept, and the resolver drops it as it drops any link to a page.
  if (holdsUndecodableMarkdownEscape(path) && markdownDestinationCouldNameAnImage(path)) {
    references.push({
      file,
      start,
      end: start + path.length,
      rawPath: path,
      kind: 'md',
      shape,
      ceiling: 'unsafe',
      asserted: true,
      note: 'the path holds escapes that cannot be fully decoded, such as a misspelled character reference, or a character reference or backslash escape beside a percent-escape or decoding to one, so the file it names is not known',
    });
    return;
  }

  // A backslash CommonMark keeps, which most renderers write as `%5C`, and a `%5C` the author
  // wrote, are folder separators only to a pass-through renderer or a Windows server, so the
  // file loaded depends on the site. A drive path names a place on a disk, not a folder.
  const backslash = isDrivePath(path)
    ? null
    : markdownReadingHoldsBackslash(path)
      ? MARKDOWN_BACKSLASH_REASON
      : holdsEncodedBackslash(path)
        ? ENCODED_BACKSLASH_REASON
        : null;
  if (backslash !== null && markdownDestinationCouldNameAnImage(path)) {
    references.push({
      file,
      start,
      end: start + path.length,
      rawPath: path,
      kind: 'md',
      shape,
      ceiling: 'unsafe',
      asserted: true,
      note: backslash,
    });
    return;
  }

  references.push({
    file,
    start,
    end: start + path.length,
    rawPath: path,
    kind: 'md',
    shape,
    ceiling: 'high',
    asserted: true,
    ...(suffix === '' ? {} : { note: `query or fragment preserved: ${suffix}` }),
  });
}

/**
 * What a Markdown text holds at an offset, as `markdownRegionAt` names it: a region no reader
 * looks in, or the text a page shows, given as that run of text up to the offset with code
 * blanked, so a template engine's tag still open there can be told apart.
 */
export type MarkdownRegion = 'comment' | 'code' | 'frontmatter' | { readonly shown: string };

/**
 * What a Markdown text holds at an offset: an HTML comment, code (a fence, an indented block
 * or a code span), the YAML frontmatter at the very start, which no adapter reads, or text a
 * page shows, outside any tag and outside `<script>` and `<style>`. `null` is anything else,
 * such as an attribute of raw HTML. MDX claims no shown text, since its expressions and
 * `import` and `export` blocks are code a reader would have to tell apart from prose.
 *
 * @param extension `.md`, `.markdown` or `.mdx`, which has no indented code blocks
 */
export function markdownRegionAt(
  text: string,
  extension: string,
): (offset: number) => MarkdownRegion | null {
  const bodyStart = FRONTMATTER.exec(text)?.[0].length ?? 0;
  const masked = maskInactiveRegions(text, { indentedCode: extension !== '.mdx' });
  const comments = [...maskFencedBlocks(text).matchAll(/<!--[\s\S]*?-->/g)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );
  // The HTML parser reads the masked text as the adapter's HTML pass does, so what it calls
  // text is what neither a tag nor a script holds.
  let runs: readonly (readonly [number, number])[] | undefined;
  return (offset) => {
    if (offset < bodyStart) return 'frontmatter';
    if (masked[offset] !== text[offset]) {
      return comments.some(([start, end]) => start <= offset && offset < end) ? 'comment' : 'code';
    }
    if (extension === '.mdx') return null;
    runs ??= htmlRegions(masked).text;
    const run = runs.find(([start, end]) => start <= offset && offset < end);
    return run === undefined ? null : { shown: masked.slice(run[0], offset) };
  };
}

/**
 * Blank out every region of Markdown text where Markdown syntax is not active, so a search
 * for references cannot match inside code.
 *
 * Fenced code, code spans, HTML comments and the opening tag of a raw-text element that is
 * never closed become spaces. Newlines stay, so the result has the input's length and line
 * structure, and an offset into one indexes the other. Indented code blocks are blanked
 * only with `indentedCode: true`, and only where they are certain; MDX has none (MDX 2
 * turned them off, because JSX is indented). Mask before searching Markdown for any
 * token: an `import` or `<img src>` inside a fence is documentation, not code.
 */
export function maskInactiveRegions(
  text: string,
  options: {
    /** `true` for CommonMark (`.md`, `.markdown`); MDX has no indented code blocks. */
    readonly indentedCode?: boolean;
  } = {},
): string {
  const fenced = maskFencedBlocks(text);
  let masked = maskPattern(fenced, /<!--[\s\S]*?-->/g);
  // Before the code-span pass, not after it: a backtick inside an indented block is a
  // literal character, and left in place it can pair with one in the prose below and
  // blank a real reference between them.
  if (options.indentedCode === true) masked = maskIndentedCodeBlocks(masked, text, fenced);
  masked = maskCodeSpans(masked);
  masked = maskUnclosedRawText(masked);
  return masked;
}

/**
 * Blank every code span as CommonMark reads it: a run of backticks opens one unless a
 * backslash escapes its first backtick, the next run of exactly the same length in the same
 * paragraph closes it, and a run with no such partner is plain text. Inside a span a
 * backslash is itself, so it never stops a closing run from closing.
 */
function maskCodeSpans(text: string): string {
  const runs = backtickRuns(text);
  const startsByLength = new Map<number, number[]>();
  for (const run of runs) {
    const starts = startsByLength.get(run.length) ?? [];
    starts.push(run.start);
    startsByLength.set(run.length, starts);
  }
  const breaks = paragraphBreaks(text);

  const spans: Line[] = [];
  let cursor = 0;
  for (const run of runs) {
    if (run.start < cursor) continue;
    const escaped = isEscaped(text, run.start);
    const start = escaped ? run.start + 1 : run.start;
    const length = escaped ? run.length - 1 : run.length;
    if (length === 0) continue;
    const close = firstAtOrAfter(startsByLength.get(length) ?? [], start + length);
    if (close === undefined) continue;
    const blankLine = firstAtOrAfter(breaks, start);
    if (blankLine !== undefined && blankLine < close) continue;
    spans.push({ start, end: close + length });
    cursor = close + length;
  }
  return blankRanges(text, spans);
}

/** Every maximal run of backticks, in order. */
function backtickRuns(text: string): { readonly start: number; readonly length: number }[] {
  const runs: { start: number; length: number }[] = [];
  for (let index = text.indexOf('`'); index !== -1; ) {
    let end = index;
    while (text.charAt(end) === '`') end++;
    runs.push({ start: index, length: end - index });
    index = text.indexOf('`', end);
  }
  return runs;
}

/** Where each blank line starts: the line ending before it. No inline span crosses one. */
function paragraphBreaks(text: string): number[] {
  const breaks: number[] = [];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (isBlankLineAt(text, index + 1)) breaks.push(index);
  }
  return breaks;
}

/** Whether an odd run of backslashes stands right before `at`. */
function isEscaped(text: string, at: number): boolean {
  let count = 0;
  while (text.charAt(at - count - 1) === '\\') count++;
  return count % 2 === 1;
}

/** The first value in a sorted list that is at least `value`. */
function firstAtOrAfter(sorted: readonly number[], value: number): number | undefined {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? value) < value) low = middle + 1;
    else high = middle;
  }
  return sorted[low];
}

/** A list item's marker, wherever it sits: bullet or ordered, and what follows it. */
const LIST_MARKER = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/;

/** `***`, `- - -` or `___`: a thematic break, which is never a list item. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** An ATX heading: a whole block on one line. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/**
 * CommonMark's HTML block type 1, which a blank line does not end: its content is HTML
 * until the closing tag, however it is indented.
 */
const RAW_HTML_BLOCK = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;

/**
 * Blank every indented code block, and nothing that only looks like one.
 *
 * An indented block is code shown, not run, like a fence. But blanking a line that is not
 * code loses a real reference, so wherever CommonMark could read it otherwise, it stays live:
 * - in a list item, even as nested code: telling the two apart needs column arithmetic,
 *   and a wrong guess blanks a real image;
 * - after a paragraph line, which it continues. Code needs a blank line, an ATX heading, a
 *   thematic break, a fence or more code before it; a `===` underline is not recognised;
 * - in a `<pre>`, `<script>`, `<style>` or `<textarea>` block, which a blank line does not end.
 *
 * Structure comes from `source`, never the mask: a masked HTML comment is not a blank line,
 * and reading it as one would end an HTML block early and blank the live lines after it.
 */
function maskIndentedCodeBlocks(masked: string, source: string, fenced: string): string {
  const sourceLines = source.split('\n');
  const fencedLines = fenced.split('\n');
  const state: BlockState = { listContent: null, rawHtmlEnd: null, previous: 'blank' };

  return masked
    .split('\n')
    .map((line, index) =>
      isIndentedCode(state, sourceLines[index] ?? '', fencedLines[index] ?? '')
        ? blank(line)
        : line,
    )
    .join('\n');
}

/** What the lines so far leave open, as far as indented code is concerned. */
interface BlockState {
  /** The outermost open list item's content column, or null when no list is open. */
  listContent: number | null;
  /** The closing tag of an open `<pre>`-type HTML block, which a blank line does not end. */
  rawHtmlEnd: RegExp | null;
  previous: 'blank' | 'code' | 'block' | 'text';
}

/** Advance `state` past one source line, and say whether that line is indented code. */
function isIndentedCode(state: BlockState, original: string, fenced: string): boolean {
  const isBlank = BLANK_LINE.test(original);
  // A fence's own lines are blank already, and the block they form is complete once it
  // closes, so what follows the closing fence starts afresh.
  if (!isBlank && BLANK_LINE.test(fenced)) {
    state.previous = 'block';
    return false;
  }
  if (state.rawHtmlEnd !== null) {
    if (state.rawHtmlEnd.test(original)) state.rawHtmlEnd = null;
    state.previous = 'text';
    return false;
  }
  if (isBlank) {
    state.previous = 'blank';
    return false;
  }

  const indent = columnsOf(original);
  trackList(state, original, indent);
  if (state.listContent === null && indent >= 4 && state.previous !== 'text') {
    state.previous = 'code';
    return true;
  }

  state.rawHtmlEnd = rawHtmlBlockEnd(original);
  state.previous = ATX_HEADING.test(original) || THEMATIC_BREAK.test(original) ? 'block' : 'text';
  return false;
}

/**
 * Open a list at a marker, and close it at the first line after a blank that is indented
 * less than its outermost item's content, never at a line carrying a paragraph on.
 */
function trackList(state: BlockState, original: string, indent: number): void {
  const marker = THEMATIC_BREAK.test(original) ? null : LIST_MARKER.exec(original);
  const open = state.listContent;
  if (open !== null && marker === null && state.previous === 'blank' && indent < open) {
    state.listContent = null;
  }
  if (marker !== null && (open === null ? indent <= 3 : indent < open)) {
    state.listContent = contentColumnOf(marker);
  }
}

/** The closing tag a `<pre>`-type HTML block waits for, when this line opens one. */
function rawHtmlBlockEnd(original: string): RegExp | null {
  const opener = RAW_HTML_BLOCK.exec(original);
  if (opener === null) return null;
  const close = new RegExp(`</${opener[1]}\\s*>`, 'i');
  return close.test(original) ? null : close;
}

/** Leading whitespace in columns, a tab advancing to the next multiple of four. */
function columnsOf(line: string): number {
  let column = 0;
  for (const character of line) {
    if (character === ' ') column += 1;
    else if (character === '\t') column += 4 - (column % 4);
    else break;
  }
  return column;
}

/**
 * Where a list item's content starts. One to four columns of space after the marker
 * are part of it; five or more mean the item opens with indented code, and then, as
 * for an empty item, the content column is one past the marker.
 */
function contentColumnOf(marker: RegExpExecArray): number {
  const [, leading = '', symbol = '', spacing = ''] = marker;
  const markerEnd = columnsOf(leading) + symbol.length;
  const gap = columnsOf(`${' '.repeat(markerEnd)}${spacing}`) - markerEnd;
  return gap >= 1 && gap <= 4 ? markerEnd + gap : markerEnd + 1;
}

/**
 * HTML's raw-text elements, which consume everything until their closing tag.
 *
 * The set parse5 reads as text in a document body, from `startTagInBody` in its parser.
 * `<noscript>` joins them only with scripting on, and html.ts parses with it off.
 * `<plaintext>` never closes at all. GitHub's Markdown filters the same nine tags.
 */
const RAW_TEXT_ELEMENTS = [
  'style',
  'script',
  'textarea',
  'title',
  'plaintext',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
] as const;

/**
 * Blank a raw-text open tag that never closes.
 *
 * parse5 is a real HTML parser, so a `<script>` or `<style>` opens a raw-text element
 * wherever it appears, and prose that merely mentions one ("a base-`<style>` variant")
 * swallows the rest of the document. For `<style>` the swallowed text reaches the CSS
 * parser, which throws; the others swallow silently, so a later `<img src>` is dropped
 * with nothing in the report. An open tag with no matching close is not an element the
 * author meant, and mid-sentence CommonMark agrees: there it is inline HTML, and the text
 * after it is still Markdown. So it is blanked with spaces of the same length.
 */
function maskUnclosedRawText(text: string): string {
  let masked = text;

  for (const element of RAW_TEXT_ELEMENTS) {
    const open = new RegExp(`<${element}(?=[\\s/>])[^>]*>`, 'gi');
    const close = new RegExp(`</${element}\\s*>`, 'i');

    let match = open.exec(masked);
    while (match !== null) {
      const after = masked.slice(match.index + match[0].length);
      if (!close.test(after)) {
        masked =
          masked.slice(0, match.index) +
          blank(match[0]) +
          masked.slice(match.index + match[0].length);
      }
      match = open.exec(masked);
    }
  }

  return masked;
}

/**
 * Blank every fenced code block.
 *
 * The closing rules below are CommonMark's, and getting one wrong puts the mask out of
 * step for the rest of the file: a fenced example turns live and a real reference after
 * it is blanked, with no error either way. ` ```ts ` can only open a block, and a
 * ` ```` ` block can quote a ` ``` ` one, as documentation about Markdown often does.
 * A fence indented past three spaces, as one inside a list item's step is, opens only
 * when a closing line follows beside its indent, so a stray fence line never blanks the
 * rest of the file.
 */
function maskFencedBlocks(text: string): string {
  const lines = text.split('\n');
  let open: FenceLine | null = null;

  const maskedLines = lines.map((line, index) => {
    const fence = fenceLine(line);

    if (open === null) {
      const opener = fence;
      if (
        opener !== null &&
        (opener.indent <= 3 ||
          lines.slice(index + 1).some((later) => closes(fenceLine(later), opener)))
      ) {
        open = opener;
        return blank(line);
      }
      return line;
    }

    if (closes(fence, open)) open = null;
    return blank(line);
  });

  return maskedLines.join('\n');
}

/** A line of three or more backticks or tildes: its indent, the run, and what follows it. */
interface FenceLine {
  readonly indent: number;
  readonly marker: string;
  readonly info: string;
}

function fenceLine(line: string): FenceLine | null {
  const match = /^( *)(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (match === null) return null;
  return { indent: match[1]?.length ?? 0, marker: match[2] ?? '', info: match[3] ?? '' };
}

/**
 * Whether a line closes the fence `opener` began: the same character, a run at least as
 * long, and no info string (a backtick fence's info may not hold a backtick, so a line of
 * pure backticks longer than the opener still closes). At the margin a closer may be
 * indented up to three spaces; under a list item it sits beside the opener's indent.
 */
function closes(line: FenceLine | null, opener: FenceLine): boolean {
  if (line === null || line.marker.charAt(0) !== opener.marker.charAt(0)) return false;
  if (line.marker.length < opener.marker.length || line.info.trim() !== '') return false;
  return opener.indent <= 3 ? line.indent <= 3 : Math.abs(line.indent - opener.indent) <= 3;
}

function maskPattern(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => blank(match));
}

/** Replace everything but newlines with spaces, preserving length exactly. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}
