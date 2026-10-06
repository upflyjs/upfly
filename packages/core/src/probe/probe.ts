/**
 * Measure images: dimensions from a header read, and the size of an in-memory encode in
 * each requested format.
 *
 * `oversized` needs the dimensions, and a format opportunity must come from a real encode
 * rather than an estimate. A header read costs about a millisecond at any size and an
 * encode three orders of magnitude more, so `ImageProbe` keeps them as separate methods
 * and a caller asks for encodes by format. See "The probe, and why it has two methods" in
 * ARCHITECTURE.md.
 */

import { mapInOrder } from '../map-in-order.js';
import { compareStrings, extensionOf, isVectorExtension } from '../paths.js';
import type { Asset } from '../types.js';

/** A format we can measure an asset against. */
export type EncodeFormat = 'webp' | 'avif';

/** What a header read tells us. */
export interface ImageMetadata {
  /**
   * Width in pixels, of a single frame, as a viewer shows it: a quarter turn in the EXIF
   * orientation tag swaps width and height.
   */
  readonly width: number;
  /** Height in pixels, of a single frame, as a viewer shows it. */
  readonly height: number;
  /** Container format as decoded: `png`, `jpeg`, `webp`, `gif`, `svg`, … */
  readonly format: string;
  /** Frames. `1` for a still image; more means animated. */
  readonly pages: number;
}

/**
 * Reads image headers, measures encodes and writes encoded files. `createSharpProbe` is
 * the real implementation.
 *
 * `audit` measures through it and `optimize` writes through it, so a file is written by
 * the same code that measured it. Methods reject rather than return a sentinel, so that
 * "1×1" and "could not read" cannot be confused; `probeAssets` turns every rejection into
 * a recorded reason.
 */
export interface ImageProbe {
  /**
   * The quality this probe encodes each format at.
   *
   * On the probe rather than on `ProbeOptions`, so `audit` and `optimize`, which share
   * the probe, cannot use different settings.
   */
  readonly quality: Readonly<Record<EncodeFormat, number>>;
  /**
   * Header-only read.
   *
   * Must report the dimensions of one frame, not of every frame stacked together, and
   * `pages`, so a caller can tell an animation from a still without a second read.
   */
  metadata(path: string): Promise<ImageMetadata>;
  /**
   * Encode into memory and report the byte count. Writes nothing.
   *
   * `animated` must be honoured: encoding a ten-frame GIF without it keeps one
   * frame and reports a saving that is only achievable by destroying the image.
   */
  encodedBytes(input: {
    readonly path: string;
    readonly format: EncodeFormat;
    readonly animated: boolean;
    /**
     * Encode losslessly instead of at `quality`. When to ask for it is decided by
     * `probeAssets`, not by the port, so the report can say which setting produced the
     * bytes.
     */
    readonly lossless?: boolean;
  }): Promise<number>;
  /** Encode to a file and report the bytes written. */
  encodeToFile(input: {
    readonly path: string;
    readonly format: EncodeFormat;
    readonly animated: boolean;
    readonly destination: string;
    /**
     * Must match the setting the saving was measured at, or the file written is not the
     * one whose saving was reported. `PlannedConversion.quality` carries it here.
     */
    readonly lossless?: boolean;
  }): Promise<number>;
}

/**
 * Why a measurement was not taken. Machine-readable so a report can group by it.
 *
 * The failure codes follow what a user can do about the failure: supply a real image,
 * fix the SVG, or make the image smaller. Each is decided from our own data (the
 * extension, the measured dimensions), never from the library's error text, so the list
 * does not grow when libvips adds a message. See "The recorded reason is ours, and the
 * library's is not in the report" in ARCHITECTURE.md.
 */
export type ProbeSkipCode =
  /**
   * Not readable as an image at all: usually a file with an image extension that is not
   * an image, such as an HTML error page saved as `.png`, a Git LFS pointer or a
   * zero-byte placeholder.
   */
  | 'not-an-image'
  /**
   * An SVG the vector parser would not read: no usable width and height, malformed XML,
   * or a file too large for the XML parser. One code for all three, because the fix is
   * the same and only libvips' wording tells them apart.
   */
  | 'svg-unreadable'
  /**
   * The header read, but the image is larger than `MAX_ENCODE_PIXELS`, the most we
   * decode to measure an encode. Kept apart from `encode-failed` because it has a clear
   * fix: resizing the image.
   */
  | 'too-large-to-encode'
  /**
   * The header read, but the encode failed for a reason we cannot attribute.
   *
   * The residual: without it, a failure nothing classifies would be missing from the
   * report. It should be rare, and an instance is a prompt to investigate rather than a
   * reason to add codes.
   */
  | 'encode-failed'
  /** An SVG: encoding it measures a rasterisation, not a saving. */
  | 'vector'
  /** The asset is already in the format we would convert it to. */
  | 'already-target-format'
  /**
   * An animation the conversion would not keep: its source format is in
   * `FIRST_FRAME_ONLY_SOURCES`, or the target is in `STILL_ONLY_FORMATS`.
   */
  | 'drops-animation'
  /** Deliberately not measured, to bound how long the audit takes. */
  | 'beyond-encode-cap'
  /**
   * Not encoded because `optimize` would not convert it whatever it measured, as
   * `ProbeOptions.encodeOnly` says: no saving of its would reach a visitor.
   */
  | 'would-not-convert';

/**
 * A measurement that was not taken, and why. It reaches the report like any other
 * skipped item, with its reason.
 */
export interface ProbeSkip {
  /** `metadata`, or the format whose encode was skipped. */
  readonly measurement: 'metadata' | EncodeFormat;
  /** Groupable: a report counts capped assets without matching on prose. */
  readonly code: ProbeSkipCode;
  /**
   * Rendered verbatim in the report. Written by Upfly, never the library's error text,
   * which varies between runs and versions; that text goes to `ProbeOptions.onDiagnostic`.
   */
  readonly reason: string;
}

/**
 * A failing imaging library's own message, for `ProbeOptions.onDiagnostic`.
 *
 * Not a field on `ProbeSkip`, so the report, which is built from `ProbeSkip`, has no way
 * to print it or sort on it.
 */
export interface ProbeDiagnostic {
  /** POSIX-relative path of the asset being measured. */
  readonly asset: string;
  readonly measurement: 'metadata' | EncodeFormat;
  readonly code: Extract<
    ProbeSkipCode,
    'not-an-image' | 'svg-unreadable' | 'too-large-to-encode' | 'encode-failed'
  >;
  /** Verbatim from the library. Unstable between runs, and never a report's business. */
  readonly detail: string;
}

/**
 * How an encode was produced: a lossy quality setting, or exactly.
 *
 * `'lossless'` is a setting, not a quality of 100. A lossless WebP is bit-exact and a
 * lossy one at 100 is not, so any number standing in for it (`0`, `-1`, `100`) would
 * misdescribe the encode to everything that formats it.
 */
export type EncodeSetting = number | 'lossless';

/** What one encode measured. */
export interface EncodedSize {
  readonly format: EncodeFormat;
  readonly bytes: number;
  /**
   * The setting this byte count was produced at.
   *
   * Carried on the measurement, so a saving is never written down without its setting:
   * 95% at quality 50 and 44% at quality 90 describe different files.
   *
   * It varies per image, not per run: two PNGs in one run can carry `80` and
   * `'lossless'`. A summary across assets must collect the settings rather than keep
   * one, as `savingQuality` in `report.ts` does.
   */
  readonly quality: EncodeSetting;
}

/**
 * The quality each format is encoded at by default.
 *
 * Chosen with `bench/src/encode-quality.ts` on 30 images sampled from the five validation
 * repositories, scored on bytes saved and on how far the decoded pixels moved. webp 80 is
 * the highest quality at which no sampled image grew, and it keeps every lossless source
 * above 36 dB. Raising it does not help the two worst cases, already-lossy JPEGs near
 * 34 dB at any setting, and 90 costs 10 points of median saving. avif 75, because the two
 * scales differ: at 75 AVIF keeps every sample above 35 dB and saves about as much as
 * webp 80.
 */
export const DEFAULT_ENCODE_QUALITY: Readonly<Record<EncodeFormat, number>> = Object.freeze({
  webp: 80,
  avif: 75,
});

/**
 * The largest source decoded to measure an encode, in pixels.
 *
 * Equal to sharp's default `limitInputPixels` and passed to sharp explicitly, so that
 * `too-large-to-encode` is decided by comparing measured dimensions with a limit we own,
 * never by reading libvips' error text.
 */
export const MAX_ENCODE_PIXELS = 0x3fff * 0x3fff;

/**
 * Formats written as a single still image. sharp writes AVIF that way, and an animation sent
 * to it comes out as one picture of every frame stacked, so an animation is never encoded
 * to one of these.
 */
export const STILL_ONLY_FORMATS: ReadonlySet<EncodeFormat> = new Set(['avif']);

/**
 * Source formats read as their first frame even when animated. sharp reads an animated PNG
 * that way, so converting one would keep a still picture of its first frame.
 */
const FIRST_FRAME_ONLY_SOURCES: ReadonlySet<string> = new Set(['png']);

/** Everything measured about one asset. */
export interface AssetProbe {
  /** The report key: POSIX-relative path, matching `Asset.relative`. */
  readonly relative: string;
  /** `null` when the header could not be read; `skipped` then says why. */
  readonly metadata: ImageMetadata | null;
  /** Measured encodes, sorted by format. Only ever formats that were requested. */
  readonly encoded: readonly EncodedSize[];
  /** Every measurement not taken, with a reason. */
  readonly skipped: readonly ProbeSkip[];
}

export interface ProbeOptions {
  /** The port. Required, so nothing probes by accident. */
  readonly probe: ImageProbe;
  /**
   * Formats to measure each asset against. An empty list measures dimensions only.
   *
   * No default here: the conversion target is the configuration's decision (webp unless
   * avif is chosen), and the audit measures only the format it would convert to.
   */
  readonly formats: readonly EncodeFormat[];
  /**
   * How many assets to encode at all. Unbounded when absent.
   *
   * A count, because encode cost follows pixel count rather than file size, and a time
   * budget would make the report depend on the machine. The largest sources are chosen,
   * ties broken by path, and the rest are reported as `beyond-encode-cap`. Only format
   * opportunities lose detail: `dead`, `broken` and `oversized` need no encode. The CLI
   * sets it with `--max-encodes <n>` and clears it with `--probe-all`. See "The cap is a
   * count, not a threshold or a deadline" in ARCHITECTURE.md.
   *
   * With `encodeOnly`, an asset is taken with every other one whose name, less its
   * extension, is the same in any letter case, since whether one converts can depend on
   * another converted to the same name; the count can then pass the cap by those few.
   */
  readonly maxEncodedAssets?: number;
  /**
   * The only assets to encode, by POSIX-relative path, when not all: the rest have their
   * header read and are skipped as `would-not-convert`. The cap chooses among these.
   */
  readonly encodeOnly?: ReadonlySet<string>;
  /**
   * Assets to measure whatever the cap says. `Asset` objects rather than paths: the cap is
   * keyed on the absolute `asset.path` while the planner mostly uses relative paths, and
   * objects leave no string to get wrong.
   */
  readonly alwaysMeasure?: readonly Asset[];
  /**
   * Assets measured at once, the next starting as soon as any finishes. Defaults to 4, the
   * size of Node's thread pool, which sharp's work runs on: more at once would only queue
   * there, unless `UV_THREADPOOL_SIZE` was set before Node started.
   */
  readonly concurrency?: number;
  /**
   * Receives a failing library's own message, when a caller wants it. Without a sink the
   * text is dropped; the report needs only the skip's `code` and `reason`.
   *
   * Called during measurement, and a sink that throws makes `probeAssets` reject, so
   * append to a list or write a line and do nothing more.
   */
  readonly onDiagnostic?: (diagnostic: ProbeDiagnostic) => void;
  /**
   * Called as each image's measurement ends, with how many have ended and how many there
   * are, so a caller can show progress. The counts rise by one each time, whichever image
   * finished; a sink that throws makes `probeAssets` reject.
   */
  readonly onMeasured?: (done: number, total: number) => void;
}

const DEFAULT_CONCURRENCY = 4;

/** What the report says when a measurement failed: one fixed sentence per code. */
const FAILURE_REASON: Record<
  'not-an-image' | 'svg-unreadable' | 'too-large-to-encode' | 'encode-failed',
  string
> = {
  'not-an-image': 'this file could not be read as an image, so nothing about it could be measured',
  'svg-unreadable':
    'this SVG could not be read (its dimensions, its XML or its size defeated the parser), so nothing about it could be measured',
  'too-large-to-encode': `this image is larger than the ${groupDigits(MAX_ENCODE_PIXELS)} pixels Upfly decodes to measure an encode, every frame counted, so there is no size to compare (resize it to have it measured)`,
  'encode-failed': 'the image decoded but re-encoding it failed, so there is no size to compare',
};

/**
 * Thousands separators, by hand. `toLocaleString` is unsafe even with an explicit locale:
 * a Node built with `small-icu` can format the same number differently, and the report
 * must be the same bytes on every machine.
 */
function groupDigits(value: number): string {
  const digits = String(value);
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    const fromEnd = digits.length - index;
    out += digits[index];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
  }
  return out;
}

/**
 * A short form of the header failure, for the encode entries that follow it. The
 * metadata entry has already said what went wrong; these only say what follows from it.
 */
const ENCODE_FOLLOWS: Record<'not-an-image' | 'svg-unreadable', string> = {
  'not-an-image': 'this file could not be read as an image, so there is nothing to encode',
  'svg-unreadable': 'this SVG could not be read, so there is nothing to encode',
};

/**
 * Which of the two header failures this asset is, decided by its extension rather than
 * by the library's message: a `.svg` that will not read is an SVG to fix, and anything
 * else is not an image.
 */
function headerFailureCode(asset: Asset): 'not-an-image' | 'svg-unreadable' {
  return isVectorExtension(extensionOf(asset.path)) ? 'svg-unreadable' : 'not-an-image';
}

/**
 * Whether this asset is past `MAX_ENCODE_PIXELS`.
 *
 * `pages` counts because an animated source is decoded with every frame stacked into one
 * strip, so a ten-frame GIF presents ten times its own area to the limit. False when the
 * header never read: that asset already has a header code.
 */
function isBeyondPixelBudget(metadata: ImageMetadata): boolean {
  return metadata.width * metadata.height * Math.max(1, metadata.pages) > MAX_ENCODE_PIXELS;
}

/**
 * Measure every asset: its dimensions, and its encoded size in each requested format.
 *
 * Never rejects for a bad image. A zero-byte file, a truncated PNG, a text file
 * with a `.png` extension and a file that vanished mid-run all become an
 * `AssetProbe` carrying `metadata: null` and a reason for the report.
 */
export async function probeAssets(
  assets: readonly Asset[],
  options: ProbeOptions,
): Promise<AssetProbe[]> {
  const withinCap = assetsWithinCap(assets, options);
  let done = 0;
  // The next asset starts as soon as any finishes, so one large image never holds back the
  // rest. The output follows the asset list, not which encode finished first, and the cap
  // changes which assets are encoded, never the order they come back in.
  return mapInOrder(assets, options.concurrency ?? DEFAULT_CONCURRENCY, async (asset) => {
    const probe = await probeOne(asset, options, withinCap);
    done += 1;
    options.onMeasured?.(done, assets.length);
    return probe;
  });
}

/**
 * The assets whose encodes will be attempted: the largest sources up to the cap, plus
 * `alwaysMeasure`. `null` when nothing is capped.
 *
 * Assets that could never be encoded (a vector, or one already in every requested
 * format) are removed before the cap applies, so they cannot hold a slot they will not
 * use. That test is by extension, all that is known before a header read; a mislabelled
 * file, or an animation going to a still-only format, is caught after the header read and
 * leaves its slot unused.
 */
function assetsWithinCap(
  assets: readonly Asset[],
  options: ProbeOptions,
): ReadonlySet<string> | null {
  const cap = options.maxEncodedAssets;
  if (cap === undefined || options.formats.length === 0) return null;

  const eligible = assets.filter(
    (asset) =>
      couldEncode(asset, options.formats) && (options.encodeOnly?.has(asset.relative) ?? true),
  );
  if (eligible.length <= cap) return null;

  // Exempt assets are left out of the ranking rather than added to it, so they take no
  // slot and the cap still counts the largest of the rest.
  const exempt = new Set((options.alwaysMeasure ?? []).map((asset) => asset.path));
  const ordered = [...eligible]
    .filter((asset) => !exempt.has(asset.path))
    .sort(
      // Largest source first, ties broken by path, so two runs over the same
      // repository choose the same assets.
      (a, b) => b.bytes - a.bytes || compareStrings(a.relative, b.relative),
    );

  const taken = new Set(ordered.slice(0, Math.max(0, cap)));
  if (options.encodeOnly !== undefined) {
    const names = new Set([...taken].map(stemOf));
    for (const asset of ordered) if (names.has(stemOf(asset))) taken.add(asset);
  }
  return new Set([...exempt, ...[...taken].map((asset) => asset.path)]);
}

/** An asset's file name less its extension, in lower case: what its converted file shares. */
function stemOf(asset: Asset): string {
  const name = asset.relative.slice(asset.relative.lastIndexOf('/') + 1);
  return name.slice(0, name.length - asset.extension.length).toLowerCase();
}

/** Whether any requested format could produce a measurement, judged by extension alone. */
function couldEncode(asset: Asset, formats: readonly EncodeFormat[]): boolean {
  const extension = extensionOf(asset.path);
  if (isVectorExtension(extension)) return false;
  return formats.some((format) => extension !== `.${format}`);
}

/**
 * The size of a lossless encode, or `Infinity` when it fails. The measurement at the configured
 * quality then stands, so nothing is reported missing; the library's message still reaches the
 * diagnostics.
 */
async function losslessSize(
  asset: Asset,
  format: EncodeFormat,
  animated: boolean,
  options: ProbeOptions,
): Promise<number> {
  try {
    return await options.probe.encodedBytes({ path: asset.path, format, animated, lossless: true });
  } catch (error) {
    options.onDiagnostic?.({
      asset: asset.relative,
      measurement: format,
      code: 'encode-failed',
      detail: `lossless encode: ${describe(error)}`,
    });
    return Number.POSITIVE_INFINITY;
  }
}

async function probeOne(
  asset: Asset,
  options: ProbeOptions,
  withinCap: ReadonlySet<string> | null,
): Promise<AssetProbe> {
  const skipped: ProbeSkip[] = [];

  const fail = (
    measurement: 'metadata' | EncodeFormat,
    code: keyof typeof FAILURE_REASON,
    error: unknown,
  ): void => {
    skipped.push({ measurement, code, reason: FAILURE_REASON[code] });
    options.onDiagnostic?.({ asset: asset.relative, measurement, code, detail: describe(error) });
  };

  let metadata: ImageMetadata;
  try {
    metadata = await options.probe.metadata(asset.path);
  } catch (error) {
    // Nothing is encoded without a header, so every format is declined here, before any
    // code below could guess a frame count. The entries carry the metadata failure's code,
    // so they cannot contradict it with something vaguer in the same report.
    const code = headerFailureCode(asset);
    fail('metadata', code, error);
    const declined = [...options.formats]
      .sort()
      .map((format): ProbeSkip => ({ measurement: format, code, reason: ENCODE_FOLLOWS[code] }));
    return {
      relative: asset.relative,
      metadata: null,
      encoded: [],
      skipped: [...skipped, ...declined],
    };
  }

  const capped = withinCap !== null && !withinCap.has(asset.path);
  const encoded: EncodedSize[] = [];

  for (const format of [...options.formats].sort()) {
    const skip = encodeSkipReason(asset, metadata, format) ?? notToEncode(asset, options);
    if (skip !== null) {
      skipped.push({ measurement: format, ...skip });
      continue;
    }

    if (capped) {
      skipped.push({
        measurement: format,
        code: 'beyond-encode-cap',
        // Names `--probe-all` rather than `--max-encodes`: this is what a user reads
        // at the moment they want the missing number.
        reason: `not among the ${options.maxEncodedAssets} largest assets measured (run with --probe-all to measure the rest)`,
      });
      continue;
    }

    try {
      // Encode every frame: a GIF encoded as its first frame alone reports a saving that
      // is only achievable by throwing the other frames away.
      const animated = metadata.pages > 1;
      const lossyBytes = await options.probe.encodedBytes({ path: asset.path, format, animated });

      // For a PNG source going to WebP, also measure a lossless encode and keep whichever
      // is smaller. Lossless is bit-exact, so when it is also smaller there is nothing to
      // weigh and no quality metric is consulted. PNG only: an already-lossy source such
      // as a JPEG almost never gains. One entry is recorded, because `measuredSavings` in
      // `plan.ts`, the audit's format opportunities and the report's per-format grouping
      // all assume one measurement per format. See "Lossless WebP for PNG sources" in
      // ARCHITECTURE.md.
      const tryLossless = format === 'webp' && asset.extension === '.png';
      const losslessBytes = tryLossless
        ? await losslessSize(asset, format, animated, options)
        : Number.POSITIVE_INFINITY;

      const useLossless = losslessBytes < lossyBytes;
      encoded.push({
        format,
        quality: useLossless ? 'lossless' : options.probe.quality[format],
        bytes: useLossless ? losslessBytes : lossyBytes,
      });
    } catch (error) {
      // Decided by arithmetic against our own limit, not by reading libvips'
      // `Input image exceeds pixel limit`.
      fail(format, isBeyondPixelBudget(metadata) ? 'too-large-to-encode' : 'encode-failed', error);
    }
  }

  return { relative: asset.relative, metadata, encoded, skipped };
}

/** The skip for an asset `encodeOnly` leaves out, or null when it may be encoded. */
function notToEncode(
  asset: Asset,
  options: ProbeOptions,
): Pick<ProbeSkip, 'code' | 'reason'> | null {
  if (options.encodeOnly === undefined || options.encodeOnly.has(asset.relative)) return null;
  return {
    code: 'would-not-convert',
    reason: 'not measured: optimize would not convert it, so a saving would reach no visitor',
  };
}

/** Why this asset should not be encoded to this format at all, or `null` to measure. */
function encodeSkipReason(
  asset: Asset,
  metadata: ImageMetadata,
  format: EncodeFormat,
): Pick<ProbeSkip, 'code' | 'reason'> | null {
  if (isVectorExtension(extensionOf(asset.path))) {
    return {
      code: 'vector',
      reason: 'SVG is a vector: encoding it measures a rasterisation, not a saving',
    };
  }
  if (metadata.format === format)
    return { code: 'already-target-format', reason: `already ${format}` };
  if (metadata.pages > 1 && FIRST_FRAME_ONLY_SOURCES.has(metadata.format)) {
    return {
      code: 'drops-animation',
      reason: `an animated ${metadata.format.toUpperCase()}, and Upfly reads only its first frame, so the converted file would be a still picture`,
    };
  }
  if (metadata.pages > 1 && STILL_ONLY_FORMATS.has(format)) {
    return {
      code: 'drops-animation',
      reason: `animated, and Upfly writes ${format.toUpperCase()} as a single still image, which would stack every frame into one picture (WebP keeps the animation)`,
    };
  }
  return null;
}

/** A one-line description of a failure, without asserting its shape. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}
