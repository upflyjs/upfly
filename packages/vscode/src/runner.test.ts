import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressLine } from './contract.js';
import { type ChildLike, type Engine, type RunRequest, type Spawn, startRun } from './runner.js';

/** A child process the test drives by hand. */
class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: (NodeJS.Signals | undefined)[] = [];

  print(line: unknown): void {
    this.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  }

  complain(text: string): void {
    this.stderr.write(text);
  }

  /** Ends the streams, then reports the exit, as a real process does. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

const ENGINE: Engine = {
  node: { kind: 'editor', execPath: '/editor/node', version: '24.21.0', env: { RUN_AS: '1' } },
  cliBin: '/ext/engine/node_modules/upfly/bin/upfly.cjs',
};

function start(request: Partial<RunRequest> = {}) {
  const child = new FakeChild();
  const calls: Parameters<Spawn>[] = [];
  const spawn: Spawn = (...args) => {
    calls.push(args);
    return child;
  };
  const handle = startRun(
    ENGINE,
    { command: 'audit', args: [], cwd: '/project', ...request },
    spawn,
  );
  return { child, calls, handle };
}

const AUDIT_RESULT = {
  type: 'result',
  command: 'audit',
  exitCode: 0,
  report: { summary: { assets: 1 } },
  savings: null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('startRun', () => {
  it('starts the CLI with the command, its arguments and --json, in the project folder', () => {
    const { calls } = start({ command: 'refs', args: ['public/hero.png'] });
    const [file, args, options] = calls[0] ?? [];
    expect(file).toBe('/editor/node');
    expect(args).toEqual([ENGINE.cliBin, 'refs', 'public/hero.png', '--json']);
    expect(options?.cwd).toBe('/project');
  });

  it("gives the child the runtime's environment on top of the editor's", () => {
    const { calls } = start();
    expect(calls[0]?.[2].env.RUN_AS).toBe('1');
    expect(calls[0]?.[2].env.PATH ?? calls[0]?.[2].env.Path).toBe(
      process.env.PATH ?? process.env.Path,
    );
  });

  it('reports each progress line as it arrives, in order', async () => {
    const seen: ProgressLine[] = [];
    const { child, handle } = start({ onProgress: (line) => seen.push(line) });
    child.print({ type: 'progress', command: 'audit', stage: 'discovered', images: 2, files: 3 });
    child.print({ type: 'progress', command: 'audit', stage: 'scanned', references: 4 });
    child.print(AUDIT_RESULT);
    child.exit(0);
    await handle.outcome;
    expect(seen.map((line) => line.stage)).toEqual(['discovered', 'scanned']);
  });

  it('passes diagnostic lines on without treating them as a result', async () => {
    const details: string[] = [];
    const { child, handle } = start({ onDiagnostic: (line) => details.push(line.detail) });
    child.print({
      type: 'diagnostic',
      command: 'audit',
      source: 'parser',
      relative: 'a.css',
      adapterId: 'css',
      detail: 'Unclosed block',
    });
    child.print(AUDIT_RESULT);
    child.exit(0);
    expect((await handle.outcome).kind).toBe('result');
    expect(details).toEqual(['Unclosed block']);
  });

  it('ends with the result line when the process exits with its exit code', async () => {
    const { child, handle } = start();
    child.print(AUDIT_RESULT);
    child.exit(0);
    expect(await handle.outcome).toEqual({ kind: 'result', result: AUDIT_RESULT });
  });

  it("ends with the CLI's own message, reason and exit code when it refuses", async () => {
    const { child, handle } = start();
    const error = {
      type: 'error',
      command: 'audit',
      exitCode: 3,
      reason: 'V2_EXTENSION_CONFIG',
      message: 'upfly.config.json belongs to the Upfly VS Code extension (v2).',
    };
    child.print(error);
    child.exit(3);
    expect(await handle.outcome).toEqual({ kind: 'stopped', error });
  });

  it('calls it a crash when the process exits without a result or an error line', async () => {
    const { child, handle } = start();
    child.print({ type: 'progress', command: 'audit', stage: 'scanned', references: 1 });
    child.complain('FATAL ERROR: Reached heap limit\n');
    child.exit(134);
    const outcome = await handle.outcome;
    expect(outcome.kind).toBe('crashed');
    if (outcome.kind !== 'crashed') return;
    expect(outcome.message).toContain('exit code 134');
    expect(outcome.detail).toContain('Reached heap limit');
  });

  it('calls it a crash when the exit code differs from the one the result line gives', async () => {
    const { child, handle } = start();
    child.print(AUDIT_RESULT);
    child.exit(4);
    expect((await handle.outcome).kind).toBe('crashed');
  });

  it('passes on a line that is not JSON and still reads the result after it', async () => {
    const stray: string[] = [];
    const { child, handle } = start({ onStray: (line) => stray.push(line) });
    child.print('preloaded by NODE_OPTIONS');
    child.print(AUDIT_RESULT);
    child.exit(0);
    expect((await handle.outcome).kind).toBe('result');
    expect(stray).toEqual(['preloaded by NODE_OPTIONS']);
  });

  it('calls it a crash when the output stops part way through the last line', async () => {
    const { child, handle } = start();
    child.stdout.write('{"type":"result","command":"audit","exitCode":0,"rep');
    child.exit(0);
    expect((await handle.outcome).kind).toBe('crashed');
  });

  it('calls it a crash when Node.js cannot be started', async () => {
    const { child, handle } = start();
    child.emit('error', Object.assign(new Error('spawn /editor/node ENOENT'), { code: 'ENOENT' }));
    const outcome = await handle.outcome;
    expect(outcome.kind).toBe('crashed');
    if (outcome.kind === 'crashed') expect(outcome.detail).toContain('ENOENT');
  });

  it('keeps only the end of a long error stream', async () => {
    const { child, handle } = start();
    child.complain(`${'x'.repeat(100_000)}the last words`);
    child.exit(1);
    const outcome = await handle.outcome;
    if (outcome.kind !== 'crashed') throw new Error('expected a crash');
    expect(outcome.detail.length).toBeLessThan(20_000);
    expect(outcome.detail).toContain('the last words');
  });

  it('ends the process on Cancel and ends as cancelled', async () => {
    const { child, handle } = start();
    child.print({ type: 'progress', command: 'audit', stage: 'scanned', references: 1 });
    handle.cancel();
    expect(child.signals).toEqual([undefined]);
    child.exit(null, 'SIGTERM');
    expect(await handle.outcome).toEqual({ kind: 'cancelled' });
  });

  it('forces the process to end when it has not ended a few seconds after Cancel', () => {
    vi.useFakeTimers();
    const { child, handle } = start();
    handle.cancel();
    vi.advanceTimersByTime(5_000);
    expect(child.signals).toEqual([undefined, 'SIGKILL']);
  });

  it('does nothing on Cancel once the run has ended', async () => {
    const { child, handle } = start();
    child.print(AUDIT_RESULT);
    child.exit(0);
    await handle.outcome;
    handle.cancel();
    expect(child.signals).toEqual([]);
  });
});
