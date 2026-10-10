/**
 * The project's configuration file: `upfly.config.ts` (or `.mts`, `.cts`, `.js`, `.mjs`,
 * `.cjs`) or `upfly.config.json`, read from the directory Upfly runs on and nowhere else.
 *
 * The code forms load through c12 with everything a user did not ask for turned off: no
 * `extends` layers (which can download a remote config), no rc files, no `.env`, no
 * `package.json` key and no `NODE_ENV` sections. The JSON form is parsed directly as JSONC,
 * the way the v2 VS Code extension reads its own `upfly.config.json`, because that file has
 * the same name and must be recognised rather than misread.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type JSONCParseError, parseJSONC } from 'confbox/jsonc';

/** What a configuration file may set. Every key is optional; a flag overrides it. */
export interface UpflyConfig {
  /** A JSON schema reference for editors. Upfly reads nothing from it. */
  readonly $schema?: string;
  /**
   * The folders the site is served from, relative to the project root, such as `public`.
   * `"."` is the project root itself, as for a plain HTML site. Declaring them replaces
   * Upfly's own detection.
   */
  readonly publicDirs?: readonly string[];
  /**
   * What `optimize` does with each original once every reference to it has moved: `replace`,
   * the default, removes it once no file Upfly reads still names it; `keep-original` keeps it
   * beside its converted file.
   */
  readonly publicPolicy?: 'keep-original' | 'replace';
  /** The format images are converted to. */
  readonly format?: 'webp' | 'avif';
  /** Paths to leave out of the walk, in `.gitignore` syntax, added to `.upflyignore`. */
  readonly exclude?: readonly string[];
  /** What `upfly check` fails on besides a reference to an image that does not exist. */
  readonly check?: CheckSettings;
}

/**
 * What `upfly check` can fail on: `broken`, a reference to an image that does not exist;
 * `too-large`, an image in use larger than `maxImageBytes`; `possibly-broken`, an image path in
 * code or data that names no file.
 */
export type CheckKind = 'broken' | 'too-large' | 'possibly-broken';

/** Every kind the check can fail on, in the order it reports them. */
export const CHECK_KINDS: readonly CheckKind[] = ['broken', 'too-large', 'possibly-broken'];

/** The limits `upfly check` holds a project to. */
export interface CheckSettings {
  /**
   * The largest an image may be on disk, in bytes. An image a reference uses fails the check
   * when its file is larger; an image nothing uses never does.
   */
  readonly maxImageBytes?: number;
  /**
   * What fails the check. Unset, it fails on `broken`, and on `too-large` when
   * `maxImageBytes` is set; an empty list makes it fail on nothing. An unused image is never
   * one of them. `--fail-on` overrides it for one run.
   */
  readonly failOn?: readonly CheckKind[];
}

/** Returns its argument, typed, for an `upfly.config.ts` that wants editor completion. */
export function defineConfig(config: UpflyConfig): UpflyConfig {
  return config;
}

/** The configuration files Upfly reads, code forms first. */
export const CONFIG_FILES = [
  'upfly.config.ts',
  'upfly.config.mts',
  'upfly.config.cts',
  'upfly.config.js',
  'upfly.config.mjs',
  'upfly.config.cjs',
  'upfly.config.json',
] as const;

/**
 * The `$schema` a v3 JSON config carries. Any value naming Upfly's config schema counts,
 * whether a path into `node_modules` or a CDN copy of the same file.
 */
export const CONFIG_SCHEMA = './node_modules/upfly/schema/config.json';

/** Top-level keys of the v2 VS Code extension's `upfly.config.json`. */
export const V2_EXTENSION_KEYS: readonly string[] = [
  'enabled',
  'useGlobalSettings',
  'watchTargets',
  'storageMode',
  'outputDirectory',
  'originalDirectory',
  'maxFileSize',
  'inPlaceKeepOriginal',
  'cloudUpload',
];

const KEYS = ['$schema', 'publicDirs', 'publicPolicy', 'format', 'exclude', 'check'] as const;
// `format` is not here: the v2 extension's settings use the same name.
const V3_ONLY_KEYS = new Set(['publicDirs', 'publicPolicy', 'exclude', 'check']);
const CHECK_KEYS = ['maxImageBytes', 'failOn'] as const;

export type ConfigOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'loaded'; readonly file: string; readonly config: UpflyConfig }
  /** Another product's file, left untouched. The command stops for safety. */
  | {
      readonly kind: 'refused';
      readonly file: string;
      readonly message: string;
      /** The name `--json` gives this refusal. */
      readonly reason: 'V2_EXTENSION_CONFIG';
    }
  /** A file Upfly cannot use as written. The command stops as a usage error. */
  | { readonly kind: 'invalid'; readonly file: string; readonly message: string };

/**
 * Finds and reads the configuration in `root`.
 *
 * @param root the project directory, the same one the command runs on
 * @returns `none` when there is no file, or the validated config, or why it cannot be used
 */
export async function loadConfig(root: string): Promise<ConfigOutcome> {
  const present = CONFIG_FILES.filter((file) => existsSync(join(root, file)));
  const code = present.filter((file) => file !== 'upfly.config.json');
  const hasJson = present.includes('upfly.config.json');

  if (code.length > 1) {
    return {
      kind: 'invalid',
      file: code[0] as string,
      message: `found ${list(code)}; keep one configuration file.`,
    };
  }

  const json = hasJson ? await readJson(root) : null;
  if (json !== null && json.kind !== 'parsed') return json;

  if (code.length === 1) {
    const file = code[0] as string;
    // A v2 file beside a v3 code config is the extension's own, and stays unread here.
    if (json !== null && !isV2Only(json.value)) {
      return {
        kind: 'invalid',
        file,
        message: `found ${file} and upfly.config.json; keep one configuration file.`,
      };
    }
    return validate(file, await loadCode(root, file));
  }

  if (json === null) return { kind: 'none' };
  if (isV2Only(json.value)) {
    return {
      kind: 'refused',
      file: 'upfly.config.json',
      message: V2_REFUSAL,
      reason: 'V2_EXTENSION_CONFIG',
    };
  }
  return validate('upfly.config.json', { kind: 'value', value: json.value });
}

const V2_REFUSAL = [
  'upfly.config.json belongs to the Upfly VS Code extension (v2): it holds that',
  "extension's settings and none of this CLI's. It was not read, and it is left untouched.",
  'To configure this CLI, create upfly.config.ts, which Upfly reads instead, or give a JSON',
  `config the key "$schema": "${CONFIG_SCHEMA}".`,
].join('\n');

type Loaded =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'error'; readonly message: string };

async function readJson(
  root: string,
): Promise<
  { kind: 'parsed'; value: unknown } | { kind: 'invalid'; file: string; message: string }
> {
  let text: string;
  try {
    text = await readFile(join(root, 'upfly.config.json'), 'utf8');
  } catch (error) {
    return {
      kind: 'invalid',
      file: 'upfly.config.json',
      message: `could not be read: ${firstLine(error)}`,
    };
  }
  // The parser recovers from errors and returns what it salvaged unless asked to list them,
  // so a truncated file would otherwise load as a partial config.
  const errors: JSONCParseError[] = [];
  const value = parseJSONC(text, { errors, allowTrailingComma: true });
  const first = errors[0];
  if (first !== undefined) {
    const before = text.slice(0, first.offset).split('\n');
    return {
      kind: 'invalid',
      file: 'upfly.config.json',
      message: `could not be parsed: it is not valid JSON at line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}.`,
    };
  }
  return { kind: 'parsed', value };
}

async function loadCode(root: string, file: string): Promise<Loaded> {
  try {
    const { loadConfig: load } = await import('c12');
    const { config } = await load({
      cwd: root,
      name: 'upfly',
      configFile: file,
      rcFile: false,
      globalRc: false,
      dotenv: false,
      packageJson: false,
      envName: false,
      extend: false,
      giget: false,
    });
    return { kind: 'value', value: config };
  } catch (error) {
    return { kind: 'error', message: `could not be loaded: ${firstLine(error)}` };
  }
}

/**
 * Whether the project's `upfly.config.json` is the v2 VS Code extension's, which this CLI never
 * reads, whatever configuration file is beside it. Only the JSON is read.
 *
 * @param root the project directory
 */
export async function holdsExtensionConfig(root: string): Promise<boolean> {
  if (!existsSync(join(root, 'upfly.config.json'))) return false;
  const json = await readJson(root);
  return json.kind === 'parsed' && isV2Only(json.value);
}

/** A JSON file with a v2 key and nothing that marks it as this CLI's. */
function isV2Only(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!keys.some((key) => V2_EXTENSION_KEYS.includes(key))) return false;
  if (keys.some((key) => V3_ONLY_KEYS.has(key))) return false;
  return !isV3Schema(value.$schema);
}

function isV3Schema(value: unknown): boolean {
  return typeof value === 'string' && /upfly/i.test(value) && value.endsWith('schema/config.json');
}

function validate(file: string, loaded: Loaded): ConfigOutcome {
  if (loaded.kind === 'error') return { kind: 'invalid', file, message: loaded.message };
  const value = loaded.value;
  if (!isRecord(value)) {
    return { kind: 'invalid', file, message: 'must hold an object of settings.' };
  }

  const problems = keyProblems(Object.keys(value));
  const config: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (value[key] === undefined) continue;
    const read = FIELDS[key](value[key]);
    if ('problem' in read) problems.push(read.problem);
    else config[key] = read.value;
  }

  if (problems.length > 0) return { kind: 'invalid', file, message: problems.join('\n') };
  return { kind: 'loaded', file, config: config as UpflyConfig };
}

function keyProblems(keys: readonly string[]): string[] {
  const problems: string[] = [];
  const v2 = keys.filter((key) => V2_EXTENSION_KEYS.includes(key));
  if (v2.length > 0) {
    problems.push(
      `${list(v2.map((key) => `\`${key}\``))} ${v2.length === 1 ? 'is a setting' : 'are settings'} of the v2 VS Code extension, which this CLI does not read. Keep them in the extension's own file.`,
    );
  }
  const unknown = keys.filter(
    (key) => !V2_EXTENSION_KEYS.includes(key) && !(KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    problems.push(
      `unknown ${unknown.length === 1 ? 'setting' : 'settings'} ${list(unknown.map((key) => `\`${key}\``))}. The settings are ${list(KEYS.filter((key) => key !== '$schema').map((key) => `\`${key}\``))}.`,
    );
  }
  return problems;
}

type FieldRead = { readonly value: unknown } | { readonly problem: string };

/** How each setting is read, in the order its problems are reported. */
const FIELDS: Record<(typeof KEYS)[number], (value: unknown) => FieldRead> = {
  $schema: (value) =>
    typeof value === 'string' ? { value } : { problem: '`$schema` must be a string.' },
  publicDirs: (value) => {
    const dirs = stringList(value)?.map(normaliseServedDir);
    return dirs === undefined || dirs.some((dir) => dir === null)
      ? {
          problem:
            '`publicDirs` must be a list of folders inside the project, such as ["public"], or ["."] for the project root.',
        }
      : { value: dirs };
  },
  publicPolicy: (value) =>
    value === 'keep-original' || value === 'replace'
      ? { value }
      : { problem: '`publicPolicy` must be "keep-original" or "replace".' },
  format: (value) =>
    value === 'webp' || value === 'avif'
      ? { value }
      : { problem: '`format` must be "webp" or "avif".' },
  exclude: (value) => {
    const patterns = stringList(value);
    return patterns === undefined
      ? { problem: '`exclude` must be a list of patterns.' }
      : { value: patterns };
  },
  check: (value) => {
    if (!isRecord(value)) {
      return {
        problem: '`check` must hold an object of settings, such as {"maxImageBytes": 500000}.',
      };
    }
    const unknown = Object.keys(value).filter(
      (key) => !(CHECK_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      return {
        problem: `unknown ${unknown.length === 1 ? 'setting' : 'settings'} ${list(unknown.map((key) => `\`check.${key}\``))}. The settings under \`check\` are ${list(CHECK_KEYS.map((key) => `\`${key}\``))}.`,
      };
    }
    const max = value.maxImageBytes;
    if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max > 0)) {
      return {
        problem: '`check.maxImageBytes` must be a whole number of bytes above 0, such as 500000.',
      };
    }
    const failOn = value.failOn === undefined ? undefined : readFailOn(value.failOn, max);
    if (typeof failOn === 'string') return { problem: failOn };
    return {
      value: {
        ...(max === undefined ? {} : { maxImageBytes: max }),
        ...(failOn === undefined ? {} : { failOn }),
      },
    };
  },
};

/** `check.failOn` in the order the check reports its kinds, or why it cannot be used. */
function readFailOn(value: unknown, max: unknown): readonly CheckKind[] | string {
  const kinds = stringList(value);
  if (kinds === undefined) {
    return '`check.failOn` must be a list of what fails the check, such as ["broken", "possibly-broken"].';
  }
  const unknown = kinds.find((kind) => !(CHECK_KINDS as readonly string[]).includes(kind));
  if (unknown !== undefined) {
    return `\`check.failOn\` holds \`${unknown}\`, which the check cannot fail on: the choices are ${list(CHECK_KINDS.map((kind) => `\`${kind}\``))}, and an unused image never fails the check.`;
  }
  if (kinds.includes('too-large') && max === undefined) {
    return '`check.failOn` names `too-large`, which needs `check.maxImageBytes`, the largest an image in use may be.';
  }
  return CHECK_KINDS.filter((kind) => kinds.includes(kind));
}

/**
 * A served folder as the engine spells it: POSIX, relative, no trailing slash, and `''`
 * for the project root. `null` for a path that leaves the project.
 *
 * @param dir a folder as a user wrote it, in a config file or after `--public`
 */
export function normaliseServedDir(dir: string): string | null {
  const posix = dir.replaceAll('\\', '/').replace(/\/+$/, '');
  const trimmed = posix.replace(/^\.\//, '');
  if (trimmed === '.' || trimmed === '') return '';
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return null;
  if (trimmed.split('/').some((segment) => segment === '..')) return null;
  return trimmed;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
