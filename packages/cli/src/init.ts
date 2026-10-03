/**
 * `upfly init`: a starting `upfly.config.json`, holding the folders the engine would work out
 * for itself, so a user can read them and correct them. It never changes a configuration file
 * that already exists.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPipeline } from 'upfly-core';
import {
  type DiscoveryResult,
  PROJECT_MARKERS,
  type ServingRootDecision,
  decideServingRoots,
} from 'upfly-core/internal';
import type { InitOptions } from './args.js';
import { isDirectory } from './audit.js';
import { CONFIG_FILES, CONFIG_SCHEMA, loadConfig } from './config.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { headline, spaced } from './layout.js';
import { type Io, type Styles, emit, progressReporter, stopWith, stylesFor } from './output.js';

/** The file `init` writes. */
const FILE = 'upfly.config.json';

/** One setting `init` wrote, or left out, and why. */
export interface Reason {
  readonly setting: 'publicDirs' | 'format';
  /** The folder or format written; null when the setting was left out. */
  readonly value: string | null;
  readonly why: string;
}

/**
 * Writes `upfly.config.json` in the project, unless a configuration file is already there.
 *
 * @param options the parsed command line
 * @param io the streams and environment to use
 * @returns 0 when the file was written; 2 when the folder does not exist; 3 when a
 * configuration file already exists
 */
export async function runInit(options: InitOptions, io: Io): Promise<ExitCode> {
  const root = resolve(options.dir);
  if (!isDirectory(root)) {
    return stopWith(io, options, EXIT_CODES.USAGE, `${options.dir} is not a directory`);
  }
  const existing = CONFIG_FILES.filter((file) => existsSync(join(root, file)));
  if (existing.length > 0) {
    return stopWith(
      io,
      options,
      EXIT_CODES.ABORTED,
      await existsMessage(root, existing),
      'CONFIG_EXISTS',
    );
  }

  // The same decision every command makes when no folder is declared, kept whole for its reasons.
  const captured: { decision?: ServingRootDecision } = {};
  const progress = progressReporter(io, 'init', options.json);
  const output = await runPipeline({
    root,
    servingRoots: (discovery, scanned) => {
      const decision = decideServingRoots({
        root: discovery.root,
        directories: discovery.directories,
        assets: discovery.assets,
        sourceFiles: discovery.sourceFiles,
        unscannedFiles: discovery.unscannedFiles,
        references: scanned.references,
      });
      captured.decision = decision;
      return decision.servingRoots;
    },
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: null,
    onProgress: (event) => progress.update(event),
  });
  progress.clear();
  const decision = captured.decision;
  if (decision === undefined) throw new Error('the serving roots were never decided');

  const dirs = decision.servingRoots.dirs.map((dir) => (dir === '' ? '.' : dir));
  const config = {
    $schema: CONFIG_SCHEMA,
    ...(dirs.length === 0 ? {} : { publicDirs: dirs }),
    format: 'webp',
  };
  const reasons = [...folderReasons(decision, output.discovery), FORMAT_REASON];
  const text = `${JSON.stringify(config, null, 2)}\n`;
  try {
    // `wx` fails rather than overwrite a file that appeared while the project was read.
    writeFileSync(join(root, FILE), text, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return stopWith(
      io,
      options,
      EXIT_CODES.ABORTED,
      await existsMessage(root, [FILE]),
      'CONFIG_EXISTS',
    );
  }

  if (options.json) {
    emit(io, {
      type: 'result',
      command: 'init',
      exitCode: EXIT_CODES.OK,
      file: FILE,
      config,
      reasons,
      ...(decision.inferred.ties.length === 0 ? {} : { ties: decision.inferred.ties }),
    });
  } else {
    const styles = stylesFor(io.stdout, io.env, options);
    io.stdout.write(spaced(render(text, reasons, decision, styles).split('\n')));
  }
  return EXIT_CODES.OK;
}

const FORMAT_REASON: Reason = {
  setting: 'format',
  value: 'webp',
  why: 'the default; "avif" is the other choice, which some older browsers cannot show',
};

/** Why the files already there stop `init`, and what to do instead. */
async function existsMessage(root: string, files: readonly string[]): Promise<string> {
  const named =
    files.length === 1 ? `${files[0]} already exists` : `${files.join(' and ')} already exist`;
  // Only the JSON form is read, and without running anything: a code config is left unloaded.
  if (files.length === 1 && files[0] === FILE && (await loadConfig(root)).kind === 'refused') {
    return `${named}, and holds the settings of the Upfly VS Code extension (v2), which init leaves alone. To configure this CLI, create upfly.config.ts beside it, which Upfly reads instead.`;
  }
  return `${named}, and init never changes a configuration file. Edit it instead.`;
}

/** Why each folder was chosen, or why none was written. */
function folderReasons(decision: ServingRootDecision, discovery: DiscoveryResult): Reason[] {
  const dirs = decision.servingRoots.dirs;
  if (dirs.length === 0) {
    return [
      {
        setting: 'publicDirs',
        value: null,
        why: 'left out, since no folder was found that the site is served from, so each run works it out again; if the site is served from this folder itself, add "publicDirs": ["."]',
      },
    ];
  }
  const entries = walkedPaths(discovery);
  return dirs.map((dir) => ({
    setting: 'publicDirs',
    value: dir === '' ? '.' : dir,
    why: decision.detected.includes(dir) ? detectedWhy(dir, entries) : inferredWhy(dir, decision),
  }));
}

function detectedWhy(dir: string, entries: ReadonlySet<string>): string {
  const slash = dir.lastIndexOf('/');
  const parent = slash === -1 ? '' : dir.slice(0, slash);
  const name = dir.slice(slash + 1);
  const marker = PROJECT_MARKERS.map((file) => (parent === '' ? file : `${parent}/${file}`)).find(
    (path) => entries.has(path),
  );
  return `a folder named ${name} beside ${marker ?? 'a project file'}, where a site built with a framework serves files from`;
}

function inferredWhy(dir: string, decision: ServingRootDecision): string {
  const score = decision.inferred.evidence.find((candidate) => candidate.dir === dir);
  return score === undefined
    ? 'root-relative image paths resolve to images under it'
    : `${score.resolved} of ${score.attempted} root-relative image paths tested against it resolve to an image under it`;
}

/** Every path the walk saw, folders and files, where a project file is looked up. */
function walkedPaths(discovery: DiscoveryResult): ReadonlySet<string> {
  const paths = new Set<string>(discovery.directories);
  for (const list of [discovery.assets, discovery.sourceFiles, discovery.unscannedFiles]) {
    for (const file of list) paths.add(file.relative);
  }
  return paths;
}

function render(
  text: string,
  reasons: readonly Reason[],
  decision: ServingRootDecision,
  styles: Styles,
): string {
  const why = reasons.map((reason) =>
    reason.setting === 'publicDirs' && reason.value !== null
      ? `  ${reason.value}: ${reason.why}`
      : `  ${reason.setting}: ${reason.value === null ? '' : `${reason.value}, `}${reason.why}`,
  );
  const ties = decision.inferred.ties.map(
    ({ dir, candidates }) =>
      `  not written: ${candidates.join(' and ')} resolve the root-relative paths under ${dir === '' ? 'the project' : dir} equally well, so Upfly could not choose; add the right one to publicDirs`,
  );
  return [
    headline(styles, 'init'),
    '',
    `${styles.accent('Wrote')} ${FILE}:`,
    '',
    ...text
      .trimEnd()
      .split('\n')
      .map((line) => `  ${line}`),
    '',
    styles.accent('Why:'),
    ...why,
    ...ties,
    '',
    'Every Upfly command in this folder now reads it. Edit it to change what Upfly treats as the site.',
    '',
  ].join('\n');
}
