#!/usr/bin/env node
/**
 * `upfly-mcp [dir]`: reads the command line, then serves Upfly's commands to an MCP client over
 * standard input and output until the client closes the connection.
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isDirectory, serve } from './server.js';
import { version } from './version.js';

const OK = 0;
const USAGE = 2;

const HELP = `Usage: upfly-mcp [dir]

Serves Upfly's commands to an MCP client, such as Claude Desktop, Claude Code or Antigravity,
over standard input and output, until the client closes the connection. Each tool runs the
command of its name with the upfly installed with this package, in the project's folder, and
answers with the line that command prints last with --json: its result, or its refusal and the
reason. audit, check and refs change no file. optimize, dedupe and move answer with their plan,
and write only when a call sets apply to true, refusing what the command refuses: uncommitted
changes, an earlier run that stopped part way, a merge or a rebase in progress. undo writes
only when a call sets apply to true. No tool runs init, and none takes --allow-dirty.

dir is the folder a tool reads when a call names none, the current directory by default.

Options:
  -h, --help     Show this help
  -v, --version  Print the version

Exit status: 0 once the client has closed the connection; 2 for a usage error.
`;

/**
 * Runs one invocation: prints the help or the version, or serves the folder given.
 *
 * @param argv the arguments after `upfly-mcp`
 * @returns the process exit code
 */
async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return usageError(plainParseError(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(HELP);
    return OK;
  }
  if (values.version === true) {
    process.stdout.write(`${version()}\n`);
    return OK;
  }
  if (positionals.length > 1) {
    return usageError(
      `expected one directory, got ${positionals.length}: ${positionals.join(' ')}`,
    );
  }
  const dir = positionals[0] ?? '.';
  const folder = resolve(dir);
  if (!isDirectory(folder)) {
    process.stderr.write(`upfly-mcp: ${dir} is not a directory\n`);
    return USAGE;
  }
  await serve(folder);
  return OK;
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: true,
  });
}

function usageError(message: string): number {
  process.stderr.write(`upfly-mcp: ${message}\nSee \`upfly-mcp --help\`.\n`);
  return USAGE;
}

/** The parsing error in one line: an unknown option by name, anything else as Node words it. */
function plainParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = /Unknown option '([^']+)'/.exec(message);
  if (unknown) return `unknown option \`${unknown[1]}\``;
  return message.split('\n')[0] ?? message;
}

// `exitCode` rather than `process.exit()`, so output still queued for a pipe is written.
process.exitCode = await main(process.argv.slice(2));
