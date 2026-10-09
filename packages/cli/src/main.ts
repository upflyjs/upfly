/** Reads the command line, runs the command, and returns the exit code. */

import { type CommandOptions, parseCommandLine } from './args.js';
import { runAudit } from './audit.js';
import { runCheck } from './check.js';
import { runDedupe } from './dedupe.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { helpText } from './help.js';
import { runInit } from './init.js';
import { upflyCommand } from './invocation.js';
import { runMove } from './move.js';
import { runOptimize } from './optimize.js';
import { type Io, emit, stylesFor } from './output.js';
import { runRefs } from './refs.js';
import { runUndo } from './undo.js';
import { version } from './version.js';

/**
 * Runs one invocation of the CLI.
 *
 * @param argv the arguments after `upfly`
 * @param io the streams and environment to use
 * @returns the process exit code
 */
export async function main(argv: readonly string[], io: Io): Promise<ExitCode> {
  const upfly = upflyCommand(io.env, io.script);
  const parsed = parseCommandLine(argv, upfly);
  const json = argv.includes('--json');

  if (parsed.kind === 'version') {
    io.stdout.write(`${version()}\n`);
    return EXIT_CODES.OK;
  }
  if (parsed.kind === 'help') {
    io.stdout.write(helpText(parsed.command));
    return EXIT_CODES.OK;
  }
  if (parsed.kind === 'usage-error') {
    if (json) {
      emit(io, {
        type: 'error',
        command: parsed.command,
        exitCode: EXIT_CODES.USAGE,
        message: parsed.message,
      });
    } else {
      const { red } = stylesFor(io.stderr, io.env, {
        json,
        noColor: argv.includes('--no-color'),
      });
      const help = `${upfly}${parsed.command === null ? '' : ` ${parsed.command}`} --help`;
      io.stderr.write(`${red('upfly:')} ${parsed.message}\nSee \`${help}\`.\n`);
    }
    return EXIT_CODES.USAGE;
  }
  try {
    return await run(parsed.options, io);
  } catch (error) {
    // Neither a finding nor a refusal: something Upfly did not anticipate went wrong.
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      emit(io, {
        type: 'error',
        command: parsed.options.command,
        exitCode: EXIT_CODES.INTERNAL,
        message,
      });
    } else {
      io.stderr.write(`upfly: failed unexpectedly: ${message}\n`);
    }
    return EXIT_CODES.INTERNAL;
  }
}

function run(options: CommandOptions, io: Io): Promise<ExitCode> {
  switch (options.command) {
    case 'audit':
      return runAudit(options, io);
    case 'optimize':
      return runOptimize(options, io);
    case 'undo':
      return runUndo(options, io);
    case 'check':
      return runCheck(options, io);
    case 'init':
      return runInit(options, io);
    case 'refs':
      return runRefs(options, io);
    case 'dedupe':
      return runDedupe(options, io);
    case 'move':
      return runMove(options, io);
  }
}
