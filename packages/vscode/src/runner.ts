/**
 * Runs the CLI the extension carries in a child process and reads its JSON contract: progress
 * lines while it works, then one result line, or an error line when it stops. The engine runs
 * outside the extension host because its parsing is synchronous work the host shares with
 * every other extension, and because the only way to stop a run part way is to end its
 * process.
 */

import { type SpawnOptions, spawn as spawnProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type {
  CommandName,
  DiagnosticLine,
  ErrorLine,
  ProgressLine,
  ResultLine,
} from './contract.js';
import { LineReader } from './json-lines.js';
import type { NodeRuntime } from './node-runtime.js';

/** The part of a child process the runner uses, so tests can drive one by hand. */
export interface ChildLike {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Starts a process, as `child_process.spawn` does. */
export type Spawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions & { env: NodeJS.ProcessEnv },
) => ChildLike;

/** Which Node.js runs the CLI, and where the CLI's entry point is. */
export interface Engine {
  readonly node: NodeRuntime;
  readonly cliBin: string;
}

/** One run of a command. */
export interface RunRequest {
  readonly command: CommandName;
  /** What follows the command on its command line; `--json` is added. */
  readonly args: readonly string[];
  /** The project folder, which the command reads. */
  readonly cwd: string;
  readonly onProgress?: (line: ProgressLine) => void;
  readonly onDiagnostic?: (line: DiagnosticLine) => void;
  /** A line of output that is not part of the contract, such as one a preloaded module printed. */
  readonly onStray?: (line: string) => void;
}

/** How a run ended. */
export type RunOutcome =
  | { readonly kind: 'result'; readonly result: ResultLine }
  /** The CLI stopped and said why, with its exit code: 2, 3 or 4, as the CLI documents them. */
  | { readonly kind: 'stopped'; readonly error: ErrorLine }
  /** The process ended without keeping the contract; `detail` holds what it printed. */
  | { readonly kind: 'crashed'; readonly message: string; readonly detail: string }
  | { readonly kind: 'cancelled' };

/** A run in progress. */
export interface RunHandle {
  readonly outcome: Promise<RunOutcome>;
  /** Ends the process. Does nothing once the run has ended. */
  cancel(): void;
}

/** How much of the error stream a crash keeps: its end, where the reason usually is. */
const STDERR_KEPT = 16_000;
/** How long a process has to end after Cancel before it is forced to. */
const KILL_GRACE_MS = 5_000;

/**
 * Starts the CLI on one command and follows it to its end.
 *
 * @param engine which Node.js runs which CLI
 * @param request the command, its arguments and the folder it runs in
 * @param spawn how to start the process; `child_process.spawn` unless a test passes its own
 * @returns the run, whose outcome never rejects
 */
export function startRun(
  engine: Engine,
  request: RunRequest,
  spawn: Spawn = spawnProcess,
): RunHandle {
  let settled = false;
  let cancelled = false;
  let child: ChildLike | null = null;
  let resolveOutcome: (outcome: RunOutcome) => void = () => {};
  const outcome = new Promise<RunOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const finish = (value: RunOutcome): void => {
    if (settled) return;
    settled = true;
    resolveOutcome(cancelled ? { kind: 'cancelled' } : value);
  };

  let last: ResultLine | ErrorLine | null = null;
  let stderr = '';

  const reader = new LineReader((line) => {
    const parsed = parseLine(line);
    if (parsed === null) {
      request.onStray?.(line);
      return;
    }
    if (parsed.type === 'progress') request.onProgress?.(parsed as ProgressLine);
    else if (parsed.type === 'diagnostic') request.onDiagnostic?.(parsed as DiagnosticLine);
    else if (parsed.type === 'result' || parsed.type === 'error')
      last = parsed as ResultLine | ErrorLine;
  });

  try {
    child = spawn(
      engine.node.execPath,
      [engine.cliBin, request.command, ...request.args, '--json'],
      {
        cwd: request.cwd,
        env: { ...process.env, ...engine.node.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  } catch (error) {
    finish(couldNotStart(engine, error));
    return { outcome, cancel: () => {} };
  }

  child.stdout?.on('data', (chunk: Buffer) => reader.push(chunk));
  child.stdout?.on('end', () => reader.end());
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEPT);
  });
  child.on('error', (error) => finish(couldNotStart(engine, error)));
  child.on('close', (code, signal) => {
    reader.end();
    finish(ending(last, code, signal, stderr));
  });

  return {
    outcome,
    cancel: () => {
      if (settled || cancelled || child === null) return;
      cancelled = true;
      const running = child;
      running.kill();
      const force = setTimeout(() => {
        if (!settled) running.kill('SIGKILL');
      }, KILL_GRACE_MS);
      force.unref?.();
    },
  };
}

/** A line as JSON with a `type`, or null when it is not one. */
function parseLine(line: string): { readonly type: string } | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' &&
      value !== null &&
      typeof (value as { type?: unknown }).type === 'string'
      ? (value as { readonly type: string })
      : null;
  } catch {
    return null;
  }
}

/** What the run's last line and the process's exit say together. */
function ending(
  last: ResultLine | ErrorLine | null,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): RunOutcome {
  const exit = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
  if (last !== null && code === last.exitCode) {
    return last.type === 'result'
      ? { kind: 'result', result: last }
      : { kind: 'stopped', error: last };
  }
  return {
    kind: 'crashed',
    message:
      last === null
        ? `Upfly stopped before it gave an answer (${exit}).`
        : `Upfly gave an answer and then stopped with ${exit}, so the answer cannot be trusted.`,
    detail: stderr,
  };
}

function couldNotStart(engine: Engine, error: unknown): RunOutcome {
  return {
    kind: 'crashed',
    message: `Upfly could not start Node.js at ${engine.node.execPath}.`,
    detail: error instanceof Error ? error.message : String(error),
  };
}
