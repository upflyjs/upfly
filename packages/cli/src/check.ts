/**
 * `upfly check`: the gate for continuous integration. It fails when a reference names an image
 * that does not exist, or an image in use is larger than the config allows, and never because
 * an image is unused: most projects hold some, and a gate that fails on its first run is
 * switched off. It reads no pixels and writes nothing.
 */

import { isAbsolute, resolve } from 'node:path';
import {
  type BrokenFinding,
  type PipelineOutput,
  type ServingRootUnknownFinding,
  runPipeline,
  servingRootsFor,
} from 'upfly-core';
import { byFileAndLine, fewResolvedIn, formatBytes, relativePath } from 'upfly-core/internal';
import type { CheckOptions } from './args.js';
import { isDirectory } from './audit.js';
import { loadConfig } from './config.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { changedFiles } from './git.js';
import { type UpflyCommand, upflyCommand } from './invocation.js';
import { headline, spaced } from './layout.js';
import { type Io, type Styles, emit, progressReporter, stopWith, stylesFor } from './output.js';
import { count } from './plan-text.js';

/** An image a reference uses whose file is larger than `check.maxImageBytes`. */
export interface TooLargeFinding {
  readonly kind: 'too-large';
  /** POSIX-relative path of the image. */
  readonly asset: string;
  /** Its size on disk. */
  readonly bytes: number;
}

/** What fails the check. */
export type CheckFinding = BrokenFinding | TooLargeFinding;

/** The files a change touched, from `--changed`, and the file names it deleted. */
interface ChangeScope {
  readonly against: string | null;
  readonly paths: ReadonlySet<string>;
  readonly deletedNames: ReadonlySet<string>;
}

/**
 * Reads the project and says whether it passes.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when it passed, 1 when a finding failed it, 2 for a usage or configuration error,
 * 3 when no folder was named and it could not tell where the site is served from, or the config
 * is another tool's
 */
export async function runCheck(options: CheckOptions, io: Io): Promise<ExitCode> {
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

  // Asked before the project is read, so a ref git does not know stops the run at once.
  const upfly = upflyCommand(io.env, io.script);
  const scope = options.changed === null ? null : changeScope(root, options, upfly);
  if (typeof scope === 'string') return stopWith(io, options, EXIT_CODES.USAGE, scope);

  const publicDirs = options.publicDirs ?? settings.publicDirs ?? null;
  const progress = progressReporter(io, 'check', options.json);
  const output = await runPipeline({
    root,
    servingRoots: servingRootsFor(
      publicDirs === null ? undefined : { dirs: publicDirs, declared: true },
    ),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: null,
    extraIgnores: [...(settings.exclude ?? []), ...options.exclude],
    onProgress: (event) => progress.update(event),
  });
  progress.clear();

  const unknown = output.audit.findings.find(
    (finding): finding is ServingRootUnknownFinding => finding.kind === 'serving-root-unknown',
  );
  if (unknown !== undefined && !output.servingRoots.declared) {
    return stopWith(
      io,
      options,
      EXIT_CODES.ABORTED,
      `Upfly could not work out where this project serves files from: ${unknown.linked} of ${unknown.checkable} root-relative references resolved, so the rest cannot be checked. Name the folder with --public <dir>, or publicDirs in the config file; use . for the project root. \`${upfly} audit\` lists the references that did not resolve.`,
      'SERVING_ROOT_UNKNOWN',
    );
  }
  // Told where the site is served from, the check does not ask again: what did not resolve
  // there is a finding, and one line says how little did.
  const fewResolved =
    unknown === undefined
      ? null
      : {
          folders: output.servingRoots.dirs.map((dir) => (dir === '' ? '.' : dir)),
          linked: unknown.linked,
          checkable: unknown.checkable,
          said: fewResolvedIn(unknown, output.servingRoots.dirs),
        };

  const verdict = judge(output, settings.check?.maxImageBytes ?? null, scope, unknown);
  const exitCode = verdict.findings.length === 0 ? EXIT_CODES.OK : EXIT_CODES.FINDINGS;
  if (options.json) {
    for (const diagnostic of output.scanDiagnostics) {
      emit(io, { type: 'diagnostic', command: 'check', source: 'parser', ...diagnostic });
    }
    emit(io, {
      type: 'result',
      command: 'check',
      exitCode,
      passed: exitCode === EXIT_CODES.OK,
      findings: verdict.findings,
      maxImageBytes: verdict.limit,
      changed: scope === null ? null : { against: scope.against, files: scope.paths.size },
      leftOut: verdict.leftOut,
      unusedOverLimit: verdict.unusedOverLimit,
      unchecked: verdict.unchecked,
      ...(verdict.unread === 0 ? {} : { unread: verdict.unread }),
      ...(fewResolved === null
        ? {}
        : {
            fewResolved: {
              folders: fewResolved.folders,
              linked: fewResolved.linked,
              checkable: fewResolved.checkable,
            },
          }),
    });
  } else {
    const styles = stylesFor(io.stdout, io.env, options);
    io.stdout.write(
      spaced(render(verdict, scope, styles, fewResolved?.said ?? null, upfly).split('\n')),
    );
  }
  return exitCode;
}

/** The files `--changed` names, or why they cannot be known. */
function changeScope(
  root: string,
  options: CheckOptions,
  upfly: UpflyCommand,
): ChangeScope | string {
  const against = options.changed?.against ?? null;
  const changes = changedFiles(root, against);
  switch (changes.kind) {
    case 'no-git':
      return '--changed needs git to compare against, and git was not found on this computer. Run without --changed to check every file.';
    case 'not-a-repository':
      return `--changed needs a git repository to compare against, and ${options.dir} is not in a git repository. Run without --changed to check every file.`;
    case 'unknown-ref': {
      const folder =
        against !== null && isDirectory(resolve(against))
          ? ` \`${against}\` is a folder: to check the uncommitted changes in it, put the folder before --changed, as in \`${upfly} check ${against} --changed\`.`
          : ' Name a branch, tag or commit; a checkout that holds only the last commit has to fetch the branch first.';
      return `--changed: git knows no commit called \`${against}\` here (${changes.detail}).${folder}`;
    }
    case 'changes':
      return {
        against,
        paths: new Set(changes.paths),
        deletedNames: new Set(changes.deleted.map(nameOf)),
      };
  }
}

interface Verdict {
  readonly findings: readonly CheckFinding[];
  readonly limit: number | null;
  /** Findings `--changed` left out, since the change did not touch their files. */
  readonly leftOut: number;
  /** Images over the limit that no reference uses, which never fail the check. */
  readonly unusedOverLimit: number;
  /** References whose file Upfly cannot know, so they could not be checked. */
  readonly unchecked: number;
  /** Files an adapter claimed but could not read, so their references went unchecked. */
  readonly unread: number;
}

function judge(
  output: PipelineOutput,
  limit: number | null,
  scope: ChangeScope | null,
  unknown: ServingRootUnknownFinding | undefined,
): Verdict {
  const { root } = output.graph;
  const inScope = (path: string): boolean => scope === null || scope.paths.has(path);

  // The references a named folder did not resolve join the rest, in the audit's own order.
  const broken = [
    ...output.audit.findings.filter(
      (finding): finding is BrokenFinding => finding.kind === 'broken',
    ),
    ...(unknown?.suppressed ?? []).map((entry): BrokenFinding => ({ kind: 'broken', ...entry })),
  ].sort(byFileAndLine);
  const overLimit =
    limit === null ? [] : output.graph.assets.filter(({ asset }) => asset.bytes > limit);
  const tooLarge = overLimit
    .filter((node) => node.references.length > 0)
    .map(
      ({ asset }): TooLargeFinding => ({
        kind: 'too-large',
        asset: asset.relative,
        bytes: asset.bytes,
      }),
    );
  const all: CheckFinding[] = [...broken, ...tooLarge];

  // A change breaks a page it never touched by deleting or renaming the image the page names,
  // so a reference to a name the change deleted is kept wherever it sits.
  const findings = all.filter((finding) =>
    finding.kind === 'too-large'
      ? inScope(finding.asset)
      : inScope(projectPath(root, finding.file)) ||
        (scope?.deletedNames.has(nameOf(finding.rawPath)) ?? false),
  );
  const unchecked = [
    ...output.graph.byResolution.dynamic,
    ...output.graph.byResolution['unresolved-alias'],
  ].filter((reference) => inScope(projectPath(root, reference.file)));

  return {
    findings,
    limit,
    leftOut: all.length - findings.length,
    unusedOverLimit: overLimit.filter(
      (node) => node.references.length === 0 && inScope(node.asset.relative),
    ).length,
    unchecked: unchecked.length,
    unread: output.scanned.unscanned.filter((file) => inScope(file.relative)).length,
  };
}

/**
 * The verdict as text: the headline, the line that says whether it passed with how little
 * resolved under it when that was too little in a folder that was named, then the findings.
 * In a terminal the verdict's first word is a label, in red when it failed.
 */
function render(
  verdict: Verdict,
  scope: ChangeScope | null,
  styles: Styles,
  fewResolved: string | null,
  upfly: UpflyCommand,
): string {
  const broken = verdict.findings.filter((f): f is BrokenFinding => f.kind === 'broken');
  const tooLarge = verdict.findings.filter((f): f is TooLargeFinding => f.kind === 'too-large');
  const said = verdictLine(broken.length, tooLarge.length, verdict.limit);
  const [word = '', ...rest] = said.split(' ');
  const line = [verdict.findings.length === 0 ? styles.accent(word) : styles.red(word), ...rest];
  const sections = [
    headline(styles, 'check'),
    fewResolved === null
      ? line.join(' ')
      : `${line.join(' ')}\n${fewResolved.charAt(0).toUpperCase()}${fewResolved.slice(1)}.`,
  ];

  if (broken.length > 0) {
    sections.push(
      [
        styles.accent(`References to images that do not exist (${broken.length})`),
        ...broken.flatMap((finding) => [
          `    ${finding.where}  ${finding.rawPath}`,
          ...(finding.note === undefined ? [] : [`      ${finding.note}`]),
        ]),
      ].join('\n'),
    );
  }
  if (tooLarge.length > 0) {
    sections.push(
      [
        styles.accent(`Images in use larger than ${verdict.limit} bytes (${tooLarge.length})`),
        ...tooLarge.map((finding) => `    ${finding.asset}  ${formatBytes(finding.bytes)}`),
      ].join('\n'),
    );
  }

  const notes = notesFor(verdict, scope, upfly);
  if (notes.length > 0) sections.push(notes.map(styles.dim).join('\n'));
  return `${sections.join('\n\n')}\n`;
}

/** The one line that says whether the check passed and why. */
function verdictLine(broken: number, tooLarge: number, limit: number | null): string {
  const limitText = `check.maxImageBytes, ${limit} bytes`;
  if (broken === 0 && tooLarge === 0) {
    return limit === null
      ? 'Passed: no reference names a missing image.'
      : `Passed: no reference names a missing image, and no image in use is larger than ${limitText}.`;
  }
  const reasons: string[] = [];
  if (broken > 0) {
    reasons.push(
      `${count(broken, 'reference')} ${broken === 1 ? 'names' : 'name'} an image that does not exist`,
    );
  }
  if (tooLarge > 0) {
    reasons.push(
      `${count(tooLarge, 'image')} in use ${tooLarge === 1 ? 'is' : 'are'} larger than ${limitText}`,
    );
  }
  return `Failed: ${reasons.join(', and ')}.`;
}

/** What the verdict leaves out, each in a sentence, so nothing is skipped without a word. */
function notesFor(verdict: Verdict, scope: ChangeScope | null, upfly: UpflyCommand): string[] {
  return [
    scope === null ? null : changeNote(scope, verdict.leftOut),
    unusedNote(verdict.unusedOverLimit),
    unreadNote(verdict.unread, upfly),
    uncheckedNote(verdict.unchecked, upfly),
  ].filter((note): note is string => note !== null);
}

function changeNote(scope: ChangeScope, leftOut: number): string {
  const since = scope.against === null ? 'since the last commit' : `against ${scope.against}`;
  const left =
    leftOut === 0
      ? '.'
      : `; ${count(leftOut, 'finding')} in files this change did not touch ${leftOut === 1 ? 'was' : 'were'} left out.`;
  return `Checked the ${count(scope.paths.size, 'file')} changed ${since}${left}`;
}

function unusedNote(unused: number): string | null {
  if (unused === 0) return null;
  const one = unused === 1;
  return `${count(unused, 'image')} larger than the limit ${one ? 'is' : 'are'} not counted: no reference uses ${one ? 'it' : 'them'}, and an unused image never fails the check.`;
}

function unreadNote(unread: number, upfly: UpflyCommand): string | null {
  if (unread === 0) return null;
  const one = unread === 1;
  return `${count(unread, 'file')} could not be parsed or read, so no reference in ${one ? 'it' : 'them'} was checked; \`${upfly} audit\` names ${one ? 'it with the reason' : 'them with the reasons'}.`;
}

function uncheckedNote(unchecked: number, upfly: UpflyCommand): string | null {
  if (unchecked === 0) return null;
  const one = unchecked === 1;
  return `${count(unchecked, 'reference')} could not be checked, since Upfly cannot know which file ${one ? 'it names' : 'each names'}; \`${upfly} audit\` lists ${one ? 'it with the reason' : 'them with the reasons'}.`;
}

/** A path as the project names it: POSIX and relative to its root. */
function projectPath(root: string, path: string): string {
  return isAbsolute(path) ? relativePath(root, path) : path;
}

/** The file name a path ends in, decoded where it is percent-encoded, without `?` or `#`. */
function nameOf(path: string): string {
  const bare = path.replace(/[?#].*$/s, '');
  const name = bare.slice(Math.max(bare.lastIndexOf('/'), bare.lastIndexOf('\\')) + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
