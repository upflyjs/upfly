/**
 * Where the CLI's words go. With `--json`, stdout carries only JSON lines: progress events,
 * then one final object, so a script can read it line by line. Otherwise stdout carries
 * the report and stderr carries errors and, on a terminal, progress.
 */

import { reportsMeasuring } from 'upfly-core/internal';
import type { CommandName } from './args.js';
import type { ExitCode } from './exit-codes.js';

/** The streams and environment a command runs against, so tests can supply their own. */
export interface Io {
  readonly stdout: Output;
  readonly stderr: Output;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Output {
  write(text: string): unknown;
  readonly isTTY?: boolean;
  /**
   * How many bits of colour the terminal shows, 1, 4, 8 or 24, as Node's terminal streams
   * report it. A stream without it is taken to show 16 colours.
   */
  getColorDepth?(env?: object): number;
}

/** One stage of the run finished, with what it counted. */
export interface ProgressEvent {
  readonly stage: string;
  readonly [count: string]: string | number;
}

/**
 * Whether to colour what goes to `stream`: only on a terminal, never under `--json` or
 * `--no-color`, never when `NO_COLOR` is set to anything but the empty string, and never
 * on a terminal that calls itself `dumb`, which shows escape codes as text.
 *
 * @see https://no-color.org
 */
export function colourFor(
  stream: Output,
  env: Io['env'],
  options: { readonly json: boolean; readonly noColor: boolean },
): boolean {
  if (options.json || options.noColor) return false;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  if (env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

/** How many colours a terminal shows: 24-bit, the 256 of xterm, or 16 and fewer. */
export type ColourDepth = 'truecolor' | '256' | 'basic';

/**
 * The colour depth of the terminal behind `stream`, as Node reports it: from `COLORTERM`,
 * `TERM` and the platform, so Windows 10 and later count as 24-bit, though their consoles set
 * neither variable. `NO_COLOR` is left out of the question: `colourFor` has read it already,
 * and Node reads even an empty one as no colour.
 *
 * @see https://nodejs.org/api/tty.html#writestreamgetcolordepthenv
 */
export function colourDepth(stream: Output, env: Io['env']): ColourDepth {
  const asked = Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'NO_COLOR'));
  const bits = stream.getColorDepth?.(asked) ?? 4;
  if (bits >= 24) return 'truecolor';
  return bits >= 8 ? '256' : 'basic';
}

/**
 * The brand's coral, `#E8365F`, where the terminal can show it: exact, or index 161 of the
 * 256 (`#D7005F`), the nearest by CIE76 distance. Among 16 colours only a red comes near it,
 * and red marks a failure, so there the accent is bold without a colour.
 */
const CORAL: Readonly<Record<ColourDepth, string | null>> = {
  truecolor: '38;2;232;54;95',
  '256': '38;5;161',
  basic: null,
};

/**
 * The only ways the CLI marks its text. Colour never carries a meaning on its own: each mark
 * sits on words that already say it.
 */
export interface Styles {
  /**
   * The brand's coral in bold, for structure only: the headline's name and the labels. It is
   * the one bold thing on a line, so values stay at the terminal's own weight, apart from the
   * command to run next.
   */
  readonly accent: (text: string) => string;
  /** The command to run next, in the terminal's own colour, so it can be found and copied. */
  readonly bold: (text: string) => string;
  /** A secondary line. */
  readonly dim: (text: string) => string;
  /** A failure, and nothing else. */
  readonly red: (text: string) => string;
}

/** Styles that leave text as it is, for output with no colour. */
export const PLAIN: Styles = {
  accent: (text) => text,
  bold: (text) => text,
  dim: (text) => text,
  red: (text) => text,
};

/**
 * The styles for what goes to `stream`: `PLAIN` wherever `colourFor` turns colour off, so
 * the text then holds no escape code at all, and otherwise marks for the colours the
 * terminal shows.
 *
 * @param stream where the text goes
 * @param env the environment, which can turn colour off and says how many colours there are
 * @param options `--json` and `--no-color`
 */
export function stylesFor(
  stream: Output,
  env: Io['env'],
  options: { readonly json: boolean; readonly noColor: boolean },
): Styles {
  if (!colourFor(stream, env, options)) return PLAIN;
  const mark = (open: string, close: string) => (text: string) =>
    text === '' ? text : `\u001b[${open}m${text}\u001b[${close}m`;
  const coral = CORAL[colourDepth(stream, env)];
  return {
    accent: coral === null ? mark('1', '22') : mark(`1;${coral}`, '22;39'),
    bold: mark('1', '22'),
    dim: mark('2', '22'),
    red: mark('31', '39'),
  };
}

/** Writes one JSON line to stdout. */
export function emit(io: Io, event: Record<string, unknown>): void {
  io.stdout.write(`${JSON.stringify(event)}\n`);
}

/** The options every command's output depends on. */
export interface Style {
  readonly command: CommandName;
  readonly json: boolean;
  readonly noColor: boolean;
}

/**
 * Says why a command stopped and returns the exit code to end with: an `error` line under
 * `--json`, otherwise `upfly:` and the message on stderr.
 *
 * @param code the exit code
 * @param message what happened and what to do about it, in sentences
 * @param reason a stable name for a refusal, for scripts that branch on it
 * @returns `code`
 */
export function stopWith(
  io: Io,
  style: Style,
  code: ExitCode,
  message: string,
  reason?: string,
): ExitCode {
  if (style.json) {
    emit(io, {
      type: 'error',
      command: style.command,
      exitCode: code,
      ...(reason === undefined ? {} : { reason }),
      message,
    });
  } else {
    const { red } = stylesFor(io.stderr, io.env, style);
    io.stderr.write(`${red('upfly:')} ${message}\n`);
  }
  return code;
}

/**
 * Reports progress: a JSON line under `--json`, one overwritten line on a terminal, and
 * nothing when stderr is a file or a pipe. The terminal counts every image measured; the
 * JSON lines keep the counts `reportsMeasuring` names, twenty for a big project.
 */
export function progressReporter(
  io: Io,
  command: CommandName,
  json: boolean,
): { update(event: ProgressEvent): void; clear(): void } {
  let shown = false;
  return {
    update(event) {
      if (json) {
        const measuring = event.stage === 'measuring';
        if (measuring && !reportsMeasuring(Number(event.done), Number(event.total))) return;
        emit(io, { type: 'progress', command, ...event });
        return;
      }
      if (io.stderr.isTTY !== true) return;
      io.stderr.write(`\r\u001b[2K${describeProgress(event)}`);
      shown = true;
    },
    clear() {
      if (shown) io.stderr.write('\r\u001b[2K');
      shown = false;
    },
  };
}

function describeProgress(event: ProgressEvent): string {
  if (event.stage === 'measuring') return `measuring images: ${event.done} of ${event.total}`;
  const counts = Object.entries(event)
    .filter(([key]) => key !== 'stage')
    .map(([key, value]) => `${value} ${value === 1 ? key.replace(/s$/, '') : key}`)
    .join(', ');
  return counts === '' ? `${event.stage}...` : `${event.stage}: ${counts}`;
}
