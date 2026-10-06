/**
 * The short summaries `audit`, `optimize` and `dedupe` print by default: what will happen or
 * happened, the totals, what is left alone grouped by reason, and what to run next. Each row
 * that counts something carries its complete list, which the report file prints under it and
 * `--show` prints alone.
 */

import type {
  BrokenFinding,
  DedupePlan,
  DedupeSet,
  EncodeFormat,
  KeptBecause,
  Manifest,
  OptimizationPlan,
  PublicPolicy,
  Report,
  ServingRootUnknownFinding,
  ServingRoots,
} from 'upfly-core';
import {
  type AssetProbe,
  type Graph,
  compareStrings,
  fewResolvedIn,
  formatBytes,
  servingRootOf,
} from 'upfly-core/internal';
import type { Savings } from './audit.js';
import { type GitState, insideRepository } from './git.js';
import type { UpflyCommand } from './invocation.js';
import {
  type Row,
  type RowList,
  type Summary,
  VALUE_WIDTH,
  columns,
  commandLine,
} from './layout.js';
import { count, movingText, writtenByKind } from './plan-text.js';
import {
  OTHER,
  countGroups,
  declineGroup,
  formatName,
  stayGroup,
  unmeasuredGroup,
} from './reasons.js';
import type { ReportFile } from './report-file.js';

/** What to do next: a command to copy, or words when no single command will do. */
export interface NextStep {
  /** The command, word by word, or null when the step is not one command. */
  readonly words: readonly string[] | null;
  /** What is printed when there is no command, or when it is too long to print whole. */
  readonly text: string;
  readonly details?: readonly string[];
}

/** The summary of an audit. */
export function auditSummary(
  report: Report,
  savings: Savings | null,
  file: ReportFile,
  next: NextStep | null,
  upfly: UpflyCommand,
): Summary {
  const { summary } = report;
  const references =
    summary.references === 0
      ? [`none, in ${count(summary.sourceFiles, 'source file')}`]
      : [
          `${summary.linkedReferences} of ${summary.references}`,
          ` resolved, from ${count(summary.sourceFiles, 'source file')}`,
        ];
  return {
    command: 'audit',
    sections: [
      [
        {
          label: 'Images',
          value: [count(summary.assets, 'image'), `, ${formatBytes(summary.assetBytes)}`],
        },
        { label: 'References', value: references, key: 'references', ...unfollowed(report) },
        savingsRow(report, savings, upfly),
        brokenRow(report, upfly),
        unusedRow(report, file),
        ...oversizedRows(report),
        copiesRow(report, upfly),
        skippedRow(report),
      ],
      [reportRow('Full report', file), ...nextRows(next)],
    ],
    closing: auditClosing(report, savings, upfly),
    caveats: engineCaveats(report),
  };
}

/** The references no run rewrites because Upfly could not follow them to a file. */
function unfollowed(report: Report): { list?: RowList } {
  const entries = [...report.references.unsafe, ...report.references.leftOut];
  if (entries.length === 0) return {};
  const broken = brokenListed(report);
  return {
    list: {
      intro: `Upfly could not follow these references to a file, so no run rewrites them; each says why.${broken === 0 ? '' : ` The ${count(broken, 'reference')} naming an image that does not exist ${broken === 1 ? 'is' : 'are'} under Broken.`}`,
      items: entries.map((entry) => `${entry.file}  ${entry.rawPath}  ${entry.reason}`),
    },
  };
}

/** The sentence that ends an audit: what `optimize` would do, with the savings figure. */
function auditClosing(report: Report, savings: Savings | null, upfly: UpflyCommand): string {
  if (!report.summary.probed) return 'No image was measured, so this run states no savings.';
  if (savings === null) {
    return report.coverage.servingRoots.declared
      ? `${upfly} optimize plans nothing while so few references resolve where the site is served from; Broken lists the rest.`
      : `${upfly} optimize plans nothing until it knows the folder the site is served from.`;
  }
  const n = savings.conversions.length;
  if (n === 0) return `${upfly} optimize would convert no image.`;
  const least = savings.unmeasured === 0 ? '' : 'at least ';
  return `${upfly} optimize would convert ${least}${count(n, 'image')} and save ${least}${formatBytes(savings.savedBytes)}.`;
}

/**
 * The engine's caveats, last in a report file: how far its counts can be off, the strings that
 * only looked like paths, the values it does not read as paths, and what it could not read.
 */
export function engineCaveats(report: Report): RowList[] {
  const { references } = report;
  const lists: RowList[] = [];
  if (references.classificationBounds.length > 0) {
    lists.push({
      intro:
        'How far the counts of references can be off: these reasons for not following a reference are known to cover some that a closer reading would follow.',
      items: references.classificationBounds.map(
        (entry) =>
          `${entry.count} counted as "${entry.reason}": ${entry.bound} Measured ${entry.measuredAgainst}`,
      ),
    });
  }
  if (references.discardedCount > 0) {
    lists.push({
      intro: `${count(references.discardedCount, 'string')} looked like image paths and named no file, most often in lockfiles, translations or data. One may still be a path Upfly should read: --include-discarded lists them here.`,
      items: (references.discarded ?? []).map((entry) => `${entry.file}  ${entry.rawPath}`),
    });
  }
  const declined = references.declinedValues;
  if (declined.count > 0) {
    lists.push({
      intro: `${count(declined.count, 'value')} with an image extension sat where Upfly reads no file path, such as a component's own prop. If one is an image path, Upfly does not see that image as used there; --include-discarded lists each.`,
      items: [
        ...declined.byReason.map((entry) => `${entry.count}  ${entry.reason}`),
        ...(declined.values ?? []).map((value) => `${value.file}  ${value.rawPath}`),
      ],
    });
  }
  for (const caveat of report.caveats) lists.push({ intro: caveat.message, items: caveat.detail });
  if (report.diagnosticsFile !== null) {
    lists.push({
      intro: `What the imaging and parsing libraries said, in their own words, is in ${report.diagnosticsFile}.`,
      items: [],
    });
  }
  return lists;
}

/**
 * What `optimize` would convert and save with the same options: the plan's own figure, so
 * an image it would not convert is never counted. Past the cap it is a part of the plan,
 * marked "at least", with the number of images left unmeasured.
 */
function savingsRow(report: Report, savings: Savings | null, upfly: UpflyCommand): Row {
  const { summary } = report;
  const label = 'Savings';
  if (!summary.probed) return { label, value: ['not measured, as --no-probe asked'] };
  if (savings === null) {
    return {
      label,
      value: [
        report.coverage.servingRoots.declared
          ? 'not planned: too few references resolve where the site is served from'
          : 'not planned: where the site is served from is unknown',
      ],
    };
  }
  const { conversions, unmeasured } = savings;
  const details = [
    ...(unmeasured === 0
      ? []
      : [
          `${count(unmeasured, 'more image')} optimize may convert ${unmeasured === 1 ? 'was' : 'were'} not measured; --probe-all measures them`,
        ]),
    ...(summary.unmeasuredAssets === 0
      ? []
      : [`${count(summary.unmeasuredAssets, 'image')} could not be measured`]),
  ];
  if (conversions.length === 0) {
    return {
      label,
      value: [unmeasured === 0 ? 'none: optimize would convert no image' : 'none found so far'],
      details,
    };
  }
  const [first] = conversions;
  const quality = qualityPhrase([...new Set(conversions.map((conversion) => conversion.quality))]);
  return {
    label,
    value: [
      `${unmeasured === 0 ? '' : 'at least '}${formatBytes(savings.savedBytes)}`,
      ` as ${formatName(first?.format ?? 'webp')}${quality === '' ? '' : ` ${quality}`}, across ${count(conversions.length, 'image')}`,
    ],
    details,
    key: 'savings',
    list: {
      intro: `${upfly} optimize would convert each of these images and move every reference it can rewrite to the new file.${unmeasured === 0 ? '' : ` ${count(unmeasured, 'more image')} it may convert ${unmeasured === 1 ? 'was' : 'were'} not measured; --probe-all measures them.`}`,
      items: conversions.map((conversion) => conversionLine(conversion, savings.sizes)),
    },
  };
}

/** One conversion: where it goes, and its size before and after. */
function conversionLine(
  conversion: OptimizationPlan['conversions'][number],
  sizes: ReadonlyMap<string, number>,
): string {
  const size = sizes.get(conversion.asset) ?? 0;
  return `${conversion.asset} → ${conversion.target}  ${formatBytes(size)} → ${formatBytes(size - conversion.savedBytes)}`;
}

/** The settings a saving was measured at: `at quality 80`, `lossless`, or both. */
function qualityPhrase(settings: readonly (number | 'lossless')[]): string {
  const numbers = settings
    .filter((setting): setting is number => setting !== 'lossless')
    .sort((a, b) => a - b);
  const quality = numbers.length === 0 ? '' : `at quality ${numbers.join(' or ')}`;
  if (!settings.includes('lossless')) return quality;
  return quality === '' ? 'lossless' : `${quality}, or lossless`;
}

function brokenRow(report: Report, upfly: UpflyCommand): Row {
  const label = 'Broken';
  const unknown = report.findings.find((finding) => finding.kind === 'serving-root-unknown');
  if (unknown?.kind === 'serving-root-unknown' && report.coverage.servingRoots.declared) {
    return namedFolderBrokenRow(report, unknown, upfly);
  }
  if (unknown?.kind === 'serving-root-unknown') {
    return {
      label,
      value: ['not judged: where the site is served from is unknown'],
      details: ['name the folder with --public <dir>; the full report says more'],
      key: 'broken',
      list: {
        intro: `Only ${unknown.linked} of ${unknown.checkable} root-relative references resolved, so Upfly could not tell where the site is served from and judged none of these. Name the folder with --public <dir>, and run again.`,
        items: unknown.suppressed.flatMap(brokenItem),
      },
    };
  }
  const broken = report.summary.findings.broken;
  if (broken === 0) return { label, value: ['none'], key: 'broken' };
  return {
    label,
    value: [
      count(broken, 'reference'),
      ` ${broken === 1 ? 'names' : 'name'} an image that does not exist`,
    ],
    details: [`${upfly} check lists each with its file and line`],
    key: 'broken',
    list: {
      intro: `Each of these names an image that does not exist, at the file and line given: fix the path, or put the image back. ${upfly} check fails while any is left.`,
      items: report.findings.flatMap((finding) =>
        finding.kind === 'broken' ? brokenItem(finding) : [],
      ),
    },
  };
}

/**
 * The broken row of a run told where the site is served from, when too few references
 * resolved there: the folder is not asked for again, and each reference that did not resolve
 * is listed as naming no file there, beside any other broken one.
 */
function namedFolderBrokenRow(
  report: Report,
  unknown: ServingRootUnknownFinding,
  upfly: UpflyCommand,
): Row {
  const said = fewResolvedIn(unknown, report.coverage.servingRoots.dirs);
  const entries = [
    ...unknown.suppressed,
    ...report.findings.filter((finding): finding is BrokenFinding => finding.kind === 'broken'),
  ].sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.rawPath, b.rawPath));
  const one = entries.length === 1;
  return {
    label: 'Broken',
    value: [
      count(entries.length, 'reference'),
      ` ${one ? 'names' : 'name'} an image that does not exist`,
    ],
    details: [said, `${upfly} check lists each with its file and line`],
    key: 'broken',
    list: {
      intro: `${said.charAt(0).toUpperCase()}${said.slice(1)}. Each of these names an image that does not exist, at the file and line given: fix the path, or put the image back. ${upfly} check fails while any is left.`,
      items: entries.flatMap(brokenItem),
    },
  };
}

/**
 * How many references the Broken row lists as naming an image that does not exist: with the
 * folder named, those that did not resolve there too.
 */
function brokenListed(report: Report): number {
  const unknown = report.findings.find((finding) => finding.kind === 'serving-root-unknown');
  const named =
    unknown?.kind === 'serving-root-unknown' && report.coverage.servingRoots.declared
      ? unknown.suppressedBroken
      : 0;
  return report.summary.findings.broken + named;
}

/** A broken reference where it is written, and its note under it. */
function brokenItem(entry: {
  readonly where: string;
  readonly rawPath: string;
  readonly note?: string;
}): string[] {
  return [
    `${entry.where}  ${entry.rawPath}`,
    ...(entry.note === undefined ? [] : [`  ${entry.note}`]),
  ];
}

function unusedRow(report: Report, file: ReportFile): Row {
  const dead = report.findings.filter((finding) => finding.kind === 'dead');
  const bytes = dead.reduce((sum, finding) => sum + finding.bytes, 0);
  const possibly = report.findings.filter((finding) => finding.kind === 'possibly-dead');
  const vectors = report.unusedVectors;
  const kept = report.keptOriginals;
  const listed = dead.length + possibly.length + kept.count + (vectors.assets?.length ?? 0) > 0;
  return {
    label: 'Unused',
    value: dead.length === 0 ? ['none'] : [count(dead.length, 'image'), `, ${formatBytes(bytes)}`],
    details: [
      ...(possibly.length === 0
        ? []
        : [
            `${possibly.length} possibly unused: ${possibly.length === 1 ? 'its name appears' : 'their names appear'} in the project`,
          ]),
      ...(vectors.count === 0
        ? []
        : [`and ${count(vectors.count, 'unreferenced SVG')}, counted, not listed`]),
      ...(kept.count === 0
        ? []
        : [
            kept.count === 1
              ? '1 original kept beside its converted file is not counted'
              : `${kept.count} originals kept beside converted files are not counted`,
          ]),
      ...(listed ? [`${listedIn(file)} lists them; Upfly never deletes one`] : []),
    ],
    key: 'unused',
    ...(listed
      ? {
          list: {
            intro: `Nothing Upfly can see uses these images, and Upfly never deletes an image that nothing uses: delete one yourself once you are sure nothing outside the project, such as an email or another site, links to it.${possibly.length === 0 ? '' : ' A possibly unused image has its name somewhere in the project, shown under it; look there first.'}`,
            items: [
              ...dead.map((finding) => `${finding.asset}  ${formatBytes(finding.bytes)}`),
              ...possibly.flatMap((finding) =>
                finding.kind === 'possibly-dead'
                  ? [
                      `${finding.asset}  ${formatBytes(finding.bytes)}  possibly unused`,
                      ...finding.evidence.map(
                        (mention) => `  named in ${mention.where}: ${mention.quote}`,
                      ),
                    ]
                  : [],
              ),
              ...(vectors.assets ?? []).map(
                (vector) => `${vector.asset}  ${formatBytes(vector.bytes)}  an unreferenced SVG`,
              ),
              ...kept.assets.map(
                (original) =>
                  `${original.asset}  ${formatBytes(original.bytes)}  an original kept beside ${original.convertedTo}, not counted`,
              ),
            ],
          },
        }
      : {}),
  };
}

/** Where the report file is, or where it would have been. */
function listedIn(file: ReportFile): string {
  return 'written' in file ? file.written : '--show unused';
}

function oversizedRows(report: Report): Row[] {
  const oversized = report.summary.findings.oversized;
  if (oversized === 0) return [];
  return [
    {
      label: 'Oversized',
      value: [count(oversized, 'image'), ' over the limits'],
      key: 'oversized',
      list: {
        intro:
          'Each of these images is larger than a size or dimension limit: resize it, or check that the page shows it this large.',
        items: report.findings.flatMap((finding) =>
          finding.kind === 'oversized'
            ? [
                `${finding.asset}  ${formatBytes(finding.bytes)}${finding.width === null || finding.height === null ? '' : `, ${finding.width}×${finding.height}`}  over the ${finding.exceeded.join(' and ')} limit`,
              ]
            : [],
        ),
      },
    },
  ];
}

function copiesRow(report: Report, upfly: UpflyCommand): Row {
  const sets = report.findings.filter((finding) => finding.kind === 'duplicate');
  if (sets.length === 0) return { label: 'Copies', value: ['none'], key: 'copies' };
  const wasted = sets.reduce((sum, finding) => sum + finding.wastedBytes, 0);
  return {
    label: 'Copies',
    value: [count(sets.length, 'set'), ` of identical images, ${formatBytes(wasted)} recoverable`],
    details: [`${upfly} dedupe points each set's references at one copy`],
    key: 'copies',
    list: {
      intro: `The files in each set hold the same bytes. ${upfly} dedupe keeps one copy of each set and points the references to the others at it; it deletes nothing.`,
      items: sets.flatMap((finding) => [
        `${formatBytes(finding.bytes)} each, ${formatBytes(finding.wastedBytes)} recoverable by keeping one:`,
        ...finding.assets.map((asset) => `  ${asset}`),
      ]),
    },
  };
}

/** What each stage's skipped entries are, after their count. */
const SKIPPED: Readonly<Record<string, readonly [string, string]>> = {
  discovery: ['file', 'could not be read'],
  scan: ['file', 'could not be parsed'],
  sweep: ['file', 'too large to search for image names'],
  citation: ['file', 'could not be read again for a line number'],
  aliases: ['config', 'had path aliases Upfly could not read'],
};

function skippedRow(report: Report): Row {
  // The measurements past the encode cap are in the savings row, so the image count here is
  // the one the report keeps for failed measurements.
  const groups = new Map<string, number>();
  for (const item of report.skipped) {
    if (item.stage === 'measurement') continue;
    groups.set(item.stage, (groups.get(item.stage) ?? 0) + 1);
  }
  const counts = [...groups].map(([stage, n]) => {
    const [noun, what] = SKIPPED[stage] ?? ['item', 'skipped'];
    return { count: n, text: `${n === 1 ? noun : `${noun}s`} ${what}` };
  });
  const unmeasured = report.summary.unmeasuredAssets;
  if (unmeasured > 0) {
    counts.push({
      count: unmeasured,
      text: `${unmeasured === 1 ? 'image' : 'images'} could not be measured`,
    });
  }
  if (counts.length === 0) return { label: 'Skipped', value: ['nothing'], key: 'skipped' };
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  return {
    label: 'Skipped',
    value: [String(total), ', each with its reason in the full report'],
    counts,
    key: 'skipped',
    list: {
      intro:
        'Upfly could not read, parse or measure each of these, so what they hold is not in the counts above; each says why.',
      items: report.skipped
        .filter((item) => item.stage !== 'measurement' || !item.reason.includes('--probe-all'))
        .map((item) => `${item.what}  ${item.reason}`),
    },
  };
}

/** What `optimize` planned or did, and what the summary needs to say it. */
export interface OptimizeFacts {
  readonly plan: OptimizationPlan;
  readonly graph: Graph;
  readonly probes: readonly AssetProbe[] | undefined;
  /** The images `--only` named, or null when every image could convert. */
  readonly only: readonly string[] | null;
  readonly format: EncodeFormat;
  readonly policy: PublicPolicy;
  readonly apply: boolean;
  readonly manifest: Manifest | null;
  readonly commit: string | null;
  readonly git: GitState;
  readonly notes: readonly string[];
  readonly file: ReportFile;
  readonly next: NextStep | null;
  /** How the commands it prints are typed. */
  readonly upfly: UpflyCommand;
  /** The report of the same run, for the engine's caveats at the end of the file. */
  readonly report: Report;
  /** The folders the site is served from, where a link from outside may name an original. */
  readonly servingRoots: ServingRoots;
}

/** The summary of an `optimize` run, dry or applied. */
export function optimizeSummary(facts: OptimizeFacts): Summary {
  const { plan, apply } = facts;
  const sizes = new Map(facts.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]));
  const before = plan.conversions.reduce((sum, c) => sum + (sizes.get(c.asset) ?? 0), 0);
  const saved = plan.conversions.reduce((sum, c) => sum + c.savedBytes, 0);
  const format = plan.conversions[0]?.format ?? facts.format;

  const convert: Row = {
    label: apply ? 'Converted' : 'Convert',
    value:
      plan.conversions.length === 0
        ? ['no image']
        : [
            count(plan.conversions.length, 'image'),
            ` to ${formatName(format)}, `,
            `${formatBytes(before)} → ${formatBytes(before - saved)}`,
          ],
    details:
      plan.conversions.length === 0
        ? []
        : originalsDetails(plan, facts.policy, apply, sizes, facts.servingRoots),
    key: 'convert',
    ...(plan.conversions.length === 0
      ? {}
      : { list: convertList(plan, sizes, facts.policy, format, apply) }),
  };

  const assets = new Set(sizes.keys());
  const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
  const stays = plan.declined.filter((entry) => !assets.has(entry.path));
  const stay = stays.length;
  const update: Row = {
    label: apply ? 'Updated' : 'Update',
    value:
      references === 0
        ? ['no reference']
        : [count(references, 'reference'), ` in ${count(plan.rewrites.length, 'file')}`],
    details:
      stay === 0
        ? []
        : [
            `${count(stay, 'other reference')} ${stay === 1 ? 'stays' : 'stay'} as written, each for a reason in the full plan`,
          ],
    key: 'update',
    ...(references + stay === 0
      ? {}
      : {
          list: {
            intro: `In each file, every reference Upfly can rewrite moves to the converted file.${stay === 0 ? '' : ' The references after the files stay as written, each for the reason given.'}`,
            items: [
              ...plan.rewrites.map(
                (rewrite) => `${rewrite.file}  ${count(rewrite.edits.length, 'reference')}`,
              ),
              ...stays.map(
                (entry) =>
                  `${entry.line === null ? entry.path : `${entry.path}:${entry.line}`}  stays: ${entry.reason}`,
              ),
            ],
          },
        }),
  };

  return {
    command: 'optimize',
    mode: apply ? 'applied' : 'dry run',
    sections: [
      [convert, update, leaveRow(facts, sizes)],
      noteRows(facts.notes, facts.git),
      [
        ...runRows(facts),
        ...repositoryRows(facts),
        reportRow('Full plan', facts.file),
        ...nextRows(facts.next),
      ],
    ],
    closing: optimizeClosing(
      facts,
      plan.conversions.reduce((sum, c) => sum + c.savedBytes, 0),
    ),
    caveats: engineCaveats(facts.report),
  };
}

/** The sentence that ends an `optimize` run: what it would do, or did, with the saving. */
function optimizeClosing(facts: OptimizeFacts, saved: number): string {
  const converts = count(facts.plan.conversions.length, 'image');
  if (!facts.apply) {
    return facts.plan.conversions.length === 0
      ? 'Dry run: no project file was changed, and there is nothing to convert.'
      : `Dry run: no project file was changed. With --apply, ${facts.upfly} optimize would convert ${converts} and save ${formatBytes(saved)}.`;
  }
  if (facts.manifest === null) return 'Nothing was written: the plan has nothing to do.';
  return `Upfly converted ${converts} and saved ${formatBytes(saved)}.`;
}

/** Each conversion, then the originals removed and the originals kept, each with its reason. */
function convertList(
  plan: OptimizationPlan,
  sizes: ReadonlyMap<string, number>,
  policy: PublicPolicy,
  format: EncodeFormat,
  apply: boolean,
): RowList {
  const removed = plan.conversions.filter((conversion) => conversion.replacesOriginal);
  const kept = plan.keptOriginals;
  return {
    intro: `Each image converts to ${formatName(format)}, and every reference Upfly can rewrite moves to the new file.${policy === 'keep-original' ? ' Each original stays beside its new file.' : ''}`,
    items: [
      ...plan.conversions.map((conversion) => conversionLine(conversion, sizes)),
      ...(removed.length === 0
        ? []
        : [
            `Originals ${apply ? 'removed' : 'to remove once their references move'}: ${removed.length}`,
            ...removed.map((conversion) => `  ${conversion.asset}`),
          ]),
      ...(kept.length === 0
        ? []
        : [
            `Originals kept, each with its reason: ${kept.length}`,
            ...kept.map((original) => `  ${original.asset}  ${original.reason}`),
          ]),
    ],
  };
}

/**
 * What happens to the originals: how many go and their size, how many stay, and before a run
 * that removes any from a folder the site is served from, what that costs: a link from
 * outside the project may name one there. An image the build loads is published under a name
 * that changes with every build, so nothing outside links to its original.
 */
function originalsDetails(
  plan: OptimizationPlan,
  policy: PublicPolicy,
  apply: boolean,
  sizes: ReadonlyMap<string, number>,
  servingRoots: ServingRoots,
): string[] {
  if (policy === 'keep-original') return ['each original stays beside its new file'];
  const removed = plan.conversions.filter((conversion) => conversion.replacesOriginal);
  const bytes = formatBytes(removed.reduce((sum, c) => sum + (sizes.get(c.asset) ?? 0), 0));
  const kept = plan.keptOriginals.length;
  const originals = count(removed.length, 'original');
  const served = removed.filter(
    (conversion) => servingRootOf(conversion.asset, servingRoots) !== null,
  ).length;
  return [
    ...(removed.length === 0
      ? []
      : apply
        ? [`${originals} removed, ${bytes}, since their references moved`]
        : [
            `${originals} to remove, ${bytes}, once their references move`,
            ...(served === 0
              ? []
              : [
                  `${served} of them ${served === 1 ? 'is' : 'are'} in a folder the site is served from, where a link from outside the project (an email, another site, a CMS) then stops working; --keep-originals keeps them`,
                ]),
          ]),
    ...(kept === 0 ? [] : [`${count(kept, 'original')} kept, each for a reason in the full plan`]),
  ];
}

/**
 * Every image that does not convert, counted by why. An image nothing uses is counted in the
 * words and the numbers of audit's Unused row, whatever else keeps it as it is, so the two
 * commands never give two numbers for one idea.
 */
function leaveRow(facts: OptimizeFacts, sizes: ReadonlyMap<string, number>): Row {
  const converting = new Set(facts.plan.conversions.map((conversion) => conversion.asset));
  const declined = new Map<string, string>();
  for (const entry of facts.plan.declined) {
    if (sizes.has(entry.path) && !declined.has(entry.path)) declined.set(entry.path, entry.reason);
  }
  const probes = new Map((facts.probes ?? []).map((probe) => [probe.relative, probe]));
  const only = facts.only === null ? null : new Set(facts.only);
  const unused = unusedGroups(facts.report);

  const reasonLeft = (path: string): { group: string; why: string } => {
    const reason = declined.get(path);
    if (reason !== undefined) return { group: declineGroup(reason), why: reason };
    if (only !== null && !only.has(path)) {
      return { group: 'left out by --only', why: 'left out by --only' };
    }
    const skip = probes.get(path)?.skipped[0];
    return {
      group: unmeasuredGroup(skip?.code ?? null, facts.format),
      why: skip?.reason ?? OTHER,
    };
  };
  const whyLeft = (path: string): { group: string; why: string } => {
    const left = reasonLeft(path);
    const group = unused.get(path);
    return group === undefined ? left : { group, why: left.why };
  };

  const groups: string[] = [];
  const items: string[] = [];
  let bytes = 0;
  for (const [path, size] of sizes) {
    if (converting.has(path)) continue;
    bytes += size;
    const { group, why } = whyLeft(path);
    groups.push(group);
    items.push(`${path}  ${formatBytes(size)}  ${why}`);
  }
  return {
    label: facts.apply ? 'Left alone' : 'Leave',
    value:
      groups.length === 0
        ? ['no image']
        : [count(groups.length, 'image'), `, ${formatBytes(bytes)}`],
    counts: countGroups(groups),
    key: 'leave',
    ...(items.length === 0
      ? {}
      : {
          list: {
            intro: 'Each of these images stays as it is, for the reason given.',
            items: items.sort(),
          },
        }),
  };
}

/**
 * The images audit's Unused row counts, each with its group in the words of that row: unused,
 * possibly unused, or an original kept beside its converted file.
 */
function unusedGroups(report: Report): ReadonlyMap<string, string> {
  const groups = new Map<string, string>();
  for (const finding of report.findings) {
    if (finding.kind === 'dead') groups.set(finding.asset, 'unused');
    if (finding.kind === 'possibly-dead') groups.set(finding.asset, 'possibly unused');
  }
  for (const original of report.keptOriginals.assets) {
    groups.set(original.asset, 'kept beside its converted file');
  }
  return groups;
}

/** The applied run's record and commit, as rows. */
function runRows(facts: {
  readonly apply: boolean;
  readonly manifest: Manifest | null;
  readonly commit: string | null;
  readonly git: GitState;
}): Row[] {
  if (!facts.apply) return [];
  if (facts.manifest === null) {
    return [{ label: 'Run', value: ['nothing written: the plan has nothing to do'] }];
  }
  const { created, changed, removed } = writtenByKind(facts.manifest);
  const rows: Row[] = [
    {
      label: 'Run',
      value: [
        `${facts.manifest.runId}: `,
        `${count(created.length, 'file')} created, ${changed.length} changed, ${removed.length} removed`,
      ],
    },
  ];
  if (facts.commit !== null && facts.git.kind === 'repository') {
    rows.push({
      label: 'Commit',
      value: [facts.commit.slice(0, 12), ', exactly the files the run wrote'],
    });
  }
  return rows;
}

/**
 * The repository a commit is made in, when the project is a folder of a larger one: before
 * `--apply`, and after a run that committed. Its top is printed whole, since a path cut short
 * in the middle would not say where.
 */
function repositoryRows(facts: {
  readonly apply: boolean;
  readonly commit: string | null;
  readonly git: GitState;
}): Row[] {
  const { git } = facts;
  if (git.kind !== 'repository' || git.prefix === '') return [];
  if (facts.apply && facts.commit === null) return [];
  return [
    {
      label: 'Repository',
      value: [`${git.prefix} in the git repository at ${git.top}`],
      whole: true,
      details: [
        facts.apply
          ? 'the commit holds only the files under it'
          : '--apply checks, and --commit commits, only the files under it',
      ],
    },
  ];
}

/** The notes as rows, but the one the repository row says. */
function noteRows(notes: readonly string[], git: GitState): Row[] {
  const inside = insideRepository(git);
  return notes.filter((note) => note !== inside).map((note) => ({ label: 'Note', value: [note] }));
}

/** What a `dedupe` run planned or did, and what the summary needs to say it. */
export interface DedupeFacts {
  readonly plan: DedupePlan;
  readonly apply: boolean;
  readonly manifest: Manifest | null;
  readonly commit: string | null;
  readonly git: GitState;
  readonly notes: readonly string[];
  readonly file: ReportFile;
  readonly next: NextStep | null;
  /** How the commands it prints are typed. */
  readonly upfly: UpflyCommand;
}

/** The summary of a `dedupe` run, dry or applied. */
export function dedupeSummary(facts: DedupeFacts): Summary {
  const { plan, apply } = facts;
  const files = plan.sets.reduce((sum, set) => sum + 1 + set.copies.length, 0);
  const references = plan.rewrites.reduce((sum, rewrite) => sum + rewrite.edits.length, 0);
  const stays = plan.sets.flatMap((set) => set.copies.flatMap((copy) => copy.stays));
  const unused = plan.sets.flatMap((set) =>
    set.copies.filter((copy) => copy.unusedAfter).map(() => set.bytes),
  );

  const rows: Row[] = [
    {
      label: 'Sets',
      value:
        plan.sets.length === 0
          ? ['none: no two images hold the same bytes']
          : [count(plan.sets.length, 'set'), ` of identical images, ${count(files, 'file')}`],
      key: 'sets',
      ...(plan.sets.length === 0
        ? {}
        : {
            list: {
              intro:
                'Each set starts with the copy kept and why, then each other copy and what happens to its references.',
              items: plan.sets.flatMap(setLines),
            },
          }),
    },
  ];
  if (plan.sets.length > 0) {
    rows.push({
      label: apply ? 'Updated' : 'Update',
      value:
        references === 0
          ? ['no reference']
          : [count(references, 'reference'), ` in ${count(plan.rewrites.length, 'file')}`],
      key: 'update',
      ...(references === 0
        ? {}
        : {
            list: {
              intro: 'In each file, the references to a copy move to the copy kept.',
              items: plan.rewrites.map(
                (rewrite) => `${rewrite.file}  ${count(rewrite.edits.length, 'reference')}`,
              ),
            },
          }),
    });
  }
  if (stays.length > 0) {
    rows.push({
      label: apply ? 'Left alone' : 'Leave',
      value: [count(stays.length, 'reference'), ' as written'],
      counts: countGroups(stays.map((stay) => stayGroup(stay.why))),
      key: 'leave',
      list: {
        intro: 'Each of these references stays as written, for the reason given.',
        items: stays.map((stay) => `${stay.where}  ${stay.text}  ${stay.why}`),
      },
    });
  }
  if (unused.length > 0) {
    const one = unused.length === 1;
    rows.push({
      label: 'Unused',
      value: [
        one ? '1 copy' : `${unused.length} copies`,
        `, ${formatBytes(unused.reduce((sum, bytes) => sum + bytes, 0))}, with no reference left`,
      ],
      details: [
        `Upfly never deletes ${one ? 'it' : 'them'}; ${facts.upfly} audit lists ${one ? 'it' : 'them'} as unused`,
      ],
      key: 'unused',
      list: {
        intro: `No reference names these copies once the plan is written. ${facts.upfly} dedupe deletes none of them; ${facts.upfly} audit then lists each as unused, with its size.`,
        items: plan.sets.flatMap((set) =>
          set.copies.filter((copy) => copy.unusedAfter).map((copy) => copy.path),
        ),
      },
    });
  }

  return {
    command: 'dedupe',
    mode: apply ? 'applied' : 'dry run',
    sections: [
      rows,
      noteRows(facts.notes, facts.git),
      [
        ...runRows(facts),
        ...repositoryRows(facts),
        reportRow('Full plan', facts.file),
        ...nextRows(facts.next),
      ],
    ],
    closing: dedupeClosing(facts, references),
  };
}

/** The sentence that ends a `dedupe` run. */
function dedupeClosing(facts: DedupeFacts, references: number): string {
  const moving = `${count(references, 'reference')} in ${count(facts.plan.rewrites.length, 'file')}`;
  if (!facts.apply) {
    return references === 0
      ? 'Dry run: no project file was changed, and there is nothing to do.'
      : `Dry run: no project file was changed. With --apply, ${moving} would point at the copy kept.`;
  }
  if (facts.manifest === null) return 'Nothing was written: the plan has nothing to do.';
  return `Upfly pointed ${moving} at the copy kept. No file was deleted.`;
}

const KEPT: Readonly<Record<KeptBecause, string>> = {
  chosen: 'named by --keep',
  'most-used': 'more references use it than any other copy',
  served:
    'as many references use it as another copy, and a folder the site is served from holds it',
  shorter: 'tied on references, and its path is the shortest',
  first: 'tied on references and length, and it comes first in path order',
};

/** One set: the copy kept and why, then each other copy and what happens to its references. */
function setLines(set: DedupeSet): string[] {
  const lines = [`${set.keep}  ${formatBytes(set.bytes)}, kept: ${KEPT[set.kept]}`];
  for (const copy of set.copies) {
    lines.push(
      copy.references === 0
        ? `  ${copy.path}  no reference names it`
        : `  ${copy.path}  ${movingText(copy.moved, copy.references, 'to the kept copy')}`,
    );
    for (const stay of copy.stays) {
      lines.push(`    ${stay.where}  ${stay.text} stays as written: ${stay.why}`);
    }
  }
  return lines;
}

function reportRow(label: string, file: ReportFile): Row {
  if ('written' in file) return { label, value: [file.written], terminalOnly: true };
  return {
    label,
    value: [`not written (${file.failed})`],
    details: ['add --full to print it here instead'],
    terminalOnly: true,
  };
}

function nextRows(next: NextStep | null): Row[] {
  if (next === null) return [];
  const line = next.words === null ? null : commandLine(next.words);
  const command = line !== null && columns(line) <= VALUE_WIDTH ? line : null;
  return [
    {
      label: 'Next',
      value: [command ?? next.text],
      bold: command !== null,
      ...(next.details === undefined ? {} : { details: next.details }),
    },
  ];
}

/**
 * What to run after a plan: the same command with `--apply`, or what has to happen first
 * when git or an unfinished run would refuse it.
 *
 * @param command the command that made the plan
 * @param dir the project folder as given, or `.`
 * @param flags the flags that shaped the plan, to repeat with `--apply`
 * @param git what git said about the folder
 * @param unfinished whether an earlier run stopped part way
 * @param upfly how the commands printed are typed
 */
export function nextAfterPlan(
  command: 'optimize' | 'dedupe',
  dir: string,
  flags: readonly string[],
  git: GitState,
  unfinished: boolean,
  upfly: UpflyCommand,
): NextStep {
  const folder = dir === '.' ? [] : [dir];
  if (unfinished) {
    return {
      words: [...upfly.split(' '), 'undo', ...folder],
      text: `${upfly} undo, to finish the earlier run first`,
    };
  }
  const run = [...upfly.split(' '), command, ...folder, ...flags, '--apply'];
  if (git.kind !== 'repository' || !git.tracked) {
    return {
      words: [...run, '--allow-dirty'],
      text: 'the same command with --apply --allow-dirty',
    };
  }
  if (git.changed.some((path) => path !== '.upfly' && !path.startsWith('.upfly/'))) {
    return { words: null, text: 'commit or stash your changes, then add --apply' };
  }
  return { words: run, text: 'the same command with --apply' };
}

/**
 * What to do after an applied run: check it, with the ways back.
 *
 * @param commit the run's commit, or null
 * @param upfly how the commands printed are typed
 */
export function nextAfterRun(commit: string | null, upfly: UpflyCommand): NextStep {
  return {
    words: null,
    text: `run the project's build, if it has one, then ${upfly} check`,
    details: [
      `${upfly} undo puts every file back`,
      ...(commit === null ? [] : [`git revert ${commit.slice(0, 12)} undoes the commit`]),
    ],
  };
}
