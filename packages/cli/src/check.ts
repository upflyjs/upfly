/**
 * `upfly check`: an optional guard for continuous integration. By default it fails when a
 * reference names an image that does not exist, or an image in use is larger than the config
 * allows; `check.failOn` and `--fail-on` choose what fails, and `--warn` lists everything
 * without failing. It never fails because an image is unused: most projects hold some, and
 * a gate that fails on its first run is switched off. It reads no pixels and writes nothing.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  type BrokenFinding,
  type PipelineOutput,
  type ServingRootUnknownFinding,
  runPipeline,
  servingRootsFor,
} from 'upfly-core';
import {
  type PossiblyBrokenPath,
  type PossiblyBrokenPaths,
  byFileAndLine,
  fewResolvedIn,
  formatBytes,
  possiblyBrokenPaths,
  relativePath,
} from 'upfly-core/internal';
import type { CheckOptions } from './args.js';
import { isDirectory } from './audit.js';
import { CHECK_KINDS, type CheckKind, loadConfig } from './config.js';
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

/** What the check finds, listed whether or not its kind fails the check. */
export type CheckFinding = BrokenFinding | TooLargeFinding;

/** Where this run's list of what fails the check came from. */
type FailOnSource = 'default' | 'config' | 'flag' | 'warn';

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
 * @returns 0 when it passed, or under `--warn`; 1 when something of a kind that fails it was
 * found; 2 for a usage or configuration error; 3 when no folder was named and it could not tell
 * where the site is served from, or the config is another tool's
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
  const limit = settings.check?.maxImageBytes ?? null;
  const fails = failOnFor(options, settings.check?.failOn, limit);
  if (fails.kinds.includes('too-large') && limit === null) {
    return stopWith(
      io,
      options,
      EXIT_CODES.USAGE,
      '--fail-on too-large needs check.maxImageBytes in the config file, the largest an image in use may be',
    );
  }

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

  const listed = await possiblyBrokenPaths({
    graph: output.graph,
    readFile: (file) => readFile(file, 'utf8'),
  });
  const verdict = judge(output, { limit, fails, scope, unknown, listed });
  const exitCode = failingCount(verdict) === 0 ? EXIT_CODES.OK : EXIT_CODES.FINDINGS;
  if (options.json) {
    for (const diagnostic of output.scanDiagnostics) {
      emit(io, { type: 'diagnostic', command: 'check', source: 'parser', ...diagnostic });
    }
    emit(io, {
      type: 'result',
      command: 'check',
      exitCode,
      passed: exitCode === EXIT_CODES.OK,
      failOn: verdict.fails.kinds,
      findings: verdict.findings,
      possiblyBroken: {
        paths: verdict.possiblyBroken,
        leftOut: verdict.possiblyBrokenLeftOut,
        unlisted: verdict.unlisted,
      },
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

/** The kinds that fail this run, and what chose them. */
interface FailOn {
  readonly kinds: readonly CheckKind[];
  readonly source: FailOnSource;
}

/**
 * `--warn` first, then `--fail-on`, then the config's `check.failOn`; with none of them,
 * `broken`, and `too-large` when a limit is set, so a config that sets only the limit still
 * fails on it.
 */
function failOnFor(
  options: CheckOptions,
  configured: readonly CheckKind[] | undefined,
  limit: number | null,
): FailOn {
  if (options.warn) return { kinds: [], source: 'warn' };
  if (options.failOn !== null) return { kinds: options.failOn, source: 'flag' };
  if (configured !== undefined) return { kinds: configured, source: 'config' };
  return { kinds: limit === null ? ['broken'] : ['broken', 'too-large'], source: 'default' };
}

interface Verdict {
  readonly findings: readonly CheckFinding[];
  /** Image paths in code or data that name no file, listed apart from the findings. */
  readonly possiblyBroken: readonly PossiblyBrokenPath[];
  readonly fails: FailOn;
  readonly limit: number | null;
  /** Findings `--changed` left out, since the change did not touch their files. */
  readonly leftOut: number;
  /** Possibly broken paths `--changed` left out, the same way. */
  readonly possiblyBrokenLeftOut: number;
  /** Strings that name no file and do not start with `/`, counted, not listed. */
  readonly unlisted: number;
  /** Images over the limit that no reference uses, which never fail the check. */
  readonly unusedOverLimit: number;
  /** References whose file Upfly cannot know, so they could not be checked. */
  readonly unchecked: number;
  /** Files an adapter claimed but could not read, so their references went unchecked. */
  readonly unread: number;
}

/** How many of what was found are of a kind that fails this run. */
function failingCount(verdict: Verdict): number {
  return (
    verdict.findings.filter((finding) => verdict.fails.kinds.includes(finding.kind)).length +
    (verdict.fails.kinds.includes('possibly-broken') ? verdict.possiblyBroken.length : 0)
  );
}

interface Judged {
  readonly limit: number | null;
  readonly fails: FailOn;
  readonly scope: ChangeScope | null;
  readonly unknown: ServingRootUnknownFinding | undefined;
  readonly listed: PossiblyBrokenPaths;
}

function judge(output: PipelineOutput, judged: Judged): Verdict {
  const { limit, scope, unknown, listed } = judged;
  const { root } = output.graph;
  const inScope = (path: string): boolean => scope === null || scope.paths.has(path);
  // A change breaks a page it never touched by deleting or renaming the image the page names,
  // so a path naming a file the change deleted is kept wherever it sits.
  const kept = (file: string, rawPath: string): boolean =>
    inScope(projectPath(root, file)) || (scope?.deletedNames.has(nameOf(rawPath)) ?? false);

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

  const findings = all.filter((finding) =>
    finding.kind === 'too-large' ? inScope(finding.asset) : kept(finding.file, finding.rawPath),
  );
  const possiblyBroken = listed.paths.filter((path) => kept(path.file, path.rawPath));
  const unchecked = [
    ...output.graph.byResolution.dynamic,
    ...output.graph.byResolution['unresolved-alias'],
  ].filter((reference) => inScope(projectPath(root, reference.file)));

  return {
    findings,
    possiblyBroken,
    fails: judged.fails,
    limit,
    leftOut: all.length - findings.length,
    possiblyBrokenLeftOut: listed.paths.length - possiblyBroken.length,
    unlisted: listed.unlisted.filter((entry) => kept(entry.file, entry.rawPath)).length,
    unusedOverLimit: overLimit.filter(
      (node) => node.references.length === 0 && inScope(node.asset.relative),
    ).length,
    unchecked: unchecked.length,
    unread: output.scanned.unscanned.filter((file) => inScope(file.relative)).length,
  };
}

/**
 * The verdict as text: the headline, the line that says whether it passed with how little
 * resolved under it when that was too little in a folder that was named, then the findings,
 * then the possibly broken paths. In a terminal the verdict's first word is a label, in red
 * when it failed.
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
  const [word = '', ...rest] = verdictLine(verdict).split(' ');
  const line = [failingCount(verdict) === 0 ? styles.accent(word) : styles.red(word), ...rest];
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
        ...broken.flatMap((finding) => cited(finding)),
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
  if (verdict.possiblyBroken.length > 0) {
    sections.push(
      [
        styles.accent(
          `Possibly broken: image paths in code or data that name no file (${verdict.possiblyBroken.length})`,
        ),
        ...verdict.possiblyBroken.flatMap((path) => cited(path)),
      ].join('\n'),
    );
  }

  const notes = notesFor(verdict, scope, upfly);
  if (notes.length > 0) sections.push(notes.map(styles.dim).join('\n'));
  return `${sections.join('\n\n')}\n`;
}

/** A path where it is written, with what more is known about it on the line below. */
function cited(path: {
  readonly where: string;
  readonly rawPath: string;
  readonly note?: string;
}): string[] {
  return [
    `    ${path.where}  ${path.rawPath}`,
    ...(path.note === undefined ? [] : [`      ${path.note}`]),
  ];
}

/**
 * The one line that says whether the check passed and why: what failed it; or, when nothing
 * did, what was found that the kinds failing this run leave out; or what held.
 */
function verdictLine(verdict: Verdict): string {
  const found: Record<CheckKind, number> = {
    broken: verdict.findings.filter((finding) => finding.kind === 'broken').length,
    'too-large': verdict.findings.filter((finding) => finding.kind === 'too-large').length,
    'possibly-broken': verdict.possiblyBroken.length,
  };
  const { kinds, source } = verdict.fails;
  const said = (list: readonly CheckKind[]) =>
    clauses(list.map((kind) => foundClause(kind, found[kind], verdict.limit)));

  const failing = CHECK_KINDS.filter((kind) => kinds.includes(kind) && found[kind] > 0);
  if (failing.length > 0) return `Failed: ${said(failing)}.`;

  // A path in code or data is listed apart by design, so only a finding that would fail by
  // default turns the line into a warning.
  const quiet = CHECK_KINDS.filter((kind) => kind !== 'possibly-broken' && found[kind] > 0);
  if (quiet.length > 0) {
    if (source === 'warn') return `Warning: ${said(quiet)}. --warn keeps the exit code at 0.`;
    const one = quiet.length === 1 && found[quiet[0] as CheckKind] === 1;
    return `Warning: ${said(quiet)}; ${source === 'flag' ? '--fail-on' : 'check.failOn'} does not name ${quiet.join(' or ')}, so ${one ? 'it does' : 'they do'} not fail the check.`;
  }

  return `Passed: ${clauses([
    'no reference names a missing image',
    ...(verdict.limit === null
      ? []
      : [`no image in use is larger than check.maxImageBytes, ${verdict.limit} bytes`]),
    ...(kinds.includes('possibly-broken') ? ['no path in code or data names a missing image'] : []),
  ])}.`;
}

/** What was found of one kind, in words. */
function foundClause(kind: CheckKind, found: number, limit: number | null): string {
  const one = found === 1;
  switch (kind) {
    case 'broken':
      return `${count(found, 'reference')} ${one ? 'names' : 'name'} an image that does not exist`;
    case 'too-large':
      return `${count(found, 'image')} in use ${one ? 'is' : 'are'} larger than check.maxImageBytes, ${limit} bytes`;
    case 'possibly-broken':
      return `${count(found, 'image path')} in code or data ${one ? 'names' : 'name'} no file`;
  }
}

/** Clauses joined as a sentence lists them: `a`, `a, and b`, `a, b, and c`. */
function clauses(parts: readonly string[]): string {
  return parts.length <= 1
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/** What the verdict leaves out, each in a sentence, so nothing is skipped without a word. */
function notesFor(verdict: Verdict, scope: ChangeScope | null, upfly: UpflyCommand): string[] {
  return [
    scope === null ? null : changeNote(scope, verdict),
    possiblyBrokenNote(verdict),
    unlistedNote(verdict, upfly),
    unusedNote(verdict.unusedOverLimit),
    unreadNote(verdict.unread, upfly),
    uncheckedNote(verdict.unchecked, upfly),
  ].filter((note): note is string => note !== null);
}

function changeNote(scope: ChangeScope, verdict: Verdict): string {
  const since = scope.against === null ? 'since the last commit' : `against ${scope.against}`;
  const { leftOut, possiblyBrokenLeftOut } = verdict;
  const parts = [
    ...(leftOut === 0 ? [] : [count(leftOut, 'finding')]),
    ...(possiblyBrokenLeftOut === 0 ? [] : [count(possiblyBrokenLeftOut, 'possibly broken path')]),
  ];
  const left =
    parts.length === 0
      ? '.'
      : `; ${parts.join(' and ')} in files this change did not touch ${leftOut + possiblyBrokenLeftOut === 1 ? 'was' : 'were'} left out.`;
  return `Checked the ${count(scope.paths.size, 'file')} changed ${since}${left}`;
}

function possiblyBrokenNote(verdict: Verdict): string | null {
  if (verdict.possiblyBroken.length === 0) return null;
  const what =
    'A possibly broken path is a string Upfly does not read as a reference: a page that shows it shows no image, but Upfly cannot tell whether a page does.';
  return verdict.fails.kinds.includes('possibly-broken')
    ? what
    : `${what} Such paths fail the check only when check.failOn or --fail-on names possibly-broken.`;
}

function unlistedNote(verdict: Verdict, upfly: UpflyCommand): string | null {
  const { unlisted } = verdict;
  if (unlisted === 0) return null;
  const more = verdict.possiblyBroken.length === 0 ? '' : 'more ';
  return unlisted === 1
    ? `1 ${more}string ends in an image extension and names no file, but does not start with / as a path on the site does; \`${upfly} audit --include-discarded\` lists it.`
    : `${unlisted} ${more}strings end in an image extension and name no file, but do not start with / as a path on the site does; \`${upfly} audit --include-discarded\` lists them.`;
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
