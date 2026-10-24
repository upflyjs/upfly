import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UpflyError } from '../errors.js';
import { createNodeFileStore } from './file-store-node.js';
import { LOCK_PATH } from './lock.js';
import {
  MANIFEST_PATH,
  MANIFEST_VOLATILE_FIELDS,
  NO_UNDO_DIRECTORY,
  NO_UNDO_MANIFEST_PATH,
  pathsTouched,
  withoutVolatileFields,
} from './manifest.js';
import { commitWithoutUndo, settleNoUndoRun } from './no-undo.js';
import {
  type FileStore,
  type PlannedOperation,
  type RunContext,
  commit,
  inspect,
  prepare,
  revert,
} from './transaction.js';

const RUN_DIR = '.upfly/runs/r1';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Harness {
  readonly store: FileStore;
  readonly files: Map<string, string>;
  mutations(): number;
  /** A crash ends a process; the next one starts with a disk that works again. */
  stopFailing(): void;
}

/**
 * Wrap a store so it can be told to die partway through.
 *
 * The count is of operations that change something: a write, a copy, a removal.
 * Injecting the failure here rather than calling revert directly is the point, because
 * it interrupts commit on the same code path a real crash would.
 *
 * Separate from any one store, so the in-memory double and the real filesystem store
 * are interrupted by the same mechanism at the same points.
 */
function interruptible(store: FileStore): {
  readonly store: FileStore;
  mutations(): number;
  failAfter(count: number): void;
  stopFailing(): void;
} {
  let mutations = 0;
  let limit = Number.POSITIVE_INFINITY;

  const mutate = (): void => {
    mutations += 1;
    if (mutations > limit) throw new Error(`injected failure at mutation ${mutations}`);
  };

  return {
    mutations: () => mutations,
    failAfter: (count) => {
      mutations = 0;
      limit = count;
    },
    stopFailing: () => {
      limit = Number.POSITIVE_INFINITY;
    },
    store: {
      hashAlgorithm: store.hashAlgorithm,
      hash: (path) => store.hash(path),
      readText: (path) => store.readText(path),
      readForSearch: (path) => store.readForSearch(path),
      async writeText(path, text) {
        mutate();
        await store.writeText(path, text);
      },
      // Passed through without `mutate()`. The crash harness counts mutations to fail at
      // every step of a commit, and taking the lock is not a step of the commit: counting
      // it would shift every injected failure by one and aim the crash matrix at the
      // wrong operations.
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
    },
  };
}

/** A bare in-memory store, with the failure injection left to `interruptible`. */
function memoryFiles(files: Map<string, string>): FileStore {
  return {
    hashAlgorithm: 'sha256',
    async hash(path) {
      const text = files.get(path);
      return text === undefined ? null : sha(text);
    },
    async readText(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    // Every file these tests hold is text.
    async readForSearch(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    async writeText(path, text) {
      files.set(path, text);
    },
    // Real exclusive semantics, not a stub that always succeeds. A memory store that
    // overwrote here would let every lock test pass against a lock that could never
    // refuse.
    async createExclusive(path, text) {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    async copy(from, to) {
      const text = files.get(from);
      if (text === undefined) throw new Error(`no such file: ${from}`);
      files.set(to, text);
    },
    async remove(path) {
      files.delete(path);
    },
    async listDirectory(path) {
      const prefix = `${path}/`;
      const names = [...files.keys()].flatMap((file) =>
        file.startsWith(prefix) ? [file.slice(prefix.length).split('/')[0] ?? ''] : [],
      );
      return [...new Set(names)];
    },
    async removeDirectory(path) {
      for (const file of [...files.keys()]) {
        if (file.startsWith(`${path}/`)) files.delete(file);
      }
    },
  };
}

function memoryStore(
  initial: Record<string, string>,
  failAfter = Number.POSITIVE_INFINITY,
): Harness {
  const files = new Map(Object.entries(initial));
  const interrupted = interruptible(memoryFiles(files));
  interrupted.failAfter(failAfter);

  return {
    files,
    store: interrupted.store,
    mutations: interrupted.mutations,
    stopFailing: interrupted.stopFailing,
  };
}

/** A tree exercising all four operation kinds at once. */
function tree(runDir = RUN_DIR): Record<string, string> {
  return {
    'src/App.jsx': 'import logo from "./logo.png";\nexport const alt = "./logo.png";\n',
    'src/logo.png': 'PNG-BYTES',
    'public/hero.png': 'HERO-BYTES',
    'images/old.png': 'OLD-BYTES',
    [`${runDir}/staged/logo.webp`]: 'WEBP-BYTES',
    [`${runDir}/backup/old.png`]: 'OLD-BYTES',
  };
}

/**
 * The plan. The two edits inside `App.jsx` are deliberate: a single reference would
 * not exercise the offset shifting that inverting a multi-edit rewrite depends on.
 */
function plan(): PlannedOperation[] {
  const text = tree()['src/App.jsx'] as string;
  const first = text.indexOf('./logo.png');
  const second = text.indexOf('./logo.png', first + 1);
  const edits = [
    { start: first, end: first + './logo.png'.length, replacement: './logo.webp' },
    { start: second, end: second + './logo.png'.length, replacement: './logo.webp' },
  ];
  const after = `${text.slice(0, first)}./logo.webp${text.slice(first + 10, second)}./logo.webp${text.slice(second + 10)}`;

  return [
    {
      kind: 'create',
      path: 'src/logo.webp',
      staged: 'staged/logo.webp',
      afterHash: sha('WEBP-BYTES'),
    },
    { kind: 'edit', path: 'src/App.jsx', beforeHash: sha(text), afterHash: sha(after), edits },
    {
      kind: 'move',
      from: 'public/hero.png',
      to: 'public/images/hero.png',
      hash: sha('HERO-BYTES'),
    },
    {
      kind: 'delete',
      path: 'images/old.png',
      beforeHash: sha('OLD-BYTES'),
      backup: 'backup/old.png',
    },
  ];
}

function context(): RunContext {
  let tick = 0;
  return {
    runId: 'r1',
    runDir: RUN_DIR,
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    declined: [
      {
        path: 'src/data/logos.ts',
        line: 55,
        reason: 'the reference is assembled at runtime and cannot be rewritten safely',
      },
    ],
  };
}

/** The project's own files, with the run directory and the manifest left out. */
function projectFiles(files: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith('.upfly/')) continue;
    out[path] = text;
  }
  return out;
}

describe('prepare', () => {
  it('accepts a plan whose operations each target a different path', async () => {
    const harness = memoryStore(tree());
    await expect(prepare(plan(), harness.store, RUN_DIR)).resolves.toBeUndefined();
  });

  it('refuses two operations that target the same path', async () => {
    const harness = memoryStore(tree());
    const clash: PlannedOperation[] = [
      ...plan(),
      { kind: 'delete', path: 'src/App.jsx', beforeHash: sha('x'), backup: 'backup/old.png' },
    ];
    await expect(prepare(clash, harness.store, RUN_DIR)).rejects.toThrow(
      /both target src\/App\.jsx/,
    );
  });

  it('refuses two creates whose paths differ only in case, which are one file on Windows', async () => {
    // Neither file exists yet, so the absent check passes for both and only this
    // catches it. Compared exactly, the second create would land on top of the first
    // and the run would report success.
    const harness = memoryStore(tree());
    const clash: PlannedOperation[] = [
      ...plan(),
      { kind: 'create', path: 'src/LOGO.webp', staged: 'staged/LOGO.webp', afterHash: sha('n') },
    ];

    await expect(prepare(clash, harness.store, RUN_DIR)).rejects.toThrow(
      /are the same file on Windows and macOS/,
    );
  });

  it('refuses a delete whose backup was never written', async () => {
    const files = tree();
    delete files[`${RUN_DIR}/backup/old.png`];
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(
      /backup\/old\.png in the run directory, which was never written/,
    );
  });

  it('refuses a create whose destination already exists', async () => {
    const files = { ...tree(), 'src/logo.webp': 'SOMETHING-ELSE' };
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(/which already exists/);
  });

  it('refuses a plan built on content that has since changed', async () => {
    const files = { ...tree(), 'src/App.jsx': 'something a person edited after the audit\n' };
    const harness = memoryStore(files);

    await expect(prepare(plan(), harness.store, RUN_DIR)).rejects.toThrow(
      /changed between planning and now/,
    );
  });

  it('refuses a plan whose undo would not apply', async () => {
    // A deletion immediately followed by a replacement inverts into two edits that
    // share a start offset, which applyEdits rejects. Catching it here is the whole
    // reason prepare checks the inverse rather than trusting it.
    const harness = memoryStore({ 'a.css': 'abcdef', [`${RUN_DIR}/staged/x`]: 'x' });
    const bad: PlannedOperation[] = [
      {
        kind: 'edit',
        path: 'a.css',
        beforeHash: sha('abcdef'),
        afterHash: sha('Xcdef'),
        edits: [
          { start: 0, end: 1, replacement: '' },
          { start: 1, end: 2, replacement: 'X' },
        ],
      },
    ];
    await expect(prepare(bad, harness.store, RUN_DIR)).rejects.toThrow(/undo for a\.css/);
  });
});

describe('prepare, on a file that is not UTF-8', () => {
  it('refuses the edit, saying why, and leaves every byte in place', async () => {
    // A caller building its own plan, with the hash of the bytes on disk. Writing the
    // edited text back as UTF-8 would turn the Latin-1 0xE9 into three bytes.
    const root = await mkdtemp(join(tmpdir(), 'upfly-latin1-'));
    const bytes = Buffer.from('<p>Caf\xE9</p><img src="logo.png">', 'latin1');
    await writeFile(join(root, 'page.html'), bytes);
    const store = createNodeFileStore(root);
    const start = bytes.indexOf('logo.png');

    try {
      const edit: PlannedOperation = {
        kind: 'edit',
        path: 'page.html',
        beforeHash: (await store.hash('page.html')) ?? '',
        afterHash: sha('unused'),
        edits: [{ start, end: start + 8, replacement: 'logo.webp', expected: 'logo.png' }],
      };

      await expect(prepare([edit], store, RUN_DIR)).rejects.toMatchObject({
        code: 'TRANSACTION_PLAN_INVALID',
        message: expect.stringContaining('page.html is not valid UTF-8'),
      });
      expect(await readFile(join(root, 'page.html'))).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('commit', () => {
  it('writes the manifest before it touches a single file', async () => {
    // Allow exactly one mutation, then die. Whichever mutation that was is the one
    // commit does first, and it has to be the manifest: a changed tree with no
    // manifest is the single state undo cannot get out of.
    //
    // Asserting the manifest is present matters more than asserting the tree is
    // clean: a crash at mutation zero leaves a clean tree whatever the order, because
    // nothing has happened yet either way.
    const harness = memoryStore(tree(), 1);
    await expect(commit(plan(), harness.store, context())).rejects.toThrow(/injected failure/);

    expect(harness.files.has(MANIFEST_PATH)).toBe(true);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(tree()))));
  });

  it('applies every operation and records them all', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());

    expect(manifest.state).toBe('committed');
    expect(manifest.operations).toHaveLength(4);
    expect(harness.files.get('src/logo.webp')).toBe('WEBP-BYTES');
    expect(harness.files.get('src/App.jsx')).toContain('./logo.webp');
    expect(harness.files.get('src/App.jsx')).not.toContain('./logo.png');
    expect(harness.files.get('public/images/hero.png')).toBe('HERO-BYTES');
    expect(harness.files.has('public/hero.png')).toBe(false);
    expect(harness.files.has('images/old.png')).toBe(false);
  });

  it('carries every declined item into the manifest', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());

    expect(manifest.declined).toEqual([
      {
        path: 'src/data/logos.ts',
        line: 55,
        reason: 'the reference is assembled at runtime and cannot be rewritten safely',
      },
    ]);
  });
});

/**
 * `undo` restores only the run the manifest names, and a committed manifest replaces the
 * last one, so once a run commits no earlier run's folder can be restored from again.
 */
describe('the folders of earlier runs, each holding its staged files and backups', () => {
  const EARLIER = '.upfly/runs/r0';
  const withEarlier = () => ({
    ...tree(),
    [`${EARLIER}/backup/gone.png`]: 'GONE-BYTES',
    [`${EARLIER}/staged/gone.webp`]: 'WEBP',
  });
  const runFolders = (files: Map<string, string>) =>
    [
      ...new Set([...files.keys()].flatMap((path) => /^\.upfly\/runs\/[^/]+/.exec(path) ?? [])),
    ].sort();

  it('go once this run commits, and its own stays for undo', async () => {
    const harness = memoryStore(withEarlier());
    const manifest = await commit(plan(), harness.store, context());

    expect(runFolders(harness.files)).toEqual([RUN_DIR]);
    await revert(manifest, harness.store);
    expect(harness.files.get('images/old.png')).toBe('OLD-BYTES');
  });

  it('stay when the commit stops part way, since that run is the one undo must follow', async () => {
    const harness = memoryStore(withEarlier(), 3);
    await expect(commit(plan(), harness.store, context())).rejects.toThrow(/injected failure/);

    expect(runFolders(harness.files)).toEqual([EARLIER, RUN_DIR]);
  });
});

/**
 * Both windows in which a file can move under a run that already checked it.
 *
 * The replacement text is chosen to be the same length as the original in both
 * tests, so the planned offsets still land inside the file and every other check
 * still passes. That is the version worth testing: a change that shortens the file
 * throws somewhere in `applyEdits` by luck, and a test resting on that luck would
 * pass against code that has no check at all.
 */
describe('commit refuses a file that changed after the plan was checked', () => {
  const edited = (text: string): string => text.replace('const alt', 'const ALT');

  it('refuses before writing the manifest, leaving the tree untouched', async () => {
    const harness = memoryStore(tree());
    const original = projectFiles(harness.files);
    await prepare(plan(), harness.store, RUN_DIR);

    harness.files.set('src/App.jsx', edited(tree()['src/App.jsx'] as string));

    await expect(commit(plan(), harness.store, context())).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
    });
    expect(harness.files.has(MANIFEST_PATH)).toBe(false);
    expect(projectFiles(harness.files)).toEqual({
      ...original,
      'src/App.jsx': edited(tree()['src/App.jsx'] as string),
    });
  });

  it('refuses mid-run without overwriting what the other writer put there', async () => {
    const harness = memoryStore(tree());
    const saved = edited(tree()['src/App.jsx'] as string);

    // Saved during the create phase, which is where the encoded images land, so this
    // stands in for the editor that writes while a run is copying bytes into place.
    const store: FileStore = {
      ...harness.store,
      async copy(from, to) {
        await harness.store.copy(from, to);
        harness.files.set('src/App.jsx', saved);
      },
    };

    await expect(commit(plan(), store, context())).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
    });
    expect(harness.files.get('src/App.jsx')).toBe(saved);
    expect(harness.files.has(MANIFEST_PATH)).toBe(true);
  });
});

describe('revert', () => {
  it('names how many files changed since the run in words a person reads', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    harness.files.set('src/App.jsx', 'edited');

    await expect(revert(manifest, harness.store)).rejects.toMatchObject({
      message: expect.stringContaining('1 file changed since this run: src/App.jsx.'),
    });
  });

  it('restores a byte-identical tree after a complete run', async () => {
    const original = tree();
    const harness = memoryStore(original);
    const manifest = await commit(plan(), harness.store, context());

    expect(projectFiles(harness.files)).not.toEqual(
      projectFiles(new Map(Object.entries(original))),
    );

    await revert(manifest, harness.store);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(original))));
  });

  it('refuses to revert over a file somebody else changed', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    harness.files.set('src/App.jsx', 'a person edited this after the run\n');

    await expect(revert(manifest, harness.store)).rejects.toBeInstanceOf(UpflyError);
    // Nothing else was rolled back either: a refusal must not leave a third state.
    expect(harness.files.get('src/logo.webp')).toBe('WEBP-BYTES');
  });

  it("refuses, and changes nothing, when a removed original's backup is gone", async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    harness.files.delete(`${RUN_DIR}/backup/old.png`);
    const after = projectFiles(harness.files);

    await expect(revert(manifest, harness.store)).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('images/old.png'),
    });
    expect(projectFiles(harness.files)).toEqual(after);
  });

  it('is safe to run twice', async () => {
    const original = tree();
    const harness = memoryStore(original);
    const manifest = await commit(plan(), harness.store, context());

    await revert(manifest, harness.store);
    await revert(manifest, harness.store);
    expect(projectFiles(harness.files)).toEqual(projectFiles(new Map(Object.entries(original))));
  });
});

/**
 * A tree and a store over it, so a matrix can run against either implementation.
 *
 * The disk half is not thoroughness for its own sake. The in-memory double's `copy`
 * overwrites its destination and the real store refuses to, so any recovery path
 * that copies onto a file already present passes in memory and fails on a disk.
 */
interface MatrixHarness {
  readonly store: FileStore;
  /** The project's own files, with the run directory and the manifest left out. */
  projectFiles(): Promise<Record<string, string>>;
  /** The manifest as written, or undefined when the run never reached it. */
  manifest(): Promise<string | undefined>;
  mutations(): number;
  failAfter(count: number): void;
  stopFailing(): void;
  dispose(): Promise<void>;
}

interface MatrixStore {
  readonly name: string;
  open(initial?: Record<string, string>): Promise<MatrixHarness>;
}

const inMemory: MatrixStore = {
  name: 'in memory',
  async open(initial = tree()) {
    const files = new Map(Object.entries(initial));
    const interrupted = interruptible(memoryFiles(files));

    return {
      ...interrupted,
      projectFiles: async () => projectFiles(files),
      manifest: async () => files.get(MANIFEST_PATH),
      dispose: async () => {},
    };
  },
};

const onDisk: MatrixStore = {
  name: 'on a real filesystem',
  async open(initial = tree()) {
    // The OS temp directory rather than anywhere in the workspace: this tree has a
    // `public/` in it, and the v2 editor extension converts images inside a workspace's
    // `public/` folders in place.
    const root = await mkdtemp(join(tmpdir(), 'upfly-matrix-'));

    for (const [path, text] of Object.entries(initial)) {
      const absolute = join(root, ...path.split('/'));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text, 'utf8');
    }
    const interrupted = interruptible(createNodeFileStore(root));

    return {
      ...interrupted,
      projectFiles: () => diskProjectFiles(root),
      manifest: async () => {
        try {
          return await readFile(join(root, ...MANIFEST_PATH.split('/')), 'utf8');
        } catch {
          return undefined;
        }
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  },
};

/** The view `projectFiles` gives of the in-memory map, taken from a real tree. */
async function diskProjectFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const relative = name.split(sep).join('/');
    if (relative.startsWith('.upfly/')) continue;
    const absolute = join(root, name);
    if (!(await stat(absolute)).isFile()) continue;
    out[relative] = await readFile(absolute, 'utf8');
  }
  return out;
}

/**
 * Well beyond what either store needs alone, because these do not run alone.
 *
 * The disk matrices take a couple of seconds by themselves and several times that
 * when the whole suite is running in parallel around them, which is the only way CI
 * ever runs them. A default timeout tuned to a quiet machine turns a real failure
 * and a busy one into the same red.
 */
const MATRIX_TIMEOUT_MS = 120_000;

describe.each([inMemory, onDisk])('the crash matrix, $name', (matrix) => {
  it(
    'restores a byte-identical tree after a failure at every step of commit',
    async () => {
      const reference = await matrix.open();
      const original = await reference.projectFiles();
      await commit(plan(), reference.store, context());
      const steps = reference.mutations();
      await reference.dispose();

      expect(steps).toBeGreaterThan(5);
      let treesActuallyChanged = 0;

      for (let failAfter = 0; failAfter < steps; failAfter++) {
        const harness = await matrix.open();
        harness.failAfter(failAfter);
        await expect(commit(plan(), harness.store, context())).rejects.toThrow(/injected failure/);

        const interrupted = await harness.manifest();
        if (interrupted === undefined) {
          // Only possible when the crash beat the manifest write, in which case the
          // tree cannot have been touched.
          expect(await harness.projectFiles()).toEqual(original);
          await harness.dispose();
          continue;
        }

        if (JSON.stringify(await harness.projectFiles()) !== JSON.stringify(original)) {
          treesActuallyChanged += 1;
        }

        harness.stopFailing();
        await revert(JSON.parse(interrupted), harness.store);
        expect(await harness.projectFiles(), `failure after mutation ${failAfter}`).toEqual(
          original,
        );
        await harness.dispose();
      }

      // Without this the matrix could pass by never having changed anything, which is
      // the vacuous version of the same test.
      expect(treesActuallyChanged).toBeGreaterThan(0);
    },
    MATRIX_TIMEOUT_MS,
  );

  it(
    'recovers when the undo is itself interrupted, from every state a commit can leave',
    async () => {
      const reference = await matrix.open();
      const original = await reference.projectFiles();
      await commit(plan(), reference.store, context());
      const commitSteps = reference.mutations();
      await reference.dispose();

      let undosActuallyInterrupted = 0;

      // The last value lets commit run to the end, so undo is exercised from the
      // completed run as well as from every point a crash can cut it short at. The
      // matrix above interrupts commit only, and reverts on a disk that works again.
      for (let commitFailAfter = 0; commitFailAfter <= commitSteps; commitFailAfter++) {
        for (let undoFailAfter = 0; ; undoFailAfter++) {
          const harness = await matrix.open();
          harness.failAfter(commitFailAfter);
          const run = commit(plan(), harness.store, context());

          if (commitFailAfter < commitSteps) {
            await expect(run).rejects.toThrow(/injected failure/);
          } else {
            await run;
          }

          const afterCommit = await harness.manifest();
          if (afterCommit === undefined) {
            await harness.dispose();
            break;
          }

          harness.failAfter(undoFailAfter);
          let interrupted = false;
          try {
            await revert(JSON.parse(afterCommit), harness.store);
          } catch (cause) {
            if (!/injected failure/.test((cause as Error).message)) throw cause;
            interrupted = true;
            undosActuallyInterrupted += 1;
          }

          // What a person does next: read whatever manifest is on disk and undo again.
          harness.stopFailing();
          const remaining = await harness.manifest();
          expect(remaining).toBeDefined();
          await revert(JSON.parse(remaining as string), harness.store);

          expect(
            await harness.projectFiles(),
            `commit cut after ${commitFailAfter}, undo cut after ${undoFailAfter}`,
          ).toEqual(original);
          await harness.dispose();

          // One step past the last mutation the undo makes, so the loop stops at the
          // point where there was nothing left to interrupt.
          if (!interrupted) break;
        }
      }

      expect(undosActuallyInterrupted).toBeGreaterThan(0);
    },
    MATRIX_TIMEOUT_MS,
  );
});

describe('the manifest is deterministic except where it says it is not', () => {
  it('produces byte-identical manifests across two runs over identical input', async () => {
    const other = '.upfly/runs/a-different-run';
    const first = await commit(plan(), memoryStore(tree()).store, context());
    const second = await commit(plan(), memoryStore(tree(other)).store, {
      ...context(),
      runId: 'a-different-run',
      runDir: other,
    });

    expect(withoutVolatileFields(first)).toEqual(withoutVolatileFields(second));
  });

  it('fails when a field outside the allow-list varies', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    const drifted = {
      ...manifest,
      declined: [{ path: 'other.png', line: 1, reason: 'different' }],
    };

    expect(withoutVolatileFields(manifest)).not.toEqual(withoutVolatileFields(drifted));
  });

  it('refuses an allow-list entry naming a field the manifest does not have', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    const { startedAt: _renamedAway, ...renamed } = manifest;

    expect(() => withoutVolatileFields(renamed as never)).toThrow(/listed as volatile/);
  });

  it('names every volatile field', () => {
    expect([...MANIFEST_VOLATILE_FIELDS]).toEqual([
      'runId',
      'startedAt',
      'completedAt',
      'revertedAt',
      'runDir',
    ]);
  });
});

describe('inspect', () => {
  it('reports every operation as not-applied before a commit', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), memoryStore(tree()).store, context());

    const states = await inspect(manifest, harness.store);
    expect(states.map((state) => state.status)).toEqual([
      'not-applied',
      'not-applied',
      'not-applied',
      'not-applied',
    ]);
  });

  it('reports a move whose copy landed but whose source is still there as partial', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    await harness.store.copy('public/hero.png', 'public/images/hero.png');

    const states = await inspect(manifest, harness.store);
    const move = states.find((state) => state.operation.kind === 'move');
    expect(move?.status).toBe('partial');
  });
});

describe('the manifest names the function that made its hashes', () => {
  it('records the algorithm its store reported', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    expect(manifest.hashAlgorithm).toBe('sha256');
  });

  it('refuses to check hashes made by a different function', async () => {
    // Comparing sha256 against something else would call every file foreign, which
    // is the most alarming thing this tool can say and would be entirely an artefact
    // of the mismatch.
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    const older = { ...manifest, hashAlgorithm: 'sha1' };

    await expect(inspect(older, harness.store)).rejects.toThrow(/none of them can be checked/);
    await expect(revert(older, harness.store)).rejects.toThrow(/none of them can be checked/);
  });
});

describe('a reverted manifest says so', () => {
  it('does not leave the manifest claiming the changes are live', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    const reverted = await revert(manifest, harness.store, () => '2026-01-02T00:00:00.000Z');

    expect(reverted.state).toBe('reverted');
    expect(reverted.revertedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(JSON.parse(harness.files.get(MANIFEST_PATH) as string).state).toBe('reverted');
  });

  it('keeps the first undo time when run a second time', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());

    const first = await revert(manifest, harness.store, () => '2026-01-02T00:00:00.000Z');
    const second = await revert(first, harness.store, () => '2026-01-03T00:00:00.000Z');

    // The second call reverts nothing, so stamping a new time would claim otherwise.
    expect(second.revertedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('is distinguishable from an interrupted run', async () => {
    const harness = memoryStore(tree());
    const manifest = await commit(plan(), harness.store, context());
    const reverted = await revert(manifest, harness.store, () => '2026-01-02T00:00:00.000Z');

    // The distinction recovery needs: pending means finish cleaning up, reverted
    // means there is nothing left to do.
    expect(manifest.state).toBe('committed');
    expect(reverted.state).not.toBe('pending');
  });
});

describe('a declined item points at a place', () => {
  it('carries the line as well as the file', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    const [declined] = manifest.declined;

    expect(declined?.path).toBe('src/data/logos.ts');
    expect(declined?.line).toBe(55);
  });
});

describe('a run that stopped part way keeps its record until it is reverted', () => {
  const next: RunContext = { ...context(), runId: 'r2', runDir: '.upfly/runs/r2' };
  // The killed run's process is gone, so the lock it left behind is stale.
  const killed = { isAlive: () => false };

  /** A run killed right after its pending manifest was written. */
  async function interrupted() {
    const harness = memoryStore(tree(), 1);
    await expect(commit(plan(), harness.store, context())).rejects.toThrow(/injected failure/);
    harness.stopFailing();
    return harness;
  }

  it('refuses to start another run over it, and changes nothing', async () => {
    const harness = await interrupted();
    const record = harness.files.get(MANIFEST_PATH);
    const before = projectFiles(harness.files);

    await expect(commit([], harness.store, next, killed)).rejects.toMatchObject({
      code: 'TRANSACTION_INTERRUPTED',
      message: expect.stringContaining('r1'),
    });
    expect(harness.files.get(MANIFEST_PATH)).toBe(record);
    expect(projectFiles(harness.files)).toEqual(before);
  });

  it('lets the next run start once that run is reverted', async () => {
    const harness = await interrupted();
    const record = JSON.parse(harness.files.get(MANIFEST_PATH) as string);
    await revert(record, harness.store, undefined, killed);

    await expect(commit([], harness.store, next, killed)).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('lets the next run start over a finished run, or over a manifest nobody can read', async () => {
    const finished = memoryStore(tree());
    await commit(plan(), finished.store, context());
    const unreadable = memoryStore({ ...tree(), [MANIFEST_PATH]: '{ cut off by a power' });

    await expect(commit([], finished.store, next)).resolves.toMatchObject({ state: 'committed' });
    await expect(commit([], unreadable.store, next)).resolves.toMatchObject({ state: 'committed' });
  });
});

describe('pathsTouched', () => {
  it('lists every path a run changed, both ends of a move included, sorted', async () => {
    const manifest = await commit(plan(), memoryStore(tree()).store, context());

    expect(pathsTouched(manifest)).toEqual([
      'images/old.png',
      'public/hero.png',
      'public/images/hero.png',
      'src/App.jsx',
      'src/logo.webp',
    ]);
  });
});

describe('the manifest schema is public API', () => {
  it('matches the approved shape', async () => {
    // A change to this snapshot is a schema change, and a schema change is something a
    // reviewer approves rather than something that lands because the tests were
    // updated alongside it.
    const manifest = await commit(plan(), memoryStore(tree()).store, context());
    expect(withoutVolatileFields(manifest)).toMatchSnapshot();
  });
});

/** The folder of the run made without undo in these tests. */
const NO_UNDO_RUN_DIR = `${NO_UNDO_DIRECTORY}/n1`;

/** A page naming a new image, beside `tree()`, with what a run made without undo staged for it. */
function noUndoTree(): Record<string, string> {
  return {
    ...tree(),
    'src/page.html': '<img src="new.png">\n',
    'src/new.png': 'NEW-BYTES',
    [`${NO_UNDO_RUN_DIR}/staged/new.webp`]: 'NEW-WEBP',
    [`${NO_UNDO_RUN_DIR}/backup/new.png`]: 'NEW-BYTES',
  };
}

/** The new image converted, its page rewritten and its original removed: none of `plan()`'s files. */
function noUndoPlan(): PlannedOperation[] {
  const text = '<img src="new.png">\n';
  const start = text.indexOf('new.png');
  return [
    { kind: 'create', path: 'src/new.webp', staged: 'staged/new.webp', afterHash: sha('NEW-WEBP') },
    {
      kind: 'edit',
      path: 'src/page.html',
      beforeHash: sha(text),
      afterHash: sha(text.replace('new.png', 'new.webp')),
      edits: [{ start, end: start + 'new.png'.length, replacement: 'new.webp' }],
    },
    {
      kind: 'delete',
      path: 'src/new.png',
      beforeHash: sha('NEW-BYTES'),
      backup: 'backup/new.png',
    },
  ];
}

function noUndoContext(): RunContext {
  return { ...context(), runId: 'n1', runDir: NO_UNDO_RUN_DIR };
}

/** The project as a finished run made without undo leaves it, from its tree before. */
function afterNoUndo(before: Record<string, string>): Record<string, string> {
  const after: Record<string, string> = { ...before, 'src/new.webp': 'NEW-WEBP' };
  after['src/page.html'] = '<img src="new.webp">\n';
  return Object.fromEntries(
    Object.entries(after)
      .filter(([path]) => path !== 'src/new.png')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Every path under the folder runs made without undo keep. */
function noUndoLeft(files: ReadonlyMap<string, string>): string[] {
  return [...files.keys()].filter((path) => path.startsWith(`${NO_UNDO_DIRECTORY}/`));
}

/** The lock and the record as a run left them, as another process would find them. */
const anotherProcess = { pid: 424242, isAlive: () => false };

describe('a run made without undo', () => {
  it("leaves the last run's record and folder as they were, and nothing of its own once it finishes", async () => {
    const harness = memoryStore(noUndoTree());
    const original = projectFiles(harness.files);
    const last = await commit(plan(), harness.store, context());
    const record = harness.files.get(MANIFEST_PATH);
    const folder = [...harness.files].filter(([path]) => path.startsWith(`${RUN_DIR}/`));
    const afterLast = projectFiles(harness.files);

    await commitWithoutUndo(noUndoPlan(), harness.store, noUndoContext());

    expect(harness.files.get(MANIFEST_PATH)).toBe(record);
    expect([...harness.files].filter(([path]) => path.startsWith(`${RUN_DIR}/`))).toEqual(folder);
    expect(noUndoLeft(harness.files)).toEqual([]);
    expect(projectFiles(harness.files)).toEqual(afterNoUndo(afterLast));

    await revert(last, harness.store);
    expect(projectFiles(harness.files)).toEqual(afterNoUndo(original));
  });

  it('refuses while another run holds the lock, which every run shares', async () => {
    const harness = memoryStore(noUndoTree());
    const holder = { pid: 31337, startedAt: '2026-01-01T00:00:00.000Z', runId: 'r9' };
    harness.files.set(LOCK_PATH, `${JSON.stringify(holder)}\n`);
    const before = projectFiles(harness.files);

    await expect(
      commitWithoutUndo(noUndoPlan(), harness.store, noUndoContext(), { isAlive: () => true }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_LOCKED' });
    expect(projectFiles(harness.files)).toEqual(before);
    expect(noUndoLeft(harness.files).every((path) => path.startsWith(NO_UNDO_RUN_DIR))).toBe(true);
    expect(harness.files.has(NO_UNDO_MANIFEST_PATH)).toBe(false);
  });

  it('refuses to start over one that stopped part way, as a run that keeps its record does', async () => {
    const harness = memoryStore(noUndoTree(), 1);
    await expect(commitWithoutUndo(noUndoPlan(), harness.store, noUndoContext())).rejects.toThrow(
      /injected failure/,
    );
    harness.stopFailing();
    const before = projectFiles(harness.files);
    const next: RunContext = { ...context(), runId: 'r2', runDir: '.upfly/runs/r2' };

    await expect(commit(plan(), harness.store, next, anotherProcess)).rejects.toMatchObject({
      code: 'TRANSACTION_INTERRUPTED',
      message: expect.stringContaining('n1'),
    });
    expect(projectFiles(harness.files)).toEqual(before);
    expect(harness.files.has(MANIFEST_PATH)).toBe(false);
  });

  it('stopped part way while its process lives, puts back what it wrote before it throws', async () => {
    const reference = memoryStore(noUndoTree());
    await commitWithoutUndo(noUndoPlan(), reference.store, noUndoContext());
    const steps = reference.mutations();
    let putBack = 0;

    for (let failing = 1; failing <= steps; failing++) {
      const files = new Map(Object.entries(noUndoTree()));
      const original = projectFiles(files);
      const store = failingOnce(memoryFiles(files), failing);
      await commitWithoutUndo(noUndoPlan(), store, noUndoContext()).catch((cause: Error) => {
        expect(cause.message).toMatch(/injected failure/);
      });

      // A failure once it has finished, while it clears what it left or releases the lock,
      // cannot undo it: the run stands, and the next run clears the rest.
      const now = projectFiles(files);
      expect([original, afterNoUndo(original)], `failure at mutation ${failing}`).toContainEqual(
        now,
      );
      expect(await recordState(store), `failure at mutation ${failing}`).not.toBe('pending');
      if (JSON.stringify(now) === JSON.stringify(original)) putBack += 1;
    }
    expect(putBack).toBeGreaterThan(3);
  });

  it('is put back when its record was cut off mid-write, which leaves the project whole', async () => {
    const harness = memoryStore({ ...noUndoTree(), [NO_UNDO_MANIFEST_PATH]: '{ "state": "pend' });
    const before = projectFiles(harness.files);

    await expect(settleNoUndoRun(harness.store)).resolves.toBeNull();
    expect(noUndoLeft(harness.files)).toEqual([]);
    expect(projectFiles(harness.files)).toEqual(before);
  });

  it('is not put back over a file changed since, which is named, and nothing is written', async () => {
    // Cut off for good after its record and the new file: what a crash leaves.
    const harness = memoryStore(noUndoTree(), 2);
    await expect(commitWithoutUndo(noUndoPlan(), harness.store, noUndoContext())).rejects.toThrow(
      /injected failure/,
    );
    harness.stopFailing();
    expect(await recordState(harness.store)).toBe('pending');
    expect(harness.files.get('src/new.webp')).toBe('NEW-WEBP');
    harness.files.set('src/new.webp', 'EDITED-SINCE');
    // The lock the cut-off run left is cleared as stale, which is no part of what is compared.
    const unlocked = (files: Map<string, string>) =>
      [...files].filter(([path]) => path !== LOCK_PATH).sort(([a], [b]) => a.localeCompare(b));
    const before = unlocked(harness.files);

    await expect(settleNoUndoRun(harness.store, { lock: anotherProcess })).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('src/new.webp'),
    });
    expect(unlocked(harness.files)).toEqual(before);
  });

  it('settling finds nothing to do in a project where none has run', async () => {
    const harness = memoryStore(tree());

    await expect(settleNoUndoRun(harness.store)).resolves.toBeNull();
    expect(harness.mutations()).toBe(0);
  });
});

describe.each([inMemory, onDisk])(
  'the crash matrix of a run made without undo, $name',
  (matrix) => {
    it(
      'leaves a project the next run puts back before anything else, cut off at every write',
      async () => {
        const reference = await matrix.open(noUndoTree());
        const original = await reference.projectFiles();
        await commitWithoutUndo(noUndoPlan(), reference.store, noUndoContext());
        const steps = reference.mutations();
        await reference.dispose();
        let changed = 0;

        for (let failAfter = 0; failAfter < steps; failAfter++) {
          const harness = await matrix.open(noUndoTree());
          harness.failAfter(failAfter);
          const finished = await commitWithoutUndo(
            noUndoPlan(),
            harness.store,
            noUndoContext(),
          ).then(
            () => true,
            () => false,
          );
          harness.stopFailing();
          const left = await harness.projectFiles();
          if (JSON.stringify(left) !== JSON.stringify(original)) changed += 1;

          const putBack = await settleNoUndoRun(harness.store, { lock: anotherProcess });
          const expected = finished || putBack === null ? left : original;
          expect(await harness.projectFiles(), `cut after ${failAfter}`).toEqual(expected);
          // Whatever it was cut at, the tree is one the run's record names as whole: before it,
          // or after it.
          expect([original, afterNoUndo(original)], `cut after ${failAfter}`).toContainEqual(
            await harness.projectFiles(),
          );
          expect(await harness.store.listDirectory(NO_UNDO_DIRECTORY)).toEqual([]);

          // The next run that keeps its record starts, as it would not over the interrupted one.
          await expect(
            commit(
              [],
              harness.store,
              { ...context(), runId: 'r2', runDir: '.upfly/runs/r2' },
              anotherProcess,
            ),
          ).resolves.toMatchObject({ state: 'committed' });
          await harness.dispose();
        }
        expect(changed).toBeGreaterThan(0);
      },
      MATRIX_TIMEOUT_MS,
    );

    it(
      'is put back when putting it back is cut off too, from every state the run can leave',
      async () => {
        const reference = await matrix.open(noUndoTree());
        const original = await reference.projectFiles();
        await commitWithoutUndo(noUndoPlan(), reference.store, noUndoContext());
        const steps = reference.mutations();
        await reference.dispose();
        let settlesCut = 0;

        for (let runCut = 0; runCut < steps; runCut++) {
          for (let settleCut = 0; ; settleCut++) {
            const cut = await cutTwice(matrix, original, runCut, settleCut);
            if (!cut) break;
            settlesCut += 1;
          }
        }
        expect(settlesCut).toBeGreaterThan(0);
      },
      MATRIX_TIMEOUT_MS,
    );
  },
);

/** A store whose `failing`-th change fails, and every other works: a failure the process outlives. */
function failingOnce(store: FileStore, failing: number): FileStore {
  let mutations = 0;
  const mutate = () => {
    mutations += 1;
    if (mutations === failing) throw new Error(`injected failure at mutation ${mutations}`);
  };
  return {
    ...store,
    async writeText(path, text) {
      mutate();
      await store.writeText(path, text);
    },
    async copy(from, to) {
      mutate();
      await store.copy(from, to);
    },
    async remove(path) {
      mutate();
      await store.remove(path);
    },
    async removeDirectory(path) {
      mutate();
      await store.removeDirectory(path);
    },
  };
}

/**
 * A run made without undo cut off after `runCut` writes, then putting it back cut off after
 * `settleCut`, then put back again: the project must be whole, and put back when the run had
 * stopped part way.
 *
 * @returns whether putting it back was cut off, so a larger `settleCut` is worth trying
 */
async function cutTwice(
  matrix: MatrixStore,
  original: Record<string, string>,
  runCut: number,
  settleCut: number,
): Promise<boolean> {
  const where = `run cut ${runCut}, settle cut ${settleCut}`;
  const harness = await matrix.open(noUndoTree());
  harness.failAfter(runCut);
  await commitWithoutUndo(noUndoPlan(), harness.store, noUndoContext()).catch(() => {});
  harness.stopFailing();
  const pending = (await recordState(harness.store)) === 'pending';

  harness.failAfter(settleCut);
  let cut = false;
  try {
    await settleNoUndoRun(harness.store, { lock: anotherProcess });
  } catch (cause) {
    if (!/injected failure/.test((cause as Error).message)) throw cause;
    cut = true;
  }
  harness.stopFailing();
  await settleNoUndoRun(harness.store, { lock: anotherProcess });

  const now = await harness.projectFiles();
  expect([original, afterNoUndo(original)], where).toContainEqual(now);
  if (pending) expect(now, where).toEqual(original);
  expect(await harness.store.listDirectory(NO_UNDO_DIRECTORY), where).toEqual([]);
  await harness.dispose();
  return cut;
}

/** The state the record of a run made without undo names, or null when there is none. */
async function recordState(store: FileStore): Promise<string | null> {
  if ((await store.hash(NO_UNDO_MANIFEST_PATH)) === null) return null;
  try {
    return (JSON.parse(await store.readText(NO_UNDO_MANIFEST_PATH)) as { state: string }).state;
  } catch {
    return 'unreadable';
  }
}
