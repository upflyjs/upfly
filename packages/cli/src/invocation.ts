/**
 * How to type an Upfly command so that it runs, for the commands the CLI prints: `upfly` for a
 * global install the shell finds by that name, and `npx upfly` otherwise.
 *
 * A project install puts `upfly` in `node_modules/.bin`, which a shell does not search, so a
 * printed `upfly optimize --apply` fails there as typed. Every package manager that starts a
 * run (`npx`, `pnpm exec`, a `package.json` script, yarn) sets `npm_config_user_agent`; a global
 * install typed by name sets nothing, so it is recognised by the command the shell would find:
 * a file `upfly` on `PATH` that is this script (npm links one there on Linux and macOS), or an
 * `upfly.cmd` there that names it (npm's shim on Windows). When it cannot be told, the form that
 * works for a project install is the one printed.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';

/** The words that start a command as the person can type it. */
export type UpflyCommand = 'upfly' | 'npx upfly';

/**
 * How this run's commands are typed, from the environment it started in and the script it is.
 *
 * @param env the environment, which says whether a package manager started the run and holds
 *   the `PATH` the shell searches
 * @param script the path the run was started as, `process.argv[1]`, or undefined when unknown
 * @returns `upfly` when the shell runs this script by that name, `npx upfly` otherwise
 */
export function upflyCommand(
  env: Readonly<Record<string, string | undefined>>,
  script: string | undefined,
): UpflyCommand {
  if ((env.npm_config_user_agent ?? '') !== '' || script === undefined) return 'npx upfly';
  const real = realPath(script);
  if (real === null) return 'npx upfly';
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    // A package manager's own `.bin` folders hold a project's commands, not global ones.
    if (dir === '' || /[\\/]node_modules([\\/]|$)/.test(dir)) continue;
    if (realPath(join(dir, 'upfly')) === real) return 'upfly';
    const shim = text(join(dir, 'upfly.cmd'));
    if (shim !== null && [script, real].some((path) => shim.includes(relative(dir, path)))) {
      return 'upfly';
    }
  }
  return 'npx upfly';
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function text(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
