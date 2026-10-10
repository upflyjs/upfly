import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { animatedPng, gradientFrames } from '../../test/animated-png.js';
import type { Asset } from '../types.js';
import { createSharpProbe } from './probe-sharp.js';
import { probeAssets } from './probe.js';
import type { ImageProbe } from './probe.js';

/**
 * The sharp-backed probe, against real bytes.
 *
 * `probe.test.ts` covers the logic with a fake; this covers what a fake cannot: what
 * libvips does with an animation, a truncated file and a vector.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures');

let probe: ImageProbe;
let temp: string;

beforeAll(async () => {
  probe = await createSharpProbe();
  temp = await mkdtemp(join(tmpdir(), 'upfly-probe-'));
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined);
});

function asset(path: string, relative: string): Asset {
  return { path, relative, extension: relative.slice(relative.lastIndexOf('.')), bytes: 0 };
}

/** A real JPEG with content the encoders cannot trivially collapse. */
async function noisyJpeg(name: string, width: number, height: number): Promise<string> {
  const { default: sharp } = await import('sharp');
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 2654435761) % 251;

  const path = join(temp, name);
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(path);
  return path;
}

const FRAME_WIDTH = 24;
const FRAME_HEIGHT = 12;

/**
 * A genuinely animated GIF.
 *
 * Built with `join: { animated: true }`. Neither `pageHeight` on raw input nor a tall
 * strip through `.gif()` produces multiple pages: both make a tall still image, which
 * gives a fixture that silently tests nothing.
 */
async function animatedGif(name: string, frames: number): Promise<string> {
  const { default: sharp } = await import('sharp');

  const pages = await Promise.all(
    Array.from({ length: frames }, (_, index) =>
      sharp({
        create: {
          width: FRAME_WIDTH,
          height: FRAME_HEIGHT,
          channels: 3,
          background: { r: index * 40, g: 100, b: 200 },
        },
      })
        .png()
        .toBuffer(),
    ),
  );

  const path = join(temp, `${name}.gif`);
  await sharp(pages, { join: { animated: true } })
    .gif()
    .toFile(path);
  return path;
}

/**
 * A photo stored as a camera's sensor read it: 400 by 200, the left half red and the right
 * half blue, with the EXIF tag that tells a viewer how to turn it.
 */
async function taggedPhoto(name: string, orientation: number): Promise<string> {
  const { default: sharp } = await import('sharp');
  const width = 400;
  const height = 200;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index++) {
    pixels.set(index % width < width / 2 ? [220, 30, 20] : [20, 30, 220], index * 3);
  }

  const path = join(temp, name);
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation })
    .toFile(path);
  return path;
}

/**
 * What a viewer shows: the size, and whether a point is red or blue. A viewer honours an
 * orientation tag, so a file that kept its tag and its unturned pixels would pass too.
 */
async function shown(path: string) {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(path, { autoOrient: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    size: `${info.width}x${info.height}`,
    at(x: number, y: number): 'red' | 'blue' | 'neither' {
      const index = (y * info.width + x) * info.channels;
      const red = data[index] ?? 0;
      const blue = data[index + 2] ?? 0;
      if (red > 150 && blue < 100) return 'red';
      if (blue > 150 && red < 100) return 'blue';
      return 'neither';
    },
  };
}

describe('createSharpProbe', () => {
  it('reads a real fixture image', async () => {
    const result = await probe.metadata(join(FIXTURES, 'plain-html/images/hero.jpg'));

    expect(result).toEqual({ width: 240, height: 160, format: 'jpeg', pages: 1 });
  });

  it('reports a still image as one page', async () => {
    const path = await noisyJpeg('still.jpg', 40, 30);

    expect(await probe.metadata(path)).toEqual({
      width: 40,
      height: 30,
      format: 'jpeg',
      pages: 1,
    });
  });

  it('reads an SVG without rasterising it', async () => {
    const path = join(temp, 'icon.svg');
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"/>');

    expect(await probe.metadata(path)).toEqual({
      width: 24,
      height: 16,
      format: 'svg',
      pages: 1,
    });
  });

  // A quarter turn swaps width and height, mirrored as with tag 5 or not; a half turn keeps
  // them. The photo is stored 400 by 200.
  it.each([
    { orientation: 6, size: [200, 400] },
    { orientation: 8, size: [200, 400] },
    { orientation: 5, size: [200, 400] },
    { orientation: 3, size: [400, 200] },
  ] as const)(
    'reports a photo tagged $orientation at the size a viewer shows',
    async ({ orientation, size }) => {
      const path = await taggedPhoto(`size-${orientation}.jpg`, orientation);

      const { width, height } = await probe.metadata(path);

      expect([width, height]).toEqual(size);
    },
  );

  it('measures an encode without writing anything', async () => {
    const path = await noisyJpeg('encode.jpg', 60, 40);
    const before = await readdir(temp);

    const bytes = await probe.encodedBytes({ path, format: 'webp', animated: false });

    expect(bytes).toBeGreaterThan(0);
    // `encodedBytes` promises to write nothing, so that is asserted rather than
    // assumed: an encode that reached the disk would leave a file behind.
    expect(await readdir(temp)).toEqual(before);
  });

  it('measures an AVIF encode too', async () => {
    // Tiny, because an AVIF encode costs about eight times a WebP one. This only checks
    // that the format reaches libvips; the numbers live in `bench/`.
    const path = await noisyJpeg('avif.jpg', 24, 16);

    const bytes = await probe.encodedBytes({ path, format: 'avif', animated: false });

    expect(bytes).toBeGreaterThan(0);
  });

  describe('what it writes is what it measured', () => {
    it('writes exactly as many bytes as it reported', async () => {
      const path = await noisyJpeg('measured.jpg', 120, 90);
      const destination = join(temp, 'measured.webp');

      const measured = await probe.encodedBytes({ path, format: 'webp', animated: false });
      const written = await probe.encodeToFile({
        path,
        format: 'webp',
        animated: false,
        destination,
      });

      expect(written).toBe(measured);
      expect((await stat(destination)).size).toBe(measured);
    });

    it('writes at the quality it reports, byte for byte', async () => {
      // A saving quoted at a quality the file was not written at would be a false
      // figure. Compared with an independent encode at the declared quality, because
      // comparing the probe's output with itself would prove nothing.
      const { default: sharp } = await import('sharp');
      const path = await noisyJpeg('quality.jpg', 120, 90);
      const destination = join(temp, 'quality.webp');

      await probe.encodeToFile({ path, format: 'webp', animated: false, destination });
      const atDeclared = await sharp(path).webp({ quality: probe.quality.webp }).toBuffer();

      expect(Buffer.compare(await readFile(destination), atDeclared)).toBe(0);
    });

    it('would notice if the two used different qualities', async () => {
      // The control. If an encode at a different quality produced the same bytes, the
      // test above would pass whatever the probe did.
      const { default: sharp } = await import('sharp');
      const path = await noisyJpeg('control.jpg', 120, 90);

      const declared = await sharp(path).webp({ quality: probe.quality.webp }).toBuffer();
      const other = await sharp(path)
        .webp({ quality: probe.quality.webp - 30 })
        .toBuffer();

      expect(Buffer.compare(declared, other)).not.toBe(0);
    });
  });

  describe('hostile inputs', () => {
    it('rejects a zero-byte file', async () => {
      const path = join(temp, 'zero.png');
      await writeFile(path, Buffer.alloc(0));

      await expect(probe.metadata(path)).rejects.toThrow(/is empty/);
    });

    it('rejects a text file wearing a .png extension', async () => {
      const path = join(temp, 'text.png');
      await writeFile(path, 'this is not a png, it merely has the extension');

      await expect(probe.metadata(path)).rejects.toThrow(/does not begin as any image format/);
    });

    it('rejects a truncated image', async () => {
      const source = await noisyJpeg('whole.jpg', 40, 40);
      const { readFile } = await import('node:fs/promises');
      const path = join(temp, 'truncated.jpg');
      await writeFile(path, (await readFile(source)).subarray(0, 24));

      // `failOn: 'none'` does not rescue this: it governs decode warnings, not header
      // parsing. There is no lenient mode, so the caller has to catch and report.
      await expect(probe.metadata(path)).rejects.toThrow(/corrupt header|unsupported/i);
    });

    it('rejects a file that is not there', async () => {
      await expect(probe.metadata(join(temp, 'absent.png'))).rejects.toThrow(/missing/i);
    });

    it('turns every one of those into a reported reason rather than a crash', async () => {
      const zero = join(temp, 'zero2.png');
      await writeFile(zero, Buffer.alloc(0));

      const results = await probeAssets(
        [asset(zero, 'zero2.png'), asset(join(temp, 'absent2.png'), 'absent2.png')],
        { probe, formats: ['webp'] },
      );

      expect(results.map((result) => result.metadata)).toEqual([null, null]);
      expect(results.every((result) => result.skipped.length === 2)).toBe(true);
    });
  });

  describe('animation: the measurement that would otherwise be a lie', () => {
    it('reports frame count from a plain read', async () => {
      const path = await animatedGif('loop', 6);

      const result = await probe.metadata(path);

      // The plain read sees the frames, so detecting an animation costs nothing.
      expect(result.pages).toBe(6);
    });

    it('reports the dimensions of one frame, not of every frame stacked', async () => {
      const path = await animatedGif('loop2', 6);

      const result = await probe.metadata(path);

      // Read with `{ animated: true }`, this file reports a height six times larger,
      // every frame in one strip, and an oversized-by-dimensions finding fed from that
      // number would be wrong by a factor of six.
      expect(result.height).toBe(FRAME_HEIGHT);
      expect(result.width).toBe(FRAME_WIDTH);
    });

    it('measures an animated encode as animated, not as its first frame', async () => {
      const path = await animatedGif('loop3', 6);

      const asOneFrame = await probe.encodedBytes({ path, format: 'webp', animated: false });
      const asAnimation = await probe.encodedBytes({ path, format: 'webp', animated: true });

      // This is the whole reason `animated` is on the port. Measuring the first
      // frame reports a saving achievable only by throwing the other five away.
      expect(asAnimation).toBeGreaterThan(asOneFrame);
    });

    it('passes `animated` through from the metadata it already read', async () => {
      const path = await animatedGif('loop4', 6);

      const [result] = await probeAssets([asset(path, 'loop4.gif')], {
        probe,
        formats: ['webp'],
      });
      const asOneFrame = await probe.encodedBytes({ path, format: 'webp', animated: false });

      expect(result?.encoded[0]?.bytes).toBeGreaterThan(asOneFrame);
    });

    it('refuses to encode an animation to AVIF, which it would write as one still picture', async () => {
      const path = await animatedGif('loop5', 6);
      const destination = join(temp, 'loop5.avif');

      await expect(
        probe.encodeToFile({ path, format: 'avif', animated: true, destination }),
      ).rejects.toThrow(/single still image/);
      await expect(probe.encodedBytes({ path, format: 'avif', animated: true })).rejects.toThrow(
        /single still image/,
      );
      expect(await readdir(temp)).not.toContain('loop5.avif');
    });

    it('keeps every frame of an animation written as WebP', async () => {
      // The refusal above tells the user WebP keeps the animation, so that is checked.
      const { default: sharp } = await import('sharp');
      const path = await animatedGif('loop6', 6);
      const destination = join(temp, 'loop6.webp');

      await probe.encodeToFile({ path, format: 'webp', animated: true, destination });

      expect((await sharp(destination).metadata()).pages).toBe(6);
    });
  });

  describe('an animated PNG, which sharp reads as its first frame', () => {
    it('reports the frames the file declares', async () => {
      const path = join(temp, 'loop.png');
      await writeFile(path, animatedPng(32, 32, gradientFrames(32, 3)));

      expect(await probe.metadata(path)).toEqual({
        width: 32,
        height: 32,
        format: 'png',
        pages: 3,
      });
    });

    it('is measured in no format, since a conversion would keep one still frame', async () => {
      const path = join(temp, 'loop2.png');
      await writeFile(path, animatedPng(32, 32, gradientFrames(32, 3)));

      const [result] = await probeAssets([asset(path, 'loop2.png')], {
        probe,
        formats: ['avif', 'webp'],
      });

      expect(result?.encoded).toEqual([]);
      expect(result?.skipped.map((skip) => [skip.measurement, skip.code])).toEqual([
        ['avif', 'drops-animation'],
        ['webp', 'drops-animation'],
      ]);
    });

    it('still reads a still PNG as one frame', async () => {
      expect(await probe.metadata(join(FIXTURES, 'plain-html/images/logo.png'))).toMatchObject({
        format: 'png',
        pages: 1,
      });
    });
  });
});

describe('a converted image looks like the original', () => {
  // Where the red half of the stored image appears once a viewer turns it, at two points of
  // the image as shown. Tag 6 is a quarter turn clockwise, 8 anticlockwise and 3 a half
  // turn, so a quarter turn shows it 200 by 400.
  it.each([
    { orientation: 6, size: '200x400', red: [100, 100], blue: [100, 300] },
    { orientation: 8, size: '200x400', red: [100, 300], blue: [100, 100] },
    { orientation: 3, size: '400x200', red: [300, 100], blue: [100, 100] },
  ] as const)(
    'turns a photo tagged $orientation the way a viewer shows it',
    async ({ orientation, size, red, blue }) => {
      const path = await taggedPhoto(`tagged-${orientation}.jpg`, orientation);
      const destination = join(temp, `tagged-${orientation}.webp`);

      await probe.encodeToFile({ path, format: 'webp', animated: false, destination });

      for (const file of [path, destination]) {
        const view = await shown(file);
        expect([file, view.size]).toEqual([file, size]);
        expect([file, view.at(red[0], red[1]), view.at(blue[0], blue[1])]).toEqual([
          file,
          'red',
          'blue',
        ]);
      }
    },
  );

  it('measures the turned file it writes, byte for byte', async () => {
    const { default: sharp } = await import('sharp');
    const path = await taggedPhoto('tagged-measured.jpg', 6);
    const destination = join(temp, 'tagged-measured.webp');

    const measured = await probe.encodedBytes({ path, format: 'webp', animated: false });
    const written = await probe.encodeToFile({
      path,
      format: 'webp',
      animated: false,
      destination,
    });
    // The unturned encode differs in size, so measuring the unturned image cannot pass.
    const unturned = await sharp(path).webp({ quality: probe.quality.webp }).toBuffer();

    expect(written).toBe(measured);
    expect(unturned.length).not.toBe(measured);
    expect((await shown(destination)).size).toBe('200x400');
  });

  it.each(['webp', 'avif'] as const)(
    'keeps the colours of a photo with an embedded colour profile, as %s',
    async (format) => {
      // Display P3 stores other numbers for the same red. Read as sRGB, those numbers
      // show a duller red, so the encode has to keep the profile or convert through it.
      const { default: sharp } = await import('sharp');
      const red = Buffer.alloc(32 * 32 * 3);
      for (let index = 0; index < red.length; index += 3) red.set([255, 0, 0], index);
      const path = join(temp, `p3-${format}.png`);
      await sharp(red, { raw: { width: 32, height: 32, channels: 3 } })
        .withIccProfile('p3')
        .png()
        .toFile(path);
      const destination = join(temp, `p3.${format}`);

      await probe.encodeToFile({ path, format, animated: false, destination });

      const channels = async (file: string, options: { ignoreIcc?: boolean } = {}) => [
        ...(await sharp(file, options).raw().toBuffer()).subarray(0, 3),
      ];
      const near = (actual: number[], expected: number[]) =>
        actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= 12);
      // The fixture stores numbers that differ from the red it shows, or this proves nothing.
      expect(near(await channels(path, { ignoreIcc: true }), [255, 0, 0])).toBe(false);
      expect(near(await channels(path), [255, 0, 0])).toBe(true);
      expect(near(await channels(destination), [255, 0, 0])).toBe(true);
    },
  );

  /** A 32 by 32 red PNG or JPEG carrying one of libvips' own profiles, and its stored numbers. */
  async function profiledRed(name: string, profile: 'srgb' | 'p3' | 'cmyk') {
    const { default: sharp } = await import('sharp');
    const red = Buffer.alloc(32 * 32 * 3);
    for (let index = 0; index < red.length; index += 3) red.set([255, 0, 0], index);
    const path = join(temp, name);
    await sharp(red, { raw: { width: 32, height: 32, channels: 3 } })
      .withIccProfile(profile)
      .toFile(path);
    const { icc } = await sharp(path).metadata();
    const stored = await sharp(path, { ignoreIcc: true }).raw().toBuffer();
    return { path, icc, stored };
  }

  it.each(['webp', 'avif'] as const)(
    'keeps a Display P3 profile with the numbers it describes, so a wide-gamut screen shows them, as %s',
    async (format) => {
      const { default: sharp } = await import('sharp');
      const source = await profiledRed(`wide-${format}.png`, 'p3');
      const destination = join(temp, `wide.${format}`);

      const measured = await probe.encodedBytes({ path: source.path, format, animated: false });
      const written = await probe.encodeToFile({
        path: source.path,
        format,
        animated: false,
        destination,
      });

      const { icc } = await sharp(destination).metadata();
      const stored = await sharp(destination, { ignoreIcc: true }).raw().toBuffer();
      expect(source.icc).toBeDefined();
      expect(icc?.equals(source.icc ?? Buffer.alloc(0))).toBe(true);
      // Converted into sRGB, the stored red would be about 255, 0, 0 instead of these.
      for (const channel of [0, 1, 2]) {
        expect(
          Math.abs((stored[channel] ?? 0) - (source.stored[channel] ?? 0)),
        ).toBeLessThanOrEqual(3);
      }
      expect(written).toBe(measured);
    },
  );

  it.each(['webp', 'avif'] as const)(
    'adds no bytes to an image whose profile is sRGB, as %s',
    async (format) => {
      const { default: sharp } = await import('sharp');
      const source = await profiledRed(`srgb-${format}.png`, 'srgb');
      const bare = join(temp, `srgb-bare-${format}.png`);
      await sharp(source.stored, { raw: { width: 32, height: 32, channels: 3 } }).toFile(bare);
      const destination = join(temp, `srgb.${format}`);

      const profiled = await probe.encodedBytes({ path: source.path, format, animated: false });
      const plain = await probe.encodedBytes({ path: bare, format, animated: false });
      await probe.encodeToFile({ path: source.path, format, animated: false, destination });

      expect(source.icc).toBeDefined();
      expect(profiled).toBe(plain);
      expect((await sharp(destination).metadata()).icc).toBeUndefined();
    },
  );

  it.each(['webp', 'avif'] as const)(
    'keeps the colours of a 16-bit image whose profile is sRGB, as %s',
    async (format) => {
      // Converted without a target, libvips turns a 16-bit sRGB image into another space's
      // numbers and the profile is then dropped: pure red was written as 234, 51, 34.
      const { default: sharp } = await import('sharp');
      const red = Buffer.alloc(32 * 32 * 3);
      for (let index = 0; index < red.length; index += 3) red.set([255, 0, 0], index);
      const path = join(temp, `deep-srgb-${format}.png`);
      await sharp(red, { raw: { width: 32, height: 32, channels: 3 } })
        .withIccProfile('srgb')
        .toColourspace('rgb16')
        .png()
        .toFile(path);
      const destination = join(temp, `deep-srgb.${format}`);

      const measured = await probe.encodedBytes({ path, format, animated: false });
      const written = await probe.encodeToFile({ path, format, animated: false, destination });

      const shown = [
        ...(await sharp(destination, { ignoreIcc: true }).raw().toBuffer()).subarray(0, 3),
      ];
      expect((await sharp(path).metadata()).depth).toBe('ushort');
      expect((await sharp(destination).metadata()).icc).toBeUndefined();
      expect(shown.every((value, index) => Math.abs(value - (index === 0 ? 255 : 0)) <= 3)).toBe(
        true,
      );
      expect(written).toBe(measured);
    },
  );

  it('converts a CMYK photo into sRGB, since WebP and AVIF hold only RGB', async () => {
    const { default: sharp } = await import('sharp');
    const source = await profiledRed('cmyk.jpg', 'cmyk');
    const destination = join(temp, 'cmyk.webp');

    await probe.encodeToFile({ path: source.path, format: 'webp', animated: false, destination });

    const shownRed = [...(await sharp(destination).raw().toBuffer()).subarray(0, 3)];
    expect((await sharp(source.path).metadata()).space).toBe('cmyk');
    expect((await sharp(destination).metadata()).icc).toBeUndefined();
    expect(shownRed.every((value, index) => Math.abs(value - (index === 0 ? 255 : 0)) <= 40)).toBe(
      true,
    );
  });
});
