/**
 * `upfly refs <image>`: every line that names one image. First the references Upfly follows,
 * with whether `optimize` could rewrite each, then every other line a search for the image's
 * path finds, with why Upfly does not follow it, and last what `optimize` would do with the
 * image. The whole project is read, since a line can sit in any file; only that image is
 * measured. Nothing is written.
 */

import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { type EncodeFormat, type OptimizeProjectResult, optimizeProject } from 'upfly-core';
import {
  type AssetNode,
  type LinkedReference,
  type UnfollowedLine,
  type UnfollowedReason,
  citeReferences,
  compareStrings,
  formatBytes,
  isLinked,
  relativePath,
  unfollowedLines,
  whyReferenceStays,
} from 'upfly-core/internal';
import type { RefsOptions } from './args.js';
import { isDirectory } from './audit.js';
import { loadConfig } from './config.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { type UpflyCommand, upflyCommand } from './invocation.js';
import { headline, spaced } from './layout.js';
import { policyFor } from './optimize.js';
import { type Io, type Styles, emit, progressReporter, stopWith, stylesFor } from './output.js';
import { movingText } from './plan-text.js';

/** One reference to the image: where it is, what it says, and whether a run could move it. */
export interface ReferenceAnswer {
  /** POSIX-relative path of the file that holds it. */
  readonly file: string;
  /** One-based line, or `null` when the file could not be read again. */
  readonly line: number | null;
  /** The path as it is written. */
  readonly text: string;
  readonly rewritable: boolean;
  /** Why it stays as written, when it does. */
  readonly why?: string;
}

/**
 * A line that names the image which Upfly does not follow: a full address, a path built at
 * runtime, a comment, a file type it does not read, and the like, with the reason.
 */
export interface UnfollowedAnswer {
  /** POSIX-relative path of the file that holds it. */
  readonly file: string;
  /** One-based line. */
  readonly line: number;
  /** The path as the line writes it, such as a whole address. */
  readonly text: string;
  readonly reason: UnfollowedReason;
  /** Why Upfly does not follow it. */
  readonly why: string;
  /**
   * Whether a page can still load the image through this line, so converting or moving the
   * image breaks it unless somebody changes it by hand.
   */
  readonly loads: boolean;
  /** The host, for a full address. */
  readonly host?: string;
}

/** What `optimize` would do with the image, with the configured format and policy. */
export type Verdict =
  | {
      readonly kind: 'converts';
      readonly to: string;
      readonly savedBytes: number;
      readonly removesOriginal: boolean;
    }
  | { readonly kind: 'not-converted'; readonly why: string }
  | { readonly kind: 'unused' }
  | {
      readonly kind: 'possibly-unused';
      readonly mentions: readonly { readonly where: string; readonly quote: string }[];
    };

/**
 * Answers for one image.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 with the answer; 2 when the image is missing, outside the project or not an
 * image Upfly found; 3 when the configuration file belongs to another tool
 */
export async function runRefs(options: RefsOptions, io: Io): Promise<ExitCode> {
  const root = resolve(options.dir);
  if (!isDirectory(root)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `${options.dir} is not a directory`);
  }
  const config = await loadConfig(root);
  if (config.kind === 'refused') {
    return stopWith(io, options, EXIT_CODES.ABORTED, config.message, config.reason);
  }
  if (config.kind === 'invalid') {
    return stopWith(io, options, EXIT_CODES.USAGE, `${config.file} ${config.message}`);
  }
  const settings = config.kind === 'loaded' ? config.config : {};
  const upfly = upflyCommand(io.env, io.script);

  const image = resolve(options.image);
  const within = relative(root, image);
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    return stopWith(
      io,
      options,
      EXIT_CODES.USAGE,
      `${options.image} is outside the project at ${root}. Name an image inside it, or name its project after it: ${upfly} refs <image> <folder>.`,
    );
  }
  if (!isFile(image)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `there is no file at ${options.image}.`);
  }
  const path = within.split(sep).join('/');
  const format = settings.format ?? 'webp';

  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;
  const progress = progressReporter(io, 'refs', options.json);
  let result: OptimizeProjectResult;
  try {
    result = await optimizeProject({
      root,
      ...(publicDirs === null ? {} : { declared: { dirs: publicDirs, declared: true } }),
      format,
      publicPolicy: policyFor({ policy: null }, settings),
      apply: false,
      extraIgnores: [...(settings.exclude ?? []), ...options.exclude],
      only: { paths: [path] },
      onProgress: (event) => progress.update(event),
    });
  } finally {
    progress.clear();
  }

  const node = result.pipeline.graph.assets.find((candidate) => candidate.asset.relative === path);
  if (node === undefined) {
    return stopWith(
      io,
      options,
      EXIT_CODES.USAGE,
      `${path} is not an image Upfly found in the project: its extension is not an image's, or the walk leaves it out (.upflyignore, --exclude, or a folder Upfly always skips, such as node_modules).`,
    );
  }

  const references = await answersFor(node, result, format);
  const search = await unfollowedLines(result.pipeline, [path]);
  const unfollowed = search.lines.map(unfollowedAnswer);
  const verdict = verdictFor(node, result, format, unfollowed);
  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'refs',
      exitCode: EXIT_CODES.OK,
      image: path,
      bytes: node.asset.bytes,
      references,
      unfollowed,
      ...(search.unsearchable.length === 0 ? {} : { unsearchable: search.unsearchable }),
      verdict,
    });
  } else {
    const styles = stylesFor(io.stdout, io.env, options);
    const lines = render(node, references, unfollowed, search.unsearchable, verdict, styles, upfly);
    io.stdout.write(spaced(lines.split('\n')));
  }
  return EXIT_CODES.OK;
}

function unfollowedAnswer(line: UnfollowedLine): UnfollowedAnswer {
  return {
    file: line.file,
    line: line.line,
    text: line.text,
    reason: line.reason,
    why: line.why,
    loads: line.loads,
    ...(line.host === undefined ? {} : { host: line.host }),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Each reference, cited, with the planner's own answer to whether it could move. */
async function answersFor(
  node: AssetNode,
  result: OptimizeProjectResult,
  format: EncodeFormat,
): Promise<ReferenceAnswer[]> {
  const { graph, servingRoots, builds } = result.pipeline;
  const linked = node.references.filter(isLinked) as LinkedReference[];
  const { citations } = await citeReferences({
    references: linked,
    root: graph.root,
    readFile: (file) => readFile(file, 'utf8'),
  });
  return linked.map((reference) => {
    const citation = citations.get(reference);
    const why = whyReferenceStays(reference, { graph, servingRoots, format, builds });
    return {
      file: citation?.file ?? relativePath(graph.root, reference.file),
      line: citation?.line ?? null,
      text: reference.rawPath,
      rewritable: why === null,
      ...(why === null ? {} : { why }),
    };
  });
}

function verdictFor(
  node: AssetNode,
  result: OptimizeProjectResult,
  format: EncodeFormat,
  unfollowed: readonly UnfollowedAnswer[],
): Verdict {
  const path = node.asset.relative;
  if (node.references.length === 0) {
    const hedged = result.pipeline.audit.findings.find(
      (finding) => finding.kind === 'possibly-dead' && finding.asset === path,
    );
    if (hedged?.kind === 'possibly-dead') {
      return {
        kind: 'possibly-unused',
        mentions: hedged.evidence.map(({ where, quote }) => ({ where, quote })),
      };
    }
    // A line that names its path, such as a full address, may be a use the audit cannot see.
    return unfollowed.length === 0
      ? { kind: 'unused' }
      : {
          kind: 'possibly-unused',
          mentions: unfollowed.map((line) => ({
            where: `${line.file}:${line.line}`,
            quote: line.text,
          })),
        };
  }
  const { plan, refusal } = result.optimize;
  if (refusal !== null) return { kind: 'not-converted', why: refusal.reason.replace(/\.$/, '') };
  const conversion = plan.conversions.find((planned) => planned.asset === path);
  if (conversion !== undefined) {
    return {
      kind: 'converts',
      to: conversion.target,
      savedBytes: conversion.savedBytes,
      removesOriginal: conversion.replacesOriginal,
    };
  }
  const declined = plan.declined.find((entry) => entry.path === path);
  if (declined !== undefined) return { kind: 'not-converted', why: declined.reason };
  return { kind: 'not-converted', why: unmeasuredWhy(node, result, format) };
}

/** Why an image the plan neither converted nor declined stays: it could not be measured. */
function unmeasuredWhy(
  node: AssetNode,
  result: OptimizeProjectResult,
  format: EncodeFormat,
): string {
  const name = format === 'avif' ? 'AVIF' : 'WebP';
  if (node.asset.extension === `.${format}`) return `it is already a ${name}`;
  const probe = result.pipeline.probes?.find((entry) => entry.relative === node.asset.relative);
  const skipped = probe?.skipped[0];
  return skipped === undefined
    ? `Upfly could not measure it as ${name}, and converts only on a measured saving`
    : `it was not measured as ${name}: ${skipped.reason}`;
}

function render(
  node: AssetNode,
  references: readonly ReferenceAnswer[],
  unfollowed: readonly UnfollowedAnswer[],
  unsearchable: readonly { readonly file: string; readonly reason: string }[],
  verdict: Verdict,
  styles: Styles,
  upfly: UpflyCommand,
): string {
  const cited = references.flatMap((reference) => [
    `    ${reference.line === null ? reference.file : `${reference.file}:${reference.line}`}  ${reference.text}`,
    ...(reference.why === undefined ? [] : [`      stays as written: ${reference.why}`]),
  ]);
  return [
    headline(styles, 'refs'),
    '',
    `${node.asset.relative}  ${formatBytes(node.asset.bytes)}`,
    '',
    ...(references.length === 0
      ? ['No reference Upfly can read reaches it.']
      : [styles.accent(`References (${references.length})`), ...cited]),
    '',
    ...notFollowed(unfollowed, styles),
    ...(unsearchable.length === 0
      ? []
      : [
          `${unsearchable.length === 1 ? '1 file' : `${unsearchable.length} files`} could not be read, so a line in ${unsearchable.length === 1 ? 'it' : 'them'} naming the image cannot be ruled out: ${unsearchable.map((entry) => `${entry.file} (${entry.reason})`).join(', ')}.`,
          '',
        ]),
    `${styles.accent('Verdict:')} ${verdictText(node, references, verdict, upfly)}`,
    '',
  ].join('\n');
}

/** The order the reasons are printed in: the ones a reader most often has to act on first. */
const REASON_ORDER: readonly UnfollowedReason[] = [
  'full-address',
  'built-at-runtime',
  'data-or-props',
  'unread-file-type',
  'comment',
  'other',
];

/** The lines Upfly does not follow, grouped under each reason, which is printed once. */
function notFollowed(lines: readonly UnfollowedAnswer[], styles: Styles): string[] {
  if (lines.length === 0) return [];
  const groups = new Map<string, UnfollowedAnswer[]>();
  const ordered = [...lines].sort(
    (a, b) =>
      REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) ||
      compareStrings(a.why, b.why),
  );
  for (const line of ordered) groups.set(line.why, [...(groups.get(line.why) ?? []), line]);
  return [
    `${styles.accent(`Not followed (${lines.length})`)}: other lines that name it, which Upfly leaves as written`,
    ...[...groups].flatMap(([why, group]) => [
      `  ${why}`,
      ...group.map((line) => `    ${line.file}:${line.line}  ${line.text}`),
    ]),
    '',
  ];
}

function verdictText(
  node: AssetNode,
  references: readonly ReferenceAnswer[],
  verdict: Verdict,
  upfly: UpflyCommand,
): string {
  switch (verdict.kind) {
    case 'converts': {
      const moving = references.filter((reference) => reference.rewritable).length;
      const after = formatBytes(node.asset.bytes - verdict.savedBytes);
      const original = verdict.removesOriginal
        ? 'the original is removed, since every reference to it moves'
        : 'the original stays beside it';
      return `converts to ${verdict.to}, ${formatBytes(node.asset.bytes)} to ${after}. ${capitalise(movingText(moving, references.length, 'to the new file'))}; ${original}.`;
    }
    case 'not-converted':
      return `not converted: ${verdict.why}.`;
    case 'unused':
      return `unused. Nothing names it, not even by file name in a file Upfly could not read; Upfly never deletes an image that nothing uses, and \`${upfly} audit\` lists it with its size.`;
    case 'possibly-unused':
      return `possibly unused. No reference Upfly can follow reaches it, but its name appears in ${verdict.mentions.map((mention) => mention.where).join(', ')}.`;
  }
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
