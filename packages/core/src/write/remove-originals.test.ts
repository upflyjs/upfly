/**
 * A run that removes originals kept beside their converted files, through `optimize`'s steps,
 * on an in-memory disk and on a real one: the plan, the backup, the search before the delete,
 * and every state a crash can leave.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditResult } from '../audit/audit.js';
import { buildGraph } from '../graph/graph.js';
import type { AssetProbe, ImageProbe } from '../probe/probe.js';
import type { ScannedText } from '../scan/scan.js';
import type { Asset, Reference } from '../types.js';
import { createNodeFileStore } from './file-store-node.js';
import { LOCK_PATH } from './lock.js';
import { MANIFEST_PATH, NO_UNDO_DIRECTORY, NO_UNDO_MANIFEST_PATH } from './manifest.js';
import { settleNoUndoRun } from './no-undo.js';
import { type OptimizeInput, optimize } from './optimize.js';
import { type FileStore, commit, revert } from './transaction.js';

const RUN_ID = '2026-01-01T000000-abcd';
const PNG = 'images/arrived.png';
const WEBP = 'images/arrived.webp';
const PAGE = 'page.html';
const PAGE_TEXT = '<img src="images/arrived.webp" alt="">\n';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The project an editor leaves after converting an arrival with its original kept. */
function keptTree(): Record<string, string> {
  return {
    [PNG]: 'PNG-BYTES',
    [WEBP]: 'WEBP-BYTES',
    [PAGE]: PAGE_TEXT,
    'index.html': '<p>home</p>\n',
  };
}

function asset(root: string, relative: string, bytes = 10_000): Asset {
  return {
    path: `${root}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

function header(relative: string, width = 64): AssetProbe {
  const format = relative.slice(relative.lastIndexOf('.') + 1);
  return {
    relative,
    metadata: { width, height: 48, format, pages: 1 },
    encoded: [],
    skipped: [],
  };
}

function linkToWebp(root: string): Reference {
  const start = PAGE_TEXT.indexOf(WEBP);
  return {
    file: `${root}/${PAGE}`,
    rawPath: WEBP,
    start,
    end: start + WEBP.length,
    kind: 'attr',
    shape: 'html.img.src',
    ceiling: 'high',
    asserted: true,
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${root}/${WEBP}`,
    resolvedVia: 'file',
  } as Reference;
}

/** No encode is ever asked for: a run that removes originals converts nothing. */
const NO_ENCODES: ImageProbe = {
  quality: { webp: 80, avif: 75 },
  metadata: async () => ({ width: 64, height: 48, format: 'png', pages: 1 }),
  encodedBytes: async () => 2_000,
  encodeToFile: async () => {
    throw new Error('a run that removes originals encoded an image');
  },
};

function inputFor(
  root: string,
  store: FileStore,
  over: Partial<OptimizeInput> = {},
): OptimizeInput {
  const audit: AuditResult = {
    findings: [{ kind: 'dead', asset: PNG, bytes: 10_000, inPublicDir: true }],
    conventionLinked: [],
    unreadableSources: [],
    probed: true,
    duplicatesChecked: false,
  };
  const texts: ScannedText[] = [
    { path: `${root}/${PAGE}`, hash: sha(PAGE_TEXT), holdsReplacementCharacter: false },
  ];
  return {
    graph: buildGraph({
      root,
      assets: [asset(root, PNG), asset(root, WEBP, 2_000)],
      references: [linkToWebp(root)],
      unscannedFiles: [],
      texts,
    }),
    audit,
    probes: [header(PNG), header(WEBP)],
    probe: NO_ENCODES,
    store,
    files: [PAGE, 'index.html'],
    unread: [],
    servingRoots: { dirs: [''], declared: true },
    builds: { packages: [] },
    format: 'webp',
    publicPolicy: 'replace',
    apply: true,
    removeOriginals: new Set([PNG]),
    runId: RUN_ID,
    now: () => '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** A store over a map, which a test can tell to fail at its nth change. */
function memory(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  let changes = 0;
  let limit = Number.POSITIVE_INFINITY;
  const change = () => {
    changes += 1;
    if (changes > limit) throw new Error(`injected failure at change ${changes}`);
  };
  const store: FileStore = {
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
    async readForSearch(path) {
      return store.readText(path);
    },
    async writeText(path, text) {
      change();
      files.set(path, text);
    },
    async createExclusive(path, text) {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    async copy(from, to) {
      change();
      const text = files.get(from);
      if (text === undefined) throw new Error(`no such file: ${from}`);
      files.set(to, text);
    },
    async remove(path) {
      change();
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
      change();
      for (const file of [...files.keys()]) {
        if (file.startsWith(`${path}/`)) files.delete(file);
      }
    },
  };
  return {
    files,
    store,
    changes: () => changes,
    failAfter(count: number) {
      changes = 0;
      limit = count;
    },
    stopFailing() {
      limit = Number.POSITIVE_INFINITY;
    },
  };
}

/** The project's own files, Upfly's folder left out. */
function project(files: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(
    [...files]
      .filter(([path]) => !path.startsWith('.upfly/'))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

const ROOT = resolve('/repo');

describe('a run that removes an original kept beside its converted file', () => {
  it('plans the removal on a dry run and writes nothing', async () => {
    const disk = memory(keptTree());
    const before = new Map(disk.files);

    const result = await optimize(inputFor(ROOT, disk.store, { apply: false }));

    expect(result.plan.removals).toEqual([{ asset: PNG, converted: WEBP }]);
    expect(result.plan.conversions).toEqual([]);
    expect(result.manifest).toBeNull();
    expect([...disk.files]).toEqual([...before]);
  });

  it('removes it, keeps the converted file, and undo puts it back byte for byte', async () => {
    const disk = memory(keptTree());
    const before = project(disk.files);

    const result = await optimize(inputFor(ROOT, disk.store));

    expect(disk.files.has(PNG)).toBe(false);
    expect(disk.files.get(WEBP)).toBe('WEBP-BYTES');
    expect(result.manifest?.state).toBe('committed');
    expect(disk.files.has(MANIFEST_PATH)).toBe(true);
    expect(disk.files.get(`.upfly/runs/${RUN_ID}/backup/${PNG}`)).toBe('PNG-BYTES');

    await revert(result.manifest as NonNullable<typeof result.manifest>, disk.store);
    expect(project(disk.files)).toEqual(before);
  });

  it("without undo, leaves the last run's record as it was and nothing of its own", async () => {
    const disk = memory(keptTree());
    const last = await commit([], disk.store, {
      runId: 'person',
      runDir: '.upfly/runs/person',
      now: () => '2026-01-01T00:00:00.000Z',
      declined: [],
    });
    const record = disk.files.get(MANIFEST_PATH);

    await optimize(inputFor(ROOT, disk.store, { undoable: false }));

    expect(disk.files.has(PNG)).toBe(false);
    expect(disk.files.get(MANIFEST_PATH)).toBe(record);
    expect(last.state).toBe('committed');
    expect([...disk.files.keys()].filter((path) => path.startsWith(NO_UNDO_DIRECTORY))).toEqual([]);
  });

  it('is refused, removing nothing, when the converted file goes before the write', async () => {
    const disk = memory(keptTree());
    const before = project(disk.files);

    await expect(
      optimize(
        inputFor(ROOT, disk.store, {
          beforeWrite: () => {
            disk.files.delete(WEBP);
            return true;
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining(WEBP),
    });

    const now = project(disk.files);
    expect(now[PNG]).toBe('PNG-BYTES');
    expect({ ...now, [WEBP]: 'WEBP-BYTES' }).toEqual(before);
    expect(disk.files.has(MANIFEST_PATH)).toBe(false);
    expect(disk.files.has(LOCK_PATH)).toBe(false);
  });

  it('is refused when the converted file changes while the original is backed up', async () => {
    const disk = memory(keptTree());
    const store: FileStore = {
      ...disk.store,
      async copy(from, to) {
        await disk.store.copy(from, to);
        if (from === PNG) disk.files.set(WEBP, 'ANOTHER-PICTURE');
      },
    };

    await expect(optimize(inputFor(ROOT, store))).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining(`${WEBP} changed while Upfly was removing its original`),
    });
    expect(disk.files.get(PNG)).toBe('PNG-BYTES');
    expect([...disk.files.keys()].filter((path) => path.includes('/backup/'))).toEqual([]);
  });

  it('keeps it when a page written after the read names it, and writes no record', async () => {
    const disk = memory(keptTree());
    const run = await optimize(
      inputFor(ROOT, disk.store, {
        beforeWrite: () => {
          disk.files.set('agent.html', '<img src="images/arrived.png" alt="">\n');
          return true;
        },
        listFiles: async () => ({ files: [PAGE, 'index.html', 'agent.html'], unread: [] }),
      }),
    );

    expect(disk.files.get(PNG)).toBe('PNG-BYTES');
    expect(run.manifest).toBeNull();
    expect(run.plan.removals).toEqual([]);
    expect(run.plan.declined).toEqual([
      {
        path: PNG,
        line: null,
        reason: 'agent.html:1 still names its path, written since Upfly read the project',
      },
    ]);
    expect(disk.files.has(MANIFEST_PATH)).toBe(false);
    expect([...disk.files.keys()].filter((path) => path.startsWith('.upfly/runs/'))).toEqual([]);
  });

  it('keeps it when the search finds a line naming it that the audit did not', async () => {
    const disk = memory({ ...keptTree(), 'notes.txt': 'the photo is images/arrived.png\n' });

    const run = await optimize(
      inputFor(ROOT, disk.store, { files: [PAGE, 'index.html', 'notes.txt'] }),
    );

    expect(disk.files.get(PNG)).toBe('PNG-BYTES');
    expect(run.manifest).toBeNull();
    expect(run.plan.declined.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/^notes\.txt:1 still names its path/),
    ]);
  });

  it('keeps it when the search finds a comment naming it, which it does not rewrite', async () => {
    // A comment the audit's read did not see, as one saved between that read and the search.
    const comment = '<!-- from images/arrived.png -->\n<p>notes</p>\n';
    const disk = memory({ ...keptTree(), 'notes.html': comment });

    const run = await optimize(
      inputFor(ROOT, disk.store, { files: [PAGE, 'index.html', 'notes.html'] }),
    );

    expect(disk.files.get(PNG)).toBe('PNG-BYTES');
    expect(disk.files.get('notes.html')).toBe(comment);
    expect(run.manifest).toBeNull();
    expect(run.plan.rewrites).toEqual([]);
    expect(run.plan.declined.map((entry) => entry.reason)).toEqual([
      'notes.html:1 still names its path: in a comment, which no page loads',
    ]);
  });

  it('keeps it when a file the search must read could not be read', async () => {
    const disk = memory(keptTree());

    const run = await optimize(
      inputFor(ROOT, disk.store, {
        unread: [{ file: 'locked', reason: 'permission denied' }],
      }),
    );

    expect(disk.files.get(PNG)).toBe('PNG-BYTES');
    expect(run.plan.declined.map((entry) => entry.reason)).toEqual([
      'locked could not be read to rule out a mention of it',
    ]);
  });
});

interface Disk {
  readonly store: FileStore;
  project(): Promise<Record<string, string>>;
  changes(): number;
  failAfter(count: number): void;
  stopFailing(): void;
  dispose(): Promise<void>;
  readonly root: string;
}

const inMemory = {
  name: 'in memory',
  async open(): Promise<Disk> {
    const disk = memory(keptTree());
    return {
      ...disk,
      root: ROOT,
      project: async () => project(disk.files),
      dispose: async () => {},
    };
  },
};

const onDisk = {
  name: 'on a real filesystem',
  async open(): Promise<Disk> {
    const root = await mkdtemp(join(tmpdir(), 'upfly-removal-'));
    for (const [path, text] of Object.entries(keptTree())) {
      const absolute = join(root, ...path.split('/'));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text, 'utf8');
    }
    const real = createNodeFileStore(root);
    let changes = 0;
    let limit = Number.POSITIVE_INFINITY;
    const change = () => {
      changes += 1;
      if (changes > limit) throw new Error(`injected failure at change ${changes}`);
    };
    const store: FileStore = {
      ...real,
      async writeText(path, text) {
        change();
        await real.writeText(path, text);
      },
      async copy(from, to) {
        change();
        await real.copy(from, to);
      },
      async remove(path) {
        change();
        await real.remove(path);
      },
      async removeDirectory(path) {
        change();
        await real.removeDirectory(path);
      },
    };
    return {
      store,
      root,
      changes: () => changes,
      failAfter(count) {
        changes = 0;
        limit = count;
      },
      stopFailing() {
        limit = Number.POSITIVE_INFINITY;
      },
      project: async () => {
        const out: Record<string, string> = {};
        for (const name of (await readdir(root, { recursive: true })).sort()) {
          const relative = name.split(sep).join('/');
          if (relative.startsWith('.upfly')) continue;
          const absolute = join(root, name);
          if (!(await stat(absolute)).isFile()) continue;
          out[relative] = await readFile(absolute, 'utf8');
        }
        return out;
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  },
};

/** The removal of `keptTree`'s original, as the finished run leaves the project. */
function removed(before: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(before).filter(([path]) => path !== PNG));
}

/** A lock left by a process that is gone, as another process would find it. */
const anotherProcess = { pid: 424242, isAlive: () => false };

const MATRIX_TIMEOUT_MS = 120_000;

describe.each([inMemory, onDisk])('the crash matrix of a removal, $name', (matrix) => {
  it(
    'with undo: cut at every write, undo from the record puts every byte back',
    async () => {
      const reference = await matrix.open();
      const original = await reference.project();
      await optimize(inputFor(reference.root, reference.store));
      const steps = reference.changes();
      await reference.dispose();
      expect(steps).toBeGreaterThan(3);
      let changed = 0;

      for (let cut = 0; cut < steps; cut++) {
        const disk = await matrix.open();
        disk.failAfter(cut);
        await expect(optimize(inputFor(disk.root, disk.store))).rejects.toThrow(/injected failure/);
        disk.stopFailing();
        if (JSON.stringify(await disk.project()) !== JSON.stringify(original)) changed += 1;

        const record = await disk.store.hash(MANIFEST_PATH);
        if (record !== null) {
          const manifest = JSON.parse(await disk.store.readText(MANIFEST_PATH));
          await revert(manifest, disk.store, undefined, anotherProcess);
        }
        expect(await disk.project(), `cut after ${cut}`).toEqual(original);
        await disk.dispose();
      }
      expect(changed).toBeGreaterThan(0);
    },
    MATRIX_TIMEOUT_MS,
  );

  it(
    'without undo: cut at every write, the next command puts it back or it stands whole',
    async () => {
      const reference = await matrix.open();
      const original = await reference.project();
      await optimize(inputFor(reference.root, reference.store, { undoable: false }));
      const steps = reference.changes();
      await reference.dispose();
      expect(steps).toBeGreaterThan(3);
      let putBack = 0;

      for (let cut = 0; cut < steps; cut++) {
        const disk = await matrix.open();
        disk.failAfter(cut);
        const finished = await optimize(inputFor(disk.root, disk.store, { undoable: false })).then(
          () => true,
          () => false,
        );
        disk.stopFailing();
        const settled = await settleNoUndoRun(disk.store, { lock: anotherProcess });
        if (settled !== null) putBack += 1;

        const now = await disk.project();
        expect([original, removed(original)], `cut after ${cut}`).toContainEqual(now);
        if (settled !== null) expect(now, `cut after ${cut}`).toEqual(original);
        if (finished) expect(now, `cut after ${cut}`).toEqual(removed(original));
        expect(await disk.store.hash(NO_UNDO_MANIFEST_PATH), `cut after ${cut}`).toBeNull();
        expect(await disk.store.listDirectory(NO_UNDO_DIRECTORY), `cut after ${cut}`).toEqual([]);
        await disk.dispose();
      }
      expect(putBack).toBeGreaterThan(0);
    },
    MATRIX_TIMEOUT_MS,
  );
});
