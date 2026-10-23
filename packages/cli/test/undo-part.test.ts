/**
 * `upfly undo --file` and `--line`, which undo part of the last run, and `--list`, which
 * shows what it changed, through the built binary on copies of the plain HTML fixture and of
 * two runs recorded by Upfly 3.1.0.
 */

import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  commitAll,
  copyFixture,
  jsonLines,
  snapshot,
  tempFolder,
  upfly,
  write,
} from './helpers.js';

beforeAll(() => {
  expect(existsSync(BIN), `${BIN} is missing; run pnpm build first`).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOT_THE_PROJECT = ['.git', '.upfly'];
const RECORDED_BY_310 = fileURLToPath(new URL('../../core/fixtures/undo-3.1.0/', import.meta.url));

/** The lines of the plain HTML fixture's pages that hold a reference the run rewrites. */
const CHANGED = [
  ['index.html', 10],
  ['index.html', 12],
  ['index.html', 13],
  ['index.html', 15],
  ['css/site.css', 2],
] as const;

function result(stdout: string): Record<string, unknown> {
  return jsonLines(stdout).at(-1) ?? {};
}

/** A committed copy of the plain HTML fixture with an applied run that removes originals. */
function applied(): { root: string; before: Record<string, string>; run: Run } {
  const root = copyFixture('plain-html', tempFolder(roots, 'upfly-part-'));
  commitAll(root);
  const before = snapshot(root, NOT_THE_PROJECT);
  const optimize = upfly(['optimize', root, '--apply', '--replace', '--public', '.', '--json']);
  expect(optimize.status, optimize.stderr).toBe(0);
  return { root, before, run: result(optimize.stdout).run as Run };
}

interface Run {
  readonly id: string;
  readonly created: string[];
  readonly changed: string[];
  readonly removed: string[];
}

/** `upfly undo` run from inside the project, as a person types it there. */
function undo(root: string, ...args: string[]) {
  return upfly(['undo', ...args], { cwd: root });
}

function lineOf(root: string, file: string, line: number): string {
  return readFileSync(join(root, file), 'utf8').split('\n')[line - 1] ?? '';
}

describe('undoing one line of the last run', () => {
  it('puts back that line alone and brings back the original it names, leaving the new file', () => {
    const { root, before, run } = applied();
    expect(run.removed).toContain('images/logo.png');
    const afterRun = snapshot(root, NOT_THE_PROJECT);

    const part = undo(root, '--file', 'index.html', '--line', '10', '--json');

    expect(part.status, part.stderr).toBe(0);
    expect(result(part.stdout)).toMatchObject({
      type: 'result',
      command: 'undo',
      exitCode: 0,
      part: { file: 'index.html', line: 10 },
      undone: { id: run.id, reverted: ['index.html'], restored: ['images/logo.png'], removed: [] },
    });
    expect(lineOf(root, 'index.html', 10)).toContain('images/logo.png');
    const now = snapshot(root, NOT_THE_PROJECT);
    const changed = Object.keys(now).filter((path) => now[path] !== afterRun[path]);
    expect(changed.sort()).toEqual(['images/logo.png', 'index.html']);
    expect(now['images/logo.png']).toBe(before['images/logo.png']);
    expect(now['images/logo.webp']).toBe(afterRun['images/logo.webp']);
    for (const [file, line] of CHANGED) {
      if (line !== 10) expect(lineOf(root, file, line)).toContain('.webp');
    }
  }, 60_000);

  it('brings back every original a line names, and only those', () => {
    const { root, before } = applied();

    const part = undo(root, '--file', 'index.html', '--line', '12', '--json');

    expect(part.status, part.stderr).toBe(0);
    expect(result(part.stdout)).toMatchObject({
      undone: { restored: ['images/hero.jpg', 'images/hero@2x.jpg'] },
    });
    const now = snapshot(root, NOT_THE_PROJECT);
    expect(now['images/hero.jpg']).toBe(before['images/hero.jpg']);
    expect(now['images/hero@2x.jpg']).toBe(before['images/hero@2x.jpg']);
    expect(now['images/logo.png']).toBeUndefined();
    expect(lineOf(root, 'index.html', 13)).toContain('images/hero.webp');
  }, 60_000);

  it('does nothing the second time, and says the line is undone already', () => {
    const { root } = applied();
    expect(undo(root, '--file', 'index.html', '--line', '10').status).toBe(0);
    const once = snapshot(root, NOT_THE_PROJECT);
    const record = readFileSync(join(root, '.upfly/manifest.json'), 'utf8');

    const again = undo(root, '--file', 'index.html', '--line', '10', '--json');
    const text = undo(root, '--file', 'index.html', '--line', '10');

    expect(again.status, again.stderr).toBe(0);
    expect(result(again.stdout)).toMatchObject({
      undone: null,
      part: { file: 'index.html', line: 10 },
      notes: [expect.stringContaining('already undone')],
    });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('already undone');
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(once);
    expect(readFileSync(join(root, '.upfly/manifest.json'), 'utf8')).toBe(record);
  }, 60_000);
});

describe('undoing one file of the last run', () => {
  it('puts back each of its lines and every original they name, and no other file', () => {
    const { root, before, run } = applied();
    const afterRun = snapshot(root, NOT_THE_PROJECT);

    const part = undo(root, '--file', 'index.html', '--json');

    expect(part.status, part.stderr).toBe(0);
    expect(result(part.stdout)).toMatchObject({
      part: { file: 'index.html', line: null },
      undone: {
        reverted: ['index.html'],
        restored: ['images/hero.jpg', 'images/hero@2x.jpg', 'images/inline.png', 'images/logo.png'],
      },
    });
    const now = snapshot(root, NOT_THE_PROJECT);
    expect(now['index.html']).toBe(before['index.html']);
    expect(now['css/site.css']).toBe(afterRun['css/site.css']);
    expect(now['images/texture.png']).toBeUndefined();
    for (const created of run.created) expect(now[created]).toBe(afterRun[created]);
  }, 60_000);

  it('takes the path of a removed original and brings that one back alone', () => {
    const { root, before } = applied();
    const afterRun = snapshot(root, NOT_THE_PROJECT);

    const part = undo(root, '--file', 'images/texture.png', '--json');

    expect(part.status, part.stderr).toBe(0);
    expect(result(part.stdout)).toMatchObject({
      undone: { reverted: [], restored: ['images/texture.png'] },
    });
    const now = snapshot(root, NOT_THE_PROJECT);
    expect(now['images/texture.png']).toBe(before['images/texture.png']);
    expect({ ...now, 'images/texture.png': undefined }).toEqual({
      ...afterRun,
      'images/texture.png': undefined,
    });
  }, 60_000);
});

describe('a file changed since the run, or since its last partial undo', () => {
  it('is refused with exit 3 and the reason the whole undo gives, and nothing is written', () => {
    const { root } = applied();
    write(root, 'index.html', `${readFileSync(join(root, 'index.html'), 'utf8')}<!-- edited -->\n`);
    const before = snapshot(root, NOT_THE_PROJECT);
    const record = readFileSync(join(root, '.upfly/manifest.json'), 'utf8');

    const part = undo(root, '--file', 'index.html', '--line', '10', '--json');
    const whole = undo(root, '--json');

    expect(part.status).toBe(3);
    expect(result(part.stdout)).toMatchObject({
      type: 'error',
      reason: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('index.html'),
    });
    expect(whole.status).toBe(3);
    expect((result(part.stdout) as { message: string }).message).toBe(
      (result(whole.stdout) as { message: string }).message,
    );
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
    expect(readFileSync(join(root, '.upfly/manifest.json'), 'utf8')).toBe(record);
  }, 60_000);

  it('is refused after a partial undo too, when the file was edited since that undo', () => {
    const { root } = applied();
    expect(undo(root, '--file', 'index.html', '--line', '10').status).toBe(0);
    write(root, 'index.html', `${readFileSync(join(root, 'index.html'), 'utf8')}<!-- edited -->\n`);
    const before = snapshot(root, NOT_THE_PROJECT);

    const part = undo(root, '--file', 'index.html', '--line', '13', '--json');

    expect(part.status).toBe(3);
    expect(result(part.stdout)).toMatchObject({ reason: 'TRANSACTION_FOREIGN_CHANGE' });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 60_000);
});

/**
 * Orders of partial undos, each followed by the whole run's undo. The whole undo must put
 * every byte back whatever came before it.
 */
const SEQUENCES: readonly (readonly (readonly [string, number | null])[])[] = [
  CHANGED,
  [...CHANGED].reverse(),
  [
    ['css/site.css', null],
    ['index.html', 13],
  ],
  [
    ['index.html', 12],
    ['index.html', null],
    ['index.html', 12],
  ],
  [
    ['images/hero.jpg', null],
    ['index.html', 15],
    ['images/logo.png', null],
  ],
];

describe('the whole run undone after partial undos', () => {
  it.each(
    SEQUENCES.map((sequence) => [sequence.map(([f, l]) => `${f}:${l ?? '*'}`).join(' '), sequence]),
  )(
    'puts every byte back, after %s',
    (_name, sequence) => {
      const { root, before, run } = applied();
      for (const [file, line] of sequence) {
        const args = line === null ? ['--file', file] : ['--file', file, '--line', String(line)];
        const part = undo(root, ...args);
        expect(part.status, `${file} ${line}: ${part.stderr}`).toBe(0);
      }

      const whole = undo(root, '--json');

      expect(whole.status, whole.stderr).toBe(0);
      const now = snapshot(root, NOT_THE_PROJECT);
      for (const path of [...run.created, ...run.changed, ...run.removed]) {
        expect(now[path], path).toBe(before[path]);
      }
      expect(now).toEqual(before);
    },
    120_000,
  );
});

describe('undo --list', () => {
  it('lists each line the run changed, with its paths before and after and whether it is undone', () => {
    const { root } = applied();
    expect(undo(root, '--file', 'index.html', '--line', '12').status).toBe(0);
    const before = snapshot(root, NOT_THE_PROJECT);

    const listed = undo(root, '--list', '--json');

    expect(listed.status, listed.stderr).toBe(0);
    const run = (result(listed.stdout) as { run: ListedRun }).run;
    expect(run.state).toBe('applied');
    const index = run.files.find((file) => file.path === 'index.html');
    expect(index?.changedSince).toBe(false);
    expect(index?.changes.map((change) => [change.line, change.undone])).toEqual([
      [10, false],
      [12, true],
      [13, false],
      [15, false],
    ]);
    expect(index?.changes[1]?.paths).toEqual([
      {
        before: 'images/hero.jpg',
        after: 'images/hero.webp',
        image: 'images/hero.jpg',
        inComment: false,
      },
      {
        before: 'images/hero@2x.jpg',
        after: 'images/hero@2x.webp',
        image: 'images/hero@2x.jpg',
        inComment: false,
      },
    ]);
    expect(run.originals).toContainEqual({
      path: 'images/hero.jpg',
      movedTo: null,
      back: true,
      changedSince: false,
    });
    expect(run.originals).toContainEqual({
      path: 'images/logo.png',
      movedTo: null,
      back: false,
      changedSince: false,
    });
    expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
  }, 60_000);

  it('prints each changed file with its lines, and the commands that undo them', () => {
    const { root } = applied();

    const listed = undo(root, '--list');

    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('index.html');
    expect(listed.stdout).toContain('line 10  images/logo.png → images/logo.webp');
    expect(listed.stdout).toContain('images/logo.png     removed');
    expect(listed.stdout).toContain('Undo one line  npx upfly undo --file css/site.css --line 2');
  }, 60_000);
});

interface ListedRun {
  readonly state: string;
  readonly files: {
    readonly path: string;
    readonly changedSince: boolean;
    readonly changes: {
      readonly line: number | null;
      readonly undone: boolean | null;
      readonly paths: unknown[];
    }[];
  }[];
  readonly originals: unknown[];
}

describe('what cannot be undone on its own', () => {
  it.each([
    [['--line', '10'], 2, undefined, '--line needs --file'],
    [['--file', 'index.html', '--line', '0'], 2, undefined, '--line takes'],
    [['--file', 'index.html', '--line', 'ten'], 2, undefined, '--line takes'],
    [['--file', 'index.html', '--line', '11'], 2, 'NOT_IN_RUN', 'lines 10, 12, 13 and 15'],
    [['--file', 'about.html'], 2, 'NOT_IN_RUN', 'did not change about.html'],
    [['--file', 'images/logo.webp'], 2, 'NOT_IN_RUN', 'created'],
    [['--file', '../outside.html'], 2, undefined, 'outside the project'],
    [['--list', '--line', '10', '--file', 'index.html'], 2, undefined, 'cannot be used together'],
  ] as const)(
    '%j exits %i',
    (args, status, reason, says) => {
      const { root } = applied();
      const before = snapshot(root, NOT_THE_PROJECT);

      const refused = undo(root, ...args, '--json');

      expect(refused.status, refused.stdout).toBe(status);
      const line = result(refused.stdout) as { reason?: string; message: string };
      expect(line.reason).toBe(reason);
      expect(line.message).toContain(says);
      expect(snapshot(root, NOT_THE_PROJECT)).toEqual(before);
    },
    60_000,
  );

  it('refuses part of a run that stopped part way, naming the whole undo', () => {
    const { root } = applied();
    const path = join(root, '.upfly/manifest.json');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('"state": "committed"', '"state": "pending"'),
    );

    const part = undo(root, '--file', 'index.html', '--line', '10', '--json');

    expect(part.status).toBe(3);
    expect(result(part.stdout)).toMatchObject({ reason: 'TRANSACTION_INTERRUPTED' });
  }, 60_000);
});

/**
 * A run as Upfly 3.1.0 left it: a copy of its project after the run, with the record in
 * `.upfly/`, and the project as it was before, to compare against.
 */
function recordedBy310(kind: 'optimize' | 'move'): { root: string; before: string } {
  const root = tempFolder(roots, `upfly-310-${kind}-`);
  cpSync(join(RECORDED_BY_310, kind, 'after'), root, { recursive: true });
  renameSync(join(root, 'dot-upfly'), join(root, '.upfly'));
  return { root, before: join(RECORDED_BY_310, kind, 'before') };
}

describe('a run recorded by Upfly 3.1.0', () => {
  it('is listed, with the lines worked out from the files', () => {
    const { root } = recordedBy310('optimize');

    const listed = undo(root, '--list', '--json');

    expect(listed.status, listed.stderr).toBe(0);
    const run = (result(listed.stdout) as { run: ListedRun }).run;
    expect(run.files.map((file) => [file.path, file.changes.map((change) => change.line)])).toEqual(
      [
        ['css/site.css', [2]],
        ['index.html', [9, 10]],
      ],
    );
    expect(run.files[1]?.changes[0]?.paths).toEqual([
      { before: 'images/logo.png', after: 'images/logo.webp', image: null, inComment: false },
    ]);
  }, 60_000);

  it('undoes one line, bringing back the original of that name, then the whole run byte for byte', () => {
    const { root, before } = recordedBy310('optimize');

    const part = undo(root, '--file', 'index.html', '--line', '10', '--json');

    expect(part.status, part.stderr).toBe(0);
    expect(result(part.stdout)).toMatchObject({
      undone: { reverted: ['index.html'], restored: ['images/logo.png'] },
    });
    expect(lineOf(root, 'index.html', 9)).toContain('images/logo.webp');
    const whole = undo(root);
    expect(whole.status, whole.stderr).toBe(0);
    expect(snapshot(root, ['.upfly'])).toEqual(snapshot(before));
  }, 60_000);

  it('undoes as a whole, as 3.1.0 itself would', () => {
    const { root, before } = recordedBy310('optimize');

    const whole = undo(root, '--json');

    expect(whole.status, whole.stderr).toBe(0);
    expect(snapshot(root, ['.upfly'])).toEqual(snapshot(before));
  }, 60_000);

  it('undoes a line of a move by copying the image back, then the whole move', () => {
    const { root, before } = recordedBy310('move');

    const part = undo(root, '--file', 'index.html', '--line', '4', '--json');

    expect(part.status, part.stderr).toBe(0);
    expect(result(part.stdout)).toMatchObject({
      undone: { moved: [{ from: 'images/logo.png', to: 'assets/logo.png' }] },
    });
    expect(existsSync(join(root, 'assets/logo.png'))).toBe(true);
    expect(existsSync(join(root, 'images/logo.png'))).toBe(true);
    const whole = undo(root);
    expect(whole.status, whole.stderr).toBe(0);
    expect(snapshot(root, ['.upfly'])).toEqual(snapshot(before));
  }, 60_000);
});
