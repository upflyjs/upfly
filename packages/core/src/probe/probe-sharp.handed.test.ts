/**
 * Which files the sharp-backed probe hands to sharp. On Windows, sharp 0.35 can end the whole
 * process when it fails to recognise a file while another of its calls runs, and the probe
 * measures several images at once, so a file whose own bytes say it is no image sharp reads must
 * never reach it. sharp is wrapped here to record every path it is given, and otherwise runs as
 * it does.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Asset } from '../types.js';
import { createSharpProbe } from './probe-sharp.js';
import { type ImageProbe, type ProbeDiagnostic, probeAssets } from './probe.js';

const handed = vi.hoisted(() => [] as string[]);

vi.mock('sharp', async (importOriginal) => {
  const { default: sharp } = await importOriginal<typeof import('sharp')>();
  const recording = (...args: Parameters<typeof sharp>) => {
    if (typeof args[0] === 'string') handed.push(args[0]);
    return sharp(...args);
  };
  return { default: Object.assign(recording, sharp) };
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');

/** The text a clone made without Git LFS leaves in place of every image LFS tracks. */
const LFS_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${'4d'.repeat(32)}\nsize 48213\n`;

/** A byte order mark, which some editors write at the start of a text file. */
const BOM = String.fromCharCode(0xfeff);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"/>';

let probe: ImageProbe;
let temp: string;

beforeAll(async () => {
  probe = await createSharpProbe();
  temp = await mkdtemp(join(tmpdir(), 'upfly-handed-'));
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined);
});

function asset(path: string): Asset {
  const posix = relative(temp, path).split(sep).join('/');
  return { path, relative: posix, extension: posix.slice(posix.lastIndexOf('.')), bytes: 0 };
}

async function file(name: string, bytes: string | Buffer): Promise<string> {
  const path = join(temp, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

/** An 8 by 8 picture in `format`, made by sharp itself. */
async function picture(format: 'webp' | 'gif' | 'tiff' | 'avif' | 'png'): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#c03' } })
    .toFormat(format)
    .toBuffer();
}

describe('a file whose first bytes are no format sharp reads', () => {
  it.each([
    ['an empty file', 'empty.png', ''],
    ['a Git LFS pointer named .png', 'pointer.png', LFS_POINTER],
    ['a Git LFS pointer named .jpg', 'pointer.jpg', LFS_POINTER],
    ['a Git LFS pointer named .webp', 'pointer.webp', LFS_POINTER],
    ['a text file named .png', 'text.png', 'this is not a png, it merely has the extension\n'],
    ['a Git LFS pointer named .svg', 'pointer.svg', LFS_POINTER],
  ])('is never handed to sharp: %s', async (_, name, text) => {
    const path = await file(name, text);

    await expect(probe.metadata(path)).rejects.toThrow();
    await expect(probe.encodedBytes({ path, format: 'webp', animated: false })).rejects.toThrow();
    await expect(
      probe.encodeToFile({
        path,
        format: 'webp',
        animated: false,
        destination: join(temp, 'out', `${name}.webp`),
      }),
    ).rejects.toThrow();

    expect(handed).not.toContain(path);
  });

  it('is never handed to sharp when it is not there at all', async () => {
    const path = join(temp, 'gone.png');

    await expect(probe.metadata(path)).rejects.toThrow(/missing/);

    expect(handed).not.toContain(path);
  });

  it('keeps the reason it had, and passes on no library message, since none was asked', async () => {
    const paths = [
      await file('reason/empty.png', ''),
      await file('reason/pointer.png', LFS_POINTER),
      await file('reason/pointer.svg', LFS_POINTER),
    ];
    const diagnostics: ProbeDiagnostic[] = [];

    const results = await probeAssets(paths.map(asset), {
      probe,
      formats: ['webp'],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const notAnImage = [
      {
        measurement: 'metadata',
        code: 'not-an-image',
        reason: 'this file could not be read as an image, so nothing about it could be measured',
      },
      {
        measurement: 'webp',
        code: 'not-an-image',
        reason: 'this file could not be read as an image, so there is nothing to encode',
      },
    ];
    expect(results.map((result) => [result.metadata, result.skipped])).toEqual([
      [null, notAnImage],
      [null, notAnImage],
      [
        null,
        [
          {
            measurement: 'metadata',
            code: 'svg-unreadable',
            reason:
              'this SVG could not be read (its dimensions, its XML or its size defeated the parser), so nothing about it could be measured',
          },
          {
            measurement: 'webp',
            code: 'svg-unreadable',
            reason: 'this SVG could not be read, so there is nothing to encode',
          },
        ],
      ],
    ]);
    expect(diagnostics).toEqual([]);
    expect(handed.filter((path) => paths.includes(path))).toEqual([]);
  });
});

describe('every file sharp reads still reaches it', () => {
  it.each([
    ['PNG', 'png', 'png'],
    ['WebP', 'webp', 'webp'],
    ['GIF', 'gif', 'gif'],
    ['TIFF', 'tiff', 'tiff'],
    ['AVIF', 'avif', 'heif'],
  ] as const)('reads a real %s as it did', async (_, format, read) => {
    const path = await file(`real.${format}`, await picture(format));

    expect(await probe.metadata(path)).toMatchObject({ width: 8, height: 8, format: read });
    expect(await probe.encodedBytes({ path, format: 'webp', animated: false })).toBeGreaterThan(0);
    expect(handed.filter((handedPath) => handedPath === path).length).toBeGreaterThanOrEqual(2);
  });

  it('reads a real JPEG, and a .png holding a JPEG as the JPEG it is', async () => {
    const jpeg = await readFile(join(FIXTURES, 'plain-html/images/hero.jpg'));
    const named = await file('photo.jpg', jpeg);
    const misnamed = await file('photo-really-a-jpeg.png', jpeg);

    for (const path of [named, misnamed]) {
      expect(await probe.metadata(path)).toMatchObject({ format: 'jpeg', width: 240 });
      expect(handed).toContain(path);
    }
  });

  it('reads an SVG, a compressed one, and one that begins with a byte order mark', async () => {
    const paths = [
      await file('icon.svg', SVG),
      await file('icon-compressed.svg', gzipSync(SVG)),
      await file('icon-bom.svg', `${BOM}${SVG}`),
      await file('icon-commented.svg', `<!--${'x'.repeat(900)}-->${SVG}`),
    ];

    for (const path of paths) {
      expect(await probe.metadata(path)).toMatchObject({ format: 'svg', width: 24, height: 16 });
      expect(handed).toContain(path);
    }
  });

  it('hands sharp a truncated PNG, whose signature is right, and keeps its reason', async () => {
    const whole = await picture('png');
    const path = await file('truncated.png', whole.subarray(0, 30));
    const diagnostics: ProbeDiagnostic[] = [];

    const [result] = await probeAssets([asset(path)], {
      probe,
      formats: ['webp'],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(handed).toContain(path);
    expect(result?.metadata).toBeNull();
    expect(result?.skipped[0]).toEqual({
      measurement: 'metadata',
      code: 'not-an-image',
      reason: 'this file could not be read as an image, so nothing about it could be measured',
    });
    // sharp did read this one, so its own words are passed on as before.
    expect(diagnostics.map((diagnostic) => diagnostic.asset)).toEqual(['truncated.png']);
  });

  // Files that begin as each format sharp reads, whatever follows: sharp, not the probe, decides
  // whether they decode.
  const ftyp = (brand: string) =>
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}junk`)]);
  it.each<[string, Buffer]>([
    ['a PNG signature', Buffer.from('\x89PNG\r\n\x1a\njunk', 'latin1')],
    ['a JPEG start of image', Buffer.from([0xff, 0xd8, 0xff, 0x00])],
    ['a WebP header', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')],
    ['GIF87a', Buffer.from('GIF87a junk')],
    ['GIF89a', Buffer.from('GIF89a junk')],
    ['a TIFF header, little-endian', Buffer.from('II*\0junk', 'latin1')],
    ['a TIFF header, big-endian', Buffer.from('MM\0*junk', 'latin1')],
    ['a BigTIFF header, little-endian', Buffer.from('II+\0junk', 'latin1')],
    ['a BigTIFF header, big-endian', Buffer.from('MM\0+junk', 'latin1')],
    ...['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif'].map(
      (brand): [string, Buffer] => [`the HEIF brand ${brand}`, ftyp(brand)],
    ),
    ["libvips' own format, little-endian", Buffer.from([0xb6, 0xa6, 0xf2, 0x08, 0, 0])],
    ["libvips' own format, big-endian", Buffer.from([0x08, 0xf2, 0xa6, 0xb6, 0, 0])],
    ['an SVG tag that ends at byte 1,000', Buffer.from(`${' '.repeat(996)}<svg`)],
    ['an SVG tag in capitals', Buffer.from('<?xml version="1.0"?><SVG/>')],
  ])('hands sharp a file that begins as %s', async (name, bytes) => {
    const path = await file(`boundary/handed-${name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`, bytes);

    await probe.metadata(path).catch(() => undefined);

    expect(handed).toContain(path);
  });

  it.each<[string, Buffer]>([
    ['GIF7', Buffer.from('GIF7 junk')],
    ['a RIFF file that is not WebP', Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1')],
    ['a TIFF byte order with the wrong version', Buffer.from('II*\x01junk', 'latin1')],
    ['the brand of an animated AVIF, which libvips does not read', ftyp('avis')],
    ['the brand of an MP4 video', ftyp('mp42')],
    ['an SVG tag that ends past byte 1,000', Buffer.from(`${' '.repeat(997)}<svg`)],
    ['gzip holding text', gzipSync('version https://git-lfs.github.com/spec/v1\n'.repeat(4))],
    ['one byte of a JPEG marker', Buffer.from([0xff])],
    ['an SVG written in UTF-16', Buffer.from(`${BOM}${SVG}`, 'utf16le')],
  ])('turns away a file that begins as %s', async (name, bytes) => {
    const path = await file(`boundary/away-${name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`, bytes);

    await expect(probe.metadata(path)).rejects.toThrow(/does not begin as any image format/);

    expect(handed).not.toContain(path);
  });

  it('knows the beginning of every format the installed sharp reads from a file', async () => {
    const { default: sharp } = await import('sharp');

    const readable = Object.entries(sharp.format)
      .filter(([, format]) => format.input.file)
      .map(([id]) => id)
      .sort();

    // A format added here needs its signature in probe-sharp.ts, or a file in it is turned away
    // as not an image.
    expect(readable).toEqual(['gif', 'heif', 'jpeg', 'png', 'svg', 'tiff', 'vips', 'webp']);
  });
});
