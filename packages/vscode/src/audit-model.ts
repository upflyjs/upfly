/**
 * The audit tree's content, built from the result of `upfly audit --json` as plain objects,
 * so what the tree says can be tested without VS Code. `audit-view.ts` turns these into tree
 * items.
 */

import type { AuditResult, Conversion, Finding, Report, UnsafeReference } from './contract.js';
import { formatBytes, plural } from './format.js';

/** A place in the project to open: a file, at a line when one is known. */
export interface Location {
  /** Relative to the workspace folder, with `/`. */
  readonly file: string;
  /** Counted from 1, or null when it is not known. */
  readonly line: number | null;
  /** Text to look for in the file when the line is not known, such as the path as written. */
  readonly search?: string;
}

/** One row of a tree. */
export interface TreeNode {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** A codicon name, such as `warning`. */
  readonly icon?: string;
  /** What choosing the row opens. */
  readonly open?: Location;
  /** An image the row names, relative to the workspace folder, which can be asked about. */
  readonly image?: string;
  readonly children?: readonly TreeNode[];
}

type FindingOf<K extends Finding['kind']> = Extract<Finding, { readonly kind: K }>;

/**
 * The rows for one folder's audit: its images and references, what could be smaller, then
 * each kind of finding, including the kinds with nothing found, since none is an answer too.
 *
 * @param result the audit's result line
 */
export function auditNodes(result: AuditResult): TreeNode[] {
  const { report } = result;
  const of = <K extends Finding['kind']>(kind: K): FindingOf<K>[] =>
    report.findings.filter((finding): finding is FindingOf<K> => finding.kind === kind);
  return [
    ...servingRootNodes(of('serving-root-unknown')),
    imagesNode(report),
    referencesNode(report),
    smallerNode(result, of('format-opportunity')),
    findingNode('Broken references', 'error', of('broken').map(brokenNode), (n) =>
      plural(n, 'reference'),
    ),
    unusedNode(of('dead')),
    findingNode('Possibly unused', 'question', of('possibly-dead').map(possiblyUnusedNode), (n) =>
      plural(n, 'image'),
    ),
    duplicatesNode(of('duplicate')),
    findingNode('Oversized', 'arrow-both', of('oversized').map(oversizedNode), (n) =>
      plural(n, 'image'),
    ),
    ...notesNodes(report),
  ];
}

/**
 * A `where` from the report, `file:line` or a file alone, as a location.
 *
 * @param where the text, such as `src/a.css:12`
 */
export function parseWhere(where: string): Location {
  const match = /^(.*):(\d+)$/.exec(where);
  return match === null
    ? { file: where, line: null }
    : { file: match[1] as string, line: Number(match[2]) };
}

function imagesNode(report: Report): TreeNode {
  const { assets, assetBytes, referencedAssets } = report.summary;
  return {
    label: plural(assets, 'image'),
    description: `${formatBytes(assetBytes)}, ${referencedAssets} in use`,
    tooltip: `Upfly found ${plural(assets, 'image')} in this folder, ${formatBytes(assetBytes)} together; ${referencedAssets} of them ${referencedAssets === 1 ? 'is' : 'are'} used by at least one reference. Right-click an image in the Explorer to see where it is used.`,
    icon: 'file-media',
  };
}

function referencesNode(report: Report): TreeNode {
  const { references, sourceFiles, linkedReferences } = report.summary;
  const unsafe = report.references.unsafe;
  return {
    label: plural(references, 'reference'),
    description: `in ${plural(sourceFiles, 'file')}, ${linkedReferences} lead to an image`,
    tooltip: 'Every place a file Upfly reads names an image path.',
    icon: 'references',
    ...(unsafe.length === 0
      ? {}
      : {
          children: [
            {
              label: 'Never rewritten',
              description: plural(unsafe.length, 'reference'),
              tooltip:
                'References Upfly reads but never changes, such as a path built at runtime. Each one stays as written in every run.',
              icon: 'lock',
              children: unsafe.map(unsafeNode),
            },
          ],
        }),
  };
}

function unsafeNode(reference: UnsafeReference): TreeNode {
  return {
    label: reference.rawPath,
    description: reference.file,
    tooltip: reference.reason,
    open: { file: reference.file, line: null, search: reference.rawPath },
  };
}

function smallerNode(result: AuditResult, measured: FindingOf<'format-opportunity'>[]): TreeNode {
  const byAsset = new Map(measured.map((finding) => [finding.asset, finding]));
  const savings = result.savings;
  if (savings === null) {
    const saved = measured.reduce((sum, finding) => sum + finding.savedBytes, 0);
    return {
      label: 'Could be smaller',
      description:
        measured.length === 0
          ? 'none'
          : `${plural(measured.length, 'image')}, ${formatBytes(saved)} less`,
      tooltip:
        'Images measured smaller in another format. What optimize would convert was not worked out for this run.',
      icon: 'arrow-down',
      ...(measured.length === 0
        ? {}
        : { children: measured.map((finding) => measuredNode(finding)) }),
    };
  }
  const children = savings.conversions.map((conversion) =>
    conversionNode(conversion, byAsset.get(conversion.asset)),
  );
  if (savings.unmeasured > 0) {
    children.push({
      label: `${plural(savings.unmeasured, 'more image')} not measured`,
      tooltip:
        'The audit measured only the largest images optimize could convert, so optimize converts and saves at least this much.',
      icon: 'info',
    });
  }
  return {
    label: 'Could be smaller',
    description:
      savings.images === 0
        ? 'none'
        : `${plural(savings.images, 'image')}, ${formatBytes(savings.savedBytes)} less`,
    tooltip:
      'What upfly optimize would convert and save in this folder, measured by encoding each image.',
    icon: 'arrow-down',
    ...(children.length === 0 ? {} : { children }),
  };
}

function conversionNode(
  conversion: Conversion,
  measured: FindingOf<'format-opportunity'> | undefined,
): TreeNode {
  const format = conversion.format === 'webp' ? 'WebP' : 'AVIF';
  const original = conversion.replacesOriginal
    ? 'and removes the original once no file names it'
    : 'and keeps the original beside it';
  return {
    label: conversion.asset,
    description:
      measured === undefined
        ? `${formatBytes(conversion.savedBytes)} less as ${format}`
        : `${formatBytes(measured.bytes)} to ${formatBytes(measured.wouldBe)} as ${format}, ${measured.savedPercent}% smaller`,
    tooltip: `optimize converts it to ${conversion.target} ${original}.`,
    open: { file: conversion.asset, line: null },
    image: conversion.asset,
  };
}

function measuredNode(finding: FindingOf<'format-opportunity'>): TreeNode {
  const format = finding.to === 'webp' ? 'WebP' : 'AVIF';
  return {
    label: finding.asset,
    description: `${formatBytes(finding.bytes)} to ${formatBytes(finding.wouldBe)} as ${format}, ${finding.savedPercent}% smaller`,
    open: { file: finding.asset, line: null },
    image: finding.asset,
  };
}

function findingNode(
  label: string,
  icon: string,
  children: TreeNode[],
  counted: (count: number) => string,
): TreeNode {
  return children.length === 0
    ? { label, description: 'none', icon }
    : { label, description: counted(children.length), icon, children };
}

function brokenNode(finding: FindingOf<'broken'>): TreeNode {
  return {
    label: finding.rawPath,
    description: finding.where,
    tooltip:
      finding.note === undefined
        ? 'This path is written as an image path, and no file is there.'
        : `This path is written as an image path, and no file is there. ${finding.note}`,
    open: { file: finding.file, line: finding.line, search: finding.rawPath },
  };
}

function unusedNode(dead: FindingOf<'dead'>[]): TreeNode {
  const bytes = dead.reduce((sum, finding) => sum + finding.bytes, 0);
  if (dead.length === 0) return { label: 'Unused', description: 'none', icon: 'circle-slash' };
  return {
    label: 'Unused',
    description: `${plural(dead.length, 'image')}, ${formatBytes(bytes)}`,
    tooltip:
      'Nothing references these images, and their names appear nowhere Upfly looked. Upfly never deletes them: the decision is yours.',
    icon: 'circle-slash',
    children: dead.map((finding) => ({
      label: finding.asset,
      description: finding.inPublicDir
        ? `${formatBytes(finding.bytes)}, in a folder the site serves`
        : formatBytes(finding.bytes),
      ...(finding.inPublicDir
        ? {
            tooltip:
              'It sits in a folder the site is served from, so an email, another site or a CMS may link to it from outside the project.',
          }
        : {}),
      open: { file: finding.asset, line: null },
      image: finding.asset,
    })),
  };
}

function possiblyUnusedNode(finding: FindingOf<'possibly-dead'>): TreeNode {
  return {
    label: finding.asset,
    description: formatBytes(finding.bytes),
    tooltip:
      'Nothing Upfly can follow references it, but its name appears in the places below. Treat it as used until you have looked.',
    open: { file: finding.asset, line: null },
    image: finding.asset,
    children: finding.evidence.map((mention) => ({
      label: mention.quote,
      description: mention.where,
      open: { ...parseWhere(mention.where), search: mention.quote },
    })),
  };
}

function duplicatesNode(duplicates: FindingOf<'duplicate'>[]): TreeNode {
  if (duplicates.length === 0)
    return { label: 'Identical copies', description: 'none', icon: 'copy' };
  const wasted = duplicates.reduce((sum, finding) => sum + finding.wastedBytes, 0);
  return {
    label: 'Identical copies',
    description: `${plural(duplicates.length, 'set')}, ${formatBytes(wasted)} could go`,
    tooltip:
      'Images with exactly the same bytes. upfly dedupe points their references at one copy.',
    icon: 'copy',
    children: duplicates.map((finding) => ({
      label: `${plural(finding.assets.length, 'copy', 'copies')}, ${formatBytes(finding.bytes)} each`,
      children: finding.assets.map((asset) => ({
        label: asset,
        open: { file: asset, line: null },
        image: asset,
      })),
    })),
  };
}

const LIMIT_WORDS: Record<'bytes' | 'width' | 'height', string> = {
  bytes: 'the size',
  width: 'the width',
  height: 'the height',
};

/**
 * The limits an oversized image is over, in words: `the size and the width limits`.
 *
 * @param exceeded the limits, as the report lists them
 */
export function limitsText(exceeded: readonly ('bytes' | 'width' | 'height')[]): string {
  const limits = exceeded.map((limit) => LIMIT_WORDS[limit]);
  return limits.length === 1
    ? `${limits[0]} limit`
    : `${limits.slice(0, -1).join(', ')} and ${limits.at(-1)} limits`;
}

function oversizedNode(finding: FindingOf<'oversized'>): TreeNode {
  const pixels =
    finding.width === null || finding.height === null
      ? ''
      : `, ${finding.width} x ${finding.height} pixels`;
  return {
    label: finding.asset,
    description: `${formatBytes(finding.bytes)}${pixels}: over ${limitsText(finding.exceeded)}`,
    tooltip: 'The limits are 500 KB, and 4,000 pixels wide or high.',
    open: { file: finding.asset, line: null },
    image: finding.asset,
  };
}

function servingRootNodes(unknown: FindingOf<'serving-root-unknown'>[]): TreeNode[] {
  return unknown.map((finding) => ({
    label: 'Which folder the site is served from is not known',
    description: `${plural(finding.suppressedBroken, 'path')} not checked`,
    tooltip:
      'Upfly could not work out which folder the site is served from, so it cannot tell whether a path such as /hero.png is broken. Name the folder in upfly.config.json as publicDirs, or with npx upfly init.',
    icon: 'warning',
  }));
}

function notesNodes(report: Report): TreeNode[] {
  if (report.caveats.length === 0) return [];
  return [
    {
      label: 'Notes',
      description: plural(report.caveats.length, 'note'),
      tooltip: 'Limits that apply to the audit as a whole.',
      icon: 'info',
      children: report.caveats.map((caveat) => ({
        label: caveat.message,
        tooltip: caveat.message,
      })),
    },
  ];
}
