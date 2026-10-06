/**
 * The command line, parsed into what each command needs. Unknown flags are an error, so a
 * typo is never read as a silently ignored option, and so is a flag that would change
 * nothing in the run it was given to.
 */

import { parseArgs } from 'node:util';
import { normaliseServedDir } from './config.js';
import type { UpflyCommand } from './invocation.js';

export type CommandName =
  | 'audit'
  | 'optimize'
  | 'undo'
  | 'check'
  | 'init'
  | 'refs'
  | 'dedupe'
  | 'move';

export interface CommonOptions {
  /** The project directory, as given; the current directory when none is. */
  readonly dir: string;
  /** One JSON object per line on stdout: progress, then the result. */
  readonly json: boolean;
  /** `--no-color`; the environment is consulted separately. */
  readonly noColor: boolean;
}

export interface ScopeOptions {
  /** Served folders from `--public`, or `null` when none was given. */
  readonly publicDirs: readonly string[] | null;
  /** Patterns from `--exclude`, added to the config's and `.upflyignore`'s. */
  readonly exclude: readonly string[];
}

export interface ReportOptions {
  /** `--full`: print the full text rather than the summary. */
  readonly full: boolean;
  /** `--show <row>`: print that row of the summary with its complete list, or null. */
  readonly show: string | null;
  /** `--include-discarded`: list the path-like strings that linked nothing. */
  readonly includeDiscarded: boolean;
  /** `--include-unused-svg`: list the unused SVG files the report otherwise only counts. */
  readonly includeUnusedSvg: boolean;
}

export interface AuditOptions extends CommonOptions, ScopeOptions, ReportOptions {
  readonly command: 'audit';
  /** `false` for `--no-probe`: no header reads and no encodes. */
  readonly probe: boolean;
  /** How many images to measure by encoding; `null` is every one (`--probe-all`). */
  readonly maxEncodes: number | null;
}

export interface OptimizeOptions extends CommonOptions, ScopeOptions, ReportOptions {
  readonly command: 'optimize';
  /** `--apply`: write the plan. Without it the run only reports what it would do. */
  readonly apply: boolean;
  /** `--commit`: commit the files the run wrote, and nothing else, as one commit. */
  readonly commit: boolean;
  /**
   * What happens to each original, as a flag named it: `keep-original` for
   * `--keep-originals`, `replace` for `--replace`, or `null` for the config's policy or the
   * default, which removes each original once every reference to it has moved.
   */
  readonly policy: 'keep-original' | 'replace' | null;
  /** `--format`, or `null` for the config's format or the default. */
  readonly format: 'webp' | 'avif' | null;
  /** `--allow-dirty`: apply over uncommitted changes, or where git cannot help. */
  readonly allowDirty: boolean;
  /** `--include-declined`: list each image the plan examined and did not convert. */
  readonly includeDeclined: boolean;
  /** Patterns from `--only`, in `.gitignore` syntax, or `null` when every image may convert. */
  readonly only: readonly string[] | null;
}

export interface UndoOptions extends CommonOptions {
  readonly command: 'undo';
}

export interface CheckOptions extends CommonOptions, ScopeOptions {
  readonly command: 'check';
  /**
   * `--changed`: keep only the findings a change could have caused. `against` is the git ref
   * the change is measured from, or `null` for the uncommitted changes. `null` without the flag.
   */
  readonly changed: { readonly against: string | null } | null;
}

export interface InitOptions extends CommonOptions {
  readonly command: 'init';
}

export interface DedupeOptions extends CommonOptions, ScopeOptions {
  readonly command: 'dedupe';
  /** `--full`: print the full text rather than the summary. */
  readonly full: boolean;
  /** `--show <row>`: print that row of the summary with its complete list, or null. */
  readonly show: string | null;
  /** `--apply`: write the plan. Without it the run only reports what it would do. */
  readonly apply: boolean;
  /** `--commit`: commit the files the run wrote, and nothing else, as one commit. */
  readonly commit: boolean;
  /** `--allow-dirty`: apply over uncommitted changes, or where git cannot help. */
  readonly allowDirty: boolean;
  /** Copies to keep from `--keep`, as POSIX paths relative to the project. */
  readonly keep: readonly string[];
}

export interface RefsOptions extends CommonOptions, ScopeOptions {
  readonly command: 'refs';
  /** The image to answer for, as the user wrote it: resolved from the current folder. */
  readonly image: string;
}

export interface MoveOptions extends CommonOptions, ScopeOptions {
  readonly command: 'move';
  /** The image or folder to move, as the user wrote it: resolved from the current folder. */
  readonly from: string;
  /** Where it goes, as the user wrote it; a folder, or a path ending in a slash, takes it in. */
  readonly to: string;
  /** `--full`: print the full text rather than the summary. */
  readonly full: boolean;
  /** `--show <row>`: print that row of the summary with its complete list, or null. */
  readonly show: string | null;
  /** `--apply`: write the plan. Without it the run only reports what it would do. */
  readonly apply: boolean;
  /** `--commit`: commit the files the run wrote, and nothing else, as one commit. */
  readonly commit: boolean;
  /** `--allow-dirty`: apply over uncommitted changes, or where git cannot help. */
  readonly allowDirty: boolean;
}

export type CommandOptions =
  | AuditOptions
  | OptimizeOptions
  | UndoOptions
  | CheckOptions
  | InitOptions
  | RefsOptions
  | DedupeOptions
  | MoveOptions;

export type Parsed =
  | { readonly kind: 'run'; readonly options: CommandOptions }
  | { readonly kind: 'help'; readonly command: CommandName | null }
  | { readonly kind: 'version' }
  | {
      readonly kind: 'usage-error';
      readonly message: string;
      readonly command: CommandName | null;
    };

/**
 * The number of images `audit` measures by encoding when nobody says. Encoding runs largest
 * first, so the first hundred hold most of the bytes worth recovering.
 */
export const DEFAULT_MAX_ENCODES = 100;

/** The rows `--show` prints, for each command that has a summary, as its rows are named. */
export const SHOWN_ROWS: Readonly<
  Record<'audit' | 'optimize' | 'dedupe' | 'move', readonly string[]>
> = {
  audit: ['references', 'savings', 'broken', 'unused', 'oversized', 'copies', 'skipped'],
  optimize: ['convert', 'update', 'leave'],
  dedupe: ['sets', 'update', 'leave', 'unused'],
  move: ['move', 'update', 'leave', 'unfollowed', 'refused'],
};

const COMMANDS: readonly CommandName[] = [
  'audit',
  'optimize',
  'undo',
  'check',
  'init',
  'refs',
  'dedupe',
  'move',
];

const COMMON = {
  json: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const SCOPE = {
  public: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
} as const;

const REPORT = {
  full: { type: 'boolean' },
  show: { type: 'string' },
  'include-discarded': { type: 'boolean' },
  'include-unused-svg': { type: 'boolean' },
} as const;

const AUDIT = {
  ...COMMON,
  ...SCOPE,
  ...REPORT,
  'no-probe': { type: 'boolean' },
  'max-encodes': { type: 'string' },
  'probe-all': { type: 'boolean' },
} as const;

const OPTIMIZE = {
  ...COMMON,
  ...SCOPE,
  ...REPORT,
  apply: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  commit: { type: 'boolean' },
  replace: { type: 'boolean' },
  'keep-originals': { type: 'boolean' },
  format: { type: 'string' },
  'allow-dirty': { type: 'boolean' },
  'include-declined': { type: 'boolean' },
  only: { type: 'string', multiple: true },
} as const;

const CHECK = {
  ...COMMON,
  ...SCOPE,
  changed: { type: 'string' },
} as const;

const REFS = { ...COMMON, ...SCOPE } as const;

const DEDUPE = {
  ...COMMON,
  ...SCOPE,
  apply: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  commit: { type: 'boolean' },
  'allow-dirty': { type: 'boolean' },
  keep: { type: 'string', multiple: true },
  full: { type: 'boolean' },
  show: { type: 'string' },
} as const;

const MOVE = {
  ...COMMON,
  ...SCOPE,
  apply: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  commit: { type: 'boolean' },
  'allow-dirty': { type: 'boolean' },
  full: { type: 'boolean' },
  show: { type: 'string' },
} as const;

/**
 * Parses `argv`, the arguments after `upfly`.
 *
 * @param argv the process arguments without the node binary and the script path
 */
export function parseCommandLine(
  argv: readonly string[],
  upfly: UpflyCommand = 'npx upfly',
): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    return { kind: 'help', command: null };
  }
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (!(COMMANDS as readonly string[]).includes(first)) {
    return {
      kind: 'usage-error',
      command: null,
      message: first.startsWith('-')
        ? `${first} needs a command before it, such as \`${upfly} audit ${first}\``
        : `unknown command \`${first}\``,
    };
  }
  const command = first as CommandName;
  if (command === 'audit') return parseAudit(rest);
  if (command === 'optimize') return parseOptimize(rest);
  if (command === 'check') return parseCheck(rest);
  if (command === 'refs') return parseRefs(rest, upfly);
  if (command === 'dedupe') return parseDedupe(rest);
  if (command === 'move') return parseMove(rest, upfly);
  return parseCommonOnly(command, rest);
}

function parseDedupe(args: readonly string[]): Parsed {
  const command = 'dedupe';
  let parsed: ReturnType<typeof parseDedupeArgs>;
  try {
    parsed = parseDedupeArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const dir = directoryOf(positionals);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  const apply = values.apply === true;
  const commit = values.commit === true;
  const allowDirty = values['allow-dirty'] === true;
  const conflict =
    dryRunConflict(values['dry-run'], apply) ??
    writeFlagConflict(apply, commit, allowDirty) ??
    fullConflict(values.full, values.json) ??
    showConflict(command, values.show, values.full, values.json);
  if (conflict !== null) return { kind: 'usage-error', command, message: conflict };
  return {
    kind: 'run',
    options: {
      command,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
      full: values.full === true,
      show: values.show ?? null,
      apply,
      commit,
      allowDirty,
      keep: (values.keep ?? []).map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '')),
      ...scope,
    },
  };
}

function parseDedupeArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: DEDUPE, allowPositionals: true, strict: true });
}

function parseMove(args: readonly string[], upfly: UpflyCommand): Parsed {
  const command = 'move';
  let parsed: ReturnType<typeof parseMoveArgs>;
  try {
    parsed = parseMoveArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const [from, to, ...rest] = positionals;
  if (from === undefined || to === undefined) {
    return {
      kind: 'usage-error',
      command,
      message: `move needs the image or folder to move and where it goes, such as \`${upfly} move public/hero.png public/img/hero.png\``,
    };
  }
  const dir = directoryOf(rest);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  const apply = values.apply === true;
  const commit = values.commit === true;
  const allowDirty = values['allow-dirty'] === true;
  const conflict =
    dryRunConflict(values['dry-run'], apply) ??
    writeFlagConflict(apply, commit, allowDirty) ??
    fullConflict(values.full, values.json) ??
    showConflict(command, values.show, values.full, values.json);
  if (conflict !== null) return { kind: 'usage-error', command, message: conflict };
  return {
    kind: 'run',
    options: {
      command,
      from,
      to,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
      full: values.full === true,
      show: values.show ?? null,
      apply,
      commit,
      allowDirty,
      ...scope,
    },
  };
}

function parseMoveArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: MOVE, allowPositionals: true, strict: true });
}

function parseRefs(args: readonly string[], upfly: UpflyCommand): Parsed {
  const command = 'refs';
  let parsed: ReturnType<typeof parseRefsArgs>;
  try {
    parsed = parseRefsArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const [image, ...rest] = positionals;
  if (image === undefined) {
    return {
      kind: 'usage-error',
      command,
      message: `refs needs the path of an image, such as \`${upfly} refs public/hero.png\``,
    };
  }
  const dir = directoryOf(rest);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  return {
    kind: 'run',
    options: {
      command,
      image,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
      ...scope,
    },
  };
}

function parseRefsArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: REFS, allowPositionals: true, strict: true });
}

function parseCheck(args: readonly string[]): Parsed {
  const command = 'check';
  let parsed: ReturnType<typeof parseCheckArgs>;
  try {
    parsed = parseCheckArgs(withChangedValue(args));
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const dir = directoryOf(positionals);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  const changed = values.changed;

  return {
    kind: 'run',
    options: {
      command,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
      changed: changed === undefined ? null : { against: changed === '' ? null : changed },
      ...scope,
    },
  };
}

function parseCheckArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: CHECK, allowPositionals: true, strict: true });
}

/**
 * `--changed` takes a ref or nothing, and the parser only knows options that always take a
 * value, so a `--changed` with no ref after it is given an empty one.
 */
function withChangedValue(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    const next = args[index + 1];
    return arg === '--changed' && (next === undefined || next.startsWith('-')) ? '--changed=' : arg;
  });
}

function parseAudit(args: readonly string[]): Parsed {
  const command = 'audit';
  let parsed: ReturnType<typeof parseAuditArgs>;
  try {
    parsed = parseAuditArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const dir = directoryOf(positionals);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  const maxEncodes = maxEncodesOf(values);
  if (typeof maxEncodes === 'string') return { kind: 'usage-error', command, message: maxEncodes };
  const conflict =
    fullConflict(values.full, values.json) ??
    showConflict(command, values.show, values.full, values.json);
  if (conflict !== null) return { kind: 'usage-error', command, message: conflict };

  return {
    kind: 'run',
    options: {
      command,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
      probe: values['no-probe'] !== true,
      maxEncodes,
      full: values.full === true,
      show: values.show ?? null,
      includeDiscarded: values['include-discarded'] === true,
      includeUnusedSvg: values['include-unused-svg'] === true,
      ...scope,
    },
  };
}

function parseAuditArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: AUDIT, allowPositionals: true, strict: true });
}

function parseOptimize(args: readonly string[]): Parsed {
  const command = 'optimize';
  let parsed: ReturnType<typeof parseOptimizeArgs>;
  try {
    parsed = parseOptimizeArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const dir = directoryOf(positionals);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  const scope = scopeOf(values);
  if (typeof scope === 'string') return { kind: 'usage-error', command, message: scope };
  const format = values.format;
  if (format !== undefined && format !== 'webp' && format !== 'avif') {
    return {
      kind: 'usage-error',
      command,
      message: `--format takes webp or avif, got \`${format}\``,
    };
  }
  const apply = values.apply === true;
  const commit = values.commit === true;
  const allowDirty = values['allow-dirty'] === true;
  const conflict =
    policyConflict(values.replace, values['keep-originals']) ??
    dryRunConflict(values['dry-run'], apply) ??
    writeFlagConflict(apply, commit, allowDirty) ??
    fullConflict(values.full, values.json) ??
    showConflict(command, values.show, values.full, values.json);
  if (conflict !== null) return { kind: 'usage-error', command, message: conflict };

  return {
    kind: 'run',
    options: {
      command,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
      show: values.show ?? null,
      apply,
      commit,
      policy:
        values['keep-originals'] === true
          ? 'keep-original'
          : values.replace === true
            ? 'replace'
            : null,
      format: format ?? null,
      allowDirty,
      full: values.full === true,
      includeDeclined: values['include-declined'] === true,
      includeDiscarded: values['include-discarded'] === true,
      includeUnusedSvg: values['include-unused-svg'] === true,
      only: values.only === undefined ? null : [...values.only],
      ...scope,
    },
  };
}

function parseOptimizeArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: OPTIMIZE, allowPositionals: true, strict: true });
}

/**
 * `--commit` and `--allow-dirty` only mean something to a run that writes, and together
 * they would let a commit sweep up changes that were not the run's.
 */
function writeFlagConflict(apply: boolean, commit: boolean, allowDirty: boolean): string | null {
  if (commit && allowDirty) {
    return '--commit and --allow-dirty cannot be used together: the commit must hold only what this run wrote, so --commit needs a folder with no uncommitted changes';
  }
  if (commit && !apply) return '--commit commits what --apply writes; add --apply';
  if (allowDirty && !apply) return '--allow-dirty only changes what --apply does; add --apply';
  return null;
}

/** `--replace` names the default, and `--keep-originals` asks for the opposite. */
function policyConflict(
  replace: boolean | undefined,
  keepOriginals: boolean | undefined,
): string | null {
  return replace === true && keepOriginals === true
    ? '--replace and --keep-originals cannot be used together: --replace removes each original once its references have moved, which is the default, and --keep-originals keeps them'
    : null;
}

/** A `--show` that names no row of the command's summary, or that another flag overrides. */
function showConflict(
  command: keyof typeof SHOWN_ROWS,
  show: string | undefined,
  full: boolean | undefined,
  json: boolean | undefined,
): string | null {
  if (show === undefined) return null;
  if (json === true) {
    return '--show and --json cannot be used together: --show prints one row of the summary as text, and --json prints JSON instead';
  }
  if (full === true) {
    return '--show and --full cannot be used together: --show prints one row of the full text, and --full prints all of it';
  }
  const rows = SHOWN_ROWS[command];
  return rows.includes(show)
    ? null
    : `--show takes one of ${rows.slice(0, -1).join(', ')} or ${rows.at(-1)}, got \`${show}\``;
}

/** `--dry-run` names what a run without `--apply` already does. */
function dryRunConflict(dryRun: boolean | undefined, apply: boolean): string | null {
  return dryRun === true && apply
    ? '--dry-run and --apply cannot be used together: --dry-run shows the plan and changes nothing, and --apply writes it'
    : null;
}

/** `--full` changes what is printed as text, so beside `--json` it would change nothing. */
function fullConflict(full: boolean | undefined, json: boolean | undefined): string | null {
  return full === true && json === true
    ? '--full and --json cannot be used together: --full prints the full text, and --json prints JSON instead'
    : null;
}

/** A command that takes a folder and only the options every command takes. */
function parseCommonOnly(command: 'undo' | 'init', args: readonly string[]): Parsed {
  let parsed: ReturnType<typeof parseCommonArgs>;
  try {
    parsed = parseCommonArgs(args);
  } catch (error) {
    return { kind: 'usage-error', command, message: plainParseError(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help', command };
  const dir = directoryOf(positionals);
  if (dir.problem !== null) return { kind: 'usage-error', command, message: dir.problem };
  return {
    kind: 'run',
    options: {
      command,
      dir: dir.value,
      json: values.json === true,
      noColor: values['no-color'] === true,
    },
  };
}

function parseCommonArgs(args: readonly string[]) {
  return parseArgs({ args: [...args], options: COMMON, allowPositionals: true, strict: true });
}

function directoryOf(
  positionals: readonly string[],
): { readonly value: string; readonly problem: null } | { readonly problem: string } {
  if (positionals.length > 1) {
    return {
      problem: `expected one directory, got ${positionals.length}: ${positionals.join(' ')}`,
    };
  }
  return { value: positionals[0] ?? '.', problem: null };
}

/** How many images to encode, from the three flags that decide it, or a usage error. */
function maxEncodesOf(values: {
  readonly 'no-probe'?: boolean | undefined;
  readonly 'max-encodes'?: string | undefined;
  readonly 'probe-all'?: boolean | undefined;
}): number | null | string {
  const given = [
    values['no-probe'] === true && '--no-probe',
    values['max-encodes'] !== undefined && '--max-encodes',
    values['probe-all'] === true && '--probe-all',
  ].filter((flag): flag is string => typeof flag === 'string');
  if (given.length > 1) {
    return `${given.slice(0, -1).join(', ')} and ${given.at(-1)} cannot be used together`;
  }
  if (values['probe-all'] === true) return null;
  const written = values['max-encodes'];
  if (written === undefined) return DEFAULT_MAX_ENCODES;
  const n = Number(written);
  return Number.isInteger(n) && n >= 0
    ? n
    : `--max-encodes takes a whole number of images, got \`${written}\``;
}

function scopeOf(values: {
  readonly public?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
}): ScopeOptions | string {
  let publicDirs: string[] | null = null;
  if (values.public !== undefined) {
    publicDirs = [];
    for (const dir of values.public) {
      const normalised = normaliseServedDir(dir);
      if (normalised === null) {
        return `--public takes a folder inside the project, such as \`public\`, or \`.\` for the project root; got \`${dir}\``;
      }
      publicDirs.push(normalised);
    }
  }
  return { publicDirs, exclude: [...(values.exclude ?? [])] };
}

/** Node's own wording names the option in its own style; this keeps it short and plain. */
function plainParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = /Unknown option '([^']+)'/.exec(message);
  if (unknown) return `unknown option \`${unknown[1]}\``;
  const missing = /Option '([^']+?)(?: <value>)?' argument missing/.exec(message);
  if (missing) return `\`${missing[1]?.replace(/^-[a-z], /, '')}\` needs a value`;
  const ambiguous = /Option '([^']+)' argument is ambiguous/.exec(message);
  if (ambiguous) {
    return `\`${ambiguous[1]}\` needs a value; one that starts with a dash is written \`${ambiguous[1]}=<value>\``;
  }
  return message.split('\n')[0] ?? message;
}
