/**
 * A file's text for a search that reads every file of a project, none for a file that is not
 * text, and the copies that let a search's results outlive the text they came from.
 */

import { open } from 'node:fs/promises';

/**
 * How many bytes from the start of a file decide whether it is text. Git looks for a NUL byte
 * within the same number before it calls a file binary (`buffer_is_binary` in its
 * `xdiff-interface.c`).
 */
export const TEXT_TEST_BYTES = 8000;

/**
 * A file's text, decoded as UTF-8 exactly as `readFile(path, 'utf8')` decodes it, or null when
 * the file is not text: a NUL byte within its first 8,000 bytes.
 *
 * Decoded as UTF-8, a compiled library, a database or an archive becomes a string up to twice
 * its size, every byte that is not UTF-8 a character of its own, so a search that read one of
 * a few hundred megabytes as text could run out of memory. No text in an 8-bit encoding holds
 * a NUL byte, so no file a path could be found in is left out; UTF-16 text is, and a path
 * written in it never matched the UTF-8 the search reads.
 *
 * @param path the file's absolute path
 * @returns the text, or null for a file that is not text
 * @throws as `readFile` throws, for a file that cannot be read
 */
export async function readTextUnlessBinary(path: string): Promise<string | null> {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(TEXT_TEST_BYTES);
    const { bytesRead } = await file.read(head, 0, TEXT_TEST_BYTES, 0);
    if (head.subarray(0, bytesRead).includes(0)) return null;
    // A read at a given position leaves the file's own position at the start, so this reads
    // the whole file.
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
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
