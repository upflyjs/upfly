import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TEXT_TEST_BYTES, readTextUnlessBinary } from './read-text.js';

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

describe('reading a file as text unless it is binary', () => {
  it('reads a text file whole, as readFile decodes it, a character split across the test boundary included', async () => {
    // `é` is two bytes in UTF-8; placed across the 8,000th byte, it shows the head and the
    // rest are decoded as one text, and past it the file is read to its end.
    const text = `${'a'.repeat(TEXT_TEST_BYTES - 1)}é and /img/logo.png\n${'line\n'.repeat(200_000)}`;
    const path = await file(text);

    expect(await readTextUnlessBinary(path)).toBe(await readFile(path, 'utf8'));
    expect(await readTextUnlessBinary(path)).toBe(text);
  });

  it('calls a file binary for a NUL byte within its first 8,000 bytes, and text for one after', async () => {
    const before = Buffer.from(`${'a'.repeat(TEXT_TEST_BYTES - 1)} /img/logo.png`);
    before[TEXT_TEST_BYTES - 1] = 0;
    const after = Buffer.from(`${'a'.repeat(TEXT_TEST_BYTES)} /img/logo.png`);
    after[TEXT_TEST_BYTES] = 0;

    expect(await readTextUnlessBinary(await file(before))).toBeNull();
    expect(await readTextUnlessBinary(await file(after))).toBe(after.toString('utf8'));
  });

  it('reads a file that is not UTF-8 but holds no NUL, such as a Latin-1 page, as text', async () => {
    // A page in an 8-bit encoding can name an image, and every such encoding writes text
    // without a NUL byte, so the rule never leaves one out.
    const latin1 = Buffer.from('<img src="/img/caf\xe9.png"> <img src="/img/logo.png">', 'latin1');

    expect(await readTextUnlessBinary(await file(latin1))).toBe(latin1.toString('utf8'));
  });

  it('calls UTF-16 text binary, in which no path written in UTF-8 could be found', async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('/img/logo.png', 'utf16le'),
    ]);

    expect(await readTextUnlessBinary(await file(utf16))).toBeNull();
  });

  it('reads an empty file as empty text, and rejects for a file that is not there', async () => {
    expect(await readTextUnlessBinary(await file(''))).toBe('');
    await expect(
      readTextUnlessBinary(join(tmpdir(), 'upfly-read-text-absent-7c1e')),
    ).rejects.toThrow(/ENOENT/);
  });
});
