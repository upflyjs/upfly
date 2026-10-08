/**
 * The HTML adapter.
 *
 * Finds image references in the attributes `url-attributes.ts` lists (`src`, `srcset`,
 * `poster`, icon `href` and the rest), the list the JSX reader shares, and in the CSS that
 * HTML carries: `<style>` elements and `style=""` attributes, both handed to the CSS
 * adapter's scanner. See "The six that exist" in ARCHITECTURE.md.
 *
 * parse5 parses by the HTML specification, so an `<img>` inside a comment is a comment
 * node, never an element, and every attribute comes with its exact source range, which is
 * what makes a safe rewrite possible.
 */

import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { UpflyError } from '../errors.js';
import type { Adapter, RawReference } from '../types.js';
import { findCssReferences } from './css.js';
import { defineAdapter } from './define.js';
import {
  ENCODED_BACKSLASH_REASON,
  URL_LINE_BREAK_REASON,
  attributeCouldNameAnImage,
  decodeCharacterReferencesWithMap,
  holdsEncodedBackslash,
  holdsUndecodableCharacterReference,
  isExternalUrl,
  parseSrcset,
  plausiblePathShape,
  provablyNotAFile,
  readAsUrl,
  spellingsOf,
  splitPathSuffix,
  templateExpressionReason,
  urlWithin,
} from './reference-path.js';
import { type ShapeId, whyFormatKept } from './shapes.js';
import { urlPosition } from './url-attributes.js';

type ParsedNode = DefaultTreeAdapterMap['node'];
type ParsedElement = DefaultTreeAdapterMap['element'];

/**
 * Which srcset row a candidate belongs to.
 *
 * `<source srcset>` is one row whatever its descriptors: the whole attribute is the
 * content there, and it fails as a unit. `<img srcset>` splits three ways because the
 * three fail separately: a `w` list is meaningless without the `sizes` attribute
 * beside it, an `x` list ignores `sizes` entirely, and a lone candidate with a
 * descriptor is the case that parses differently from both.
 */
function srcsetShape(tagName: string, descriptor: string, candidateCount: number): ShapeId {
  if (tagName === 'source') return 'html.source.srcset';
  if (candidateCount === 1 && descriptor !== '') return 'html.img.srcset.single';
  return descriptor.endsWith('w') ? 'html.img.srcset.w' : 'html.img.srcset.x';
}

/**
 * Text with its line endings as the HTML parser reads them. The specification's input stream
 * preprocessing turns each CR LF pair and each lone CR into one LF before tokenising, so no
 * value parse5 returns holds a CR.
 * https://html.spec.whatwg.org/multipage/parsing.html#preprocessing-the-input-stream
 */
function asTheParserReads(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * A single URL as a browser reads it from parse5's value: stripped at either end as
 * `urlWithin` strips it, and with every tab and line break inside it removed.
 */
function asTheUrlParserReads(value: string): string {
  return urlWithin(value, 0).text.replace(/[\t\n\r]/g, '');
}

/** Whether the path carries percent-encoding. */
function isPercentEncoded(raw: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(raw);
}

export const htmlAdapter: Adapter = defineAdapter({
  id: 'html',
  extensions: ['.html', '.htm'],

  findReferences({ file, text }): RawReference[] {
    // parse5 follows the HTML spec's error recovery, so there is no such thing as an
    // unparseable document and no error branch here.
    //
    // `scriptingEnabled: false`, where parse5 defaults to true. With the scripting flag set,
    // the HTML spec parses `<noscript>` content as raw text, so an `<img>` inside it never
    // becomes an element. `<noscript><img>` is the standard lazy-loading fallback: missed, it
    // would be left pointing at an original that `optimize --replace` removed, breaking the
    // one render that has no script to recover.
    const document = parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: false });

    const references: RawReference[] = [];
    walk(document, { file, text, references });
    return references.sort((a, b) => a.start - b.start);
  },
});

/** Where an HTML document holds comments, and text a page shows, as `[start, end)` offsets. */
export interface HtmlRegions {
  readonly comments: readonly (readonly [number, number])[];
  /**
   * The runs of text between tags, less the contents of `<script>` and `<style>`, which a
   * page runs or applies rather than shows.
   */
  readonly text: readonly (readonly [number, number])[];
}

/** Elements whose text a page does not show. */
const NOT_SHOWN: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * Where the comments and the shown text are in an HTML document, as offsets into `text`, read
 * with the options the adapter parses with. parse5 recovers from any error, so every text has
 * an answer.
 */
export function htmlRegions(text: string): HtmlRegions {
  const document = parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const comments: (readonly [number, number])[] = [];
  const shown: (readonly [number, number])[] = [];
  const visit = (node: ParsedNode, inside: string): void => {
    const location = 'sourceCodeLocation' in node ? node.sourceCodeLocation : undefined;
    if (node.nodeName === '#comment' && location) {
      comments.push([location.startOffset, location.endOffset]);
    }
    if (node.nodeName === '#text' && location && !NOT_SHOWN.has(inside)) {
      shown.push([location.startOffset, location.endOffset]);
    }
    const parent = isElement(node) ? node.tagName.toLowerCase() : inside;
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, parent);
    if ('content' in node) visit(node.content, parent);
  };
  visit(document, '');
  return { comments, text: shown };
}

interface Context {
  readonly file: string;
  readonly text: string;
  readonly references: RawReference[];
}

function walk(node: ParsedNode, context: Context): void {
  if (isElement(node)) {
    collectFromElement(node, context);
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      walk(child, context);
    }
  }
  // parse5 puts a template's markup in a separate `content` fragment, not among its children.
  // It is live all the same: a script clones it, and a declarative shadow root renders it.
  if ('content' in node) {
    walk(node.content, context);
  }
}

function isElement(node: ParsedNode): node is ParsedElement {
  return 'tagName' in node && 'attrs' in node;
}

function collectFromElement(element: ParsedElement, context: Context): void {
  const tagName = element.tagName.toLowerCase();

  if (tagName === 'style') {
    collectFromStyleElement(element, context);
  }

  // Elements the parser inferred rather than read (an implied <body>, say) have no
  // location, and therefore no attributes we could point at.
  const attributeLocations = element.sourceCodeLocation?.attrs;
  if (attributeLocations === undefined) return;

  for (const attribute of element.attrs) {
    // The location map is keyed by the source spelling, but parse5 splits a namespaced
    // attribute: `xlink:href` arrives as `{ name: 'href', prefix: 'xlink' }` while its
    // location sits under `'xlink:href'`. Looking up the bare name would skip it silently.
    const name = attribute.name.toLowerCase();
    const sourceName =
      attribute.prefix === undefined ? name : `${attribute.prefix.toLowerCase()}:${name}`;
    const location = attributeLocations[sourceName];
    if (location === undefined) continue;

    const range = attributeValueRange(context.text, location.startOffset, location.endOffset);
    if (range === null) continue; // A valueless attribute such as `hidden`.

    const raw = context.text.slice(range.start, range.end);

    // parse5 decodes character references, so `src="a&amp;b.png"` is 11 characters of
    // source and 7 of value, and no range into the source spells the decoded path. Only a
    // reference position may decide what that means, so the flag travels with the
    // attribute: deciding here would report every escaped `alt`, or `<meta content>` that
    // names no image, as a reference the engine could not handle. Line endings are compared
    // as the parser reads them, since a CR the parser dropped is not a character reference.
    // See "Character references in HTML attributes" in ARCHITECTURE.md.
    const entityEscaped = asTheParserReads(raw) !== attribute.value;

    collectFromAttribute({
      element,
      tagName,
      name: sourceName,
      raw,
      start: range.start,
      end: range.end,
      entityEscaped,
      // parse5's decoded value, carried so a style attribute can be read as the CSS a
      // browser sees, and so our bounded decoder can be checked against a complete one
      // before any offset derived from it is trusted.
      decodedValue: attribute.value,
      location,
      context,
    });
  }
}

/** Decide what one attribute is, now that its value has been located in the source. */
function collectFromAttribute(input: {
  element: ParsedElement;
  tagName: string;
  name: string;
  raw: string;
  start: number;
  end: number;
  /** parse5's value differs from the source text by more than its line endings. */
  entityEscaped: boolean;
  /** That decoded value, for the style branch, the one that can map offsets back. */
  decodedValue: string;
  /** Where parse5 found the attribute, from which the style branch places its value. */
  location: SourceStart;
  context: Context;
}): void {
  const {
    element,
    tagName,
    name,
    raw,
    start,
    end,
    entityEscaped,
    decodedValue,
    location,
    context,
  } = input;

  // A single URL is read as a browser reads it (see `urlWithin`). The range covers the URL
  // alone, so a rewrite leaves the whitespace around it in place.
  const url = urlWithin(raw, start);

  // Every URL-valued position below answers the character-reference question through this
  // one helper, so a new position gets the same answer. It drops another host's URL first,
  // as `addAttributeReference` does for an unescaped one: an entity in a query string
  // (`?w=1&amp;h=2`) does not make that file ours.
  const escaped = (shape: ShapeId | 'srcset'): void => {
    const isSrcset = shape === 'srcset';
    if (escapedIsSomebodyElses(isSrcset ? raw : url.text, isSrcset)) return;
    // A `srcset` is a list, so its one range is not one path and there is nothing to
    // decode for a lookup. It stays unsafe; only single-URL attributes are resolved decoded.
    if (isSrcset) {
      addEntityEscapedReference({ start, end }, context, 'path.charref');
      return;
    }
    const parsed = asTheUrlParserReads(decodedValue);
    // Refused only while some reading could name an image: `/avatar/AT&amp;T&x;` names none,
    // whatever `&x;` means, so it is kept as any other value is, and the resolver drops it.
    if (!attributeCouldNameAnImage(url.text, parsed)) {
      addAttributeReference(url.text, url.start, context, shape);
      return;
    }
    addCharacterReferenceReference(url.text, parsed, url, context, charrefShape(shape));
  };

  if (name === 'style') {
    if (entityEscaped) {
      // Not `escaped()`: a style attribute holds CSS, and the external-URL test reads
      // `width: 100%` as a URL scheme (letters, then a colon), which would drop the whole
      // attribute. A value that starts with a space slips past that test, so a test of
      // this branch needs one that does not.
      if (collectFromEscapedStyleAttribute(raw, decodedValue, start, context)) return;
      addStyleAttributeRefusal(raw, decodedValue, { start, end }, context);
      return;
    }
    collectFromStyleAttribute(raw, start, positionFrom(context.text, location, start), context);
    return;
  }

  const position = urlPosition(tagName, name, {
    attribute: (other) => attributeValue(element, other),
    valueText: () => url.text,
  });
  if (position === null) {
    declineAttributeValue(name, raw, start, asTheUrlParserReads(decodedValue), context);
    return;
  }

  if (position.html === 'srcset') {
    if (entityEscaped) {
      escaped('srcset');
      return;
    }
    const candidates = parseSrcset(raw);
    for (const candidate of candidates) {
      addAttributeReference(
        candidate.url,
        start + candidate.offset,
        context,
        srcsetShape(tagName, candidate.descriptor, candidates.length),
      );
    }
    return;
  }

  // A tab or line break inside the URL: `urlWithin` says why no range spells it.
  if (/[\t\n\r]/.test(url.text)) {
    addUrlWithLineBreakReference(url, context, position.html);
    return;
  }
  // Compared with parse5's value as the URL parser reads it, so the CR LF that ends a line
  // around the URL in a CRLF file is whitespace, not a sign of character references.
  if (url.text !== asTheUrlParserReads(decodedValue)) {
    escaped(position.html);
    return;
  }
  addAttributeReference(url.text, url.start, context, position.html);
}

/** Attributes a browser or a lazy-loading script loads an image from, which Upfly does not read. */
const NOT_READ_YET: ReadonlySet<string> = new Set(['data-src', 'data-srcset', 'imagesrcset']);

/** Of those, the ones that hold a candidate list, as `srcset` does. */
const SRCSET_LISTS: ReadonlySet<string> = new Set(['data-srcset', 'imagesrcset']);

/**
 * A path-shaped value naming an image in an attribute Upfly does not read on its element,
 * returned declined so the report counts it by attribute, as the JSX reader does: a
 * tooltip's `title`, an `alt`, a custom attribute, or one Upfly does not read (`NOT_READ_YET`). The resolver discards it; nothing links or rewrites it.
 */
function declineAttributeValue(
  name: string,
  raw: string,
  start: number,
  parserValue: string,
  context: Context,
): void {
  const note = NOT_READ_YET.has(name)
    ? `HTML attribute ${name}, which a browser or a lazy-loading script may load, and Upfly does not read`
    : `HTML attribute ${name}, which Upfly does not read as a file path on this element`;
  const values = SRCSET_LISTS.has(name)
    ? parseSrcset(raw).map((candidate) => ({ text: candidate.url, at: start + candidate.offset }))
    : [{ text: urlWithin(raw, start).text, at: urlWithin(raw, start).start }];
  for (const { text, at } of values) {
    const { path } = splitPathSuffix(text);
    if (path === '' || isExternalUrl(text, 'attr') || !plausiblePathShape(path)) continue;
    if (!attributeCouldNameAnImage(text, values.length === 1 ? parserValue : text)) continue;
    context.references.push({
      file: context.file,
      start: at,
      end: at + path.length,
      rawPath: path,
      kind: 'attr',
      shape: 'html.attribute.other',
      ceiling: 'unsafe',
      asserted: false,
      declined: true,
      note,
    });
  }
}

/**
 * The shape of a path spelled with character references at a position of this shape:
 * `path.charref`, because the spelling is what would break it, unless the position keeps
 * the file's format. That shape is where the planner reads that the reference is never
 * rewritten, so it outranks the spelling.
 */
function charrefShape(shape: ShapeId): ShapeId {
  return whyFormatKept(shape) === null ? 'path.charref' : shape;
}

function attributeValue(element: ParsedElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function collectFromStyleElement(element: ParsedElement, context: Context): void {
  for (const child of element.childNodes) {
    if (child.nodeName !== '#text') continue;
    const location = child.sourceCodeLocation;
    if (location === undefined || location === null) continue;

    const css = context.text.slice(location.startOffset, location.endOffset);

    // A `<style>` body built by a template (`{% if production %}`, as Eleventy, Jekyll,
    // Hugo, Nunjucks and Liquid sites inline conditional CSS) is not CSS yet, and PostCSS
    // would fail on it and fail the whole document. It is reported as unsafe instead, found
    // by `templateExpressionReason` as a templated path is.
    const templated = templateExpressionReason(css);
    if (templated !== null) {
      context.references.push({
        file: context.file,
        start: location.startOffset,
        end: location.endOffset,
        rawPath: css,
        kind: 'css-url',
        shape: 'html.style.element',
        ceiling: 'unsafe',
        asserted: false,
        unread: true,
        note: `a <style> block built by a template, so its CSS is not final: ${templated}`,
      });
      continue;
    }

    try {
      context.references.push(
        ...findCssReferences({
          file: context.file,
          text: css,
          baseOffset: location.startOffset,
          hostShape: 'html.style.element',
          startsAt: { line: location.startLine, column: location.startCol },
        }),
      );
    } catch (error) {
      // parse5 has already found where a closed element ends, so its CSS failing is that
      // element's alone, as in a browser, which drops only the rules it cannot read.
      if (error instanceof UpflyError && !isUnclosed(element)) {
        addStyleElementRefusal(css, location, error, context);
        continue;
      }
      throw styleElementFailure(element, context, error);
    }
  }
}

/** The rest of the message for an unclosed `<style>`, after the words naming the tag. */
const UNCLOSED_RAWTEXT =
  'is never closed, so everything after it is inside the stylesheet rather than being markup. A ' +
  'browser reads this document the same way and renders nothing below that point. Close the tag, ' +
  'or write &lt;style&gt; if the word was meant as text.';

/**
 * Turn a CSS parse failure inside an unclosed `<style>` into an error about the user's
 * document, naming the tag and its line.
 *
 * An unclosed `<style>` is not an engine defect: in HTML every character is markup, so it
 * opens a raw-text element that runs to the end of the document, as it does in a browser.
 * Masking the tag, as `maskUnclosedRawText` does for Markdown prose, would disagree with
 * the browser about what the page renders.
 *
 * The error carries the references found before the failure as `partial`. `scan` still
 * reports the file as `parse-failed` and keeps them, since losing the correct references
 * above the tag would make their assets look dead.
 */
function styleElementFailure(element: ParsedElement, context: Context, error: unknown): UpflyError {
  const partial = [...context.references];
  if (!(error instanceof UpflyError)) {
    throw error;
  }

  const line = element.sourceCodeLocation?.startTag?.startLine;
  const where = line === undefined ? 'A <style>' : `The <style> on line ${line}`;
  return new UpflyError(
    'ADAPTER_PARSE_FAILED',
    `${where} ${UNCLOSED_RAWTEXT}`,
    partial,
    error.diagnostic,
  );
}

/** Whether parse5 found no end tag, so the element runs to the end of the document. */
function isUnclosed(element: ParsedElement): boolean {
  const location = element.sourceCodeLocation;
  return (
    location !== undefined &&
    location !== null &&
    (location.endTag === null || location.endTag === undefined)
  );
}

/**
 * A closed `<style>` element whose CSS does not parse, refused as one construct with a note
 * saying whether it could hide a reference. The rest of the document is still read.
 */
function addStyleElementRefusal(
  css: string,
  location: { readonly startOffset: number; readonly endOffset: number },
  error: UpflyError,
  context: Context,
): void {
  context.references.push({
    file: context.file,
    start: location.startOffset,
    end: location.endOffset,
    rawPath: css,
    kind: 'css-url',
    shape: 'html.style.element',
    ceiling: 'unsafe',
    asserted: false,
    unread: true,
    note: `could not parse the <style> element: ${error.message}${describeUrlFunction(css)}`,
  });
}

/**
 * An entity-escaped style attribute that `collectFromEscapedStyleAttribute` could not read,
 * reported as unsafe with a note saying whether it could hide a reference.
 */
function addStyleAttributeRefusal(
  css: string,
  parserValue: string,
  range: { start: number; end: number },
  context: Context,
): void {
  context.references.push({
    file: context.file,
    start: range.start,
    end: range.end,
    rawPath: css,
    kind: 'css-url',
    shape: 'html.style.attribute',
    ceiling: 'unsafe',
    asserted: false,
    unread: true,
    // Asked of parse5's value, the CSS a browser reads: `url&#40;` is a `url(` there.
    note: `the style attribute contains HTML character references, so its CSS cannot be handed to the parser with offsets that hold${describeUrlFunction(parserValue)}`,
  });
}

/**
 * The end of the note for CSS the adapter could not read, shared by the style attribute,
 * escaped or unparseable, and the `<style>` element, so they cannot drift: it says whether
 * the CSS holds a url-taking function. Without one the note ends with
 * `NO_REFERENCE_TO_FIND`, which `report.ts` reads to count the refusal as correct.
 */
function describeUrlFunction(css: string): string {
  return CSS_URL_FUNCTION.test(css)
    ? '; it contains a url-taking function, so a reference may be hidden in it'
    : `; it contains no url() or image-set(), so ${NO_REFERENCE_TO_FIND}`;
}

/**
 * A style attribute whose CSS is spelled with character references, read properly.
 *
 * In `style="background-image: url(&quot;/logo.png&quot;)"` only the delimiters are encoded
 * and the path is plain in the source, so the CSS is decoded for the parser and each
 * reference is mapped back to source offsets. Three guards must hold, or the caller refuses
 * the whole attribute, so the worst case is a refusal and never a wrong range:
 * 1. Our decoder finishes. A name the HTML spec does not define, such as `&eacut;`, stops it.
 * 2. Our decoded text equals parse5's, which also decodes legacy names without a semicolon:
 *    where the two differ, our offsets would describe text the browser never saw.
 * 3. Each mapped range starts within the attribute, runs forwards, and decodes to the path
 *    the CSS adapter found.
 *
 * @returns `true` when it handled the attribute, `false` to let the caller refuse it.
 */
function collectFromEscapedStyleAttribute(
  raw: string,
  parserValue: string,
  baseOffset: number,
  context: Context,
): boolean {
  const decoded = decodeCharacterReferencesWithMap(raw);
  if (decoded === null) return false;
  // Guard 2: agree with parse5, which also decodes legacy names without their semicolon. Its
  // value holds no CR, so line endings are compared as it reads them.
  if (asTheParserReads(decoded.text) !== parserValue) return false;

  let found: RawReference[];
  try {
    found = findCssReferences({
      file: context.file,
      text: decoded.text,
      hostShape: 'html.style.attribute',
    });
  } catch {
    // A malformed declaration list is the caller's to report, with its url() test.
    return false;
  }

  const remapped: RawReference[] = [];
  for (const reference of found) {
    const start = baseOffset + (decoded.map[reference.start] ?? -1);
    const end = baseOffset + (decoded.map[reference.end] ?? -1);
    if (start < baseOffset || end < start) return false;

    const rawPath = context.text.slice(start, end);
    // Guard 3: the source range, decoded, must be the path the CSS reader found, so a map
    // that is off by any amount is refused rather than trusted.
    if (decodeCharacterReferencesWithMap(rawPath)?.text !== reference.rawPath) return false;

    remapped.push({ ...reference, start, end, rawPath });
  }

  context.references.push(...remapped);
  return true;
}

function collectFromStyleAttribute(
  css: string,
  baseOffset: number,
  startsAt: { line: number; column: number },
  context: Context,
): void {
  try {
    context.references.push(
      ...findCssReferences({
        file: context.file,
        text: css,
        baseOffset,
        hostShape: 'html.style.attribute',
        startsAt,
      }),
    );
  } catch (error) {
    // A malformed inline style must not take down the document, and must not vanish
    // either, so it is reported as unsafe. Its note says whether the CSS holds a
    // url-taking function, because the two cases are opposite outcomes: without one there
    // is nothing to find and the refusal is correct (an author's missing colon, or an
    // Astro `style={{…}}` object); with one, a reference may be hidden. The engine decides
    // this once, here, so no consumer has to derive it from the parser's message.
    context.references.push({
      file: context.file,
      start: baseOffset,
      end: baseOffset + css.length,
      rawPath: css,
      kind: 'css-url',
      shape: 'html.style.attribute',
      ceiling: 'unsafe',
      asserted: false,
      unread: true,
      note: `could not parse the style attribute: ${
        error instanceof UpflyError ? error.message : String(error)
      }${describeUrlFunction(css)}`,
    });
  }
}

/**
 * The end of a refusal's note when the CSS holds no url-taking function. The report reads it
 * to count such a refusal as correct, so the adapter and the report share this one string.
 */
export const NO_REFERENCE_TO_FIND = 'there is no reference in it to find';

/**
 * The CSS functions that take a file path, to decide whether an unparseable declaration
 * list could hide a reference.
 *
 * They are the ones the CSS adapter collects: `url()` and `image-set()`, vendor prefixes
 * included. A bare quoted string is a reference only in a preprocessor variable, which a
 * `style` attribute cannot hold. If the CSS adapter learns another position, add it here.
 */
const CSS_URL_FUNCTION = /\b(?:url|(?:-[a-z]+-)?image-set)\s*\(/i;

/** The start of something parse5 located, as its source location records it (1-based). */
interface SourceStart {
  readonly startLine: number;
  readonly startCol: number;
  readonly startOffset: number;
}

/** The 1-based line and column of `offset`, counted on from a start parse5 recorded before it. */
function positionFrom(
  text: string,
  from: SourceStart,
  offset: number,
): { line: number; column: number } {
  const between = text.slice(from.startOffset, offset);
  const lastNewline = between.lastIndexOf('\n');
  if (lastNewline === -1) return { line: from.startLine, column: from.startCol + between.length };
  const newlines = between.split('\n').length - 1;
  return { line: from.startLine + newlines, column: between.length - lastNewline };
}

/**
 * Locate the value inside an attribute's source range.
 *
 * parse5 gives the range of the whole `name="value"`, so the quotes have to be
 * stepped over here. Unquoted values (`src=hero.png`) run to the end of the range.
 */
function attributeValueRange(
  text: string,
  startOffset: number,
  endOffset: number,
): { start: number; end: number } | null {
  const attribute = text.slice(startOffset, endOffset);
  const equals = attribute.indexOf('=');
  if (equals === -1) return quotedValueAfterName(text, endOffset);

  let index = equals + 1;
  while (index < attribute.length && /\s/.test(attribute.charAt(index))) index += 1;

  const quote = attribute.charAt(index);
  if (quote === '"' || quote === "'") {
    return { start: startOffset + index + 1, end: startOffset + attribute.length - 1 };
  }
  return { start: startOffset + index, end: endOffset };
}

/** Whitespace as the HTML tokenizer reads it, then `=`, then an opening quote. */
const EQUALS_THEN_QUOTE = /[\t\n\f\r ]*=[\t\n\f\r ]*(["'])/y;

/**
 * The quoted value an attribute's range leaves out.
 *
 * When the next attribute follows the closing quote with no space, as in
 * `<img src="a.png"alt="">`, the specification still ends the value at the quote and
 * parse5 still reads it, but the range parse5 records for the attribute ends at its name.
 * A valueless attribute such as `hidden` has no `=` after its name.
 */
function quotedValueAfterName(
  text: string,
  nameEnd: number,
): { start: number; end: number } | null {
  EQUALS_THEN_QUOTE.lastIndex = nameEnd;
  const quote = EQUALS_THEN_QUOTE.exec(text)?.[1];
  if (quote === undefined) return null;
  const start = EQUALS_THEN_QUOTE.lastIndex;
  const end = text.indexOf(quote, start);
  return end === -1 ? null : { start, end };
}

/**
 * Whether an entity-escaped attribute names nothing of ours, so there is no path we are
 * failing to locate.
 *
 * A `srcset` is a list and is asked candidate by candidate, because one external URL
 * beside a local path does not make the attribute external. A `style` attribute must
 * never reach this test; see the style branch of `collectFromAttribute`.
 */
function escapedIsSomebodyElses(raw: string, isSrcset: boolean): boolean {
  if (!isSrcset) return isExternalUrl(raw, 'attr');
  const candidates = parseSrcset(raw);
  return (
    candidates.length > 0 && candidates.every((candidate) => isExternalUrl(candidate.url, 'attr'))
  );
}

/**
 * A URL-valued attribute whose path is spelled with character references.
 *
 * The range covers the encoded source text and `rawPath` is that text, so the range
 * invariant holds; the resolver also tries the decoded spelling, and `relocate` re-encodes
 * when it writes. `/gallery/a&amp;b.png` names `a&b.png` and can be rewritten.
 *
 * That needs the decoded spelling to be parse5's reading, which a legacy name without its
 * semicolon breaks, and complete, which a percent-escape beside the references or made by
 * them breaks. A `high` ceiling means a lookup that can report `broken`, so any other path
 * stays `unsafe`.
 */
function addCharacterReferenceReference(
  raw: string,
  parserValue: string,
  range: { start: number; end: number },
  context: Context,
  shape: ShapeId,
): void {
  const decoded = spellingsOf(raw, 'attr').find(({ spelling }) => spelling === 'html-entities');
  const decodable =
    decoded?.path === readAsUrl(parserValue, 'attr') &&
    !holdsUndecodableCharacterReference(splitPathSuffix(raw).path);
  if (!decodable) {
    addEntityEscapedReference(range, context, shape, readAsUrl(parserValue, 'attr'));
    return;
  }

  context.references.push({
    file: context.file,
    start: range.start,
    end: range.end,
    rawPath: raw,
    kind: 'attr',
    shape,
    ceiling: 'high',
    asserted: true,
    note: 'the path is spelled with HTML character references; it is resolved decoded and rewritten re-encoded',
  });
}

/**
 * @param shape `path.charref` wherever the spelling outranks the attribute, as it does for
 *   an absolute URL: the spelling is what would break this reference. See `charrefShape`.
 */
function addEntityEscapedReference(
  range: { start: number; end: number },
  context: Context,
  shape: ShapeId,
  /**
   * The path a browser reads there, parse5's value, for one URL: it travels for the name search
   * to hedge by. Absent for a `srcset`, whose one range holds a list rather than a path.
   */
  browserReads?: string,
): void {
  context.references.push({
    file: context.file,
    start: range.start,
    end: range.end,
    rawPath: context.text.slice(range.start, range.end),
    ...(browserReads === undefined ? {} : { assembledPath: splitPathSuffix(browserReads).path }),
    kind: 'attr',
    shape,
    ceiling: 'unsafe',
    asserted: true,
    note: 'contains HTML character references, so the path text cannot be located exactly',
  });
}

/**
 * A single URL with a tab or line break inside it, which the URL parser removes, so no range
 * of the source spells the path a browser reads and the reference stays unsafe. Another
 * host's URL is dropped first, as everywhere else.
 */
function addUrlWithLineBreakReference(
  range: { start: number; end: number },
  context: Context,
  shape: ShapeId,
): void {
  const rawPath = context.text.slice(range.start, range.end);
  if (isExternalUrl(rawPath, 'attr')) return;
  context.references.push({
    file: context.file,
    start: range.start,
    end: range.end,
    rawPath,
    kind: 'attr',
    shape,
    ceiling: 'unsafe',
    asserted: true,
    note: URL_LINE_BREAK_REASON,
  });
}

function addAttributeReference(raw: string, start: number, context: Context, shape: ShapeId): void {
  if (raw === '') return;
  if (isExternalUrl(raw, 'attr')) return;
  // Like the external-URL test, this asks whether a file of ours could be at the end of the
  // path at all. It runs before the template test, so a templated path that provably names
  // no file (`{{ base }}/`) is dropped rather than reported as dynamic.
  if (provablyNotAFile(raw) !== null) return;

  const reason = templateExpressionReason(raw);
  if (reason !== null) {
    context.references.push({
      file: context.file,
      start,
      end: start + raw.length,
      rawPath: raw,
      kind: 'attr',
      shape,
      ceiling: 'unsafe',
      asserted: true,
      note: reason,
    });
    return;
  }

  const { path, suffix } = splitPathSuffix(raw);
  if (path === '') return;
  // A `%5C` is a folder separator only to a Windows server, so which file loads depends on
  // the site. It is refused, with its image left to the name search, never rewritten.
  const encodedBackslash = holdsEncodedBackslash(path);

  context.references.push({
    file: context.file,
    start,
    // The range covers the path alone, so a rewrite preserves the author's `?v=2`.
    end: start + path.length,
    rawPath: path,
    kind: 'attr',
    // The encoding outranks the attribute, as it does for `path.absolute-url`: what would
    // break a percent-encoded path (a filename with spaces, say) is the decoder, not `<img src>`.
    // A position that keeps the file's format outranks both, as in `charrefShape`.
    shape: isPercentEncoded(path) && whyFormatKept(shape) === null ? 'html.percent-encoded' : shape,
    ceiling: encodedBackslash ? 'unsafe' : 'high',
    asserted: true,
    ...(encodedBackslash
      ? { note: ENCODED_BACKSLASH_REASON }
      : suffix === ''
        ? {}
        : { note: `query or fragment preserved: ${suffix}` }),
  });
}
