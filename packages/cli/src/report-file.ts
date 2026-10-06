/**
 * The report file each of `audit`, `optimize`, `dedupe` and `move` writes in Upfly's own folder, named
 * after the command, so the terminal can show a summary. The folder's `.gitignore` is written
 * before anything else in it, so a report never shows as a change in git and never stops a
 * later `optimize --apply` as one.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPFLY_DIRECTORY } from 'upfly-core/internal';
import {
  type AuditOptions,
  DEFAULT_MAX_ENCODES,
  type DedupeOptions,
  type MoveOptions,
  type OptimizeOptions,
} from './args.js';
import { type Summary, renderSection, renderSummary, spaced } from './layout.js';
import { type Io, stylesFor } from './output.js';

/** A command that writes a report file of its own. */
export type ReportCommand = 'audit' | 'optimize' | 'dedupe' | 'move';

/**
 * Where a command's report file is kept, relative to the project: `.upfly/audit.txt`,
 * `.upfly/optimize.txt`, `.upfly/dedupe.txt` or `.upfly/move.txt`.
 */
export function reportPath(command: ReportCommand): string {
  return `${UPFLY_DIRECTORY}/${command}.txt`;
}

/** The report file as written, or why it could not be. */
export type ReportFile = { readonly written: string } | { readonly failed: string };

/**
 * Writes a command's report file, replacing its last one, and for an applied run a copy into
 * that run's own folder, which stays until a later applied run replaces it.
 *
 * @param root the project directory
 * @param command the command, which names the file
 * @param text the file's text
 * @param runDir the applied run's folder relative to the project, such as
 *   `.upfly/runs/<id>`, or null for a run that wrote nothing
 * @returns the path written, or the reason it could not be: a read-only folder must not stop
 *   a command whose real work is done
 */
export function writeReport(
  root: string,
  command: ReportCommand,
  text: string,
  runDir: string | null,
): ReportFile {
  try {
    mkdirSync(join(root, UPFLY_DIRECTORY), { recursive: true });
    writeIgnoreFile(root);
    writeFileSync(join(root, reportPath(command)), text);
    if (runDir !== null) {
      mkdirSync(join(root, runDir), { recursive: true });
      writeFileSync(join(root, runDir, `${command}.txt`), text);
    }
    return { written: reportPath(command) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { failed: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Says so on stderr when `--full` printed the text but it could not be kept as well, since
 * the file would then still hold an earlier run's text.
 */
export function warnIfNotKept(
  io: Pick<Io, 'stderr'>,
  command: ReportCommand,
  file: ReportFile,
): void {
  if ('failed' in file) {
    io.stderr.write(
      `The full text could not be kept in ${reportPath(command)} (${file.failed}).\n`,
    );
  }
}

/**
 * A date and time as a report file's first lines give it: local time, to the minute, written
 * without the locale's help so it reads the same on every machine.
 *
 * @example localTime(new Date(2026, 9, 2, 19, 42)) // "2026-10-02 19:42"
 */
export function localTime(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * The options a run was given, as they would be typed after the folder: what the report
 * file's first lines name, so a reader can run the same command again.
 */
export function typedOptions(
  options: AuditOptions | OptimizeOptions | DedupeOptions | MoveOptions,
): string[] {
  const scope = [
    ...(options.publicDirs ?? []).flatMap((dir) => ['--public', dir === '' ? '.' : dir]),
    ...options.exclude.flatMap((pattern) => ['--exclude', pattern]),
  ];
  const flags = (pairs: readonly (readonly [boolean, string])[]) =>
    pairs.flatMap(([on, word]) => (on ? [word] : []));
  if (options.command === 'audit') {
    const measured = !options.probe
      ? ['--no-probe']
      : options.maxEncodes === null
        ? ['--probe-all']
        : options.maxEncodes === DEFAULT_MAX_ENCODES
          ? []
          : ['--max-encodes', String(options.maxEncodes)];
    return [...scope, ...measured, ...flags(listFlags(options))];
  }
  const writes = flags([
    [options.apply, '--apply'],
    [options.commit, '--commit'],
    [options.allowDirty, '--allow-dirty'],
  ]);
  if (options.command === 'dedupe') {
    return [...scope, ...options.keep.flatMap((path) => ['--keep', path]), ...writes];
  }
  if (options.command === 'move') return [options.from, options.to, ...scope, ...writes];
  return [
    ...scope,
    ...flags([
      [options.policy === 'keep-original', '--keep-originals'],
      [options.policy === 'replace', '--replace'],
    ]),
    ...(options.format === null ? [] : ['--format', options.format]),
    ...(options.only ?? []).flatMap((pattern) => ['--only', pattern]),
    ...writes,
    ...flags([[options.includeDeclined, '--include-declined'], ...listFlags(options)]),
  ];
}

/** The flags that add a list to the report, as each was given. */
function listFlags(options: AuditOptions | OptimizeOptions): (readonly [boolean, string])[] {
  return [
    [options.includeDiscarded, '--include-discarded'],
    [options.includeUnusedSvg, '--include-unused-svg'],
  ];
}

/**
 * Prints what the run asked for: the report file's text under `--full`, one row and its list
 * under `--show`, and otherwise the summary.
 *
 * @param summary the run's summary, naming the file as it was written
 * @param text the report file's text
 * @param file the file as written, or why it could not be
 */
export function printRun(
  io: Io,
  options: AuditOptions | OptimizeOptions | DedupeOptions | MoveOptions,
  summary: Summary,
  text: string,
  file: ReportFile,
): void {
  if (options.full) {
    io.stdout.write(spaced(text.split('\n')));
    warnIfNotKept(io, options.command, file);
  } else if (options.show !== null) {
    io.stdout.write(
      renderSection(summary, options.show) ??
        spaced([`  This run has nothing under ${options.show}.`]),
    );
  } else {
    io.stdout.write(renderSummary(summary, stylesFor(io.stdout, io.env, options)));
  }
}

/** The same file an applied run writes, and like it, left alone when it is already there. */
function writeIgnoreFile(root: string): void {
  try {
    writeFileSync(join(root, UPFLY_DIRECTORY, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
