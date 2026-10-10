/**
 * A file as a search that reads every file of a project reads it: the text of a text file, and
 * the bytes of any other a chunk at a time; and the copies that let a search's results outlive
 * the text they came from.
 */

import { open } from 'node:fs/promises';

/**
 * How many bytes from the start of a file decide whether it is text. Git looks for a NUL byte
 * within the same number before it calls a file binary (`buffer_is_binary` in its
 * `xdiff-interface.c`).
 */
export const TEXT_TEST_BYTES = 8000;

/** How many bytes of a file that is not text one read takes. */
export const CHUNK_BYTES = 1 << 20;

/** A file that is not text, which a search reads as bytes, a chunk at a time. */
export interface NotText {
  /** The file's bytes in order, a chunk at a time, read from the start on each call. */
  readonly chunks: () => AsyncIterable<Uint8Array>;
}

/**
 * A file's text, decoded as UTF-8 exactly as `readFile(path, 'utf8')` decodes it, or, when the
 * file is not text (a NUL byte within its first 8,000 bytes), its bytes to read a chunk at a
 * time.
 *
 * Decoded as UTF-8, a compiled library becomes a string up to twice its size, every byte that is
 * not UTF-8 a character of its own, so one of a few hundred megabytes could take more memory than
 * the run has. Its bytes can still hold a path as plain text, as a database holds the pages a
 * site renders from it, so such a file is read in chunks rather than left out.
 *
 * @param path the file's absolute path
 * @returns the text, or the bytes of a file that is not text
 * @throws as `readFile` throws, for a file that cannot be read
 */
export async function readForSearch(path: string): Promise<string | NotText> {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(TEXT_TEST_BYTES);
    const { bytesRead } = await file.read(head, 0, TEXT_TEST_BYTES, 0);
    // A read at a given position leaves the file's own position at the start, so each read
    // below reads the whole file.
    if (!head.subarray(0, bytesRead).includes(0)) return await file.readFile('utf8');
    // Most files that are not text are small, as compiled modules are, and opening each one a
    // second time took a search over tens of thousands of them seconds longer. One no larger
    // than a chunk is read whole through this open.
    if ((await file.stat()).size > CHUNK_BYTES) return { chunks: () => chunksOf(path) };
    const bytes = await file.readFile();
    return {
      chunks: async function* () {
        yield bytes;
      },
    };
  } finally {
    await file.close();
  }
}

/** A file's bytes from its start, `CHUNK_BYTES` at a time, the file closed however it ends. */
async function* chunksOf(path: string): AsyncGenerator<Uint8Array> {
  const file = await open(path, 'r');
  try {
    for (let at = 0; ; ) {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      const { bytesRead } = await file.read(chunk, 0, CHUNK_BYTES, at);
      if (bytesRead === 0) return;
      at += bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
  } finally {
    await file.close();
  }
}

/**
 * Bytes as a string of one character each, U+0000 to U+00FF: what a search reads a file that is
 * not text as, so the string is no longer than the bytes and every byte keeps its place.
 *
 * @param bytes any bytes
 * @returns one character for each byte
 */
export function oneCharacterPerByte(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

/**
 * What bytes held one to a character say as UTF-8, for showing a person what a file that is not
 * text writes: a name beyond ASCII written in UTF-8 reads as itself, and a byte that starts no
 * UTF-8 character reads as U+FFFD.
 *
 * @param held a string of characters U+0000 to U+00FF, as `oneCharacterPerByte` makes one
 * @returns the text those bytes encode
 */
export function textOfBytes(held: string): string {
  return Buffer.from(held, 'latin1').toString('utf8');
}

/**
 * The same characters in a string of their own.
 *
 * V8 keeps a slice of 13 or more characters, and a regular expression's match, as a view into
 * the string it came from, so a path or a line that a result keeps from a file's text would keep
 * the whole text in memory for as long as the result. Every string a search keeps from a text
 * goes through this.
 *
 * @param text a string, usually a slice of a file's text
 * @returns an equal string that holds no other
 */
export function ownCopy(text: string): string {
  // Joined to a space, the characters are copied into a new string; sliced off it, they are
  // a view into that copy alone.
  return ` ${text}`.slice(1);
}
