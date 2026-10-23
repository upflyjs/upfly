import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFileStore } from './file-store-node.js';
import { MANIFEST_PATH, type Manifest, parseManifest } from './manifest.js';
import {
  type FileStore,
  type PlannedOperation,
  checkedVersion,
  commit,
  readManifest,
  revert,
} from './transaction.js';
import { type RunPart, describeRun, undoPart } from './undo-part.js';

const RUN_DIR = '.upfly/runs/r1';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const APP =
  "import logo from './logo.png';\nconst again = './logo.png';\nconst hero = '/hero.png';\n";
const CSS = 'a { background: url(./logo.png); }\n';

/** A project before the run, with the run's staged file and backup already in its folder. */
function tree(): Record<string, string> {
  return {
    'src/App.jsx': APP,
    'src/b.css': CSS,
    'src/logo.png': 'PNG-BYTES',
    'public/hero.png': 'HERO-BYTES',
    [`${RUN_DIR}/staged/src/logo.webp`]: 'WEBP-BYTES',
    [`${RUN_DIR}/backup/src/logo.png`]: 'PNG-BYTES',
  };
}

/** Edits of one path written as `from`, to `to`, each naming `asset` before the run. */
function edits(text: string, from: string, to: string, asset: string, only?: number[]) {
  const found: {
    start: number;
    end: number;
    replacement: string;
    expected: string;
    asset: string;
  }[] = [];
  for (let at = text.indexOf(from); at !== -1; at = text.indexOf(from, at + 1)) {
    found.push({ start: at, end: at + from.length, replacement: to, expected: from, asset });
  }
  return only === undefined ? found : found.filter((_, index) => only.includes(index));
}

/**
 * A run of all four kinds: `logo.png` converted and removed, `hero.png` moved, and three
 * lines of `App.jsx` and one of `b.css` rewritten to follow.
 */
function plan(): PlannedOperation[] {
  const appEdits = [
    ...edits(APP, './logo.png', './logo.webp', 'src/logo.png'),
    ...edits(APP, '/hero.png', '/img/hero.png', 'public/hero.png'),
  ].sort((a, b) => a.start - b.start);
  const cssEdits = edits(CSS, './logo.png', './logo.webp', 'src/logo.png');
  const apply = (text: string, list: typeof appEdits) =>
    [...list]
      .reverse()
      .reduce((out, e) => out.slice(0, e.start) + e.replacement + out.slice(e.end), text);
  return [
    {
      kind: 'create',
      path: 'src/logo.webp',
      staged: 'staged/src/logo.webp',
      afterHash: sha('WEBP-BYTES'),
    },
    { kind: 'move', from: 'public/hero.png', to: 'public/img/hero.png', hash: sha('HERO-BYTES') },
    {
      kind: 'edit',
      path: 'src/App.jsx',
      beforeHash: sha(APP),
      afterHash: sha(apply(APP, appEdits)),
      edits: appEdits,
    },
    {
      kind: 'edit',
      path: 'src/b.css',
      beforeHash: sha(CSS),
      afterHash: sha(apply(CSS, cssEdits)),
      edits: cssEdits,
    },
    {
      kind: 'delete',
      path: 'src/logo.png',
      beforeHash: sha('PNG-BYTES'),
      backup: 'backup/src/logo.png',
    },
  ];
}

function context() {
  let tick = 0;
  return {
    runId: 'r1',
    runDir: RUN_DIR,
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    declined: [],
  };
}

/** Every store these tests run on, the in-memory one and a real folder, with failures injected. */
interface Harness {
  readonly store: FileStore;
  projectFiles(): Promise<Record<string, string>>;
  record(): Promise<Manifest>;
  failAfter(count: number): void;
  stopFailing(): void;
  mutations(): number;
  edit(path: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

function interruptible(store: FileStore) {
  let mutations = 0;
  let limit = Number.POSITIVE_INFINITY;
  const mutate = (): void => {
    mutations += 1;
    if (mutations > limit) throw new Error(`injected failure at mutation ${mutations}`);
  };
  const wrapped: FileStore = {
    hashAlgorithm: store.hashAlgorithm,
    hash: (path) => store.hash(path),
    readText: (path) => store.readText(path),
    readForSearch: (path) => store.readForSearch(path),
    async writeText(path, text) {
      mutate();
      await store.writeText(path, text);
    },
    createExclusive: (path, text) => store.createExclusive(path, text),
    async copy(from, to) {
      mutate();
      await store.copy(from, to);
    },
    async remove(path) {
      mutate();
      await store.remove(path);
    },
    listDirectory: (path) => store.listDirectory(path),
    async removeDirectory(path) {
      mutate();
      await store.removeDirectory(path);
    },
  };
  return {
    store: wrapped,
    mutations: () => mutations,
    failAfter: (count: number) => {
      mutations = 0;
      limit = count;
    },
    stopFailing: () => {
      limit = Number.POSITIVE_INFINITY;
    },
  };
}

function memoryFiles(files: Map<string, string>): FileStore {
  return {
    hashAlgorithm: 'sha256',
    hash: async (path) => {
      const text = files.get(path);
      return text === undefined ? null : sha(text);
    },
    readText: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    readForSearch: async (path) => files.get(path) ?? '',
    writeText: async (path, text) => {
      files.set(path, text);
    },
    createExclusive: async (path, text) => {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    // As the disk store does: a copy never replaces a file.
    copy: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw new Error(`no such file: ${from}`);
      if (files.has(to)) throw new Error(`already there: ${to}`);
      files.set(to, text);
    },
    remove: async (path) => {
      files.delete(path);
    },
    listDirectory: async (path) => [
      ...new Set(
        [...files.keys()].flatMap((file) =>
          file.startsWith(`${path}/`) ? [file.slice(path.length + 1).split('/')[0] ?? ''] : [],
        ),
      ),
    ],
    removeDirectory: async (path) => {
      for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file);
    },
  };
}

const inMemory = {
  name: 'in memory',
  async open(): Promise<Harness> {
    const files = new Map(Object.entries(tree()));
    const interrupted = interruptible(memoryFiles(files));
    return {
      ...interrupted,
      projectFiles: async () =>
        Object.fromEntries(
          [...files]
            .filter(([path]) => !path.startsWith('.upfly/'))
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      record: async () => parseManifest(files.get(MANIFEST_PATH) ?? ''),
      edit: async (path, text) => {
        files.set(path, text);
      },
      dispose: async () => {},
    };
  },
};

const onDisk = {
  name: 'on a real filesystem',
  async open(): Promise<Harness> {
    // Outside the workspace: the tree has a `public/` folder, which the v2 editor extension
    // converts images in.
    const root = await mkdtemp(join(tmpdir(), 'upfly-part-'));
    for (const [path, text] of Object.entries(tree())) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, 'utf8');
    }
    const interrupted = interruptible(createNodeFileStore(root));
    return {
      ...interrupted,
      projectFiles: async () => {
        const out: Record<string, string> = {};
        for (const name of (await readdir(root, { recursive: true })).sort()) {
          const relative = name.split(sep).join('/');
          if (relative.startsWith('.upfly')) continue;
          if (!(await stat(join(root, name))).isFile()) continue;
          out[relative] = await readFile(join(root, name), 'utf8');
        }
        return out;
      },
      record: async () => parseManifest(await readFile(join(root, MANIFEST_PATH), 'utf8')),
      edit: (path, text) => writeFile(join(root, path), text, 'utf8'),
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  },
};

/** The project files before the run, as `projectFiles` lists them. */
function original(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree())
      .filter(([path]) => !path.startsWith('.upfly/'))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

async function applied(matrix: { open(): Promise<Harness> }): Promise<Harness> {
  const harness = await matrix.open();
  await commit(plan(), harness.store, context());
  return harness;
}

/** Undo a part from the record as it is on disk now, as each command run does. */
async function undoNow(harness: Harness, part: RunPart) {
  return undoPart(await harness.record(), part, harness.store);
}

const LINES: readonly RunPart[] = [
  { file: 'src/App.jsx', line: 1 },
  { file: 'src/App.jsx', line: 2 },
  { file: 'src/App.jsx', line: 3 },
  { file: 'src/b.css', line: 1 },
];
const PARTS: readonly RunPart[] = [
  ...LINES,
  { file: 'src/App.jsx', line: null },
  { file: 'src/b.css', line: null },
  { file: 'src/logo.png', line: null },
  { file: 'public/hero.png', line: null },
];

/** A small, seeded generator, so a failing order can be run again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each([inMemory, onDisk])('undoing part of a run, $name', (matrix) => {
  it('puts back one line and the original it names, and nothing else', async () => {
    const harness = await applied(matrix);
    const afterRun = await harness.projectFiles();

    const done = await undoNow(harness, { file: 'src/App.jsx', line: 2 });

    expect(done).toEqual({
      reverted: 'src/App.jsx',
      lines: [2],
      restored: ['src/logo.png'],
      copiedBack: [],
    });
    const now = await harness.projectFiles();
    expect(now['src/App.jsx']).toBe(
      "import logo from './logo.webp';\nconst again = './logo.png';\nconst hero = '/img/hero.png';\n",
    );
    expect({ ...now, 'src/App.jsx': '', 'src/logo.png': '' }).toEqual({
      ...afterRun,
      'src/App.jsx': '',
      'src/logo.png': '',
    });
    expect(now['src/logo.webp']).toBe('WEBP-BYTES');
    await harness.dispose();
  });

  it('copies a moved image back for a line that names its old place, leaving it at the new one too', async () => {
    const harness = await applied(matrix);

    const done = await undoNow(harness, { file: 'src/App.jsx', line: 3 });

    expect(done.copiedBack).toEqual([{ from: 'public/hero.png', to: 'public/img/hero.png' }]);
    const now = await harness.projectFiles();
    expect(now['public/hero.png']).toBe('HERO-BYTES');
    expect(now['public/img/hero.png']).toBe('HERO-BYTES');
    await harness.dispose();
  });

  it('refuses a file changed since the run, writing nothing, record included', async () => {
    const harness = await applied(matrix);
    const changed = `${(await harness.projectFiles())['src/App.jsx']}// edited\n`;
    await harness.edit('src/App.jsx', changed);
    const before = await harness.projectFiles();
    const record = JSON.stringify(await harness.record());

    await expect(undoNow(harness, { file: 'src/App.jsx', line: 1 })).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('src/App.jsx'),
    });
    expect(await harness.projectFiles()).toEqual(before);
    expect(JSON.stringify(await harness.record())).toBe(record);
    await harness.dispose();
  });

  it('does nothing for a line undone already, and leaves the record as it was', async () => {
    const harness = await applied(matrix);
    await undoNow(harness, { file: 'src/App.jsx', line: 1 });
    const record = JSON.stringify(await harness.record());

    const again = await undoNow(harness, { file: 'src/App.jsx', line: 1 });

    expect(again).toEqual({ reverted: null, lines: [], restored: [], copiedBack: [] });
    expect(JSON.stringify(await harness.record())).toBe(record);
    await harness.dispose();
  });

  it('puts every byte back with the whole undo, after each change undone one by one', async () => {
    const harness = await applied(matrix);
    for (const part of LINES) await undoNow(harness, part);
    for (const part of LINES) {
      expect(await undoNow(harness, part)).toMatchObject({ reverted: null });
    }

    await revert(await harness.record(), harness.store);

    expect(await harness.projectFiles()).toEqual(original());
    await harness.dispose();
  });

  it('puts every byte back with the whole undo, after any order of partial undos', async () => {
    const random = seeded(20261023);
    for (let round = 0; round < 12; round++) {
      const harness = await applied(matrix);
      const length = 1 + Math.floor(random() * 6);
      const sequence = Array.from(
        { length },
        () => PARTS[Math.floor(random() * PARTS.length)] as RunPart,
      );
      for (const part of sequence) await undoNow(harness, part);

      await revert(await harness.record(), harness.store);

      expect(await harness.projectFiles(), JSON.stringify(sequence)).toEqual(original());
      await harness.dispose();
    }
  }, 120_000);

  it('describes each line, whether it is undone, and each original, whether it is back', async () => {
    const harness = await applied(matrix);
    await undoNow(harness, { file: 'src/App.jsx', line: 3 });

    const run = await describeRun(await harness.record(), harness.store);

    expect(run.state).toBe('applied');
    expect(run.files.map((file) => file.path)).toEqual(['src/App.jsx', 'src/b.css']);
    expect(run.files[0]?.changes).toEqual([
      {
        line: 1,
        undone: false,
        paths: [
          { before: './logo.png', after: './logo.webp', image: 'src/logo.png', inComment: false },
        ],
      },
      {
        line: 2,
        undone: false,
        paths: [
          { before: './logo.png', after: './logo.webp', image: 'src/logo.png', inComment: false },
        ],
      },
      {
        line: 3,
        undone: true,
        paths: [
          {
            before: '/hero.png',
            after: '/img/hero.png',
            image: 'public/hero.png',
            inComment: false,
          },
        ],
      },
    ]);
    expect(run.originals).toEqual([
      { path: 'public/hero.png', movedTo: 'public/img/hero.png', back: true, changedSince: false },
      { path: 'src/logo.png', movedTo: null, back: false, changedSince: false },
    ]);
    expect(run.created).toEqual(['public/img/hero.png', 'src/logo.webp']);
    await harness.dispose();
  });
});

/** Every point at which a partial undo can be cut off, then what a person does next. */
describe.each([inMemory, onDisk])('the crash matrix for a partial undo, $name', (matrix) => {
  const CUTS: readonly (readonly RunPart[])[] = [
    [{ file: 'src/App.jsx', line: 1 }],
    [{ file: 'src/App.jsx', line: null }],
    [
      { file: 'src/App.jsx', line: 3 },
      { file: 'src/App.jsx', line: 1 },
    ],
    [
      { file: 'src/b.css', line: null },
      { file: 'src/App.jsx', line: 2 },
    ],
  ];

  it.each(CUTS.map((parts) => [parts.map((p) => `${p.file}:${p.line ?? '*'}`).join(' '), parts]))(
    'leaves a record the whole undo follows, wherever %s is cut off',
    async (_name, parts) => {
      const before = parts.slice(0, -1);
      const last = parts.at(-1) as RunPart;

      const reference = await applied(matrix);
      for (const part of before) await undoNow(reference, part);
      reference.failAfter(Number.POSITIVE_INFINITY);
      const counted = reference.mutations();
      await undoNow(reference, last);
      const steps = reference.mutations() - counted;
      await reference.dispose();
      expect(steps).toBeGreaterThanOrEqual(2);

      let cut = 0;
      for (let failAfter = 0; failAfter < steps; failAfter++) {
        for (const next of ['whole undo', 'the same part again, then the whole undo'] as const) {
          const harness = await applied(matrix);
          for (const part of before) await undoNow(harness, part);
          harness.failAfter(failAfter);
          await expect(undoNow(harness, last)).rejects.toThrow(/injected failure/);
          cut += 1;
          harness.stopFailing();

          if (next !== 'whole undo') await undoNow(harness, last);
          await revert(await harness.record(), harness.store);

          expect(await harness.projectFiles(), `cut after ${failAfter}, then ${next}`).toEqual(
            original(),
          );
          await harness.dispose();
        }
      }
      expect(cut).toBeGreaterThan(0);
    },
    120_000,
  );
});

describe('the record after a partial undo', () => {
  it('says version 2 once a file is part undone, and 1 while each file is all or nothing', async () => {
    const harness = await applied(inMemory);
    expect((await harness.record()).schemaVersion).toBe(1);

    await undoNow(harness, { file: 'src/b.css', line: null });
    expect((await harness.record()).schemaVersion).toBe(1);

    await undoNow(harness, { file: 'src/App.jsx', line: 1 });
    const record = await harness.record();
    expect(record.schemaVersion).toBe(2);
    expect(await readManifest(harness.store)).toEqual(record);
  });

  it('refuses a version this build does not know', () => {
    for (const schemaVersion of [0, 3, 1.5]) {
      expect(() => checkedVersion({ schemaVersion } as Manifest)).toThrow(
        expect.objectContaining({ code: 'MANIFEST_VERSION_UNSUPPORTED' }),
      );
    }
  });
});
