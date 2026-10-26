/**
 * Removing an original kept beside its converted file, once nothing needs it: the rules, as
 * `plan.ts` holds the conversion's. Pure, like it: nothing here reads a file.
 *
 * Nothing converts and no line is rewritten. An original goes only when its converted file
 * stands beside it as the same picture, the audit found nothing that names it, and the search
 * before a delete finds no line naming it. See "Removing an original kept beside its converted
 * file" in ARCHITECTURE.md.
 */

import type { AuditResult } from '../audit/audit.js';
import type { AssetNode, Graph } from '../graph/graph.js';
import { compareStrings, extensionOf, isVectorExtension, relativePath } from '../paths.js';
import type { AssetProbe, EncodeFormat, ImageMetadata } from '../probe/probe.js';
import type { Declined } from '../write/manifest.js';
import {
  type HedgedMention,
  MENTION_SURVIVES,
  type OptimizationPlan,
  type SurvivingMention,
} from './plan.js';

/** An original a run removes, and the converted file beside it that takes its place. */
export interface PlannedRemoval {
  /** POSIX-relative path of the original. */
  readonly asset: string;
  /** POSIX-relative path of its converted file: the same path in the run's format. */
  readonly converted: string;
}

/** What `planRemovals` reads: the project as the audit saw it, and the originals named. */
export interface RemovalInput {
  readonly graph: Graph;
  /** The audit of that graph, for what it found nothing names and what a framework reads. */
  readonly audit: Pick<AuditResult, 'findings' | 'conventionLinked'>;
  /** The header of each original and of each converted file beside one. */
  readonly probes: readonly AssetProbe[];
  /** The format the converted files are in. */
  readonly format: EncodeFormat;
  /**
   * The originals to remove, by exact POSIX path relative to the project. A path that is not
   * an image in the graph gets no entry: the caller says it named nothing.
   */
  readonly originals: ReadonlySet<string>;
  /** Where something names each image nothing links to, as `PlanInput.hedged`. */
  readonly hedged: ReadonlyMap<string, HedgedMention>;
  /** As `PlanInput.blockedByMention`: a line the search found naming an original. */
  readonly blockedByMention?: ReadonlyMap<string, SurvivingMention>;
  /** As `PlanInput.blockedByExclusion`. */
  readonly blockedByExclusion?: ReadonlyMap<string, string>;
  /** As `PlanInput.blockedByUnread`. */
  readonly blockedByUnread?: ReadonlyMap<string, string>;
}

/**
 * The plan for a run that removes originals kept beside their converted files: each original
 * named that may go, and for each one that stays, why. It converts nothing and rewrites
 * nothing.
 *
 * @param input the graph, the audit, the headers and the originals named
 * @returns a plan whose only changes are `removals`
 */
export function planRemovals(input: RemovalInput): OptimizationPlan {
  const nodes = new Map(input.graph.assets.map((node) => [node.asset.relative, node]));
  const unnamed = new Set(
    input.audit.findings.flatMap((finding) => (finding.kind === 'dead' ? [finding.asset] : [])),
  );
  const removals: PlannedRemoval[] = [];
  const declined: Declined[] = [];
  for (const original of [...input.originals].sort(compareStrings)) {
    const node = nodes.get(original);
    if (node === undefined) continue;
    const reason = whyOriginalStays(node, input, nodes, unnamed);
    if (reason === null) {
      removals.push({ asset: original, converted: convertedPath(original, input.format) });
    } else {
      declined.push({ path: original, line: null, reason });
    }
  }
  return { conversions: [], rewrites: [], declined, keptOriginals: [], removals, refusal: null };
}

/**
 * The path of an original's converted file: the same path with the format's extension, as a
 * conversion names the file it writes.
 *
 * @param original the original's POSIX path, relative to the project
 * @param format the format of the converted file
 */
export function convertedPath(original: string, format: EncodeFormat): string {
  const extension = extensionOf(original);
  if (extension === '') return original;
  return `${original.slice(0, original.length - extension.length)}.${format}`;
}

const FORMAT_NAMES: Readonly<Record<EncodeFormat, string>> = { webp: 'WebP', avif: 'AVIF' };

/**
 * Why this original stays, or null when it may go. What its converted file is comes first,
 * since without one there is nothing to remove it for; then what still names it, which is
 * what a person would have to change.
 */
function whyOriginalStays(
  node: AssetNode,
  input: RemovalInput,
  nodes: ReadonlyMap<string, AssetNode>,
  unnamed: ReadonlySet<string>,
): string | null {
  const original = node.asset.relative;
  const converted = convertedPath(original, input.format);
  if (converted === original) {
    return `its name already ends in .${input.format}, so it is a converted file rather than an original beside one`;
  }
  if (isVectorExtension(extensionOf(original))) {
    return `it is a vector, which Upfly never converts, so ${converted} is not a converted copy of it`;
  }
  if (!nodes.has(converted)) {
    return `no ${converted} stands beside it, so nothing has replaced it`;
  }
  const different = notTheSamePicture(original, converted, input);
  if (different !== null) return different;

  const named = whatNamesIt(node, input, unnamed);
  if (named !== null) return named;

  const surviving = input.blockedByMention?.get(original);
  if (surviving !== undefined) return `${surviving.where} ${MENTION_SURVIVES}: ${surviving.kind}`;
  const excluded = input.blockedByExclusion?.get(original);
  if (excluded !== undefined) return `${excluded} ${MENTION_SURVIVES}, in a file this run excluded`;
  const unread = input.blockedByUnread?.get(original);
  if (unread !== undefined) return `${unread} could not be read to rule out a mention of it`;
  return null;
}

/**
 * Why the converted file is not this image converted, or null when it can be: both headers
 * read, the converted file in the format its name says, at the original's size as a viewer
 * shows it and with as many frames. A conversion writes exactly that, so a file that differs
 * is another picture under the same name, which a person made.
 */
function notTheSamePicture(
  original: string,
  converted: string,
  input: RemovalInput,
): string | null {
  const name = FORMAT_NAMES[input.format];
  const before = headerOf(original, input.probes);
  if (before === null) {
    return `it could not be read as an image, so Upfly cannot check that ${converted} shows the same picture`;
  }
  const after = headerOf(converted, input.probes);
  if (after === null || !holdsFormat(after, input.format)) {
    return `${converted} could not be read as a ${name} image, so it cannot stand in for this one`;
  }
  if (after.width !== before.width || after.height !== before.height) {
    return `${converted} is ${after.width}×${after.height} where this image is ${before.width}×${before.height}, so it is not this image converted`;
  }
  if (after.pages !== before.pages) {
    return `${converted} holds ${frames(after.pages)} where this image holds ${frames(before.pages)}, so it is not this image converted`;
  }
  return null;
}

/** The header read for an image, or null when it was not read or could not be. */
function headerOf(relative: string, probes: readonly AssetProbe[]): ImageMetadata | null {
  return probes.find((probe) => probe.relative === relative)?.metadata ?? null;
}

/** Whether a header is the format's: libvips names an AVIF file's container `heif`. */
function holdsFormat(header: ImageMetadata, format: EncodeFormat): boolean {
  return format === 'avif'
    ? header.format === 'avif' || header.format === 'heif'
    : header.format === format;
}

function frames(count: number): string {
  return count === 1 ? '1 frame' : `${count} frames`;
}

/**
 * What still names the original, in the words of the reasons a conversion gives, or null when
 * the audit found nothing: a reference, a framework that reads it by its file name, or its
 * name somewhere a page may load it through.
 */
function whatNamesIt(
  node: AssetNode,
  input: RemovalInput,
  unnamed: ReadonlySet<string>,
): string | null {
  const original = node.asset.relative;
  const [first] = node.references;
  if (first !== undefined) {
    const where = `\`${relativePath(input.graph.root, first.file)}\``;
    const more = node.references.length === 1 ? '' : ` (and ${node.references.length - 1} more)`;
    const how =
      first.resolution === 'resolved-pattern'
        ? `reaches it through \`${first.rawPath}\``
        : `names it as \`${first.rawPath}\``;
    return `${where} ${how}${more}, so a page still uses it`;
  }
  const convention = input.audit.conventionLinked.find((link) => link.asset === original);
  if (convention !== undefined) return convention.reason;
  const hedge = input.hedged.get(original);
  if (hedge !== undefined) return `${hedge.where} ${hedge.says}`;
  // Every image nothing links to is one of the three; this keeps the rule from depending on it.
  if (!unnamed.has(original)) return 'Upfly could not rule out that something names it';
  return null;
}
