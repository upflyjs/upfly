import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES,
  type NotText,
  oneCharacterPerByte,
  readForSearch,
  textOfBytes,
} from './read-text.js';

/** Git's number: a NUL byte within a file's first 8,000 bytes calls it binary. */
const GIT_TEST_BYTES = 8000;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** One file, written as these bytes, outside the workspace. */
async function file(bytes: Uint8Array | string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upfly-read-text-'));
  roots.push(root);
  const path = join(root, 'file');
  await writeFile(path, bytes);
  return path;
}

/** Every chunk a file that is not text hands over, in order. */
async function chunksOf(read: string | NotText): Promise<Buffer[]> {
  if (typeof read === 'string') throw new Error('read as text');
  const chunks: Buffer[] = [];
  for await (const chunk of read.chunks()) chunks.push(Buffer.from(chunk));
  return chunks;
}

describe('reading a file for a search: a text whole, any other file as its bytes', () => {
  it('reads a text file whole, as readFile decodes it, a character split across the test boundary included', async () => {
    // `é` is two bytes in UTF-8; placed across the 8,000th byte, it shows the head and the
    // rest are decoded as one text, and past it the file is read to its end.
    const text = `${'a'.repeat(GIT_TEST_BYTES - 1)}é and /img/logo.png\n${'line\n'.repeat(200_000)}`;
    const path = await file(text);

    expect(await readForSearch(path)).toBe(await readFile(path, 'utf8'));
    expect(await readForSearch(path)).toBe(text);
  });

  it('hands over the bytes of a file with a NUL byte within its first 8,000 bytes, and reads one with a NUL after as text', async () => {
    const before = Buffer.from(`${'a'.repeat(GIT_TEST_BYTES - 1)} /img/logo.png`);
    before[GIT_TEST_BYTES - 1] = 0;
    const after = Buffer.from(`${'a'.repeat(GIT_TEST_BYTES)} /img/logo.png`);
    after[GIT_TEST_BYTES] = 0;

    expect(Buffer.concat(await chunksOf(await readForSearch(await file(before))))).toEqual(before);
    expect(await readForSearch(await file(after))).toBe(after.toString('utf8'));
  });

  it('reads a file that is not UTF-8 but holds no NUL, such as a Latin-1 page, as text', async () => {
    // A page in an 8-bit encoding can name an image, and every such encoding writes text
    // without a NUL byte, so the test never sends one to the bytes.
    const latin1 = Buffer.from('<img src="/img/caf\xe9.png"> <img src="/img/logo.png">', 'latin1');

    expect(await readForSearch(await file(latin1))).toBe(latin1.toString('utf8'));
  });

  it('hands over UTF-16 text as bytes, NUL bytes and all', async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('/img/logo.png', 'utf16le'),
    ]);

    expect(Buffer.concat(await chunksOf(await readForSearch(await file(utf16))))).toEqual(utf16);
  });

  it('reads a small file that is not text whole through the open that tested it, so its bytes need no second open', async () => {
    const bytes = Buffer.from('\0SQLite row: <img src="/img/logo.png">', 'latin1');
    const path = await file(bytes);

    const read = await readForSearch(path);
    await rm(path);

    expect(Buffer.concat(await chunksOf(read))).toEqual(bytes);
  });

  it('hands over a large file a chunk at a time, from its start each time it is asked', async () => {
    const bytes = Buffer.alloc(2 * CHUNK_BYTES + 5, 7);
    bytes[0] = 0;
    const read = await readForSearch(await file(bytes));

    const first = await chunksOf(read);
    const again = await chunksOf(read);

    expect(first.map((chunk) => chunk.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 5]);
    expect(Buffer.concat(first)).toEqual(bytes);
    expect(Buffer.concat(again)).toEqual(bytes);
  });

  it('reads an empty file as empty text, and rejects for a file that is not there', async () => {
    expect(await readForSearch(await file(''))).toBe('');
    await expect(readForSearch(join(tmpdir(), 'upfly-read-text-absent-7c1e'))).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe('bytes held one to a character', () => {
  it('holds each byte as the character of its value, and reads them back as UTF-8', () => {
    const bytes = Buffer.from('\0/img/café.pngÿ', 'utf8');

    const held = oneCharacterPerByte(bytes);

    expect(held).toHaveLength(bytes.length);
    expect([...held].map((character) => character.charCodeAt(0))).toEqual([...bytes]);
    expect(textOfBytes(held)).toBe('\0/img/café.pngÿ');
  });
});
