/**
 * Which Node.js runs the CLI. The editor's own comes first: VS Code's executable runs as
 * plain Node.js when `ELECTRON_RUN_AS_NODE` is set, so nothing else needs installing. An
 * editor built on an older Electron carries a Node.js the CLI turns away, and then a Node.js
 * on the computer's PATH is used instead. The CLI's own version check decides both.
 */

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/** A Node.js that can run the CLI. */
export interface NodeRuntime {
  /** `editor` for the editor's own executable, `system` for a Node.js found on the PATH. */
  readonly kind: 'editor' | 'system';
  readonly execPath: string;
  readonly version: string;
  /** Variables the child process needs on top of the editor's environment. */
  readonly env: Readonly<Record<string, string>>;
}

/** The Node.js found, or the message saying what is needed. */
export type NodeChoice =
  | { readonly kind: 'found'; readonly runtime: NodeRuntime }
  | { readonly kind: 'missing'; readonly message: string };

/** What choosing a Node.js looks at, so tests can stand in for the computer. */
export interface NodeProbe {
  /** The extension host's own executable and the Node.js version inside it. */
  readonly editor: { readonly execPath: string; readonly version: string };
  /** Why the CLI cannot run on a Node.js version, or null when it can: the CLI's own check. */
  readonly tooOld: (version: string) => string | null;
  /** Each Node.js executable on the PATH, in PATH order. */
  readonly onPath: () => readonly string[];
  /** The version a Node.js executable reports, or null when it does not run. */
  readonly versionOf: (execPath: string) => Promise<string | null>;
}

/**
 * Chooses the Node.js that runs the CLI.
 *
 * @param probe the editor's Node.js, the CLI's version check, and the PATH
 * @returns the editor's own Node.js when the CLI accepts it, otherwise the first one on the
 *   PATH that it accepts, otherwise one message saying what is needed
 */
export async function chooseNode(probe: NodeProbe): Promise<NodeChoice> {
  const { editor } = probe;
  if (probe.tooOld(editor.version) === null) {
    return {
      kind: 'found',
      runtime: {
        kind: 'editor',
        execPath: editor.execPath,
        version: editor.version,
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    };
  }
  const seen: string[] = [];
  for (const execPath of probe.onPath()) {
    const version = await probe.versionOf(execPath);
    if (version === null) continue;
    if (probe.tooOld(version) === null) {
      return { kind: 'found', runtime: { kind: 'system', execPath, version, env: {} } };
    }
    seen.push(version);
  }
  const floor = floorFrom(probe.tooOld(editor.version) ?? '') ?? '22.0.0';
  const onPath =
    seen.length === 0
      ? "there is no Node.js on this computer's PATH"
      : `the Node.js on this computer's PATH is ${seen.join(', ')}`;
  return {
    kind: 'missing',
    message: `Upfly needs Node.js ${floor} or later. This editor runs Node.js ${editor.version}, and ${onPath}. Install Node.js ${floor} or later from https://nodejs.org, then run the command again.`,
  };
}

/** The version the CLI's refusal names, such as `22.0.0`, or null when it names none. */
function floorFrom(refusal: string): string | null {
  return /Node\.js (\d+\.\d+\.\d+) or later/.exec(refusal)?.[1] ?? null;
}

/**
 * Each Node.js executable in the folders of a PATH, in order and once each.
 *
 * @param env the environment holding the PATH; Windows spells its name in any letter case
 * @param platform which separator and executable name to use
 * @param isFile whether a path is a file; the real file system unless a test passes its own
 */
export function nodeOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (candidate: string) => boolean = fileExists,
): string[] {
  const windows = platform === 'win32';
  const key = Object.keys(env).find((name) =>
    windows ? name.toUpperCase() === 'PATH' : name === 'PATH',
  );
  const value = key === undefined ? undefined : env[key];
  if (value === undefined) return [];
  const paths = windows ? path.win32 : path.posix;
  const found: string[] = [];
  for (const folder of value.split(windows ? ';' : ':')) {
    if (folder === '') continue;
    const candidate = paths.join(folder, windows ? 'node.exe' : 'node');
    if (!found.includes(candidate) && isFile(candidate)) found.push(candidate);
  }
  return found;
}

function fileExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The Node.js version an executable reports, or null when it does not start or answers with
 * something else.
 *
 * @param execPath the executable
 */
export function versionOf(execPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      execPath,
      ['-p', 'process.versions.node'],
      { timeout: 10_000, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        const version = stdout.trim();
        resolve(error === null && /^\d+\.\d+\.\d+$/.test(version) ? version : null);
      },
    );
  });
}
