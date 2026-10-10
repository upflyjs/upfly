/**
 * The real `ImageProbe`, backed by sharp. It both measures and writes, and is one of the
 * few modules that touch the disk.
 *
 * sharp is imported lazily. It is a native module, and a top-level import would load its
 * binary whenever `upfly-core` is imported, so `upfly audit --no-probe` would fail on a
 * machine whose sharp binary does not load, although it reads no pixels at all.
 */

import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { constants, gunzipSync } from 'node:zlib';
import type { EncodeFormat, ImageMetadata, ImageProbe } from './probe.js';
import {
  DEFAULT_ENCODE_QUALITY,
  MAX_ENCODE_PIXELS,
  NotAnImageError,
  STILL_ONLY_FORMATS,
} from './probe.js';

/**
 * Build the sharp-backed probe.
 *
 * The quality is fixed here, and the same probe serves `audit` and `optimize`, so the two
 * cannot use different settings. Async because sharp is imported on first use: it rejects
 * when sharp's native binary cannot load, before any image has been read.
 */
export async function createSharpProbe(
  quality: Readonly<Record<EncodeFormat, number>> = DEFAULT_ENCODE_QUALITY,
): Promise<ImageProbe> {
  const { default: sharp } = await import('sharp');

  // libvips caches operations, and a cached operation holds its input file open for the
  // life of the process, so on Windows the process cannot delete a file it has probed and
  // no retry helps. Turned off here rather than by the caller, because a caller who forgets
  // gets a failure that looks like a virus scanner or a flaky disk. What the cache would
  // save is unmeasured: an applied run decodes each source up to three times (header,
  // measurement, written file).
  sharp.cache(false);

  /**
   * Build the output pipeline for one encode.
   *
   * Both encoding methods use it, so a measurement and the file it predicts always share
   * their settings.
   */
  const encoder = async (
    path: string,
    format: EncodeFormat,
    animated: boolean,
    lossless = false,
  ) => {
    if (animated && STILL_ONLY_FORMATS.has(format)) {
      throw new Error(
        `${format} is written as a single still image, so an animation cannot be encoded to it without stacking its frames into one picture`,
      );
    }
    await mustBeReadable(path);

    // Without `animated`, sharp encodes the first frame alone, and every animated GIF
    // would report a saving only achievable by destroying the animation.
    //
    // `MAX_ENCODE_PIXELS` equals sharp's default `limitInputPixels`, so passing it changes
    // no output. It is passed so that the limit in force stays the one
    // `too-large-to-encode` is computed against, even if sharp's default changes.
    //
    // The encode drops metadata, the EXIF orientation tag with it, so `autoOrient` turns the
    // pixels the way a viewer would; phones store most photos unturned.
    const pipeline = sharp(path, {
      animated,
      autoOrient: true,
      limitInputPixels: MAX_ENCODE_PIXELS,
    });
    // Without this, sharp converts through the embedded profile into sRGB and drops it.
    if (keepsProfile((await pipeline.metadata()).icc)) pipeline.keepIccProfile();
    // Converted with no target named, a 16-bit image ends in another space's numbers once its
    // profile is dropped, and its colours come out duller; for any other image this writes
    // the same bytes.
    else pipeline.withIccProfile('srgb', { attach: false });
    switch (format) {
      case 'webp':
        // sharp ignores `quality` when `lossless` is set, so the two are never passed
        // together: a number with no effect would look as if it had one.
        return lossless
          ? pipeline.webp({ lossless: true })
          : pipeline.webp({ quality: quality.webp });
      case 'avif':
        // No lossless AVIF: `avif 75` already holds up on the images lossless helps, and
        // lossless AVIF has not been measured, so it is not offered.
        return pipeline.avif({ quality: quality.avif });
      default: {
        const unhandled: never = format;
        return unhandled;
      }
    }
  };

  return {
    quality,

    async metadata(path: string): Promise<ImageMetadata> {
      // A plain read, not `{ animated: true }`: the animated read reports every frame
      // stacked into one strip, so an oversized-by-dimensions finding would be wrong by
      // the frame count. The plain read gives one frame's size and still reports `pages`.
      await mustBeReadable(path);
      const result = await sharp(path).metadata();
      const format = result.format ?? 'unknown';

      return {
        // `autoOrient` holds the size once the EXIF orientation tag is applied, as a viewer
        // shows it; `width` and `height` are the stored size.
        width: result.autoOrient?.width ?? result.width ?? 0,
        height: result.autoOrient?.height ?? result.height ?? 0,
        format,
        // Absent for a still image; present and greater than 1 for an animation. sharp
        // reads an animated PNG as its first frame and reports no pages, so a PNG's count
        // comes from the file.
        pages: format === 'png' ? await pngFrames(path) : (result.pages ?? 1),
      };
    },

    async encodedBytes({ path, format, animated, lossless }): Promise<number> {
      const buffer = await (await encoder(path, format, animated, lossless)).toBuffer();
      return buffer.length;
    },

    async encodeToFile({ path, format, animated, destination, lossless }): Promise<number> {
      // The staged tree mirrors the project, so a destination is often several
      // directories deep in a run directory that did not exist a moment ago. sharp
      // reports a missing directory as "unable to open for write", which reads like a
      // permissions problem, so the port creates it.
      await mkdir(dirname(destination), { recursive: true });
      const { size } = await (await encoder(path, format, animated, lossless)).toFile(destination);
      return size;
    },
  };
}

/**
 * How much of a file is read to tell whether sharp reads it: libvips looks for an SVG's `<svg`
 * within the first 1,000 bytes, and tells every other format it reads by the first 12.
 */
const HEAD_BYTES = 1000;

/**
 * Rejects a file whose own bytes show sharp cannot read it, before sharp is asked: an empty
 * file, text under an image's name such as a Git LFS pointer, a file that is gone.
 *
 * On Windows, sharp 0.35 can end the whole process, printing nothing, when it fails to
 * recognise one file while it reads another, and the probe measures several images at once.
 * A file sharp would refuse is refused here instead, with the same outcome in the report. A
 * file in a format sharp reads goes to sharp whatever its name says, and sharp still decides
 * whether it decodes.
 */
async function mustBeReadable(path: string): Promise<void> {
  let head: Buffer;
  try {
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new NotAnImageError(missing ? `${path} is missing` : `${path} could not be read`);
  }
  if (head.length === 0) throw new NotAnImageError(`${path} is empty`);
  if (!inFormatSharpReads(head)) {
    throw new NotAnImageError(`${path} does not begin as any image format sharp reads`);
  }
}

/** The major brands libvips reads as HEIF or AVIF, as `ftyp` names them at bytes 8 to 11. */
const HEIF_BRANDS: ReadonlySet<string> = new Set([
  'heic',
  'heix',
  'hevc',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
]);

/**
 * Whether a file beginning with `head` is in a format sharp's prebuilt binaries read from a
 * file: PNG, JPEG, WebP, GIF, TIFF, HEIF or AVIF, libvips' own format, or SVG. Each test
 * accepts at least what libvips 8.18's loader for that format accepts, so no file sharp reads
 * is turned away.
 */
function inFormatSharpReads(head: Buffer): boolean {
  const text = (start: number, end: number) => head.toString('latin1', start, end);
  const first = head.length >= 4 ? head.readUInt32BE(0) : -1;
  return (
    text(0, 8) === '\x89PNG\r\n\x1a\n' ||
    (head[0] === 0xff && head[1] === 0xd8) ||
    (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') ||
    text(0, 4) === 'GIF8' ||
    // TIFF and BigTIFF, in either byte order.
    [0x49492a00, 0x4d4d002a, 0x49492b00, 0x4d4d002b].includes(first) ||
    (text(4, 8) === 'ftyp' && HEIF_BRANDS.has(text(8, 12))) ||
    // libvips' own format, written in either byte order.
    [0x08f2a6b6, 0xb6a6f208].includes(first) ||
    namesSvg(head)
  );
}

/**
 * Whether libvips would take a file beginning with `head` for an SVG: `<svg` in any letter
 * case within its first 1,000 bytes, inflated first when they are gzip, as an `.svgz` is.
 * libvips also stops at a byte that is not UTF-8 before the tag; that case is left to sharp.
 */
function namesSvg(head: Buffer): boolean {
  let text = head;
  if (head.length >= 18 && head[0] === 0x1f && head[1] === 0x8b) {
    try {
      // A sync flush inflates what the first bytes hold, though the stream goes on past them.
      text = gunzipSync(head, { finishFlush: constants.Z_SYNC_FLUSH }).subarray(0, HEAD_BYTES);
    } catch {
      // libvips inflates with zlib too; a stream that fails here is left for sharp to judge.
      return true;
    }
  }
  return text.toString('latin1').toLowerCase().includes('<svg');
}

/**
 * sRGB's red, green and blue as a profile records them: CIE XYZ adapted to D50, as rounded
 * from the sRGB standard. Profiles from different makers agree to about 0.0001, and Display P3,
 * the nearest wider range, differs by 0.08.
 */
const SRGB_PRIMARIES = [
  ['rXYZ', [0.4361, 0.2225, 0.0139]],
  ['gXYZ', [0.3851, 0.7169, 0.0971]],
  ['bXYZ', [0.1431, 0.0606, 0.7142]],
] as const;

/**
 * Whether an encode keeps an embedded colour profile, rather than converting through it.
 *
 * Converting into sRGB loses nothing from a profile whose primaries are sRGB's, and a grey or
 * CMYK profile cannot describe the RGB that WebP and AVIF store, so those are converted. Any
 * other RGB profile is kept, one that records no primaries included, since nothing short of
 * converting through it tells whether its colours fit inside sRGB.
 * See https://www.color.org/specification/ICC.1-2022-05.pdf, sections 7.2 and 7.3.
 */
function keepsProfile(icc: Buffer | undefined): boolean {
  if (icc === undefined || icc.length < 132 || icc.toString('latin1', 16, 20) !== 'RGB ') {
    return false;
  }
  return !SRGB_PRIMARIES.every(([tag, expected]) => {
    const recorded = primary(icc, tag);
    return (
      recorded !== undefined &&
      expected.every((value, index) => Math.abs((recorded[index] ?? Number.NaN) - value) <= 0.01)
    );
  });
}

/** One primary's XYZ from a profile's tag table, or undefined when the profile has none. */
function primary(icc: Buffer, tag: string): number[] | undefined {
  const end = Math.min(icc.length, 132 + icc.readUInt32BE(128) * 12);
  for (let entry = 132; entry + 12 <= end; entry += 12) {
    if (icc.toString('latin1', entry, entry + 4) !== tag) continue;
    const offset = icc.readUInt32BE(entry + 4);
    if (offset + 20 > icc.length || icc.toString('latin1', offset, offset + 4) !== 'XYZ ') {
      return undefined;
    }
    // An XYZ value is its type, 4 reserved bytes, then X, Y and Z as signed 16.16 fixed point.
    return [0, 1, 2].map((index) => icc.readInt32BE(offset + 8 + 4 * index) / 65536);
  }
  return undefined;
}

/**
 * The frame count an animated PNG declares in its `acTL` chunk, or 1 for a still PNG.
 *
 * `acTL` must come before the first `IDAT`, so only the chunk headers up to there are read.
 * See https://wiki.mozilla.org/APNG_Specification.
 */
async function pngFrames(path: string): Promise<number> {
  const file = await open(path, 'r');
  try {
    // A chunk is its length, its type, its data and a checksum: 12 bytes around the data.
    // The first 4 bytes of an `acTL` chunk's data are the frame count.
    const head = Buffer.alloc(12);
    let position = 8;
    for (;;) {
      const { bytesRead } = await file.read(head, 0, head.length, position);
      if (bytesRead < 8) return 1;
      const type = head.toString('latin1', 4, 8);
      if (type === 'acTL') return bytesRead === head.length ? Math.max(1, head.readUInt32BE(8)) : 1;
      if (type === 'IDAT' || type === 'IEND') return 1;
      position += head.length + head.readUInt32BE(0);
    }
  } finally {
    await file.close();
  }
}
