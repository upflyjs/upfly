/**
 * Turns the graph, the sweep, the probe results and the content hashes into findings.
 *
 * The findings cost very different amounts. `broken`, `serving-root-unknown`, `dead` and
 * `possibly-dead` need only the graph and the sweep, and `duplicate` needs the content
 * hashes. `oversized` needs a header read per asset, about 1 ms, and `format-opportunity`
 * a real encode, up to seconds each, so a low encode cap degrades that one finding alone.
 * Without a probe neither size finding is produced.
 * See "The cap is a count, not a threshold or a deadline" in ARCHITECTURE.md.
 *
 * Pure apart from the `readFile` port, which only turns a broken reference's offset into
 * a line.
 */

import { formatBytes } from '../format.js';
import type { Graph } from '../graph/graph.js';
import { unreferencedAssets } from '../graph/graph.js';
import { compareStrings, relativePath } from '../paths.js';
import type { AssetProbe, EncodeFormat, EncodeSetting } from '../probe/probe.js';
import { provenPath } from '../resolve/reference.js';
import { likelyTypoOf } from '../resolve/resolve.js';
import { citeReferences } from '../scan/citation.js';
import type { ReadFilePort } from '../scan/scan.js';
import type { Reference } from '../types.js';
import type { ConventionLink, ConventionRoot } from './conventions.js';
import { conventionLinkFor } from './conventions.js';
import { findDuplicates } from './duplicates.js';
import {
  type ResolutionHealth,
  dependsOnServingRoot,
  resolutionHealth,
} from './resolution-health.js';
import type { Mention, SweepResult } from './sweep.js';

/** An asset nothing references, whose filename the sweep found nowhere else either. */
export interface DeadFinding {
  readonly kind: 'dead';
  /** POSIX-relative path. */
  readonly asset: string;
  readonly bytes: number;
  /**
   * Whether it sits under a public directory. Such an asset may be linked from outside
   * the repository (a CMS, an email template, another site), which Upfly cannot see. It
   * stays `dead`, because hedging on a possibility with no evidence would hedge every
   * public asset, and the report adds one caveat instead.
   */
  readonly inPublicDir: boolean;
}

/**
 * An asset nothing references, whose filename the sweep found somewhere: in a file no
 * adapter could read, in a path that did not resolve, or in text no adapter understood.
 */
export interface PossiblyDeadFinding {
  readonly kind: 'possibly-dead';
  readonly asset: string;
  readonly bytes: number;
  readonly inPublicDir: boolean;
  /** Why it is hedged. Never empty: an asset with no evidence is `dead`. */
  readonly evidence: readonly [Mention, ...Mention[]];
}

/** A path the author asserted was an asset, pointing at nothing. */
export interface BrokenFinding {
  readonly kind: 'broken';
  /** POSIX-relative path of the source file. */
  readonly file: string;
  /** One-based line, or `null` if the file could not be re-read. */
  readonly line: number | null;
  /** `file:line`, or the file alone when the line is unknown. */
  readonly where: string;
  /** The path exactly as written. */
  readonly rawPath: string;
  /**
   * What more is known about why the path points at nothing, such as an extension one
   * keystroke from an image's. Absent when there is nothing more to say.
   */
  readonly note?: string;
}

/**
 * A root-relative broken reference that a `serving-root-unknown` finding replaced, cited
 * with the same fields its `broken` finding would have had.
 */
export type SuppressedBroken = Omit<BrokenFinding, 'kind'>;

/** Which limit an asset exceeded. */
export type OversizeDimension = 'bytes' | 'width' | 'height';

/**
 * An image over the size or dimension limit: its size, its dimensions, and which limit it crosses.
 */
export interface OversizedFinding {
  readonly kind: 'oversized';
  readonly asset: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** Every limit exceeded, sorted. Never empty. */
  readonly exceeded: readonly [OversizeDimension, ...OversizeDimension[]];
}

/** A measured saving, never an estimated one. */
export interface FormatOpportunityFinding {
  readonly kind: 'format-opportunity';
  readonly asset: string;
  /** Source format as the decoder reported it, not as the extension claimed. */
  readonly from: string;
  readonly to: EncodeFormat;
  readonly bytes: number;
  /** What the encode actually produced, in memory. */
  readonly wouldBe: number;
  readonly savedBytes: number;
  /** Whole percent, rounded down. */
  readonly savedPercent: number;
  /**
   * The encode quality this saving was measured at.
   *
   * A saving without it is not a figure: the same image gives 95% at quality 50 and
   * 44% at quality 90, and those describe two different products. Carried from the
   * measurement rather than looked up, so the number and its setting cannot come
   * apart on the way to the report.
   */
  readonly quality: EncodeSetting;
}

/**
 * The engine could not work out where this project serves files from.
 *
 * It replaces the run's root-relative `broken` findings: when almost none of those
 * references resolve, they are one misconfiguration seen many times, not many broken
 * references. Each reference it replaced is listed in `suppressed`, so none is set aside
 * where a reader cannot see it.
 * See "When the serving root cannot be found at all" in ARCHITECTURE.md.
 */
export interface ServingRootUnknownFinding {
  readonly kind: 'serving-root-unknown';
  /** Root-relative references that did resolve. */
  readonly linked: number;
  /** Root-relative references the engine could check: linked plus broken. */
  readonly checkable: number;
  /** How many `broken` findings this replaced: the length of `suppressed`. */
  readonly suppressedBroken: number;
  /** The references behind those findings, in the order the findings would have had. */
  readonly suppressed: readonly SuppressedBroken[];
}

/**
 * Anything the audit found to act on. `kind` tells the kinds apart, and each has its own type.
 */
export type Finding =
  | DeadFinding
  | PossiblyDeadFinding
  | BrokenFinding
  | ServingRootUnknownFinding
  | OversizedFinding
  | FormatOpportunityFinding
  | DuplicateFinding;

/**
 * Two or more assets with byte-identical content.
 *
 * It names the whole set, because no single copy is at fault. It names no copy to keep:
 * one may be a deliberate fallback, or referenced by something the graph cannot see, so
 * Upfly never picks one, and deletes none for being a copy.
 */
export interface DuplicateFinding {
  readonly kind: 'duplicate';
  /** Every asset with these bytes, in path order. At least two. */
  readonly assets: readonly string[];
  /** The size of one copy. */
  readonly bytes: number;
  /** What keeping one copy would recover: `bytes × (copies − 1)`. */
  readonly wastedBytes: number;
}

export interface AuditThresholds {
  /** Bytes above which an asset is oversized. Defaults to 500 000. */
  readonly maxBytes?: number;
  /** Pixels. Defaults to 4 000, beyond any sensible display width. */
  readonly maxWidth?: number;
  /** Pixels. Defaults to 4 000. */
  readonly maxHeight?: number;
  /**
   * Absolute floor: a saving smaller than this is never reported. Defaults to 1 KiB.
   *
   * A 40% saving on a 200-byte icon is 80 bytes. Reporting it is noise that pushes
   * the findings people can act on further down the page.
   */
  readonly minSavingBytes?: number;
  /**
   * Relative arm, in whole percent. Defaults to 10.
   *
   * Catches small files that shrink a lot, where the percentage is the meaningful
   * number and the byte count never will be.
   */
  readonly minSavingPercent?: number;
  /**
   * Absolute arm, in bytes. Defaults to 100 000.
   *
   * Catches big files that shrink a little. Percentage is a bad proxy for value once a
   * file is large: an 8 MB asset that shrinks 9% saves 720 KB and is likely the biggest
   * win in the repository, yet a percentage-only rule hides it. The two arms are an
   * `or` under the floor's `and`, so neither kind of win can be lost.
   */
  readonly largeSavingBytes?: number;
}

export interface AuditOptions {
  readonly graph: Graph;
  /**
   * What the sweep found. Required, because without it every asset with no reference
   * would be reported `dead`, including those named where no adapter could see them.
   * Pass an empty result only when nothing went unread.
   */
  readonly sweep: SweepResult;
  /**
   * Probe results, matched to assets by `relative`.
   *
   * Absent means `--no-probe`: `oversized` and `format-opportunity` are not produced,
   * and the report says so rather than showing zero of each.
   */
  readonly probes?: readonly AssetProbe[];
  /** Used only to turn a broken reference's offset into a line. */
  readonly readFile: ReadFilePort;
  /** Public directories relative to the root, as the resolver was given them. */
  readonly publicDirs?: readonly string[];
  /**
   * Directories whose framework reads certain filenames without being told to.
   *
   * From `detectConventionRoots`, which works from the file list, so this module stays
   * off the disk. Absent means the check does not run.
   */
  readonly conventionRoots?: readonly ConventionRoot[];
  /**
   * Content hashes by POSIX-relative path, for the `duplicate` finding. Absent means the
   * check did not run, which `AuditResult.duplicatesChecked` reports.
   *
   * Only the assets `hashCandidates` selects need be present: an asset whose size no
   * other asset shares cannot be a duplicate, so one missing from this map is one
   * nothing could have matched rather than one that went unchecked.
   */
  readonly contentHashes?: ReadonlyMap<string, string>;
}

export interface AuditResult {
  /** Every finding, ordered for the report. */
  readonly findings: readonly Finding[];
  /**
   * Unreferenced assets a framework reads by filename, and why.
   *
   * They produce no `dead` finding, because they are not dead. They are listed so that
   * the headline's count of unreferenced images does not exceed the findings by an
   * unexplained amount.
   */
  readonly conventionLinked: readonly ConventionLink[];
  /** Source files that could not be re-read to cite a line, sorted. */
  readonly unreadableSources: readonly { readonly relative: string; readonly reason: string }[];
  /** Whether a probe ran at all. `false` means oversized and opportunities are absent. */
  readonly probed: boolean;
  /**
   * Whether duplicates were looked for at all. Separate from the count, because a zero
   * cannot tell "none found" from "nobody looked", and when nobody looked the report
   * prints a caveat rather than an implied zero.
   */
  readonly duplicatesChecked: boolean;
}

/**
 * Product judgement rather than measurements, so they are documented defaults, not
 * settled numbers. The planner reads the saving thresholds too, through `whySavingTooSmall`,
 * so the report and the plan count the same savings.
 */
const DEFAULT_THRESHOLDS = {
  maxBytes: 500_000,
  maxWidth: 4_000,
  maxHeight: 4_000,
  minSavingBytes: 1_024,
  minSavingPercent: 10,
  largeSavingBytes: 100_000,
} as const;

/** Produce every finding the available evidence supports. */
export async function audit(options: AuditOptions): Promise<AuditResult> {
  const thresholds = DEFAULT_THRESHOLDS;
  const publicPrefixes = normalisePublicDirs(options.publicDirs);

  const { findings: broken, rootRelative, unreadableSources } = await brokenFindings(options);
  // One diagnosis instead of N symptoms. See `resolutionHealth`: below the floor the
  // engine has not established where root-relative paths are served from, and a
  // `broken` finding produced in that state is a statement about the serving roots it
  // used rather than about the user's code.
  const health = resolutionHealth(options.graph);
  const reported: (BrokenFinding | ServingRootUnknownFinding)[] = health.servingRootUnknown
    ? diagnoseServingRoot(broken, rootRelative, health)
    : broken;
  const { findings: dead, conventionLinked } = deadFindings(options, publicPrefixes);
  // `AssetProbe` measures pixels and `discover` measured bytes. They are joined here, the
  // one place that holds both, rather than by passing the graph into every size rule.
  const bytesByAsset = new Map(
    options.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]),
  );
  const probeFindings =
    options.probes === undefined ? [] : sizeFindings(options.probes, thresholds, bytesByAsset);

  // Set-scoped, so it joins the list rather than being derived per asset like the others.
  const duplicates: Finding[] =
    options.contentHashes === undefined
      ? []
      : findDuplicates(
          options.graph.assets.map((node) => node.asset),
          options.contentHashes,
        ).map((set) => ({
          kind: 'duplicate' as const,
          assets: set.assets,
          bytes: set.bytes,
          wastedBytes: set.wastedBytes,
        }));

  return {
    findings: [...dead, ...reported, ...probeFindings, ...duplicates].sort(byReportOrder),
    conventionLinked,
    unreadableSources,
    probed: options.probes !== undefined,
    duplicatesChecked: options.contentHashes !== undefined,
  };
}

/**
 * Replace the broken findings this diagnosis explains, and only those: the root-relative
 * ones. A file-relative path that points at nothing is broken whatever the serving root
 * turns out to be, so folding it in would hide a real defect behind an unrelated
 * explanation.
 */
function diagnoseServingRoot(
  broken: readonly BrokenFinding[],
  rootRelative: ReadonlySet<BrokenFinding>,
  health: ResolutionHealth,
): (BrokenFinding | ServingRootUnknownFinding)[] {
  // The same test `withheldReferences` applies, so the sweep treats exactly these
  // references as evidence that the asset they name may be in use.
  const explained = broken.filter((finding) => rootRelative.has(finding));
  const unexplained = broken.filter((finding) => !rootRelative.has(finding));

  return [
    {
      kind: 'serving-root-unknown',
      linked: health.linked,
      checkable: health.checkable,
      suppressedBroken: explained.length,
      suppressed: explained
        .sort(byReportOrder)
        .map(({ file, line, where, rawPath }) => ({ file, line, where, rawPath })),
    },
    ...unexplained,
  ];
}

/**
 * `dead` and `possibly-dead`, decided per asset by what the sweep found rather than by a
 * global flag. A hedge cites where the asset's name was found, so it tells the reader
 * where to look. See "`possibly-dead`, and why "zero references" is usually a lie" in
 * ARCHITECTURE.md.
 */
function deadFindings(
  options: AuditOptions,
  publicPrefixes: readonly string[],
): {
  findings: (DeadFinding | PossiblyDeadFinding)[];
  conventionLinked: ConventionLink[];
} {
  const findings: (DeadFinding | PossiblyDeadFinding)[] = [];
  const conventionLinked: ConventionLink[] = [];
  const roots = options.conventionRoots ?? [];

  for (const node of unreferencedAssets(options.graph)) {
    const asset = node.asset.relative;

    // Before the hedge: an asset a framework reads by filename is alive, and
    // `possibly-dead` would say "we do not know" when we do.
    const convention = conventionLinkFor(asset, roots);
    if (convention !== null) {
      conventionLinked.push(convention);
      continue;
    }

    const inPublicDir = publicPrefixes.some((prefix) => asset.startsWith(prefix));
    const mentions = options.sweep.mentions.get(asset) ?? [];
    const [first, ...rest] = mentions;

    findings.push(
      first === undefined
        ? { kind: 'dead', asset, bytes: node.asset.bytes, inPublicDir }
        : {
            kind: 'possibly-dead',
            asset,
            bytes: node.asset.bytes,
            inPublicDir,
            evidence: [first, ...rest],
          },
    );
  }

  return { findings, conventionLinked };
}

/**
 * Every asserted path pointing at nothing, cited so a reviewer can open it, and those whose
 * proven path is root-relative, which a serving root decides (`dependsOnServingRoot`).
 */
async function brokenFindings(options: AuditOptions): Promise<{
  findings: BrokenFinding[];
  rootRelative: ReadonlySet<BrokenFinding>;
  unreadableSources: AuditResult['unreadableSources'];
}> {
  const references = options.graph.byResolution.broken;
  if (references.length === 0) {
    return { findings: [], rootRelative: new Set(), unreadableSources: [] };
  }

  const { citations, unreadable } = await citeReferences({
    references,
    root: options.graph.root,
    readFile: options.readFile,
  });

  const rootRelative = new Set<BrokenFinding>();
  const findings = references.map((reference): BrokenFinding => {
    const citation = citations.get(reference);
    // Not `reference.note`: an adapter's note says why it read the path as it did, which is
    // no reason for a path to point at nothing.
    const note = likelyTypoOf(reference) ?? inAnotherCase(reference, options.graph.root);
    const finding: BrokenFinding = {
      kind: 'broken',
      file: citation?.file ?? reference.file,
      line: citation?.line ?? null,
      where: citation?.where ?? reference.file,
      rawPath: reference.rawPath,
      ...(note === null ? {} : { note }),
    };
    if (dependsOnServingRoot(provenPath(reference))) rootRelative.add(finding);
    return finding;
  });

  return { findings, rootRelative, unreadableSources: unreadable };
}

/**
 * The note for a broken path that names an image in another letter case, or `null` when it
 * names none: what the resolver found with case ignored.
 */
function inAnotherCase(reference: Reference, root: string): string | null {
  if (reference.resolution !== 'broken' || reference.namesIgnoringCase === undefined) return null;
  const image = relativePath(root, reference.namesIgnoringCase);
  return `names \`${image}\` as \`${reference.rawPath}\`: it loads on Windows and macOS and breaks on a Linux server; fix the letter case`;
}

/** `oversized` and `format-opportunity`, the two that need pixels. */
function sizeFindings(
  probes: readonly AssetProbe[],
  thresholds: Required<AuditThresholds>,
  bytesByAsset: ReadonlyMap<string, number>,
): Finding[] {
  const findings: Finding[] = [];

  for (const probe of probes) {
    const bytes = bytesByAsset.get(probe.relative) ?? 0;
    const oversized = oversizedFinding(probe, thresholds, bytes);
    if (oversized !== null) findings.push(oversized);
    findings.push(...opportunities(probe, thresholds, bytes));
  }

  return findings;
}

function oversizedFinding(
  probe: AssetProbe,
  thresholds: Required<AuditThresholds>,
  // Known even when the header would not decode, so a corrupt 40 MB file is still
  // reported as oversized rather than vanishing from the audit entirely.
  bytes: number,
): OversizedFinding | null {
  const exceeded: OversizeDimension[] = [];

  if (bytes > thresholds.maxBytes) exceeded.push('bytes');
  if ((probe.metadata?.height ?? 0) > thresholds.maxHeight) exceeded.push('height');
  if ((probe.metadata?.width ?? 0) > thresholds.maxWidth) exceeded.push('width');

  const [first, ...rest] = exceeded.sort(compareStrings);
  if (first === undefined) return null;

  return {
    kind: 'oversized',
    asset: probe.relative,
    bytes,
    width: probe.metadata?.width ?? null,
    height: probe.metadata?.height ?? null,
    exceeded: [first, ...rest],
  };
}

function* opportunities(
  probe: AssetProbe,
  thresholds: Required<AuditThresholds>,
  bytes: number,
): Generator<FormatOpportunityFinding> {
  // A zero-byte source has no saving to express as a percentage of.
  if (bytes === 0) return;

  for (const encoded of probe.encoded) {
    const savedBytes = bytes - encoded.bytes;

    if (whySavingTooSmall(bytes, savedBytes, thresholds) !== null) continue;

    yield {
      kind: 'format-opportunity',
      asset: probe.relative,
      from: probe.metadata?.format ?? 'unknown',
      to: encoded.format,
      quality: encoded.quality,
      bytes,
      wouldBe: encoded.bytes,
      savedBytes,
      savedPercent: percentOf(savedBytes, bytes),
    };
  }
}

/**
 * Floored whole percent: a report number, and one that two runs agree on without anyone
 * reasoning about float formatting.
 */
function percentOf(savedBytes: number, bytes: number): number {
  return Math.floor((savedBytes / bytes) * 100);
}

/**
 * Why a measured saving is too small to report or to convert, or null when it counts. A
 * saving counts from `minSavingBytes`, and then when it is `minSavingPercent` of the file
 * or `largeSavingBytes` in all: a small file that shrinks a lot, or a large one that
 * shrinks a little. The audit's findings and the plan's conversions both ask, so the report
 * and the plan count the same savings.
 *
 * @param bytes the file's size now, above zero
 * @param savedBytes how much smaller the converted file would be
 * @returns a sentence for a plan's declined list, or null
 */
export function whySavingTooSmall(
  bytes: number,
  savedBytes: number,
  thresholds: Required<AuditThresholds> = DEFAULT_THRESHOLDS,
): string | null {
  const reach = 'a saving must reach to be reported or converted';
  const saves = `converting it would save ${formatBytes(savedBytes)}`;
  if (savedBytes < thresholds.minSavingBytes) {
    return `${saves}, under the ${formatBytes(thresholds.minSavingBytes)} ${reach}`;
  }
  const percent = percentOf(savedBytes, bytes);
  if (percent < thresholds.minSavingPercent && savedBytes < thresholds.largeSavingBytes) {
    return `${saves}, ${percent}% of the file, under the ${thresholds.minSavingPercent}% of the file or ${formatBytes(thresholds.largeSavingBytes)} ${reach}`;
  }
  return null;
}

/**
 * Public directories as path prefixes with a trailing slash, where `''` stays as the
 * prefix of every path.
 *
 * A project can serve from its own root: a hand-written static site has no `public/`,
 * and every file in the repository is reachable from outside. Filtering `''` out would
 * mark no asset public and drop the caveat that an unreferenced image may be linked from
 * outside the repository.
 */
function normalisePublicDirs(publicDirs: readonly string[] | undefined): readonly string[] {
  return (publicDirs ?? []).map((publicDir) =>
    publicDir === '' || publicDir.endsWith('/') ? publicDir : `${publicDir}/`,
  );
}

/**
 * Report order: by kind, then by the asset or file the finding is about, so every broken
 * reference sits together and every dead asset together rather than interleaved by path.
 */
const KIND_ORDER: Record<Finding['kind'], number> = {
  // Ahead of everything, because when it is present it is the reason the rest of the
  // report looks the way it does.
  'serving-root-unknown': -1,
  broken: 0,
  dead: 1,
  'possibly-dead': 2,
  oversized: 3,
  'format-opportunity': 4,
  // Last: it is the only finding with no single asset at fault, so it reads as a
  // footnote to the list rather than an accusation inside it.
  duplicate: 5,
};

function byReportOrder(a: Finding, b: Finding): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;

  // Duplicates order by bytes worth recovering, largest first, not by path: every other
  // kind is about one asset and a reader scans for a name, but a set is about an amount.
  // `audit` sorts every finding with this function, so without this branch the order
  // `findDuplicates` returns would be lost.
  if (a.kind === 'duplicate' && b.kind === 'duplicate') {
    return b.wastedBytes - a.wastedBytes || compareStrings(subjectOf(a), subjectOf(b));
  }

  return (
    compareStrings(subjectOf(a), subjectOf(b)) ||
    lineOf(a) - lineOf(b) ||
    compareStrings(detailOf(a), detailOf(b))
  );
}

/**
 * Orders references to missing images as a reader meets them: by file, then line, then the
 * path as written. It is the order the audit lists its broken findings in, so a list that
 * merges them with other cited references keeps it by sorting with this.
 *
 * @example [...suppressed, ...broken].sort(byFileAndLine)
 */
export function byFileAndLine(
  a: Pick<BrokenFinding, 'file' | 'line' | 'rawPath'>,
  b: Pick<BrokenFinding, 'file' | 'line' | 'rawPath'>,
): number {
  return (
    compareStrings(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareStrings(a.rawPath, b.rawPath)
  );
}

/** A broken finding's line, so the references in one file read from the top; 0 for the rest. */
function lineOf(finding: Finding): number {
  return finding.kind === 'broken' ? (finding.line ?? 0) : 0;
}

function subjectOf(finding: Finding): string {
  if (finding.kind === 'broken') return finding.file;
  // At most one per run and sorted first, so it needs no subject to be ordered by.
  if (finding.kind === 'serving-root-unknown') return '';
  // A set has no single subject. Its first path is already the alphabetically first of
  // the set, so ordering by it is stable and reads the way a reader would expect.
  if (finding.kind === 'duplicate') return finding.assets[0] ?? '';
  return finding.asset;
}

function detailOf(finding: Finding): string {
  if (finding.kind === 'broken') return finding.rawPath;
  if (finding.kind === 'format-opportunity') return finding.to;
  return '';
}
