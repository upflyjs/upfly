/**
 * Renders a report for a person: the headline numbers, then what was skipped, then the
 * findings, so a limitation is read before the list it limits. The same report always
 * renders the same text, so nothing here uses timestamps, durations, `toLocaleString` or
 * `Intl`. Colour is left to the CLI.
 * See "The human renderer prints the skipped list before the findings" in ARCHITECTURE.md.
 *
 * A line whose number can be 1 is phrased so that no word has to agree with it: a noun
 * phrase (`3 images with no reference`) or an invariant verb (`did not resolve`). `count`
 * pluralises only the noun it is handed, so a verb beside it goes wrong at one.
 */

import { staticExtensionOf } from '../adapters/reference-path.js';
import type { Finding, OversizeDimension, SuppressedBroken } from '../audit/audit.js';
import { fewResolvedIn } from '../audit/resolution-health.js';
import type { MentionSource } from '../audit/sweep.js';
import { formatBytes as bytes } from '../format.js';
import { compareStrings, isImageExtension } from '../paths.js';
import type { ReferenceEntry, Report, SkipStage, SkippedItem } from './report.js';

/** Render the report as plain text. */
export function renderReport(report: Report): string {
  const lines: string[] = [];

  lines.push(...headline(report));
  lines.push(...skippedSection(report));
  lines.push(...findingsSection(report));
  lines.push(...declinedSection(report));
  lines.push(...caveatSection(report));

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The first lines, and the only ones that reliably get read.
 *
 * The first line is what a reader can act on, and the lines under it say where it came
 * from. A number that is a lower bound says so in the same sentence, because a footnote
 * elsewhere is how it gets quoted as the total. Two counts that overlap, such as the
 * references that resolved and the images they point at, state how they relate.
 */
function headline(report: Report): string[] {
  const { summary } = report;
  const unreferenced = summary.assets - summary.referencedAssets;
  const capped = report.caveats.find((caveat) => caveat.code === 'encode-capped')?.count ?? 0;

  return [
    'Upfly audit',
    '',
    `  ${savingsLine(summary, capped)}`,
    '',
    `  scanned ${count(summary.sourceFiles, 'source file')} and found ${count(summary.assets, 'image')}, ${bytes(summary.assetBytes)} in total`,
    `  ${summary.linkedReferences} of ${count(summary.references, 'reference')} resolved, pointing at ${summary.referencedAssets} of those images`,
    `  ${count(unreferenced, 'image')} with no reference Upfly could follow`,
    ...vectorLine(report),
    ...keptOriginalLine(report),
    ...servingRootLine(report),
    '',
  ];
}

/**
 * Where root-relative paths were resolved from, printed only when the project declared no
 * serving root. A root-relative `broken` finding below is only as good as that guess, so
 * the reader is told it was one. Three names and a count, because the full list is in
 * `coverage.servingRoots`; `(N in all)` keeps any noun from having to agree with it.
 * See "Serving roots" in ARCHITECTURE.md.
 */
function servingRootLine(report: Report): string[] {
  const { dirs, declared } = report.coverage.servingRoots;
  if (declared) return [];

  if (dirs.length === 0) {
    return [
      '  root-relative paths resolved from the project root: Upfly found no public directory and none was declared',
    ];
  }

  const shown = dirs.slice(0, 3).join(', ');
  const rest = dirs.length > 3 ? `, and ${dirs.length - 3} more` : '';
  return [
    `  root-relative paths resolved from what Upfly detected rather than what the project declared (${dirs.length} in all): ${shown}${rest}`,
  ];
}

/**
 * The unreferenced SVGs, counted in the headline beside the count they are part of.
 *
 * They are counted rather than listed as findings, so without this line the unreferenced
 * count above would be larger than the findings below with no stated reason. `including`
 * marks them as part of that count, and takes a noun phrase with no verb to agree. The
 * `unused-vectors` caveat repeats it, as `encode-capped` repeats `savingsLine`.
 * See "The report" in ARCHITECTURE.md.
 */
function vectorLine(report: Report): string[] {
  const { count: vectors, bytes: vectorBytes } = report.unusedVectors;
  if (vectors === 0) return [];
  return [
    `  including ${count(vectors, 'unreferenced SVG')}, ${bytes(vectorBytes)} (counted, not listed: Upfly neither converts nor deletes an SVG)`,
  ];
}

/**
 * The originals kept beside their converted files, counted with their size and not listed
 * as unused. The count sits after a colon, so no noun or verb has to agree with it.
 */
function keptOriginalLine(report: Report): string[] {
  const { count: kept, bytes: keptBytes } = report.keptOriginals;
  if (kept === 0) return [];
  return [
    `  including originals kept beside the converted file their references moved to: ${kept}, ${bytes(keptBytes)}. optimize kept each one as asked, or for a reason its plan gave, so these are not unused images`,
  ];
}

/**
 * What a reader can act on, in one sentence that carries its own caveat.
 *
 * A capped run measured only some of the images, so its number is a lower bound. Rather
 * than say "lower bound", the sentence says how many went unmeasured and which flag
 * measures them, which tells the reader what to do next.
 */
function savingsLine(summary: Report['summary'], capped: number): string {
  if (!summary.probed) {
    return 'savings not measured: images were not decoded (--no-probe)';
  }
  const failed = summary.unmeasuredAssets;
  if (capped > 0) {
    const more = failed === 0 ? '' : ` and ${failed} more could not be measured`;
    return `${bytes(summary.potentialSavingBytes)} of savings found so far${atQuality(summary)}; ${capped} of ${count(summary.assets, 'image')} went unmeasured${more}, so there may be more (--probe-all)`;
  }
  if (failed > 0) {
    const across = `measured across ${summary.assets - failed} of ${count(summary.assets, 'image')}; ${failed} could not be measured`;
    return summary.potentialSavingBytes === 0
      ? `no savings found, ${across}`
      : `${bytes(summary.potentialSavingBytes)} of savings${atQuality(summary)}, ${across}`;
  }
  if (summary.potentialSavingBytes === 0) {
    return `no savings found, and every one of ${count(summary.assets, 'image')} was measured`;
  }
  return `${bytes(summary.potentialSavingBytes)} of savings${atQuality(summary)}, measured across all ${count(summary.assets, 'image')}`;
}

/**
 * The quality a saving was measured at, phrased to sit inside the sentence. A saving means
 * little without it: the same images can save 95% at quality 50 and 44% at quality 90.
 * Read from the report rather than from configuration, so it describes the run that
 * produced the bytes beside it.
 */
function atQuality(summary: Report['summary']): string {
  const entries = Object.entries(summary.savingQuality).sort(([a], [b]) => compareStrings(a, b));
  if (entries.length === 0) return '';
  return ` as ${entries.map(([format, settings]) => `${format} ${settingsPhrase(settings ?? [])}`).join(' and ')}`;
}

/**
 * The encode settings a format was measured at, as words: `at quality 80`, `lossless`, or
 * `at quality 80, or lossless where that came out smaller`.
 */
function settingsPhrase(settings: readonly (number | 'lossless')[]): string {
  const qualities = settings.filter((setting): setting is number => setting !== 'lossless');
  const quality =
    qualities.length === 0
      ? ''
      : `at quality ${qualities.length === 1 ? qualities[0] : `${qualities.slice(0, -1).join(', ')} or ${qualities.at(-1)}`}`;
  if (!settings.includes('lossless')) return quality;
  return quality === '' ? 'lossless' : `${quality}, or lossless where that came out smaller`;
}

/**
 * The label over each stage's skipped items, saying what happened to them. The sweep's
 * entries are files, often fonts, too large to search for asset filenames, so their label
 * names that search and cannot be read as a failed conversion.
 */
const STAGE_LABEL: Record<SkipStage, string> = {
  discovery: 'could not be read',
  scan: 'could not be parsed',
  sweep: 'too large to search for asset filenames',
  citation: 'could not be re-read for a line number',
  measurement: 'could not be measured',
  aliases: 'had path aliases Upfly could not read',
};

/**
 * The sentence for the references into what the project's rules left out, apart from the
 * references with no answer: the run was told to leave their targets alone.
 */
function leftOutLine(references: number): string[] {
  if (references === 0) return [];
  const into = references === 1 ? 'points into a file' : 'point into files';
  return [`${count(references, 'reference')} ${into} this run leaves out, as asked.`];
}

/**
 * What the engine declined to do, printed before the findings.
 *
 * The unsafe references are here too. They are not failures, but they are paths the
 * engine will not touch, and a user should see that number before believing the rest.
 */
function skippedSection(report: Report): string[] {
  const { skipped, references } = report;
  const leftOut = leftOutLine(references.leftOut.length);
  // The discarded and declined counts are part of this guard: a repository with no skips and
  // no unsafe references often still has a `package.json` full of path-shaped strings, and
  // the count lines for those are at the end of this section.
  if (
    skipped.length === 0 &&
    references.unsafe.length === 0 &&
    references.discardedCount === 0 &&
    references.declinedValues.count === 0
  ) {
    const excluded = report.caveats.some((caveat) => caveat.code === 'excluded-roots');
    return [
      excluded
        ? 'Nothing was skipped apart from the paths your ignore rules left out, listed under Worth knowing.'
        : 'Nothing was skipped.',
      ...leftOut,
      '',
    ];
  }

  const lines: string[] = [];

  if (skipped.length > 0) {
    // A neutral heading, because not every entry is a failure: the encode cap is a choice
    // and the sweep's entries are a size limit. Each row carries its own reason.
    lines.push(`Skipped: ${count(skipped.length, 'thing')}, each with its reason`, '');
    for (const [stage, items] of groupByStage(skipped)) {
      lines.push(`  ${STAGE_LABEL[stage]}:`);
      const readable =
        stage === 'scan'
          ? items.map((item) => ({ ...item, reason: plainParseReason(item.reason) }))
          : items;
      lines.push(...collapseByReason(readable));
      lines.push('');
    }

    // The reasons above are Upfly's own wording, because a library's can change between
    // runs and the report must not. What libvips or PostCSS said is in a separate file,
    // named here.
    // See "The recorded reason is ours, and the library's is not in the report" in
    // ARCHITECTURE.md.
    if (report.diagnosticsFile !== null) {
      lines.push(
        `  What the underlying libraries said about these is in ${report.diagnosticsFile}.`,
        '  It is their wording, not ours, and it can change when they are upgraded,',
        '  which is why it is there and not here.',
        '',
      );
    }
  }

  if (leftOut.length > 0) lines.push(...leftOut, '');

  if (references.unsafe.length > 0) {
    // Listed only when the path shows an image filename; counted otherwise. The resolver
    // has already dropped paths whose static extension is not an image, so the rest show
    // no static extension (`/view/${style}/${name}`): nothing a reader can check, and
    // listing them buries the few they can. The count still reports every one.
    const listed = references.unsafe.filter((entry) => showsAnImageFilename(entry.rawPath));
    const unlisted = references.unsafe.filter((entry) => !showsAnImageFilename(entry.rawPath));
    const counted = unlisted.length;
    const cssWithNothing = references.unsafe.some(
      (entry) => entry.refusalReason === 'no-reference-in-it-to-find',
    );

    // The heading keeps apart references that had no answer to find (built at run time,
    // or deliberately out of scope) and ones Upfly failed to resolve. One heading over
    // both would read as that many mistakes.
    const refused = references.unsafe.filter(
      (entry) => entry.classification === 'correctly-refused',
    );
    const missed = references.unsafe.length - refused.length;

    if (missed === 0) {
      lines.push(
        `${count(references.unsafe.length, 'reference')} had no answer to find`,
        '',
        ...(cssWithNothing
          ? [
              '  none of these is a path that points at a file: each is built at run time, is CSS',
              '  that holds no url() or image-set(), or names something deliberately outside what',
              '  Upfly indexes',
            ]
          : [
              '  none of these is a path that points at a file: each is built at run time, or',
              '  names something deliberately outside what Upfly indexes',
            ]),
        '',
      );
    } else if (refused.length === 0) {
      lines.push(`${count(missed, 'reference')} could not be resolved`, '');
    } else {
      lines.push(
        `${count(references.unsafe.length, 'reference')} were not linked`,
        '',
        `  ${missed} could not be resolved, and ${refused.length} had no answer to find`,
        '',
      );
    }
    // A key for the two columns, since a reader seeing an `.mdx` file beside a path asks
    // whether the `.mdx` is being treated as an image. Printed only above a list: this
    // section is often entirely counted.
    if (listed.length > 0) {
      lines.push('  (the file it was found in, then the path text as written)', '');
    }
    for (const entry of listed) {
      lines.push(`  ${entry.file}  ${entry.rawPath}`);
      lines.push(`    ${entry.resolution}: ${entry.reason}`);
      // Only for Upfly's own misses. A refusal's `reason` already says why it was refused;
      // what the reader cannot otherwise tell is which entries Upfly got wrong.
      if (entry.classification !== 'correctly-refused') {
        lines.push('    (this one is ours: an answer exists and we did not find it)');
      }
    }
    if (counted > 0) lines.push(...countedLines(unlisted, listed.length === 0));
    lines.push('');
  }

  if (references.classificationBounds.length > 0) {
    // An accuracy worked out from these counts measures where the engine draws its own
    // boundary, not whether it is right, and a refusal reason known to over-claim
    // inflates it. So the measured over-claim prints beside the counts, not in a footnote.
    lines.push('What the counts above are known to get wrong', '');
    for (const entry of references.classificationBounds) {
      lines.push(`  ${entry.count} classified as "${entry.reason}", and:`);
      for (const line of wrapWords(entry.bound, 74)) lines.push(`    ${line}`);
      lines.push('');
      // What it was measured against prints too: a bound a reader cannot date is one they
      // cannot check.
      for (const line of wrapWords(`measured: ${entry.measuredAgainst}`, 74)) {
        lines.push(`    ${line}`);
      }
      lines.push('');
    }
  }

  if (references.discardedCount > 0) {
    // The hint names the flag that produces the list, since `--json` alone gives only
    // the count. "Did not resolve", not "was not a reference": many of these do name a
    // real asset, such as `{ file: 'gitbook.svg' }` joined to a directory at run time,
    // and the possibly-dead evidence below may cite them as proof an asset is alive.
    const hint = listHint('--include-discarded', references.discarded, references.discardedCount);
    lines.push(
      `${count(references.discardedCount, 'path-shaped string')} did not resolve to an asset${hint}`,
      '',
    );

    // Printed when asked for, or `--include-discarded` would appear to do nothing
    // without `--json`.
    for (const entry of references.discarded ?? []) {
      lines.push(`  ${entry.file}  ${entry.rawPath}`);
    }
    if (references.discarded !== null) lines.push('');
  }

  lines.push(...declinedValueLines(report));
  return lines;
}

/**
 * The hint naming the flag that lists what a count stands for, or nothing when the list is
 * already there.
 */
function listHint(flag: string, list: readonly unknown[] | null, n: number): string {
  return list === null ? ` (use ${flag} to list ${n === 1 ? 'it' : 'them'})` : '';
}

/**
 * The values an adapter declined, one line per reason. A reason names the construct, such as
 * the attribute, so a reader who knows that a prop holds a file path can see which prop.
 */
function declinedValueLines(report: Report): string[] {
  const { count: total, byReason, values } = report.references.declinedValues;
  if (total === 0) return [];

  const hint = listHint('--include-discarded', values, total);
  const lines = [
    `${count(total, 'value')} with an image extension linked nothing, written where Upfly reads no file path${hint}`,
    '',
  ];
  for (const entry of byReason) {
    lines.push(`  ${count(entry.count, 'value')}: ${entry.reason}`);
    for (const value of values ?? []) {
      if (value.reason === entry.reason) lines.push(`    ${value.file}  ${value.rawPath}`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Whether this raw path shows an image filename a person could go and check. False for a
 * path with no static extension, even though it may well name an image: there is nothing
 * in it for a reader to look up.
 */
function showsAnImageFilename(rawPath: string): boolean {
  const extension = staticExtensionOf(rawPath);
  return extension !== '' && isImageExtension(extension);
}

/**
 * Each unreferenced vector that shares its stem with a broken reference to a raster,
 * rendered first because it is the most actionable thing in the report: the broken
 * reference is a broken image on the site, and the vector is the likely explanation.
 *
 * `may have been` is the honest verb: `hero.svg` beside a broken `hero.png` could be two
 * unrelated files named alike. Both facts print so the reader can judge.
 */
function staleConversionSection(report: Report): string[] {
  if (report.staleConversions.length === 0) return [];

  const lines = [
    `  ${count(report.staleConversions.length, 'image')} may have been converted by hand without updating the reference`,
  ];
  for (const pair of report.staleConversions) {
    lines.push(`    ${pair.vector} is unreferenced, and ${pair.where} asks for ${pair.rawPath}`);
  }
  lines.push('');
  return lines;
}

function findingsSection(report: Report): string[] {
  // An empty `findings` does not mean nothing was found: unreferenced SVGs and kept
  // originals are counted outside it. No fixture reaches this branch, so report.test.ts
  // builds a case by hand.
  if (report.findings.length === 0) {
    const counted = [
      report.unusedVectors.count > 0 && count(report.unusedVectors.count, 'unreferenced SVG'),
      report.keptOriginals.count > 0 && count(report.keptOriginals.count, 'kept original'),
    ].filter((phrase): phrase is string => typeof phrase === 'string');
    if (counted.length === 0) return ['No findings.', ''];
    return [`No findings, apart from ${counted.join(' and ')} counted above.`, ''];
  }

  const lines = [`Findings: ${count(report.findings.length, 'item')}`, ''];
  lines.push(...staleConversionSection(report));
  let previous: Finding['kind'] | null = null;

  for (const finding of report.findings) {
    // Hedges are not a flat list: they are three different statements about why an
    // asset has no references, and `possiblyDeadSection` renders them as such.
    if (finding.kind === 'possibly-dead') {
      if (previous !== 'possibly-dead') {
        if (previous !== null) lines.push('');
        lines.push(...possiblyDeadSection(report));
        previous = 'possibly-dead';
      }
      continue;
    }

    // Both size findings are one statement about one file, so `sizeSection` prints them
    // together.
    if (finding.kind === 'oversized' || finding.kind === 'format-opportunity') {
      if (previous !== 'oversized') {
        if (previous !== null) lines.push('');
        lines.push(...sizeSection(report));
        previous = 'oversized';
      }
      continue;
    }

    if (finding.kind !== previous) {
      if (previous !== null) lines.push('');
      lines.push(`  ${headingFor(finding.kind, report)}`);
      previous = finding.kind;
    }
    lines.push(...describe(finding, report));
  }

  lines.push('');
  return lines;
}

type PossiblyDead = Extract<Finding, { kind: 'possibly-dead' }>;

/**
 * Most actionable first. A finding is filed under the best evidence it carries,
 * and still prints all of it.
 */
const MENTION_RANK: readonly MentionSource[] = [
  'unscanned-file',
  'scanned-file',
  'unresolved-reference',
];

/**
 * What each source means to the person reading, which is the only axis that
 * matters here: the three differ in what the user can do.
 */
const MENTION_HEADING: Record<MentionSource, string> = {
  'unscanned-file': 'in a file no adapter reads; an adapter for that file type would find these',
  'scanned-file':
    'in text Upfly read but no adapter claimed, the weakest evidence; look if the asset matters',
  'unresolved-reference': 'by a path Upfly read but could not resolve; those files parse fine',
};

/**
 * The hedges, split by what the evidence is and grouped by the file that named them.
 *
 * Many hedged assets are named only in a file Upfly read and parsed, so a single heading
 * such as "named somewhere Upfly cannot read" would be false for them, and a reader
 * following it would find a readable file. Grouping by citing file gives a fact somebody
 * can act on: one data file can explain most of a repository's hedges.
 */
function possiblyDeadSection(report: Report): string[] {
  const findings = report.findings.filter(
    (finding): finding is PossiblyDead => finding.kind === 'possibly-dead',
  );
  const lines = [
    `  possibly unreferenced (${findings.length}): each is named somewhere, but not by a reference Upfly could follow`,
  ];

  for (const source of MENTION_RANK) {
    const group = findings.filter((finding) => bestSource(finding) === source);
    if (group.length === 0) continue;

    lines.push('', `    named ${MENTION_HEADING[source]} (${group.length})`);

    const byFile = new Map<string, PossiblyDead[]>();
    for (const finding of group) {
      const file = citingFile(finding, source);
      byFile.set(file, [...(byFile.get(file) ?? []), finding]);
    }

    // Biggest cause first, because that is the one worth acting on. Ties break on the
    // path, so the same report always prints in the same order.
    const files = [...byFile].sort(
      (a, b) => b[1].length - a[1].length || compareStrings(a[0], b[0]),
    );

    for (const [file, assets] of files) {
      lines.push(`      ${file}: ${count(assets.length, 'asset')}`);
      for (const finding of assets) {
        lines.push(`        ${finding.asset}  ${bytes(finding.bytes)}`);
        // Every mention, not only the one that filed it: the citation is the whole
        // point of hedging per asset rather than globally.
        for (const mention of finding.evidence) {
          lines.push(`          named in ${mention.where}: ${mention.quote}`);
        }
      }
    }
  }

  return lines;
}

/** The most actionable source among a finding's evidence. */
function bestSource(finding: PossiblyDead): MentionSource {
  let best = finding.evidence[0].source;
  for (const mention of finding.evidence) {
    if (MENTION_RANK.indexOf(mention.source) < MENTION_RANK.indexOf(best)) best = mention.source;
  }
  return best;
}

/** The file that filed this finding, without the line number `where` carries. */
function citingFile(finding: PossiblyDead, source: MentionSource): string {
  const mention = finding.evidence.find((entry) => entry.source === source);
  const where = mention?.where ?? finding.evidence[0].where;
  return where.replace(/:\d+$/, '');
}

/** What exceeding each limit means, said as a comparison a reader can check. */
const OVERSIZE_LABEL: Record<OversizeDimension, string> = {
  bytes: 'larger than the size limit',
  width: 'wider than the width limit',
  height: 'taller than the height limit',
};

type Oversized = Extract<Finding, { kind: 'oversized' }>;
type Opportunity = Extract<Finding, { kind: 'format-opportunity' }>;

/**
 * Everything about an image's size, once per image.
 *
 * `oversized` and `format-opportunity` often describe the same file, and in separate
 * sections the line a reader wants ("551 KB, and 340 KB as webp") appears in neither.
 * Both counts stay in the heading, so the merge hides nothing.
 */
function sizeSection(report: Report): string[] {
  const merged = new Map<string, { over: Oversized | null; opportunities: Opportunity[] }>();

  // First-encounter order is the report's own deterministic finding order, so no second
  // sort is needed.
  for (const finding of report.findings) {
    if (finding.kind !== 'oversized' && finding.kind !== 'format-opportunity') continue;
    const entry = merged.get(finding.asset) ?? { over: null, opportunities: [] };
    if (finding.kind === 'oversized') entry.over = finding;
    else entry.opportunities.push(finding);
    merged.set(finding.asset, entry);
  }

  const oversized = report.summary.findings.oversized;
  const opportunities = report.summary.findings['format-opportunity'];
  const lines = [
    `  size (${count(merged.size, 'image')}): ${oversized} over the limit, ${opportunities} smaller as another format (measured, not estimated)`,
    '',
  ];

  for (const [asset, entry] of merged) {
    const first = entry.over ?? entry.opportunities[0];
    if (first === undefined) continue;

    const shape = entry.over === null ? '' : dimensions(entry.over.width, entry.over.height);
    lines.push(`    ${asset}  ${bytes(first.bytes)}${shape}`);

    if (entry.over !== null) {
      // One line per limit, each in words: `exceeded` holds identifiers, and joining them
      // reads "over bytes and width". Separate lines also avoid "limit" against "limits".
      for (const dimension of entry.over.exceeded) lines.push(`      ${OVERSIZE_LABEL[dimension]}`);
    }
    for (const opportunity of entry.opportunities) {
      lines.push(
        `      ${bytes(opportunity.wouldBe)} as ${opportunity.to} (saves ${bytes(opportunity.savedBytes)}, ${opportunity.savedPercent}%)`,
      );
    }
  }

  return lines;
}

function headingFor(kind: Finding['kind'], report: Report): string {
  const total = report.summary.findings[kind];
  switch (kind) {
    case 'serving-root-unknown':
      // No count in the heading. There is exactly one of these, and "(1)" beside a
      // sentence about the whole run reads as though it were one of a list.
      return report.coverage.servingRoots.declared
        ? 'Few root-relative references resolved where the project says the site is served from'
        : 'Upfly could not work out where this project serves files from';
    case 'broken':
      return `broken references (${total}): these point at nothing`;
    case 'dead':
      return `unreferenced images (${total})`;
    case 'possibly-dead':
      // Unreachable, as are `oversized` and `format-opportunity`: `findingsSection`
      // prints those three kinds through `possiblyDeadSection` and `sizeSection`. The
      // cases keep the switch exhaustive, so a new kind still fails to compile.
      return `possibly unreferenced (${total})`;
    case 'oversized':
      return `oversized images (${total})`;
    case 'format-opportunity':
      return `smaller as another format (${total}): measured, not estimated`;
    // The count is of sets, not images, and the heading says so, or it reads as a number
    // of files.
    case 'duplicate':
      return `identical copies (${total} ${total === 1 ? 'set' : 'sets'}): the same bytes shipped more than once`;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

function describe(finding: Finding, report: Report): string[] {
  switch (finding.kind) {
    case 'serving-root-unknown': {
      const { dirs, declared } = report.coverage.servingRoots;
      // A folder the project named is not asked for again: what did not resolve there is
      // listed as naming no file there.
      if (declared) {
        const said = fewResolvedIn(finding, dirs);
        return [
          `    ${said.charAt(0).toUpperCase()}${said.slice(1)}:`,
          ...finding.suppressed.flatMap((entry) => brokenLines(entry, '      ')),
        ];
      }
      return [
        `    ${finding.linked} of ${finding.checkable} root-relative references resolved, so the rest cannot be judged`,
        `    ${finding.suppressedBroken} broken-reference findings are withheld: they are almost certainly this one problem`,
        '    declare the directory your site serves from and run again, for example publicDirs: ["src"]',
        // Every one, in the form a broken finding takes: the count alone would not show a
        // reader which references were set aside.
        '    the withheld references, which a run with that directory declared will check:',
        ...finding.suppressed.flatMap((entry) => brokenLines(entry, '      ')),
      ];
    }
    case 'broken':
      return brokenLines(finding, '    ');
    case 'dead':
      return [`    ${finding.asset}  ${bytes(finding.bytes)}`];
    // Unreachable, as are `oversized` and `format-opportunity`; see `headingFor`.
    case 'possibly-dead':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)}`,
        ...finding.evidence.map((mention) => `      named in ${mention.where}: ${mention.quote}`),
      ];
    case 'oversized':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)}${dimensions(finding.width, finding.height)} (over ${finding.exceeded.join(' and ')})`,
      ];
    case 'format-opportunity':
      return [
        `    ${finding.asset}  ${bytes(finding.bytes)} → ${bytes(finding.wouldBe)} as ${finding.to}  (saves ${bytes(finding.savedBytes)}, ${finding.savedPercent}%)`,
      ];
    // Every path on its own line, because the set is the finding. No copy is marked as
    // the one to keep: which should survive depends on intent the engine cannot see.
    case 'duplicate':
      return [
        `    ${bytes(finding.bytes)} each, ${bytes(finding.wastedBytes)} recoverable by keeping one:`,
        ...finding.assets.map((asset) => `      ${asset}`),
      ];
    default: {
      const unhandled: never = finding;
      return unhandled;
    }
  }
}

/**
 * The line for the unsafe references that show no filename. When every one builds its path
 * at run time, one line says so; otherwise each kind is counted on its own line, since
 * "built at run time" is false of CSS that holds no url() and of a path Upfly missed.
 */
function countedLines(unlisted: readonly ReferenceEntry[], nothingListed: boolean): string[] {
  const lead = nothingListed
    ? '  none with a filename to check'
    : `  plus ${unlisted.length} with no filename to check`;
  if (unlisted.every((entry) => entry.refusalReason === 'assembled-at-runtime')) {
    return [`${lead}: each builds its path at runtime`];
  }
  const kinds: readonly [string | null, string][] = [
    ['assembled-at-runtime', 'built at run time'],
    ['no-reference-in-it-to-find', 'in CSS that holds no url() or image-set()'],
    ['out-of-scope', 'outside what Upfly indexes'],
    [null, 'that Upfly could not resolve'],
  ];
  const lines = [`${lead}:`];
  for (const [reason, words] of kinds) {
    const n = unlisted.filter((entry) => entry.refusalReason === reason).length;
    if (n > 0) lines.push(`    ${n} ${words}`);
  }
  return lines;
}

/**
 * What the plan examined and did not convert: one counted line with the total size, and
 * the list, each entry with the planner's reason, only when asked for.
 *
 * Silent when there is nothing to say, which includes every audit-only run: a report
 * built without a plan has no declines, and "0 images" would suggest the planner ran and
 * found nothing.
 */
function declinedSection(report: Report): string[] {
  const { count: declined, bytes: declinedBytes, assets } = report.declined;
  const { count: left, references } = report.declinedReferences;
  if (declined === 0 && left === 0) return [];

  const lines = ['Examined and not converted', ''];
  if (declined > 0) {
    const hint = listHint('--include-declined', assets, declined);
    lines.push(
      `  ${count(declined, 'image')}, ${bytes(declinedBytes)}, each with its reason${hint}`,
    );
  }
  if (left > 0) {
    const hint = listHint('--include-declined', references, left);
    lines.push(`  ${count(left, 'reference')} left as written, each with its reason${hint}`);
  }
  lines.push('');

  for (const entry of assets ?? []) {
    lines.push(`    ${entry.asset}  ${bytes(entry.bytes)}  ${entry.reason}`);
  }
  for (const entry of references ?? []) {
    const where = entry.line === null ? entry.file : `${entry.file}:${entry.line}`;
    lines.push(`    ${where}  ${entry.reason}`);
  }
  if (assets !== null) lines.push('');

  return lines;
}

function caveatSection(report: Report): string[] {
  if (report.caveats.length === 0) return [];

  const lines = ['Worth knowing', ''];
  for (const caveat of report.caveats) {
    // The message already carries its own count, so nothing here has to compose a
    // sentence out of a number and a fragment.
    lines.push(`  ${caveat.message}${caveat.detail.length > 0 ? ':' : ''}`);
    for (const detail of caveat.detail) lines.push(`    ${detail}`);
  }
  lines.push('');
  return lines;
}

/** Above this many items sharing one reason, the reason is lifted above them. */
const REPEAT_LIMIT = 3;

/**
 * A parse failure's reason without the codes the JSON keeps for machines. The heading above
 * it already says the file could not be parsed.
 */
function plainParseReason(reason: string): string {
  const prefix = /^parse-failed: (?:[A-Z][A-Z0-9_]*: )?(?:Could not parse: )?/.exec(reason);
  const rest = prefix === null ? '' : reason.slice(prefix[0].length);
  return rest === '' ? reason : rest;
}

/**
 * Items sharing a reason, with the reason said once and every name kept.
 *
 * Repeating one reason on every line makes a wall: a capped run would print the same
 * `--probe-all` sentence for each unmeasured asset. The names still all print, because
 * they are often the actionable part, such as which `.js` files are really templates.
 */
function collapseByReason(items: readonly SkippedItem[]): string[] {
  const byReason = new Map<string, SkippedItem[]>();
  for (const item of items) {
    byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item]);
  }

  const lines: string[] = [];
  for (const [reason, group] of byReason) {
    if (group.length > REPEAT_LIMIT) {
      lines.push(`    ${count(group.length, 'file')}: ${reason}`);
      for (const item of group) lines.push(`      ${item.what}`);
      continue;
    }
    for (const item of group) lines.push(`    ${item.what}: ${item.reason}`);
  }

  return lines;
}

function groupByStage(items: readonly SkippedItem[]): [SkipStage, SkippedItem[]][] {
  const groups = new Map<SkipStage, SkippedItem[]>();
  for (const item of items) {
    const list = groups.get(item.stage);
    if (list === undefined) groups.set(item.stage, [item]);
    else list.push(item);
  }
  // `skipped` arrives sorted by stage, so insertion order is already deterministic.
  return [...groups];
}

/** `1 image` / `2 images`. English pluralisation, which is the only language here. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function dimensions(width: number | null, height: number | null): string {
  return width === null || height === null ? '' : `, ${width}×${height}`;
}

/** A broken reference where it is written, and its note, if any, on the line below. */
function brokenLines(entry: SuppressedBroken, indent: string): string[] {
  const cited = `${indent}${entry.where}  ${entry.rawPath}`;
  return entry.note === undefined ? [cited] : [cited, `${indent}  ${entry.note}`];
}

/**
 * Break a sentence at word boundaries, so a measured bound reads as prose rather than
 * running off the terminal.
 *
 * Deliberately dumb: no hyphenation, no locale awareness. The only thing it must never do
 * is split a path or a number, and splitting on spaces alone cannot.
 */
function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out;
}
