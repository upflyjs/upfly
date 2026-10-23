/**
 * The audit as a Markdown document, for "Upfly: Show report". It is written from the result
 * the audit already returned, so showing it runs nothing again, and it quotes the CLI's own
 * sentences (its notes and reasons) as they are.
 */

import { limitsText } from './audit-model.js';
import type { AuditResult, Finding } from './contract.js';
import { formatBytes, plural } from './format.js';

/** Where and when the audit ran. */
export interface ReportMeta {
  /** The workspace folder's name. */
  readonly folder: string;
  readonly path: string;
  readonly when: string;
  readonly cliVersion: string;
}

type FindingOf<K extends Finding['kind']> = Extract<Finding, { readonly kind: K }>;

/**
 * Renders one folder's audit.
 *
 * @param result the audit's result line
 * @param meta the folder, the time and the CLI's version
 * @returns the document's text
 */
export function renderReport(result: AuditResult, meta: ReportMeta): string {
  const { report, savings } = result;
  const { summary } = report;
  const of = <K extends Finding['kind']>(kind: K): FindingOf<K>[] =>
    report.findings.filter((finding): finding is FindingOf<K> => finding.kind === kind);
  const out: string[] = [
    `# Upfly audit: ${meta.folder}`,
    '',
    `The folder ${meta.path}, read on ${meta.when} by upfly ${meta.cliVersion}. Nothing was changed.`,
    '',
    `- ${plural(summary.assets, 'image')}, ${formatBytes(summary.assetBytes)}; ${summary.referencedAssets} in use.`,
    `- ${plural(summary.references, 'reference')} in ${plural(summary.sourceFiles, 'file')}; ${summary.linkedReferences} lead to an image.`,
  ];
  if (savings !== null) {
    out.push(
      `- upfly optimize would convert ${plural(savings.images, 'image')} and save ${formatBytes(savings.savedBytes)}.`,
    );
  }

  for (const unknown of of('serving-root-unknown')) {
    section(out, 'Which folder the site is served from is not known', [
      `Upfly could not work out which folder the site is served from, so ${plural(unknown.suppressedBroken, 'path')} such as /hero.png could not be checked. Name the folder in upfly.config.json as publicDirs, or run npx upfly init.`,
    ]);
  }

  if (savings !== null) {
    section(
      out,
      'Could be smaller',
      savings.conversions.map(
        (conversion) =>
          `- ${codeSpan(conversion.asset)} to ${codeSpan(conversion.target)}, ${formatBytes(conversion.savedBytes)} less; ${conversion.replacesOriginal ? 'the original is removed once no file names it' : 'the original is kept'}.`,
      ),
    );
    if (savings.unmeasured > 0) {
      out.push(
        '',
        `${plural(savings.unmeasured, 'more image')} optimize may convert ${savings.unmeasured === 1 ? 'was' : 'were'} not measured, so it converts and saves at least this much.`,
      );
    }
  } else {
    section(
      out,
      'Smaller in another format',
      of('format-opportunity').map(
        (finding) =>
          `- ${codeSpan(finding.asset)}: ${formatBytes(finding.bytes)} to ${formatBytes(finding.wouldBe)} as ${finding.to === 'webp' ? 'WebP' : 'AVIF'}, ${finding.savedPercent}% smaller.`,
      ),
    );
  }

  section(
    out,
    'Broken references',
    of('broken').map(
      (finding) =>
        `- ${codeSpan(finding.rawPath)} in ${finding.where}${finding.note === undefined ? '' : `: ${finding.note}`}`,
    ),
  );
  section(
    out,
    'Unused',
    of('dead').map(
      (finding) =>
        `- ${codeSpan(finding.asset)}, ${formatBytes(finding.bytes)}${finding.inPublicDir ? ', in a folder the site serves, so something outside the project may link to it' : ''}.`,
    ),
  );
  section(
    out,
    'Possibly unused',
    of('possibly-dead').map(
      (finding) =>
        `- ${codeSpan(finding.asset)}, ${formatBytes(finding.bytes)}: its name appears in ${finding.evidence
          .map((mention) => `${mention.where} (${codeSpan(mention.quote)})`)
          .join(', ')}.`,
    ),
  );
  section(
    out,
    'Identical copies',
    of('duplicate').map(
      (finding) =>
        `- ${plural(finding.assets.length, 'copy', 'copies')} of ${formatBytes(finding.bytes)}: ${finding.assets.map(codeSpan).join(', ')}.`,
    ),
  );
  section(
    out,
    'Oversized',
    of('oversized').map(
      (finding) =>
        `- ${codeSpan(finding.asset)}, ${formatBytes(finding.bytes)}${finding.width === null || finding.height === null ? '' : `, ${finding.width} x ${finding.height} pixels`}: over ${limitsText(finding.exceeded)}.`,
    ),
  );
  section(
    out,
    'References never rewritten',
    report.references.unsafe.map(
      (reference) => `- ${codeSpan(reference.rawPath)} in ${reference.file}: ${reference.reason}`,
    ),
  );

  const { coverage } = report;
  const read = [
    coverage.servingRoots.dirs.length === 0
      ? '- Served from: no folder was found.'
      : `- Served from: ${coverage.servingRoots.dirs.map((dir) => codeSpan(dir === '' ? '.' : dir)).join(', ')}, ${coverage.servingRoots.declared ? 'as the config or the command line names them' : 'worked out by Upfly from what the paths resolve against'}.`,
    ...coverage.unscannedExtensions.map(
      (type) =>
        `- Not read: ${plural(type.fileCount, 'file')} of type ${codeSpan(type.ext === '' ? '(none)' : type.ext)}.`,
    ),
    ...coverage.excludedRoots.map(
      (root) => `- Not entered: ${codeSpan(root.path)}, ${root.reason}.`,
    ),
    ...report.skipped.map((item) => `- Skipped: ${codeSpan(item.what)}, ${item.reason}`),
  ];
  section(out, 'What Upfly read', read);
  if (report.caveats.length > 0) {
    section(
      out,
      'Notes',
      report.caveats.map((caveat) => `- ${caveat.message}`),
    );
  }
  return `${out.join('\n')}\n`;
}

/**
 * Text as a Markdown code span, fenced with one more backtick than the longest run inside it,
 * and padded when it starts or ends with one, as CommonMark requires.
 *
 * @param text a path or quote as Upfly printed it
 */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function section(out: string[], title: string, lines: readonly string[]): void {
  out.push('', `## ${title}`, '', ...(lines.length === 0 ? ['None.'] : lines));
}
