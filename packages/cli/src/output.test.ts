import { WriteStream } from 'node:tty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Output,
  PLAIN,
  colourDepth,
  colourFor,
  progressReporter,
  stopWith,
  stylesFor,
} from './output.js';

const terminal: Output = { write: () => true, isTTY: true };
const pipe: Output = { write: () => true };
const plain = { json: false, noColor: false };

describe('colourFor', () => {
  it('colours a terminal and nothing else', () => {
    expect(colourFor(terminal, {}, plain)).toBe(true);
    expect(colourFor(pipe, {}, plain)).toBe(false);
  });

  it('turns colour off for --no-color, --json and a non-empty NO_COLOR', () => {
    expect(colourFor(terminal, {}, { json: false, noColor: true })).toBe(false);
    expect(colourFor(terminal, {}, { json: true, noColor: false })).toBe(false);
    expect(colourFor(terminal, { NO_COLOR: '1' }, plain)).toBe(false);
    expect(colourFor(terminal, { NO_COLOR: 'false' }, plain)).toBe(false);
  });

  it('keeps colour when NO_COLOR is set but empty, as the convention says', () => {
    expect(colourFor(terminal, { NO_COLOR: '' }, plain)).toBe(true);
  });

  it('turns colour off on a terminal that calls itself dumb', () => {
    expect(colourFor(terminal, { TERM: 'dumb' }, plain)).toBe(false);
  });
});

/** A terminal that reports `bits` of colour, as Node's terminal streams do. */
function showing(bits: number): Output {
  return { write: () => true, isTTY: true, getColorDepth: () => bits };
}

describe('colourDepth', () => {
  it('takes the depth the stream reports: 24-bit, 256, or 16 and fewer', () => {
    expect(colourDepth(showing(24), {})).toBe('truecolor');
    expect(colourDepth(showing(8), {})).toBe('256');
    expect(colourDepth(showing(4), {})).toBe('basic');
    expect(colourDepth(showing(1), {})).toBe('basic');
    expect(colourDepth(terminal, {})).toBe('basic');
  });

  it('asks without NO_COLOR, which colourFor has read, and which Node reads as off even when empty', () => {
    const asked: object[] = [];
    const stream: Output = {
      write: () => true,
      isTTY: true,
      getColorDepth: (env) => {
        asked.push(env ?? {});
        return 24;
      },
    };
    expect(colourDepth(stream, { NO_COLOR: '', TERM: 'xterm' })).toBe('truecolor');
    expect(asked).toEqual([{ TERM: 'xterm' }]);
  });

  it("follows Node's own answer, which reads COLORTERM on every platform", () => {
    const node: Output = { ...terminal, getColorDepth: WriteStream.prototype.getColorDepth };
    expect(colourDepth(node, { COLORTERM: 'truecolor' })).toBe('truecolor');
  });

  it.runIf(process.platform === 'win32')(
    'finds 24-bit colour on Windows, whose consoles set no COLORTERM',
    () => {
      const node: Output = { ...terminal, getColorDepth: WriteStream.prototype.getColorDepth };
      expect(colourDepth(node, {})).toBe('truecolor');
    },
  );
});

describe('stylesFor', () => {
  it('marks nothing when colour is off', () => {
    const off = stylesFor(showing(24), { NO_COLOR: '1' }, plain);
    expect([off.accent('x'), off.bold('x'), off.dim('x'), off.red('x')]).toEqual([
      'x',
      'x',
      'x',
      'x',
    ]);
    expect(stylesFor(pipe, {}, plain).accent('x')).toBe('x');
    expect([PLAIN.accent('x'), PLAIN.bold('x'), PLAIN.dim('x'), PLAIN.red('x')]).toEqual([
      'x',
      'x',
      'x',
      'x',
    ]);
  });

  it('marks the next command bold, secondary lines dim and a failure red at every depth', () => {
    for (const bits of [4, 8, 24]) {
      const on = stylesFor(showing(bits), {}, plain);
      expect(on.bold('x')).toBe('\u001b[1mx\u001b[22m');
      expect(on.dim('x')).toBe('\u001b[2mx\u001b[22m');
      expect(on.red('x')).toBe('\u001b[31mx\u001b[39m');
      expect(on.dim('')).toBe('');
    }
  });

  it('gives the coral in bold at the depth the terminal shows, and bold alone, never a red, with 16 colours', () => {
    expect(stylesFor(showing(24), {}, plain).accent('x')).toBe(
      '\u001b[1;38;2;232;54;95mx\u001b[22;39m',
    );
    expect(stylesFor(showing(8), {}, plain).accent('x')).toBe('\u001b[1;38;5;161mx\u001b[22;39m');
    expect(stylesFor(showing(4), {}, plain).accent('x')).toBe('\u001b[1mx\u001b[22m');
    expect(stylesFor(showing(1), {}, plain).accent('x')).toBe('\u001b[1mx\u001b[22m');
  });

  it('picks, of the 256, the colour nearest the coral as the eye sees it', () => {
    // CIE76: the distance between two colours in CIELAB, under the D65 white point.
    const lab = ([r, g, b]: readonly number[]) => {
      const linear = [r, g, b].map((c) => {
        const s = (c ?? 0) / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      const [R = 0, G = 0, B = 0] = linear;
      const xyz = [
        (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047,
        0.2126 * R + 0.7152 * G + 0.0722 * B,
        (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883,
      ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
      const [x = 0, y = 0, z = 0] = xyz;
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const distance = (a: readonly number[], b: readonly number[]) => {
      const [p, q] = [lab(a), lab(b)];
      return Math.hypot(...p.map((value, index) => value - (q[index] ?? 0)));
    };
    const levels = [0, 95, 135, 175, 215, 255];
    const cube = Array.from({ length: 216 }, (_, n) => ({
      index: 16 + n,
      rgb: [
        levels[Math.floor(n / 36)] ?? 0,
        levels[Math.floor(n / 6) % 6] ?? 0,
        levels[n % 6] ?? 0,
      ],
    }));
    const coral = [232, 54, 95];
    const nearest = cube.reduce((best, each) =>
      distance(each.rgb, coral) < distance(best.rgb, coral) ? each : best,
    );
    expect(nearest.index).toBe(161);
  });
});

describe('progressReporter', () => {
  function capture(isTTY: boolean) {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (text: string) => out.push(text), isTTY },
      stderr: { write: (text: string) => err.push(text), isTTY },
      env: {},
    };
    return { io, out, err };
  }

  it('writes a JSON line per stage under --json', () => {
    const { io, out, err } = capture(false);
    const progress = progressReporter(io, 'audit', true);
    progress.update({ stage: 'discovered', images: 3, files: 9 });
    expect(out).toEqual([
      '{"type":"progress","command":"audit","stage":"discovered","images":3,"files":9}\n',
    ]);
    expect(err).toEqual([]);
  });

  it('overwrites one line on a terminal and clears it after', () => {
    const { io, out, err } = capture(true);
    const progress = progressReporter(io, 'audit', false);
    progress.update({ stage: 'scanned', references: 12 });
    progress.clear();
    expect(out).toEqual([]);
    expect(err).toEqual(['\r\u001b[2Kscanned: 12 references', '\r\u001b[2K']);
  });

  it('counts the images while they are measured, in words', () => {
    const { io, err } = capture(true);
    const progress = progressReporter(io, 'optimize', false);
    progress.update({ stage: 'measuring', done: 120, total: 2910 });
    expect(err).toEqual(['\r\u001b[2Kmeasuring images: 120 of 2910']);
    progress.clear();
  });

  it('shows every measuring count on a terminal, and writes twenty of a big run as JSON lines', () => {
    const terminal = capture(true);
    const json = capture(false);
    const shown = progressReporter(terminal.io, 'audit', false);
    const written = progressReporter(json.io, 'audit', true);
    for (let done = 1; done <= 1004; done += 1) {
      shown.update({ stage: 'measuring', done, total: 1004 });
      written.update({ stage: 'measuring', done, total: 1004 });
    }

    expect(terminal.err).toHaveLength(1004);
    expect(terminal.err.at(-1)).toBe('\r\u001b[2Kmeasuring images: 1004 of 1004');
    expect(json.out).toHaveLength(20);
    expect(json.out[0]).toBe(
      '{"type":"progress","command":"audit","stage":"measuring","done":51,"total":1004}\n',
    );
    expect(json.out.at(-1)).toBe(
      '{"type":"progress","command":"audit","stage":"measuring","done":1004,"total":1004}\n',
    );
    shown.clear();
  });

  it('names a count of one in the singular', () => {
    const { io, err } = capture(true);
    const progress = progressReporter(io, 'optimize', false);
    progress.update({ stage: 'measured', images: 1 });
    expect(err).toEqual(['\r\u001b[2Kmeasured: 1 image']);
    progress.clear();
  });

  it('says nothing when stderr is a file or a pipe', () => {
    const { io, out, err } = capture(false);
    const progress = progressReporter(io, 'audit', false);
    progress.update({ stage: 'scanned', references: 12 });
    progress.clear();
    expect([...out, ...err]).toEqual([]);
  });

  it('never keeps the process alive: Node does not wait for its timer', () => {
    const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout');
    const before = timers().length;
    const { io } = capture(true);
    const progress = progressReporter(io, 'audit', false);
    progress.update({ stage: 'scanned', references: 12 });
    expect(timers()).toHaveLength(before);
    progress.clear();
  });

  describe('on a terminal, while the next stage works', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('moves one to three dots beside the line, changing it four times a second', () => {
      const { io, err } = capture(true);
      const progress = progressReporter(io, 'audit', false);
      progress.update({ stage: 'discovered', images: 3, files: 9 });
      vi.advanceTimersByTime(1000);
      expect(err).toEqual([
        '\r\u001b[2Kdiscovered: 3 images, 9 files',
        '\r\u001b[2Kdiscovered: 3 images, 9 files .',
        '\r\u001b[2Kdiscovered: 3 images, 9 files ..',
        '\r\u001b[2Kdiscovered: 3 images, 9 files ...',
        '\r\u001b[2Kdiscovered: 3 images, 9 files .',
      ]);
      progress.clear();
    });

    it("writes each stage's line as it reads without them, with no dot left over", () => {
      const { io, err } = capture(true);
      const progress = progressReporter(io, 'audit', false);
      progress.update({ stage: 'scanned', references: 12 });
      vi.advanceTimersByTime(600);
      expect(err.at(-1)).toBe('\r\u001b[2Kscanned: 12 references ..');
      progress.update({ stage: 'resolved', linked: 9 });
      expect(err.at(-1)).toBe('\r\u001b[2Kresolved: 9 linked');
      vi.advanceTimersByTime(249);
      expect(err.at(-1)).toBe('\r\u001b[2Kresolved: 9 linked');
      vi.advanceTimersByTime(1);
      expect(err.at(-1)).toBe('\r\u001b[2Kresolved: 9 linked .');
      progress.clear();
    });

    it('leaves the measuring count as it is while it moves, and moves the dots where it stops', () => {
      const { io, err } = capture(true);
      const progress = progressReporter(io, 'optimize', false);
      for (let done = 1; done <= 30; done += 1) {
        progress.update({ stage: 'measuring', done, total: 31 });
        vi.advanceTimersByTime(200);
      }
      expect(err).toHaveLength(30);
      expect(err.every((text) => !text.endsWith('.'))).toBe(true);
      vi.advanceTimersByTime(50);
      expect(err.at(-1)).toBe('\r\u001b[2Kmeasuring images: 30 of 31 .');
      progress.update({ stage: 'measuring', done: 31, total: 31 });
      expect(err.at(-1)).toBe('\r\u001b[2Kmeasuring images: 31 of 31');
      progress.clear();
    });

    it('moves the dots alone before the first line, while the project is walked', () => {
      const { io, err } = capture(true);
      const progress = progressReporter(io, 'check', false);
      vi.advanceTimersByTime(750);
      progress.update({ stage: 'discovered', images: 3, files: 9 });
      expect(err).toEqual([
        '\r\u001b[2K.',
        '\r\u001b[2K..',
        '\r\u001b[2K...',
        '\r\u001b[2Kdiscovered: 3 images, 9 files',
      ]);
      progress.clear();
    });

    it('stops the dots when it clears the line, so nothing is written after', () => {
      const { io, err } = capture(true);
      const progress = progressReporter(io, 'audit', false);
      progress.update({ stage: 'audited', findings: 2 });
      vi.advanceTimersByTime(300);
      progress.clear();
      vi.advanceTimersByTime(5000);
      expect(err).toEqual([
        '\r\u001b[2Kaudited: 2 findings',
        '\r\u001b[2Kaudited: 2 findings .',
        '\r\u001b[2K',
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('starts no timer and writes no dot when stderr is a file or a pipe, or under --json', () => {
      const piped = capture(false);
      const json = capture(true);
      const quiet = progressReporter(piped.io, 'audit', false);
      const lines = progressReporter(json.io, 'audit', true);
      quiet.update({ stage: 'scanned', references: 12 });
      lines.update({ stage: 'scanned', references: 12 });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      quiet.clear();
      lines.clear();
      expect([...piped.out, ...piped.err, ...json.err]).toEqual([]);
      expect(json.out).toEqual([
        '{"type":"progress","command":"audit","stage":"scanned","references":12}\n',
      ]);
    });
  });
});

describe('stopWith', () => {
  function capture(env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (text: string) => out.push(text), isTTY: true },
      stderr: { write: (text: string) => err.push(text), isTTY: true },
      env,
    };
    return { io, out, err };
  }
  const style = { command: 'optimize' as const, json: false, noColor: false };

  it('names the refusal in a JSON error line under --json, and returns the code', () => {
    const { io, out, err } = capture();
    const code = stopWith(io, { ...style, json: true }, 3, 'Commit first.', 'UNCOMMITTED_CHANGES');

    expect(code).toBe(3);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'error',
        command: 'optimize',
        exitCode: 3,
        reason: 'UNCOMMITTED_CHANGES',
        message: 'Commit first.',
      },
    ]);
    expect(err).toEqual([]);
  });

  it('leaves the reason out of a usage error, which has none', () => {
    const { io, out } = capture();
    stopWith(io, { ...style, json: true }, 2, 'site is not a directory');
    expect(JSON.parse(out[0] ?? '{}')).not.toHaveProperty('reason');
  });

  it('writes to stderr in red on a terminal, and plainly under NO_COLOR or --no-color', () => {
    const coloured = capture();
    const noColorEnv = capture({ NO_COLOR: '1' });
    const noColorFlag = capture();

    stopWith(coloured.io, style, 3, 'Commit first.');
    stopWith(noColorEnv.io, style, 3, 'Commit first.');
    stopWith(noColorFlag.io, { ...style, noColor: true }, 3, 'Commit first.');

    expect(coloured.err).toEqual(['\u001b[31mupfly:\u001b[39m Commit first.\n']);
    expect(noColorEnv.err).toEqual(['upfly: Commit first.\n']);
    expect(noColorFlag.err).toEqual(['upfly: Commit first.\n']);
    expect([...coloured.out, ...noColorEnv.out, ...noColorFlag.out]).toEqual([]);
  });
});
