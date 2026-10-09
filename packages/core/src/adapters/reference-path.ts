/**
 * Small syntactic judgements about a reference path, shared by every adapter.
 *
 * Nothing here resolves a path or asks whether a file exists: these functions read only
 * the text an author wrote, which is all an adapter may do.
 */

import { parseFragment } from 'parse5';
import { extensionOf, isImageExtension } from '../paths.js';
import type { RawReference, ReferenceKind } from '../types.js';

/**
 * A URL scheme: a letter, then letters, digits, `+`, `-` or `.`, then a colon. A relative
 * path would need a colon before its first slash to match, which nobody writes on purpose.
 * A Windows drive path matches as well, so `isExternalUrl` rules a drive out first.
 */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** One letter, a colon, then a slash or a backslash. */
const DRIVE_PATH = /^[a-zA-Z]:[\\/]/;

/**
 * Whether a path starts at a Windows drive, as `C:/site/hero.png` and `C:\site\hero.png` do.
 * It names a place on one machine's disk, so it is never a URL scheme, a package or an
 * alias; the resolver decides whether that place is inside the project.
 */
export function isDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path);
}

/**
 * Whether a reference points somewhere other than a file in this project: a `data:` URI,
 * a URL with a scheme such as `https:`, a protocol-relative `//cdn/x.png`, or a
 * `#fragment` such as `url(#gradient)`, which names an element in the same document.
 *
 * Adapters drop these without a report line. They were never candidate asset references,
 * and reporting `url(data:image/png;base64,…)` as broken would be wrong. A Windows drive
 * path is not one of them: a browser reads `C:` as a scheme, but it names a file on a disk,
 * which is reported rather than dropped.
 *
 * @param kind Required because a leading `#` depends on it. In a module specifier
 * (`'import'`), `#internal/a.png` is a Node subpath import, which the resolver handles as
 * an alias; anywhere else it is a fragment. A default would let a call site keep the wrong
 * reading silently.
 */
export function isExternalUrl(rawPath: string, kind: ReferenceKind): boolean {
  if (rawPath.startsWith('#')) {
    if (kind === 'import') return false;
    // A `#` that opens a template hole, as in the SCSS `#{$dir}/hero.png`, starts a path
    // being built. Kept, it is reported as dynamic; dropped here, it would vanish.
    return !opensTemplateHole(rawPath);
  }
  if (isDrivePath(rawPath)) return false;
  // In an attribute `\\cdn/x.png` is protocol-relative, as the URL parser reads it. In a
  // Markdown destination `\\` is one escaped backslash, so its text is not read this way.
  const url = readAsUrl(rawPath, kind);
  return url.startsWith('//') || URL_SCHEME.test(rawPath);
}

/**
 * A path as the URL parser reads it where the text reaches that parser as written: in an HTML
 * or JSX attribute or a `new URL` name, a backslash is a slash on every platform, so
 * `img\photo.png` loads `img/photo.png`. Most Markdown renderers write a backslash as `%5C`,
 * which the parser keeps, CSS reads one as an escape, and a JavaScript string writes one only
 * as an escape, so their kinds keep it as written.
 */
export function readAsUrl(path: string, kind: ReferenceKind): string {
  return kind === 'attr' ? path.replaceAll('\\', '/') : path;
}

/**
 * Why a Markdown destination holding a backslash is `unsafe`, worded for the report. Most
 * renderers write one that CommonMark keeps as `%5C`, and only a renderer that passes it
 * through, or a Windows server, reads it as a folder separator.
 */
export const MARKDOWN_BACKSLASH_REASON =
  'the path holds a backslash, which only some Markdown renderers and Windows servers read as a folder separator, so on most sites the image would not load; write / between folders';

/**
 * Why a URL holding `%5C`, an encoded backslash, is `unsafe`, worded for the report. A browser
 * keeps it as written, so a Windows server reads a folder separator and any other a file with
 * a backslash in its name.
 */
export const ENCODED_BACKSLASH_REASON =
  'the path holds %5C, an encoded backslash, which only a Windows server reads as a folder separator, so on most sites the image would not load; write / between folders';

/**
 * Whether a URL's path holds `%5C`, in either case, while a reading of it ends in an image
 * extension, as written or percent-decoded. An adapter refuses such a URL with
 * `ENCODED_BACKSLASH_REASON`; one that names no image is left to the resolver, which drops it.
 */
export function holdsEncodedBackslash(path: string): boolean {
  if (!ENCODED_BACKSLASH.test(path)) return false;
  return [path, decodePercent(path)].some(
    (reading) => reading !== null && isImageExtension(extensionOf(reading)),
  );
}

const ENCODED_BACKSLASH = /%5c/i;

/**
 * Whether a Markdown destination, as CommonMark reads it, holds a backslash: one before
 * anything but ASCII punctuation, one escaped as `\\`, or one written as `&#92;`. CommonMark
 * removes only the backslash that escapes punctuation, so `my\_photo.png` holds none.
 */
export function markdownReadingHoldsBackslash(path: string): boolean {
  return (decodeMarkdownDestination(path, true) ?? path).includes('\\');
}

/**
 * A URL's text and range within a value, without the C0 controls and spaces at either end,
 * which the URL parser strips before it reads a URL. The parser also removes every tab and
 * line break inside a URL, which leaves no range that spells what it reads, so an adapter
 * keeps such a reference `unsafe` with `URL_LINE_BREAK_REASON`.
 * https://url.spec.whatwg.org/#concept-basic-url-parser
 *
 * @param valueStart The value's offset in the file, so the range is an offset in the file too.
 */
export function urlWithin(
  value: string,
  valueStart: number,
): { readonly text: string; readonly start: number; readonly end: number } {
  let from = 0;
  let to = value.length;
  while (from < to && value.charCodeAt(from) <= 0x20) from += 1;
  while (to > from && value.charCodeAt(to - 1) <= 0x20) to -= 1;
  return { text: value.slice(from, to), start: valueStart + from, end: valueStart + to };
}

/** Why a URL with a tab or line break inside it is `unsafe`, worded for the report. */
export const URL_LINE_BREAK_REASON =
  'contains a tab or line break, which a browser removes from a URL, so the path text cannot be located exactly';

/**
 * One way of writing a hole in a path: text that a template engine, a preprocessor or a
 * template literal replaces before the path is used.
 */
export interface TemplateHole {
  /** The text that opens the hole, such as `${`. */
  readonly opener: string;
  /** The text that closes it, such as `}`. */
  readonly closer: string;
  /** What to call it in a report reason, such as "a template literal expression". */
  readonly name: string;
  /**
   * Whether the resolver globs it. Only JavaScript, SCSS and Less paths are marked as
   * patterns by their adapters; a path holding any other hole is `unsafe`, so it is
   * `dynamic` without ever reaching the glob.
   */
  readonly globbed: boolean;
}

/**
 * Every syntax that stands for an unknown part of a path. Each rule in this file that reads
 * holes derives them from this list, and so do `couldHoldReference`'s tokens and the
 * markdown adapter's link pattern, so a syntax added here reaches all of them. A rule that
 * missed one would read the hole's text as part of the path: `hero.@{ext}` would have the
 * extension `.@{ext}`, which rules out an image. `templateExpressionReason` names the first
 * hole a path holds, in this order.
 */
export const TEMPLATE_HOLES: readonly TemplateHole[] = Object.freeze([
  {
    opener: '{{',
    closer: '}}',
    name: 'a Handlebars, Mustache, Vue or Jinja expression',
    globbed: false,
  },
  { opener: '{%', closer: '%}', name: 'a Liquid, Jinja or Nunjucks tag', globbed: false },
  { opener: '<%', closer: '%>', name: 'an EJS or ERB expression', globbed: false },
  { opener: '${', closer: '}', name: 'a template literal expression', globbed: true },
  { opener: '#{', closer: '}', name: 'an interpolation', globbed: true },
  { opener: '@{', closer: '}', name: 'a Less interpolation', globbed: true },
]);

/**
 * One hole as regular-expression source: its opener, anything but the first character of
 * its closer, then its closer.
 */
function holeSource({ opener, closer }: TemplateHole): string {
  return `${escapeRegExp(opener)}[^${escapeRegExp(closer.charAt(0))}]*${escapeRegExp(closer)}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every hole in any syntax, as regular-expression source with no capturing group. */
export const TEMPLATE_HOLE_PATTERN: string = TEMPLATE_HOLES.map(holeSource).join('|');

const ANY_TEMPLATE_HOLE = new RegExp(TEMPLATE_HOLE_PATTERN, 'g');

/**
 * The extension a path shows statically, lowercased, or `''` when it has none or a
 * template hole hides it.
 *
 * `components/ui/${name}.tsx` shows `.tsx`. `/view/${style}/${name}` shows nothing, and
 * neither does `hero.${ext}`, where the hole is the extension.
 */
export function staticExtensionOf(rawPath: string): string {
  const { path } = splitPathSuffix(rawPath);
  const flattened = path.replace(ANY_TEMPLATE_HOLE, '*');
  const extension = flattened.slice(flattened.lastIndexOf('.'));

  if (!extension.startsWith('.')) return '';
  // A hole in the extension leaves it unknown, not ruled out: `hero.${ext}` could be
  // `hero.png`.
  if (extension.includes('*') || extension.includes('/')) return '';
  return extension.toLowerCase();
}

/**
 * Split a trailing `?query` or `#fragment` off a path, so `hero.png?v=2` becomes
 * `hero.png` and `?v=2`. A reference's range covers the path alone, and a rewrite leaves
 * the suffix where the author put it.
 */
export function splitPathSuffix(rawPath: string): { path: string; suffix: string } {
  // A leading `#` is the prefix of a Node subpath import, not a fragment. A leading `?`
  // still splits, leaving an empty path: a bare query names no file.
  const from = rawPath.startsWith('#') ? 1 : 0;

  // A `?` or `#` inside an unknown segment or a character reference is not a delimiter:
  // `${config?.style}` is an optional chain, `#{$mode}` a SCSS interpolation and `&#38;`
  // an escaped `&`. The mask hides them while every index stays valid in `rawPath`.
  const masked = maskUnknownSegments(rawPath);
  const index = masked.slice(from).search(/[?#]/);
  if (index === -1) return { path: rawPath, suffix: '' };
  return { path: rawPath.slice(0, from + index), suffix: rawPath.slice(from + index) };
}

/**
 * A same-length copy of `rawPath` with every unknown segment and character reference
 * blanked out, so a delimiter search cannot land inside one and its offsets still index
 * `rawPath`. Keep `'\u0000'` an escape: a raw NUL byte makes git and grep treat this file
 * as binary.
 */
function maskUnknownSegments(rawPath: string): string {
  return rawPath
    .replace(ANY_TEMPLATE_HOLE, (match) => '\u0000'.repeat(match.length))
    .replace(CHARACTER_REFERENCE, (match) => '\u0000'.repeat(match.length));
}

/**
 * A numeric or named character reference. Its `#` is not a fragment delimiter: splitting
 * `/gallery/a&#38;b.png` there would leave `/gallery/a&`, which has no extension.
 */
const CHARACTER_REFERENCE = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * The holes the resolver globs, one expression each, in `TEMPLATE_HOLES` order. Adapters
 * that read a path as text decide its ceiling from these (through `interpolationChunks`)
 * and the resolver's `matchPattern` globs them, so both read this one subset.
 */
export const INTERPOLATIONS: readonly RegExp[] = Object.freeze(
  TEMPLATE_HOLES.filter((hole) => hole.globbed).map((hole) => new RegExp(holeSource(hole), 'g')),
);

/**
 * The literal text between a path's unknown segments, in any of the `INTERPOLATIONS`
 * syntaxes: the chunks `assembledPathIsGlobbable` takes, read from the written text.
 */
export function interpolationChunks(rawPath: string): readonly string[] {
  let marked = rawPath;
  for (const pattern of INTERPOLATIONS) marked = marked.replace(pattern, '\u0000');
  return marked.split('\u0000');
}

/**
 * Whether an assembled path fixes enough to be matched against the files that exist.
 *
 * A pattern needs a fixed directory, because location is what makes an asset unique:
 * `${base}/hero.png` is refused however specific the rest is. It also needs at most one
 * unknown segment in the file name, since `/icons/${theme}-${size}.png` would claim
 * `icon-192.png` and `icon-512.png` while constraining almost nothing. Taking chunks
 * rather than a string lets a template literal's `quasis` and an interpolated CSS path
 * share the rule. See "The resolver's seven outcomes" in ARCHITECTURE.md.
 *
 * @param chunks the literal text between the unknown segments, in order. A path with one
 * interpolation has two chunks; either may be empty.
 */
export function assembledPathIsGlobbable(chunks: readonly string[]): boolean {
  const first = chunks[0] ?? '';
  if (!first.includes('/')) return false;

  let unknownsInName = 0;
  for (const [index, chunk] of chunks.entries()) {
    // Every chunk but the first is preceded by an unknown segment.
    if (index > 0) unknownsInName += 1;
    // A `/` here starts the filename again, so what was counted so far sat in a
    // directory segment rather than in the name.
    if (chunk.includes('/')) unknownsInName = 0;
  }

  return unknownsInName <= 1;
}

/** Why a path that fails `assembledPathIsGlobbable` is refused, worded for the report. */
export const NOT_GLOBBABLE_REASON =
  'too little of the path is fixed to match files safely; a pattern needs a fixed directory and at most one unknown part in the file name';

/**
 * How a path is spelled in the source: as written, percent-encoded (`hero%20image.png`),
 * with HTML character references (`a&amp;b.png`), or, in a Markdown destination, with
 * backslash escapes (`my\_photo.png`).
 *
 * The resolver tries the literal spelling first, then each decoded one, and records the
 * spelling that matched, so a rewrite writes the new path back the same way (`spell`).
 * See "Percent-encoded and entity-encoded paths" in ARCHITECTURE.md.
 */
export type PathSpelling = 'literal' | 'percent-encoded' | 'html-entities' | 'markdown-escapes';

/** What a reference's text is read in, when its kind alone cannot say: the kind and shape. */
export type ReadingPosition = Pick<RawReference, 'kind' | 'shape' | 'host'>;

/** Whose character references a reader decodes: HTML's rules, or CommonMark's. */
type CharacterReferenceReading = 'html' | 'commonmark';

/**
 * Which character references the reader of a reference's text decodes, or `null` for none.
 * An HTML parser decodes an attribute, the CSS inside a style attribute and, as JSX does, a
 * JSX attribute's string; CommonMark decodes a Markdown destination. A stylesheet, a
 * `<style>` body, a `new URL` name, JavaScript and JSON decode none, so `caf&eacute;.png`
 * there is the name a browser asks for.
 */
function characterReferencesReadIn(
  read: ReferenceKind | ReadingPosition,
): CharacterReferenceReading | null {
  const { kind, shape, host } =
    typeof read === 'string' ? { kind: read, shape: null, host: undefined } : read;
  if (kind === 'md') return 'commonmark';
  if (kind === 'attr') return shape === 'js.new-url' ? null : 'html';
  if (kind !== 'css-url') return null;
  // CSS a style attribute holds is decoded as the attribute is, whichever construct of its
  // own, such as `image-set()`, gave the reference its shape.
  const holder = host ?? shape;
  return holder === 'html.style.attribute' || holder === 'md.style-attribute' ? 'html' : null;
}

const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * What each named reference looked up so far stands for. Only names the table defines are
 * kept, so the cache is bounded by the table rather than by the text read.
 */
const NAMED_REFERENCES = new Map<string, string>();

/**
 * The text a named character reference such as `&eacute;` stands for, or `null` when the
 * HTML specification defines no such name.
 *
 * The table is parse5's, which is the specification's, and CommonMark decodes the same
 * names in a link destination. The name is decoded inside an attribute value, where it
 * counts only whole and with its semicolon, as in CommonMark: there `&notit;` stays as
 * written, where a document's text would decode the legacy `&not` in it.
 */
function decodeNamedReference(name: string): string | null {
  const known = NAMED_REFERENCES.get(name);
  if (known !== undefined) return known;

  const [element] = parseFragment(`<i title="&${name};">`).childNodes;
  const value = element !== undefined && 'attrs' in element ? element.attrs[0]?.value : undefined;
  if (value === undefined || value === `&${name};`) return null;
  NAMED_REFERENCES.set(name, value);
  return value;
}

/**
 * Every spelling this path could be, literal first.
 *
 * Returns only the literal spelling when nothing is encoded, and never a partly decoded
 * path: text the decoder cannot finish contributes no candidate.
 *
 * @param read The reference, or its kind alone, which reads an attribute as HTML's and a
 * `css-url` as a stylesheet's. It picks the decoder. Only in a Markdown destination (`'md'`)
 * is a backslash before ASCII punctuation an escape, decoded with the character references in
 * one pass, as CommonMark reads it. A backslash left after that is a slash in an attribute's
 * URL, as the URL parser reads it, and is kept as written anywhere else; one a percent-escape
 * decodes to is kept everywhere, since a browser keeps `%5C` as written.
 * Required, because a call that left it out would lose a spelling without a word.
 */
export function spellingsOf(
  rawPath: string,
  read: ReferenceKind | ReadingPosition,
): ReadonlyArray<{
  readonly spelling: PathSpelling;
  readonly path: string;
}> {
  const candidates: { spelling: PathSpelling; path: string }[] = [
    { spelling: 'literal', path: rawPath },
  ];

  const kind = typeof read === 'string' ? read : read.kind;
  const reading = characterReferencesReadIn(read);
  const escaped = kind === 'md' && holdsBackslashEscape(rawPath);
  const decoded = escaped
    ? decodeMarkdownDestination(rawPath)
    : reading === null
      ? rawPath
      : decodeCharacterReferences(rawPath, reading);
  if (decoded !== null && decoded !== rawPath) {
    candidates.push({ spelling: escaped ? 'markdown-escapes' : 'html-entities', path: decoded });
  }

  // The URL parser reads a backslash in an attribute as a slash before a server decodes any
  // percent-escape, so the escapes are decoded from that reading, and a `%5C` stays a backslash.
  const asUrl = readAsUrl(rawPath, kind);
  const percent = decodePercent(asUrl);
  if (percent !== null && percent !== asUrl) {
    candidates.push({ spelling: 'percent-encoded', path: percent });
  }

  // Read last, so a character reference is decoded before its backslash could become a slash.
  // A spelling that then reads as an earlier one adds nothing to try.
  const urls: { spelling: PathSpelling; path: string }[] = [];
  for (const { spelling, path } of candidates) {
    const url = spelling === 'percent-encoded' ? path : readAsUrl(path, kind);
    if (!urls.some((earlier) => earlier.path === url)) urls.push({ spelling, path: url });
  }
  return urls;
}

/**
 * Write `path` back in `spelling`, so a rewritten reference reads the way the author
 * wrote it, and reads as `path` to the reader `spellingsOf` names.
 *
 * A rewrite builds the new text from the path on disk, so without this a file called
 * `hero image.png`, referenced as `hero%20image.png`, would be rewritten with a raw space.
 *
 * @param read The reference, or its kind alone, as `spellingsOf` takes it. A Markdown
 * destination has a syntax of its own. Required, because a call that left it out would write
 * a destination that ends early without a word.
 */
export function spell(
  path: string,
  spelling: PathSpelling,
  read: ReferenceKind | ReadingPosition,
): string {
  if ((typeof read === 'string' ? read : read.kind) === 'md') {
    return spellDestination(path, spelling);
  }
  const written = spelledAs(path, spelling);
  const unheld = typeof read === 'string' ? null : unheldIn(read.shape);
  // The whole path encoded, not only the character, since a reader decodes one way or the
  // other and never both: a `%20` already in the name would otherwise be read as a space.
  return unheld?.test(written) === true ? fullyPercentEncoded(path) : written;
}

function spelledAs(path: string, spelling: PathSpelling): string {
  switch (spelling) {
    case 'literal':
      return path;
    case 'percent-encoded':
      // Per segment: encoding `/` would turn the path into one oddly named file.
      return path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    case 'html-entities':
      // Only `&` is re-encoded. Inventing entities for the other characters would change
      // text the author did not write.
      return path.replaceAll('&', '&amp;');
    case 'markdown-escapes':
      // CommonMark would read a backslash or an ampersand as the start of an escape or a
      // character reference, so each is escaped with a backslash.
      return path.replace(/[\\&]/g, (character) => `\\${character}`);
    default:
      return path;
  }
}

/** Shapes whose URL is one candidate of a `srcset`, which ends at whitespace or a comma. */
const SRCSET_SHAPES: ReadonlySet<string> = new Set([
  'html.img.srcset.single',
  'html.img.srcset.x',
  'html.img.srcset.w',
  'html.source.srcset',
  'js.jsx.srcset',
]);

/**
 * The characters a position's syntax cannot hold as they are, or `null` for one that holds
 * any. A srcset URL ends at whitespace or a comma; an unquoted `url()` ends at whitespace, and
 * a quote, a parenthesis or a backslash there makes it invalid.
 *
 * @see https://html.spec.whatwg.org/multipage/images.html#parsing-a-srcset-attribute
 * @see https://www.w3.org/TR/css-syntax-3/#consume-url-token
 */
function unheldIn(shape: string): RegExp | null {
  if (SRCSET_SHAPES.has(shape)) return /[\s,]/;
  if (shape === 'css.url.bare') return /[\s()'"\\]/;
  return null;
}

/** Each segment percent-encoded, with the few characters `encodeURIComponent` leaves. */
function fullyPercentEncoded(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

/**
 * `path` as a Markdown destination that CommonMark reads as `path`, whether it sits bare or
 * in angle brackets, which a reference does not record.
 *
 * No backslash escapes a space or a control character, either of which ends a bare
 * destination; `#` and `?` would start a fragment or a query; and a server decodes a
 * percent-escape the name holds. Each is written percent-encoded, and the whole path with it,
 * since the resolver decodes one way or the other and never both. Parentheses are encoded too,
 * as an unmatched one ends a bare destination. Otherwise every character CommonMark would read
 * another way is escaped, and a literal path that holds none stays as written.
 */
function spellDestination(path: string, spelling: PathSpelling): string {
  if (spelling === 'percent-encoded' || onlyPercentEncodingWrites(path)) {
    return path
      .split('/')
      .map((segment) =>
        encodeURIComponent(segment).replace(/[()]/g, (paren) => (paren === '(' ? '%28' : '%29')),
      )
      .join('/');
  }
  if (spelling === 'literal' && destinationReadsAsWritten(path)) return path;
  const escaped = path.replace(/[\\()<>]/g, (character) => `\\${character}`);
  // An ampersand is written as the author wrote the others: as a reference, or escaped.
  return spelling === 'html-entities'
    ? escaped.replaceAll('&', '&amp;')
    : escaped.replaceAll('&', '\\&');
}

/**
 * Whether a name holds what a Markdown destination can carry only percent-encoded: a space, a
 * control character, `#`, `?`, or a percent-escape of its own.
 */
function onlyPercentEncodingWrites(path: string): boolean {
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || character === '#' || character === '?') return true;
  }
  return PERCENT_ESCAPE.test(path);
}

/**
 * Whether `path`, written raw, is read as `path` in either form of destination: no backslash,
 * angle bracket or text in the shape of a character reference, which the Markdown adapter
 * refuses when it names none, and parentheses only in matched pairs.
 */
function destinationReadsAsWritten(path: string): boolean {
  if (/[\\<>]/.test(path) || decodeMarkdownDestination(path) !== path) return false;
  let depth = 0;
  for (const character of path) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The text with every character reference resolved, plus a map back to source offsets, or
 * `null` when a reference is outside the bound.
 *
 * A `style` attribute's CSS can be entity-escaped (`url(&quot;/logo.png&quot;)`), and only
 * the decoded text parses as the browser reads it. `map[i]` is the source offset of decoded
 * code unit `i`, with one more entry for the end, so a decoded range `[a, b)` maps to
 * `[map[a], map[b])` and a reference's whole span belongs to the character it produced.
 * The HTML parser also decodes some legacy names written without their semicolon, which
 * this decoder leaves as they are, so `html.ts` declines when the two decode an attribute
 * differently. See "Percent-encoded and entity-encoded paths" in ARCHITECTURE.md.
 */
export function decodeCharacterReferencesWithMap(
  text: string,
): { readonly text: string; readonly map: readonly number[] } | null {
  const decoded: string[] = [];
  const map: number[] = [];
  let index = 0;

  while (index < text.length) {
    ENTITY_ONCE.lastIndex = index;
    const match = text.charAt(index) === '&' ? ENTITY_ONCE.exec(text) : null;

    if (match === null || match.index !== index) {
      map.push(index);
      decoded.push(text.charAt(index));
      index += 1;
      continue;
    }

    const character = decodeOneReference(match[1] ?? '', 'html');
    if (character === null) return null;
    // Every code unit of the character maps to the reference's start. A character above
    // U+FFFF, such as an emoji, is two code units, which `for...of` would visit as one.
    for (let unit = 0; unit < character.length; unit += 1) map.push(index);
    decoded.push(character);
    index += match[0].length;
  }

  map.push(text.length);
  return { text: decoded.join(''), map };
}

/** The entity pattern, sticky, so it can be anchored at a position rather than searched. */
const ENTITY_ONCE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/y;

const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/**
 * The characters HTML reads a numeric reference from 128 to 159 as, in order: the
 * Windows-1252 character with that number, or, where the entry is 0, the number's own code
 * point. The table parse5 reads through its `entities` dependency, as a browser does.
 */
const WINDOWS_1252_C1: readonly number[] = [
  8364, 0, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 0, 381, 0, 0, 8216, 8217,
  8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 0, 382, 376,
];

/**
 * The text a character reference stands for in an HTML attribute, as a browser reads it:
 * `amp` for `&amp;` gives `&`, and `#45` for `&#45;` gives `-`.
 *
 * @param body the reference between its `&` and its `;`
 * @returns the text, or `null` for a name the HTML specification does not define
 */
export function decodeCharacterReference(body: string): string | null {
  return decodeOneReference(body, 'html');
}

/**
 * One reference's body to its text, or `null` when it names nothing the table defines.
 *
 * @param reading HTML's rules or CommonMark's, which read a number differently; see
 *   `decodeNumericReference`.
 */
function decodeOneReference(body: string, reading: CharacterReferenceReading): string | null {
  return body.startsWith('#') ? decodeNumericReference(body, reading) : decodeNamedReference(body);
}

/**
 * `#38` or `#x26` to its text. Zero, a surrogate and a number past the last code point read
 * as U+FFFD under both rules. HTML reads any number of digits, and 128 to 159 through
 * `WINDOWS_1252_C1`; CommonMark (0.31.2, section 2.5) reads at most 7 decimal or 6
 * hexadecimal digits, so a longer number stays text, and 128 to 159 as their own code points.
 */
function decodeNumericReference(body: string, reading: CharacterReferenceReading): string {
  const isHex = body[1] === 'x' || body[1] === 'X';
  const digits = isHex ? body.slice(2) : body.slice(1);
  if (reading === 'commonmark' && digits.length > (isHex ? 6 : 7)) return `&${body};`;
  const code = Number.parseInt(digits, isHex ? 16 : 10);
  if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) {
    return REPLACEMENT_CHARACTER;
  }
  const remapped =
    reading === 'html' && code >= 128 && code <= 159 ? WINDOWS_1252_C1[code - 128] : 0;
  return String.fromCodePoint(remapped || code);
}

/**
 * The text with every character reference resolved, or `null` when one is outside the
 * bound. A partly decoded path would be neither what the author wrote nor the file's name.
 *
 * @param reading HTML's rules or CommonMark's; see `decodeNumericReference`.
 */
function decodeCharacterReferences(
  text: string,
  reading: CharacterReferenceReading = 'html',
): string | null {
  if (!text.includes('&')) return text;

  let decodable = true;
  const decoded = text.replace(ENTITY, (match, body: string) => {
    const character = decodeOneReference(body, reading);
    if (character === null) decodable = false;
    return character ?? match;
  });

  // An `&` outside a reference is part of the file name (`c&s.png`). Only a reference the
  // decoder cannot read makes the text undecodable.
  return decodable ? decoded : null;
}

/**
 * A Markdown link destination as CommonMark reads it, or `null` when a character reference
 * in it cannot be decoded.
 *
 * A backslash before an ASCII punctuation character is removed and character references
 * are decoded, in one pass (CommonMark 0.31.2, sections 2.4 and 2.5): `my\_photo.png` reads
 * `my_photo.png`, and `\&eacute;` reads `&eacute;`, since an escaped `&` starts no reference.
 *
 * With `keepUndecodable`, a character reference the decoder cannot read stays as written, as
 * CommonMark keeps a name it does not know, so the result is never `null`.
 */
export function decodeMarkdownDestination(text: string, keepUndecodable = false): string | null {
  const decoded: string[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);
    const next = text.charAt(index + 1);
    if (character === '\\' && isAsciiPunctuation(next)) {
      decoded.push(next);
      index += 2;
      continue;
    }

    ENTITY_ONCE.lastIndex = index;
    const match = character === '&' ? ENTITY_ONCE.exec(text) : null;
    if (match === null) {
      decoded.push(character);
      index += 1;
      continue;
    }

    const value = decodeOneReference(match[1] ?? '', 'commonmark');
    if (value === null && !keepUndecodable) return null;
    decoded.push(value ?? match[0]);
    index += match[0].length;
  }

  return decoded.join('');
}

/** Whether the text holds a backslash before an ASCII punctuation character. */
function holdsBackslashEscape(text: string): boolean {
  for (let index = text.indexOf('\\'); index !== -1; index = text.indexOf('\\', index + 1)) {
    if (isAsciiPunctuation(text.charAt(index + 1))) return true;
  }
  return false;
}

/**
 * CommonMark's ASCII punctuation, the characters a backslash can escape: `!` to `/`, `:` to
 * `@`, `[` to the backtick, and `{` to `~`.
 */
export function isAsciiPunctuation(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

/**
 * Whether a path holds character references that no spelling the resolver tries decodes
 * completely, so which file it names is not known: one the decoder cannot read, such as
 * the misspelled `&eacut;`, or any that leaves a percent-escape to decode, beside it as in
 * `caf&eacute;%20x.png` or made by it as in `hero&#37;20image.png`, since the resolver
 * decodes one way or the other and never both.
 */
export function holdsUndecodableCharacterReference(path: string): boolean {
  const decoded = decodeCharacterReferences(path);
  if (decoded === null) return true;
  return decoded !== path && PERCENT_ESCAPE.test(decoded);
}

const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

/**
 * `holdsUndecodableCharacterReference` for a Markdown destination, whose backslash escapes
 * are read too: true when a character reference cannot be decoded, unless a backslash
 * escapes its `&`, or when escapes or references leave a percent-escape to decode, as in
 * `my\_photo%20x.png`, which names `my_photo x.png`, or `hero&#37;20image.png`.
 */
export function holdsUndecodableMarkdownEscape(path: string): boolean {
  const decoded = decodeMarkdownDestination(path);
  if (decoded === null) return true;
  return decoded !== path && PERCENT_ESCAPE.test(decoded);
}

/**
 * Whether some reading of a Markdown destination ends in an image extension: as written, or
 * as CommonMark reads it with a reference the decoder cannot read kept as text, each also
 * percent-decoded. These readings include every spelling the resolver tries, and it drops a
 * path none of whose spellings shows an image extension.
 */
export function markdownDestinationCouldNameAnImage(path: string): boolean {
  const read = decodeMarkdownDestination(path, true) ?? path;
  return [path, decodePercent(path), read, decodePercent(read)].some(
    (reading) => reading !== null && isImageExtension(extensionOf(reading)),
  );
}

/**
 * Whether some reading of an attribute's URL ends in an image extension: the source text or
 * parse5's value, each also percent-decoded. The HTML adapter refuses a path it cannot read
 * only while one does, as `markdownDestinationCouldNameAnImage` lets the Markdown adapter.
 */
export function attributeCouldNameAnImage(written: string, parserValue: string): boolean {
  return [written, parserValue].some((reading) => {
    const { path } = splitPathSuffix(reading);
    return [path, decodePercent(path)].some(
      (spelled) => spelled !== null && isImageExtension(extensionOf(spelled)),
    );
  });
}

/**
 * The text with percent-escapes resolved, or `null` when it is not valid percent-encoding.
 * `decodeURIComponent` throws on a lone `%` or a bad pair, and `100%` in a style attribute
 * reaches here.
 */
function decodePercent(text: string): string | null {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Why this text cannot name a file at all, or `null` when it might.
 *
 * It rules only on what the static text proves. `/view/${style}/${item.name}` reads like
 * a route, but `item.name` could end in `.png`, and `report.${type}` could be
 * `report.png`, so both pass. Most dynamic references that are not images in practice
 * pass the same way, and catching them would mean ruling on what the text only suggests.
 */
export function provablyNotAFile(rawPath: string): string | null {
  if (rawPath.endsWith('/')) {
    return 'the path ends in `/`, so it names a directory rather than a file';
  }
  if (rawPath.startsWith('?')) {
    return 'the path begins with `?`, so it is a query string rather than a path';
  }

  const lastSegment = rawPath.slice(rawPath.lastIndexOf('/') + 1);
  if (lastSegment.startsWith('#') && !opensTemplateHole(lastSegment)) {
    return 'the last segment is a `#fragment`, which names a place in a document rather than a file';
  }

  return null;
}

/**
 * Whether the text opens with a template hole. A last segment such as `#{$mode}.png` is a
 * path being built, not a `#fragment`.
 */
function opensTemplateHole(text: string): boolean {
  return TEMPLATE_HOLES.some(({ opener }) => text.startsWith(opener));
}

/**
 * Why a path is built at render time rather than written literally, or `null` for a
 * plain path.
 *
 * `<img src="{{ image }}">` names no file until something renders it, so it is not a
 * broken reference. Adapters report such a path with an `unsafe` ceiling and this reason,
 * and the resolver reports it as `dynamic`.
 */
export function templateExpressionReason(rawPath: string): string | null {
  return holeReason(rawPath, TEMPLATE_HOLES);
}

/**
 * `templateExpressionReason` for a JavaScript string, which asks only about the holes of
 * another language's template: `{{ }}`, `{% %}` and `<% %>`, as a project generator leaves
 * them. A `${` in a quoted string is text rather than an interpolation, so a path holding one
 * is looked up as written, and a missing one is a real finding.
 */
export function foreignTemplateExpressionReason(rawPath: string): string | null {
  return holeReason(
    rawPath,
    TEMPLATE_HOLES.filter((hole) => !hole.globbed),
  );
}

function holeReason(rawPath: string, holes: readonly TemplateHole[]): string | null {
  for (const { opener, name } of holes) {
    if (rawPath.includes(opener)) {
      return `contains ${name}: the path is not known statically`;
    }
  }
  return null;
}

/**
 * Split a `srcset` into its candidate URLs, following the HTML parsing rules. The HTML
 * and JavaScript adapters share it, since JSX `srcSet` has the same syntax.
 *
 * Splitting on commas alone is wrong twice: a descriptor (`1x`, `800w`) follows each URL,
 * and a URL may itself end in a comma when its descriptor is omitted.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value.charAt(index))) index += 1;
    if (index >= value.length) break;

    const start = index;
    while (index < value.length && !/\s/.test(value.charAt(index))) index += 1;

    // Trailing commas belong to the separator, not to the URL.
    let end = index;
    let hadTrailingComma = false;
    while (end > start && value.charAt(end - 1) === ',') {
      end -= 1;
      hadTrailingComma = true;
    }

    const url = value.slice(start, end);

    // With no trailing comma a descriptor follows, and it runs to the next comma.
    const descriptorStart = index;
    if (!hadTrailingComma) {
      while (index < value.length && value.charAt(index) !== ',') index += 1;
    }

    if (end > start) {
      candidates.push({
        url,
        offset: start,
        descriptor: hadTrailingComma ? '' : value.slice(descriptorStart, index).trim(),
      });
    }
  }

  return candidates;
}

/**
 * One `srcset` candidate. `descriptor` is the `2x` or `800w` after the URL, or `''`.
 *
 * The descriptor only chooses the reference's shape: a density list and a width list are
 * separate shapes, because `w` descriptors come with a `sizes` attribute and fail on their
 * own. The resolver never sees it.
 */
export interface SrcsetCandidate {
  readonly url: string;
  readonly offset: number;
  readonly descriptor: string;
}

/**
 * Whether a bare string is shaped enough like a path to guess at.
 *
 * Spaces are allowed, because uploaded and dragged-in files carry them, but only alongside
 * a `/`: without one a spaced string reads as prose, like the UI label
 * `"Remove workspace.png"`, and a guess that resolves becomes a link a rewrite acts on. A
 * comma (an unsplit `srcSet` list), a tab or a newline rules a string out. A spaced name
 * with no slash, such as `{ file: 'My Logo.svg' }`, is missed; a test in
 * `javascript.test.ts` pins that. See "What counts as a path-shaped string" in
 * ARCHITECTURE.md.
 */
export function plausiblePathShape(path: string): boolean {
  if (/[\t\n\r,]/.test(path)) return false;
  if (!path.includes(' ')) return true;
  return SPACED_PATH.test(path) && path.includes('/');
}

/**
 * A string that is nothing but a path, allowing single spaces inside it.
 *
 * Anchored at both ends and finishing on an extension, so prose that runs past one
 * (`"see ./old.png for details"`) fails even though it holds a `/`. `*` stands for a
 * template hole: the JavaScript adapter joins a template literal's chunks with it.
 * Parentheses are allowed for names like `Photo (1).webp`, since a string literal is
 * already quoted; the end anchor still rejects `"url(hero one.png)"`. See "What counts as
 * a path-shaped string" in ARCHITECTURE.md.
 */
const SPACED_PATH = /^[\w@.\-/*()]+(?: [\w@.\-/*()]+)*\.[A-Za-z0-9]+$/;
