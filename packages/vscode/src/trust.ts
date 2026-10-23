/**
 * What may run in a workspace VS Code does not trust. The CLI reads `upfly.config.json` as
 * data, but loads a `upfly.config.ts` or `.js` by running it, which is the project's own code.
 * So an untrusted folder holding one of those is not read at all. The read-only commands
 * write nothing and start no git, so nothing else they do needs trust.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/** The config files the CLI loads by running them, in the order the CLI looks for them. */
export const CODE_CONFIG_FILES: readonly string[] = [
  'upfly.config.ts',
  'upfly.config.mts',
  'upfly.config.cts',
  'upfly.config.js',
  'upfly.config.mjs',
  'upfly.config.cjs',
];

/**
 * Why the CLI must not read a folder, or null when it may.
 *
 * @param folder the workspace folder the CLI would read
 * @param trusted whether VS Code trusts the workspace
 * @returns the sentence to show where the command is unavailable, or null
 */
export function untrustedRefusal(folder: string, trusted: boolean): string | null {
  if (trusted) return null;
  const code = CODE_CONFIG_FILES.find((file) => existsSync(path.join(folder, file)));
  if (code === undefined) return null;
  return `This workspace is not trusted, and reading ${code} would run code from the project. Trust the workspace to let Upfly read this folder.`;
}
