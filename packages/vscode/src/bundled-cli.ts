/**
 * The CLI the extension carries, and the one a project may have installed itself. The
 * extension always runs its own, so that every result comes from the version it was built
 * and tested with; when the project installs another, the editor says so, because a run of
 * `npx upfly` in a terminal then uses that one.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The carried CLI: its version and its entry point. */
export interface BundledCli {
  readonly version: string;
  /** `bin/upfly.cjs`, which checks the Node.js version before it loads anything else. */
  readonly bin: string;
}

/**
 * Finds the CLI inside the extension: in `engine/node_modules/upfly` in a package, or through
 * the workspace link in `node_modules/upfly` when the extension runs from a checkout.
 *
 * @param extensionPath the extension's own folder
 * @returns the CLI, or null when neither place holds one
 */
export function findBundledCli(extensionPath: string): BundledCli | null {
  for (const folder of [
    path.join(extensionPath, 'engine', 'node_modules', 'upfly'),
    path.join(extensionPath, 'node_modules', 'upfly'),
  ]) {
    const version = packageVersion(folder);
    if (version !== null) return { version, bin: path.join(folder, 'bin', 'upfly.cjs') };
  }
  return null;
}

/**
 * The version of the `upfly` a project has installed: in the folder's `node_modules`, then in
 * each folder above it up to the top of the git repository it is in, where a monorepo keeps
 * its shared packages. Outside a repository only the folder itself is looked at, so an
 * install elsewhere on the computer is never taken for the project's.
 *
 * @param projectFolder the workspace folder
 * @returns its version, or null when no `upfly` is installed there
 */
export function projectCliVersion(projectFolder: string): string | null {
  const folders = [path.resolve(projectFolder)];
  for (let folder = folders[0] as string; !existsSync(path.join(folder, '.git')); ) {
    const parent = path.dirname(folder);
    if (parent === folder) {
      folders.splice(1);
      break;
    }
    folder = parent;
    folders.push(folder);
  }
  for (const folder of folders) {
    const version = packageVersion(path.join(folder, 'node_modules', 'upfly'));
    if (version !== null) return version;
  }
  return null;
}

/**
 * What to tell the person when the project's own `upfly` is another version of Upfly 3 or
 * later. Version 2 of the `upfly` package is the Express upload middleware, which shares the
 * name and nothing else, so it gets no notice.
 *
 * @param projectVersion the project's installed version, or null
 * @param bundledVersion the version the extension carries
 * @returns the notice, or null when there is nothing to say
 */
export function versionNotice(
  projectVersion: string | null,
  bundledVersion: string,
): string | null {
  if (projectVersion === null || projectVersion === bundledVersion) return null;
  const major = Number.parseInt(projectVersion, 10);
  if (!(major >= 3)) return null;
  return `This project has upfly ${projectVersion} installed. The editor runs the upfly ${bundledVersion} it carries, so a terminal run of npx upfly can answer differently.`;
}

function packageVersion(folder: string): string | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
    const { name, version } = manifest as { name?: unknown; version?: unknown };
    return name === 'upfly' && typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}
