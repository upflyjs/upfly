/**
 * The ways a text can name a path: as written, and as a browser reads it once the text's
 * escapes are decoded.
 *
 * A page names `a b.png` as `a%20b.png` in a URL, and as `a&#32;b.png` in an HTML attribute,
 * which the browser decodes before it asks for the file. A search for the path has to find
 * every one of these, so it searches each reading of the text. Each reading keeps where its
 * characters came from, so a match in it is a range of the text as written, and each knows how
 * to write new text that it reads back as a given value.
 */

import { decodeCharacterReference } from '../adapters/reference-path.js';

/** A text as one reading has it, where its characters came from, and how to write to it. */
export interface Reading {
  /** The text as this reading has it. */
  readonly text: string;
  /**
   * The offset in the text as written of the character at `offset` in this reading, or of the
   * end when `offset` is the reading's length. Inside a character decoded from an escape, the
   * offset where the escape starts.
   */
  readonly sourceAt: (offset: number) => number;
  /** Text that this reading reads as `value`, written the way this reading decodes. */
  readonly spell: (value: string) => string;
  /** What this reading makes of another text. */
  readonly read: (text: string) => string;
}

/** A text decoded, and where each decoded character came from. */
interface Decoded {
  readonly text: string;
  readonly sourceAt: (offset: number) => number;
}

/** One way of reading a text: how it decodes, and how new text is spelled for it. */
interface Way {
  /** The text decoded, or `null` when this way decodes nothing in it. */
  readonly decode: (text: string) => Decoded | null;
  readonly spell: (value: string) => string;
}

const AS_WRITTEN: Way = {
  decode: (text) => ({ text, sourceAt: (offset) => offset }),
  spell: (value) => value,
};

/** Percent-escapes decoded once, as a server decodes the path of a URL it is asked for. */
const PERCENT: Way = { decode: percentDecoded, spell: percentEncoded };

/** Character references decoded, as an HTML parser decodes an attribute. */
const REFERENCES: Way = {
  decode: referencesDecoded,
  spell: (value) => value.replaceAll('&', '&amp;'),
};

/**
 * Both, references first: a URL written in a page reaches the server after the HTML parser
 * has decoded its references, so `caf&eacute;%20x.png` asks for `café x.png`.
 */
const BOTH: Way = {
  decode: (text) => {
    const references = referencesDecoded(text);
    const percent = references === null ? null : percentDecoded(references.text);
    if (references === null || percent === null) return null;
    return {
      text: percent.text,
      sourceAt: (offset) => references.sourceAt(percent.sourceAt(offset)),
    };
  },
  spell: percentEncoded,
};

const WAYS: readonly Way[] = [AS_WRITTEN, PERCENT, REFERENCES, BOTH];

/**
 * Every reading of a text: as written, then with its percent-escapes decoded, with its
 * character references decoded, and with both. A reading that would decode nothing is left
 * out, so a text with no escapes has the one reading, as written.
 *
 * @param text any text
 * @returns the readings, the text as written first
 */
export function readingsOf(text: string): Reading[] {
  return WAYS.flatMap((way) => {
    const decoded = way.decode(text);
    if (decoded === null) return [];
    return [
      {
        ...decoded,
        spell: way.spell,
        read: (other: string) => way.decode(other)?.text ?? other,
      },
    ];
  });
}

/**
 * Where a decoded character sits in a reading and in the text as written, and how long it is
 * in each. Between two of these, the reading and the text run in step.
 */
interface Anchor {
  readonly at: number;
  readonly from: number;
  readonly length: number;
  readonly written: number;
}

/** A decoded text built a piece at a time, from the text as written. */
interface Decoding {
  /** The escape at `from`, `written` characters long, reads as `character`. */
  readonly decoded: (from: number, written: number, character: string) => void;
  /** The decoded text, or `null` when nothing was decoded. */
  readonly done: () => Decoded | null;
}

function decoding(source: string): Decoding {
  const pieces: string[] = [];
  const anchors: Anchor[] = [];
  let copied = 0;
  let length = 0;
  return {
    decoded: (from, written, character) => {
      pieces.push(source.slice(copied, from));
      length += from - copied;
      anchors.push({ at: length, from, length: character.length, written });
      pieces.push(character);
      length += character.length;
      copied = from + written;
    },
    done: () => {
      if (anchors.length === 0) return null;
      pieces.push(source.slice(copied));
      return { text: pieces.join(''), sourceAt: (offset) => sourceOffset(anchors, offset) };
    },
  };
}

/** Where an offset in a decoded text sits in the text as written, from its anchors. */
function sourceOffset(anchors: readonly Anchor[], offset: number): number {
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((anchors[middle]?.at ?? offset + 1) <= offset) low = middle + 1;
    else high = middle;
  }
  const anchor = anchors[low - 1];
  if (anchor === undefined) return offset;
  if (offset < anchor.at + anchor.length) return anchor.from;
  return anchor.from + anchor.written + (offset - anchor.at - anchor.length);
}

const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * The text with each run of percent-escapes decoded as UTF-8, a character at a time. An
 * escape that starts no valid UTF-8 sequence stays as written, as `%FF` does, or the first
 * byte of a sequence the run cuts short.
 */
function percentDecoded(text: string): Decoded | null {
  if (!PERCENT_ESCAPE.test(text)) return null;
  const out = decoding(text);
  for (const run of text.matchAll(PERCENT_RUN)) {
    const end = run.index + run[0].length;
    let at = run.index;
    while (at < end) {
      const written = 3 * utf8Length(Number.parseInt(text.slice(at + 1, at + 3), 16));
      const character =
        written > 0 && at + written <= end ? decodedOrNull(text.slice(at, at + written)) : null;
      if (character === null) {
        at += 3;
        continue;
      }
      out.decoded(at, written, character);
      at += written;
    }
  }
  return out.done();
}

/** How many bytes the UTF-8 sequence a byte starts holds, or 0 when it starts none. */
function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** One character's escapes decoded, or `null` when they are not valid UTF-8. */
function decodedOrNull(escapes: string): string | null {
  try {
    return decodeURIComponent(escapes);
  } catch {
    return null;
  }
}

const REFERENCE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * The text with each character reference decoded as an HTML attribute decodes it: numeric
 * ones, and named ones HTML defines, each with its semicolon. A name HTML does not define
 * stays as written.
 */
function referencesDecoded(text: string): Decoded | null {
  if (!text.includes('&')) return null;
  const out = decoding(text);
  // A name looked up once per text: code holds `&name;` shapes that name no character.
  const unknown = new Set<string>();
  for (const reference of text.matchAll(REFERENCE)) {
    const body = reference[1] ?? '';
    if (unknown.has(body)) continue;
    const character = decodeCharacterReference(body);
    if (character === null) {
      unknown.add(body);
      continue;
    }
    out.decoded(reference.index, reference[0].length, character);
  }
  return out.done();
}

/**
 * Each part of a path between its separators percent-encoded, as a rewritten reference is
 * (`spell` in `adapters/reference-path.ts`), so a server decodes it back to the value.
 */
function percentEncoded(value: string): string {
  return value
    .split(/([/\\])/)
    .map((part, index) => (index % 2 === 1 ? part : encodeURIComponent(part)))
    .join('');
}
