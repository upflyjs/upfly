/**
 * The wiring, against an in-memory disk and a fake encoder.
 *
 * What these ask is whether the five stages are joined up correctly: that the plan is
 * the same on a dry run and an applied one, that staged bytes land where the
 * transaction expects them, and that a refusal stops everything.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditResult } from '../audit/audit.js';
import { buildGraph } from '../graph/graph.js';
import type { ProjectBuilds } from '../plan/builds.js';
import type { AssetProbe, ImageProbe } from '../probe/probe.js';
import type { ScannedText } from '../scan/scan.js';
import type { Asset, RawReference, Reference } from '../types.js';
import { LOCK_PATH } from './lock.js';
import { MANIFEST_PATH } from './manifest.js';
import { type OptimizeInput, type OptimizeProgress, newRunId, optimize } from './optimize.js';
import { type FileStore, type RunContext, commit } from './transaction.js';

// Resolved, as `discover` returns it: the planner resolves each rewritten path again, and on
// Windows `path.resolve` gives a bare '/repo' the current drive, which no asset here would have.
const ROOT = resolve('/repo');
const RUN_ID = '2026-01-01T000000-abcd';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What the scan records of a file it read, which an applied run checks the file against. */
function scanned(file: string, text: string): ScannedText {
  return { path: `${ROOT}/${file}`, hash: sha(text), holdsReplacementCharacter: false };
}

function asset(relative: string, bytes = 10_000): Asset {
  return {
    path: `${ROOT}/${relative}`,
    relative,
    extension: relative.slice(relative.lastIndexOf('.')),
    bytes,
  };
}

const SOURCE = 'import logo from "./logo.png";\n';

const RAW: Omit<RawReference, 'file' | 'rawPath' | 'start' | 'end'> = {
  kind: 'attr',
  shape: 'html.img.src',
  ceiling: 'high',
  asserted: true,
};

function resolved(file: string, rawPath: string, target: string, text = SOURCE): Reference {
  // Found in the text rather than written down. A hardcoded offset that is wrong by
  // six characters still produces a rewrite, and the rewrite is mangled rather than
  // absent, which is the exact failure mode the offsets exist to avoid.
  const start = text.indexOf(rawPath);
  return {
    ...RAW,
    file: `${ROOT}/${file}`,
    rawPath,
    start,
    end: start + rawPath.length,
    resolution: 'resolved',
    confidence: 'high',
    resolvedPath: `${ROOT}/${target}`,
    resolvedVia: 'file',
  } as Reference;
}

function probeOf(relative: string, over: Partial<AssetProbe> = {}): AssetProbe {
  return {
    relative,
    metadata: { width: 100, height: 100, format: 'png', pages: 1 },
    encoded: [{ format: 'webp', bytes: 2_000, quality: 80 }],
    skipped: [],
    ...over,
  };
}

/** An in-memory disk, plus a record of every encode the probe was asked for. */
function harness(initial: Record<string, string>) {
  const tree = new Map(Object.entries(initial));
  const encodes: { path: string; destination: string; animated: boolean }[] = [];

  const store: FileStore = {
    hashAlgorithm: 'sha256',
    async hash(path) {
      const text = tree.get(path);
      return text === undefined ? null : sha(text);
    },
    async readText(path) {
      const text = tree.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    async writeText(path, text) {
      tree.set(path, text);
    },
    // Real exclusive semantics, not a stub that always succeeds. A memory store that
    // overwrote here would let every lock test pass against a lock that could never
    // refuse.
    async createExclusive(path, text) {
      if (tree.has(path)) return false;
      tree.set(path, text);
      return true;
    },
    async copy(from, to) {
      const text = tree.get(from);
      if (text === undefined) throw new Error(`no such file: ${from}`);
      tree.set(to, text);
    },
    async remove(path) {
      tree.delete(path);
    },
    async listDirectory(path) {
      const prefix = `${path}/`;
      const names = [...tree.keys()].flatMap((file) =>
        file.startsWith(prefix) ? [file.slice(prefix.length).split('/')[0] ?? ''] : [],
      );
      return [...new Set(names)];
    },
    async removeDirectory(path) {
      for (const file of [...tree.keys()]) {
        if (file.startsWith(`${path}/`)) tree.delete(file);
      }
    },
  };

  const probe: ImageProbe = {
    quality: { webp: 80, avif: 75 },
    metadata: async () => ({ width: 100, height: 100, format: 'png', pages: 1 }),
    encodedBytes: async () => 2_000,
    async encodeToFile({ path, destination, animated }) {
      encodes.push({ path, destination, animated });
      // The destination is absolute; the store speaks in project-relative paths.
      tree.set(destination.slice(`${ROOT}/`.length), `WEBP(${path})`);
      return 2_000;
    },
  };

  return { tree, store, probe, encodes };
}

/**
 * `src/` is bundled, so the build that loads its import is stated as one known to load the
 * new format.
 */
const BUILT_BY_VITE: ProjectBuilds = {
  packages: [{ folder: '', build: { kind: 'known', name: 'Vite' } }],
};

function inputFor(
  over: Partial<OptimizeInput> & Pick<OptimizeInput, 'store' | 'probe'>,
): OptimizeInput {
  const assets = [asset('src/logo.png')];
  const references = [resolved('src/App.jsx', './logo.png', 'src/logo.png')];
  const audit: AuditResult = {
    findings: [],
    conventionLinked: [],
    unreadableSources: [],
    probed: true,
    duplicatesChecked: false,
  };

  return {
    graph: buildGraph({
      root: ROOT,
      assets,
      references,
      unscannedFiles: [],
      texts: [scanned('src/App.jsx', SOURCE)],
    }),
    audit,
    probes: [probeOf('src/logo.png')],
    // The files the old-path search reads. Defaults to the one file these fixtures hold
    // a reference in; a test that cares passes its own.
    files: ['src/App.jsx'],
    unread: [],
    servingRoots: { dirs: ['public'], declared: true },
    builds: BUILT_BY_VITE,
    format: 'webp',
    publicPolicy: 'keep-original',
    apply: true,
    runId: RUN_ID,
    now: () => '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('newRunId', () => {
  it('is sortable, readable, and not derived from content', () => {
    const id = newRunId(new Date('2026-09-12T02:15:00.000Z'), () => 0.5);

    expect(id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{4}$/);
  });

  it('differs between two runs over an unchanged repository', () => {
    // A content-derived name would collide, and the second run would write into the
    // first one's directory.
    const at = new Date('2026-09-12T02:15:00.000Z');

    expect(newRunId(at, () => 0.1)).not.toBe(newRunId(at, () => 0.9));
  });
});

describe('optimize', () => {
  it('makes every decision on a dry run and writes nothing', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const before = new Map(store.tree);

    const result = await optimize(inputFor({ ...store, apply: false }));

    expect(result.plan.conversions).toHaveLength(1);
    expect(result.plan.rewrites).toHaveLength(1);
    expect(result.manifest).toBeNull();
    expect([...store.tree]).toEqual([...before]);
    expect(store.encodes).toEqual([]);
  });

  it('reaches the same plan whether or not it applies it', async () => {
    // A preview that computes something different from the run is a lie in the shape
    // of a preview, so the decisions have to come out of one code path.
    const dry = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const wet = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    const dryRun = await optimize(inputFor({ ...dry, apply: false }));
    const wetRun = await optimize(inputFor({ ...wet, apply: true }));

    expect(wetRun.plan).toEqual(dryRun.plan);
  });

  it('encodes into the run directory, mirroring the project tree', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    const result = await optimize(inputFor(store));

    // A person looking into a run directory should recognise what they are seeing.
    expect(store.encodes[0]?.destination).toBe(
      `${ROOT}/.upfly/runs/${RUN_ID}/staged/src/logo.webp`,
    );
    expect(result.runDir).toBe(`.upfly/runs/${RUN_ID}`);
  });

  it('writes the encode into place and repoints the reference at it', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    const result = await optimize(inputFor(store));

    expect(store.tree.get('src/logo.webp')).toBe(`WEBP(${ROOT}/src/logo.png)`);
    expect(store.tree.get('src/App.jsx')).toBe('import logo from "./logo.webp";\n');
    expect(result.manifest?.state).toBe('committed');
    expect(store.tree.has(MANIFEST_PATH)).toBe(true);
  });

  it('keeps the original under the default policy', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    await optimize(inputFor(store));

    expect(store.tree.get('src/logo.png')).toBe('PNG');
  });

  it('takes the animation flag from the measurement, not from the extension', async () => {
    // Getting this wrong writes a one-frame GIF and reports a saving only achievable
    // by destroying the animation.
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

    await optimize(
      inputFor({
        ...store,
        probes: [
          probeOf('src/logo.png', {
            metadata: { width: 100, height: 100, format: 'gif', pages: 12 },
          }),
        ],
      }),
    );

    expect(store.encodes[0]?.animated).toBe(true);
  });

  it('writes nothing at all when the plan converts nothing', async () => {
    const store = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const before = new Map(store.tree);

    const result = await optimize(
      inputFor({ ...store, probes: [probeOf('src/logo.png', { encoded: [] })] }),
    );

    expect(result.plan.conversions).toEqual([]);
    expect(result.manifest).toBeNull();
    expect([...store.tree]).toEqual([...before]);

    // An asset with no webp measurement is left out of `declined`: the probe records
    // why it was not measured, and the report prints that skip.
    expect(result.plan.declined).toEqual([]);
  });
});

describe('an edit whose offsets do not cover its reference', () => {
  it('is refused before the file is touched, whatever put the offsets there', async () => {
    const project = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const right = resolved('src/App.jsx', './logo.png', 'src/logo.png');
    // Six characters early, as an adapter that miscounted would report it. The file is
    // unchanged since the scan, so only the edit's own expected text can catch this.
    const early = { ...right, start: right.start - 6, end: right.end - 6 } as Reference;

    const run = optimize(
      inputFor({
        ...project,
        graph: buildGraph({
          root: ROOT,
          assets: [asset('src/logo.png')],
          references: [early],
          unscannedFiles: [],
          texts: [scanned('src/App.jsx', SOURCE)],
        }),
      }),
    );

    await expect(run).rejects.toMatchObject({ code: 'EDIT_TEXT_MISMATCH' });
    expect(project.tree.get('src/App.jsx')).toBe(SOURCE);
  });
});

describe('the lock covers the gap between staging and committing', () => {
  /**
   * Why `optimize` takes the lock as well as `commit`.
   *
   * `commit` holds the lock across its own two manifest writes. That leaves a window
   * between this run's `prepare` and its `commit`, in which another run can start and
   * finish. Its committed manifest is then overwritten when this run writes its pending
   * one, and its backups are left with nothing pointing at them. `commit` hashes each
   * file again before writing, so two runs cannot corrupt the same file, but two runs
   * touching different files would still lose one of the two records.
   * See "One writer at a time" in ARCHITECTURE.md.
   */
  it('refuses a second run while the first is between prepare and commit', async () => {
    const project = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    let reached = (): void => {};
    const inside = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = (): void => {};
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stagedHashes = 0;

    const suspending: FileStore = {
      ...project.store,
      async hash(path) {
        // Suspends on the second hash of a staged path, which lands inside `prepare`: `stage`
        // takes the first, after the encode. The assertion below checks where it stopped.
        if (project.tree.has(LOCK_PATH) && path.startsWith('.upfly/runs/')) {
          stagedHashes += 1;
          if (stagedHashes === 2) {
            reached();
            await suspended;
          }
        }
        return project.store.hash(path);
      },
    };

    const running = optimize(inputFor({ ...project, store: suspending, apply: true }));
    await inside;

    // The position is asserted, not assumed: the run is past `prepare`'s first
    // staged-path check and has not written a manifest yet. That is the gap, where a
    // lock taken only by `commit` would not be held.
    expect(project.tree.has(MANIFEST_PATH)).toBe(false);

    const other: RunContext = {
      runId: 'run-other',
      runDir: '.upfly/runs/run-other',
      now: () => '2026-09-13T00:00:00.000Z',
      declined: [],
    };
    await expect(commit([], project.store, other)).rejects.toThrow(
      expect.objectContaining({ code: 'TRANSACTION_LOCKED' }),
    );

    release();
    await running;

    // And the run cleans up after itself, or the next one inherits a locked project.
    expect(project.tree.has(LOCK_PATH)).toBe(false);
  });

  it('refuses a second run while the first is still encoding', async () => {
    const project = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const other: RunContext = {
      runId: 'run-other',
      runDir: '.upfly/runs/run-other',
      now: () => '2026-09-13T00:00:00.000Z',
      declined: [],
    };
    let during: unknown = null;
    const probe: ImageProbe = {
      ...project.probe,
      async encodeToFile(options) {
        during = await commit([], project.store, other).then(
          (manifest) => manifest.state,
          (error: unknown) => error,
        );
        return project.probe.encodeToFile(options);
      },
    };

    await optimize(inputFor({ ...project, probe }));

    // The encodes can take minutes. A run that started and finished inside them would have
    // its manifest replaced by this run's.
    expect(during).toEqual(expect.objectContaining({ code: 'TRANSACTION_LOCKED' }));
  });

  it('lets that same second run through once the lock is gone', async () => {
    // The control: the same second run with no other run in flight. Without it the
    // refusal above could be caused by anything at all in a half-finished run, and
    // would still read as proof of a lock.
    const project = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const other: RunContext = {
      runId: 'run-other',
      runDir: '.upfly/runs/run-other',
      now: () => '2026-09-13T00:00:00.000Z',
      declined: [],
    };

    await expect(commit([], project.store, other)).resolves.toMatchObject({ state: 'committed' });
  });
});

describe('a run refused before it writes', () => {
  const stagedFiles = (tree: ReadonlyMap<string, string>) =>
    [...tree.keys()].filter((path) => path.startsWith(`.upfly/runs/${RUN_ID}/`));

  it.each([
    ['a page it rewrites changed during the encodes', 'src/App.jsx', 'export {};\n'],
    ['a file appeared at the converted name during the encodes', 'src/logo.webp', 'theirs'],
  ])('leaves none of its staged files behind when %s', async (_when, path, text) => {
    const project = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const probe: ImageProbe = {
      ...project.probe,
      async encodeToFile(options) {
        project.tree.set(path, text);
        return project.probe.encodeToFile(options);
      },
    };

    await expect(optimize(inputFor({ ...project, probe }))).rejects.toThrow();

    // Every encode is a full-size image, and a refused run is not one `undo` can reach.
    expect(stagedFiles(project.tree)).toEqual([]);
  });
});

describe('an image saved while it is being encoded', () => {
  it('is refused, so the file converted is the file backed up and removed', async () => {
    const project = harness({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });
    const encode = project.probe.encodeToFile;
    const probe: ImageProbe = {
      ...project.probe,
      async encodeToFile(options) {
        const bytes = await encode(options);
        project.tree.set('src/logo.png', 'PNG saved from an image editor');
        return bytes;
      },
    };

    await expect(
      optimize(inputFor({ ...project, probe, publicPolicy: 'replace' })),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_FOREIGN_CHANGE',
      message: expect.stringContaining('src/logo.png changed while'),
    });
    expect(project.tree.get('src/App.jsx')).toBe(SOURCE);
    expect(project.tree.get('src/logo.png')).toBe('PNG saved from an image editor');
  });
});

describe('staging several images at once', () => {
  const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];
  const MANY = NAMES.map((name) => `import ${name} from "./${name}.png";\n`).join('');
  const PROJECT = Object.fromEntries([
    ['src/App.jsx', MANY],
    ...NAMES.map((name) => [`src/${name}.png`, `PNG ${name}`]),
  ]);

  /** Six images, each imported by `src/App.jsx`, every original removed once converted. */
  function sixImages(
    over: Partial<OptimizeInput> & Pick<OptimizeInput, 'store' | 'probe'>,
  ): OptimizeInput {
    return {
      ...inputFor(over),
      graph: buildGraph({
        root: ROOT,
        assets: NAMES.map((name) => asset(`src/${name}.png`)),
        references: NAMES.map((name) =>
          resolved('src/App.jsx', `./${name}.png`, `src/${name}.png`, MANY),
        ),
        unscannedFiles: [],
        texts: [scanned('src/App.jsx', MANY)],
      }),
      probes: NAMES.map((name) => probeOf(`src/${name}.png`)),
      publicPolicy: 'replace',
      ...over,
    };
  }

  /**
   * Encodes that wait until the test settles each one, so it sees which are in progress. A
   * failed encode leaves part of its file behind first, as a real encoder can.
   */
  function gated(project: ReturnType<typeof harness>) {
    const started: string[] = [];
    const gates = new Map<string, (failure: Error | null) => void>();
    const probe: ImageProbe = {
      ...project.probe,
      async encodeToFile(options) {
        const name = options.path.slice(`${ROOT}/src/`.length, -'.png'.length);
        started.push(name);
        const failure = await new Promise<Error | null>((resolve) => gates.set(name, resolve));
        if (failure === null) return project.probe.encodeToFile(options);
        project.tree.set(options.destination.slice(`${ROOT}/`.length), 'PARTIAL');
        throw failure;
      },
    };
    return {
      probe,
      started,
      finish(...names: string[]) {
        for (const name of names) gates.get(name)?.(null);
      },
      fail(name: string, failure: Error) {
        gates.get(name)?.(failure);
      },
    };
  }

  /** Lets every step the in-memory disk can take run, up to the next encode that waits. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) await new Promise((done) => setImmediate(done));
  }

  const runFiles = (tree: ReadonlyMap<string, string>) =>
    [...tree.keys()].filter((path) => path.startsWith(`.upfly/runs/${RUN_ID}/`));
  const projectFiles = (tree: ReadonlyMap<string, string>) =>
    Object.fromEntries([...tree].filter(([path]) => !path.startsWith('.upfly/')));

  it('encodes four at a time, the next as any finishes, and keeps the plan order', async () => {
    const project = harness(PROJECT);
    const encodes = gated(project);
    const run = optimize(sixImages({ ...project, probe: encodes.probe }));

    await settle();
    expect(encodes.started).toEqual(['a', 'b', 'c', 'd']);
    encodes.finish('c');
    await settle();
    expect(encodes.started).toEqual(['a', 'b', 'c', 'd', 'e']);
    encodes.finish('f', 'e', 'd', 'b', 'a');
    await settle();
    encodes.finish('f');

    const { manifest } = await run;
    expect(
      manifest?.operations.map((operation) =>
        operation.kind === 'edit' || operation.kind === 'move'
          ? operation.kind
          : `${operation.kind} ${operation.path}`,
      ),
    ).toEqual([
      ...NAMES.flatMap((name) => [`create src/${name}.webp`, `delete src/${name}.png`]),
      'edit',
    ]);
    for (const name of NAMES) {
      expect(project.tree.get(`src/${name}.webp`)).toBe(`WEBP(${ROOT}/src/${name}.png)`);
    }
  });

  it.each([
    [
      'its encode fails',
      (_project: ReturnType<typeof harness>, encodes: ReturnType<typeof gated>) =>
        encodes.fail('c', new Error('the encoder ran out of disk')),
      'the encoder ran out of disk',
    ],
    [
      'its original is saved again while it encodes',
      (project: ReturnType<typeof harness>, encodes: ReturnType<typeof gated>) => {
        project.tree.set('src/c.png', 'PNG c, saved again');
        encodes.finish('c');
      },
      'src/c.png changed while Upfly was converting it',
    ],
    [
      'its backup cannot be written',
      (_project: ReturnType<typeof harness>, encodes: ReturnType<typeof gated>) =>
        encodes.finish('c'),
      'no room to back up src/c.png',
    ],
  ])(
    'refuses when one image fails as others encode (%s): no other starts, and none of their files stay',
    async (_case, failC, message) => {
      const project = harness(PROJECT);
      const encodes = gated(project);
      const store: FileStore = {
        ...project.store,
        async copy(from, to) {
          if (from !== 'src/c.png' || message !== 'no room to back up src/c.png') {
            return project.store.copy(from, to);
          }
          project.tree.set(to, 'PARTIAL');
          throw new Error(message);
        },
      };
      let settled = false;
      const run = optimize(sixImages({ ...project, store, probe: encodes.probe })).finally(() => {
        settled = true;
      });

      await settle();
      expect(encodes.started).toEqual(['a', 'b', 'c', 'd']);
      failC(project, encodes);
      await settle();

      // Nothing more starts, and the refusal waits for the three still encoding, whose files
      // land after the failure and must be removed with the rest.
      expect(encodes.started).toEqual(['a', 'b', 'c', 'd']);
      expect(settled).toBe(false);
      const before = projectFiles(project.tree);
      encodes.finish('d', 'a', 'b');

      await expect(run).rejects.toThrow(message);
      expect(runFiles(project.tree)).toEqual([]);
      expect(projectFiles(project.tree)).toEqual(before);
      expect(project.tree.has(MANIFEST_PATH)).toBe(false);
      expect(project.tree.has(LOCK_PATH)).toBe(false);
    },
  );

  it('reports the earliest failing image in the plan, whichever failed first', async () => {
    const project = harness(PROJECT);
    const encodes = gated(project);
    const run = optimize(sixImages({ ...project, probe: encodes.probe }));

    await settle();
    encodes.fail('c', new Error('c could not be encoded'));
    await settle();
    encodes.fail('a', new Error('a could not be encoded'));
    encodes.finish('b', 'd');

    // One at a time, the run would have stopped at a.
    await expect(run).rejects.toThrow('a could not be encoded');
    expect(runFiles(project.tree)).toEqual([]);
  });
});

describe('a lock file its creator is still writing', () => {
  it('is taken as held, so a second run cannot start beside the first', async () => {
    // What a reader sees between the creator's exclusive create and its write: nothing yet,
    // or part of the holder.
    for (const partial of ['', '{"pid": 4']) {
      const project = harness({
        'src/App.jsx': SOURCE,
        'src/logo.png': 'PNG',
        [LOCK_PATH]: partial,
      });

      await expect(optimize(inputFor(project))).rejects.toMatchObject({
        code: 'TRANSACTION_LOCKED',
      });
      expect(project.tree.get(LOCK_PATH)).toBe(partial);
      expect(project.tree.get('src/App.jsx')).toBe(SOURCE);
    }
  });
});

describe('replace refuses to delete an original a mention would outlive', () => {
  /**
   * A served asset, one reference the engine found, and whatever else is on disk.
   *
   * A `public` serving root with `publicPolicy: 'replace'` is what makes the original a
   * deletion candidate; outside a served directory nothing is deleted and the search for
   * surviving mentions does not apply.
   */
  /** The extensions no adapter claims, which the walk hands the graph as unscanned. */
  const UNREAD = new Set(['.yml', '.yaml', '.txt', '.pdf', '.log']);

  function servedProject(tree: Record<string, string>, files: readonly string[]) {
    const html = tree['index.html'] ?? '';
    const assets = [asset('public/logo.png')];
    const references = [resolved('index.html', '/logo.png', 'public/logo.png', html)];
    const project = harness(tree);

    return {
      ...project,
      input: inputFor({
        ...project,
        files,
        graph: buildGraph({
          root: ROOT,
          assets,
          references,
          // As the walk hands them over, so a reason about where a path sits is read from
          // the same facts a real run has.
          unscannedFiles: files.flatMap((file) => {
            const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
            return UNREAD.has(extension)
              ? [
                  {
                    path: `${ROOT}/${file}`,
                    relative: file,
                    extension,
                    reason: 'unclaimed-extension' as const,
                    detail: '',
                  },
                ]
              : [];
          }),
          texts: [scanned('index.html', html)],
        }),
        probes: [probeOf('public/logo.png')],
        publicPolicy: 'replace' as const,
        servingRoots: { dirs: ['public'], declared: true },
        apply: false,
      }),
    };
  }

  it('converts normally when the only mention is one it will rewrite', async () => {
    // At plan time every mention still reads as the old path, including the reference
    // the run is about to repoint. A guard that did not exclude those would refuse every
    // conversion it looked at, and a guard that always fires gets deleted by the next
    // person.
    const { input } = servedProject(
      { 'index.html': '<img src="/logo.png">', 'public/logo.png': 'PNG' },
      ['index.html'],
    );

    const result = await optimize(input);

    expect(result.plan.conversions.map((conversion) => conversion.asset)).toEqual([
      'public/logo.png',
    ]);
    expect(result.plan.conversions[0]?.replacesOriginal).toBe(true);
  });

  it('keeps an original that a page saved during the encodes names, and converts it all the same', async () => {
    const { input, tree, probe } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'about.html': '<p>About</p>',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'about.html'],
    );
    const saving: ImageProbe = {
      ...probe,
      async encodeToFile(options) {
        tree.set('about.html', '<img src="/logo.png">');
        return probe.encodeToFile(options);
      },
    };

    const result = await optimize({ ...input, probe: saving, apply: true });

    // Deleting the original now would break `about.html`. The run goes on: the new file is
    // written and the page the plan read is pointed at it.
    expect(tree.get('public/logo.png')).toBe('PNG');
    expect(tree.has('public/logo.webp')).toBe(true);
    expect(tree.get('index.html')).toBe('<img src="/logo.webp">');
    const kept = result.plan.keptOriginals.find((entry) => entry.asset === 'public/logo.png');
    expect(kept?.reason).toBe(
      'converted, but the original was kept: about.html:1 still names its path, written while Upfly was converting, in a form Upfly cannot rewrite',
    );
    expect(result.manifest?.operations.map((operation) => operation.kind)).not.toContain('delete');
  });

  it('says a mention found after the encodes was written meanwhile only when its file changed', async () => {
    // Two images share the suffix `team/diana.jpg`. Before the encodes, the line naming the
    // bogota image is that image's, a reference the first plan rewrites. A mention nothing
    // parses keeps the bogota image as it is, so the plan leaves the line as written, and the
    // search after the encodes, looking for the cali image alone, finds it by the suffix.
    // Nothing was written meanwhile, so the reason must not say so.
    const cali = '<img src="/cali/team/diana.jpg">';
    const bangalore = '<img src="/bogota/team/diana.jpg">';
    const project = harness({
      'cali.html': cali,
      'bangalore.html': bangalore,
      'bogota.yml': 'photo: /bogota/team/diana.jpg\n',
      'public/cali/team/diana.jpg': 'JPG',
      'public/bogota/team/diana.jpg': 'JPG',
    });
    const [bogota, mine] = ['public/bogota/team/diana.jpg', 'public/cali/team/diana.jpg'];

    const result = await optimize(
      inputFor({
        ...project,
        files: ['bangalore.html', 'bogota.yml', 'cali.html'],
        graph: buildGraph({
          root: ROOT,
          assets: [asset(bogota), asset(mine)],
          references: [
            resolved('bangalore.html', '/bogota/team/diana.jpg', bogota, bangalore),
            resolved('cali.html', '/cali/team/diana.jpg', mine, cali),
          ],
          unscannedFiles: [],
          texts: [scanned('bangalore.html', bangalore), scanned('cali.html', cali)],
        }),
        probes: [probeOf(bogota), probeOf(mine)],
        publicPolicy: 'replace',
      }),
    );

    expect(result.plan.declined.map((entry) => entry.path)).toContain(bogota);
    expect(result.plan.keptOriginals).toEqual([
      {
        asset: mine,
        reason:
          'converted, but the original was kept: bangalore.html:1 (and 1 more) still names its path: Upfly cannot rule out that this line names it',
      },
    ]);
    expect(project.tree.get('bangalore.html')).toBe(bangalore);
  });

  it('keeps an original that a file created during the encodes names, found by walking again', async () => {
    const { input, tree, probe } = servedProject(
      { 'index.html': '<img src="/logo.png">', 'public/logo.png': 'PNG' },
      ['index.html'],
    );
    const creating: ImageProbe = {
      ...probe,
      async encodeToFile(options) {
        tree.set('notes.html', '<img src="/logo.png">');
        return probe.encodeToFile(options);
      },
    };
    const listFiles = async () => ({
      files: [...tree.keys()].filter((path) => path.endsWith('.html')),
      unread: [],
    });

    const result = await optimize({ ...input, probe: creating, apply: true, listFiles });

    expect(tree.get('public/logo.png')).toBe('PNG');
    const kept = result.plan.keptOriginals.find((entry) => entry.asset === 'public/logo.png');
    expect(kept?.reason).toBe(
      'converted, but the original was kept: notes.html:1 still names its path, written while Upfly was converting, in a form Upfly cannot rewrite',
    );
  });

  it('refuses the conversion when a mention survives in a file nothing parses', async () => {
    // The reference in `index.html` is rewritten; the one in `deploy.yml` is not, and
    // deleting the original would make it a 404.
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'deploy.yml': 'banner: /logo.png\n',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'deploy.yml'],
    );

    const result = await optimize(input);

    expect(result.plan.conversions).toEqual([]);
    // And it is reported, not skipped: the reason names the trade.
    const declined = result.plan.declined.find((entry) => entry.path === 'public/logo.png');
    // It names where. A reason that says a mention survives somewhere leaves the user to
    // search for a path the engine had already located.
    expect(declined?.reason).toContain('deploy.yml:1');
    // And what kind of place it is, so nobody has to open the file to find out.
    expect(declined?.reason).toContain('in a .yml file, a type Upfly does not read');
  });

  it('reads no binary file, and a text file nothing parses that names the original still keeps it', async () => {
    // A PDF or a video can hold no path Upfly reads, and reading one as text costs the run
    // its time; a plain text file can hold one.
    const tree = {
      'index.html': '<img src="/logo.png">',
      'docs/manual.pdf': 'a binary stream that happens to hold /logo.png',
      'public/logo.png': 'PNG',
    };
    const recorded = (project: ReturnType<typeof servedProject>) => {
      const read: string[] = [];
      const store: FileStore = {
        ...project.store,
        readText: async (path) => {
          read.push(path);
          return project.store.readText(path);
        },
      };
      return { read, input: { ...project.input, store } };
    };

    const binary = recorded(servedProject(tree, ['index.html', 'docs/manual.pdf']));
    const converted = await optimize(binary.input);
    const text = recorded(
      servedProject({ ...tree, 'notes.txt': 'see /logo.png\n' }, [
        'index.html',
        'docs/manual.pdf',
        'notes.txt',
      ]),
    );
    const kept = await optimize(text.input);

    expect(binary.read).not.toContain('docs/manual.pdf');
    expect(converted.plan.conversions.map((conversion) => conversion.replacesOriginal)).toEqual([
      true,
    ]);
    expect(text.read).toContain('notes.txt');
    expect(text.read).not.toContain('docs/manual.pdf');
    expect(kept.plan.conversions).toEqual([]);
    expect(kept.plan.declined.find((entry) => entry.path === 'public/logo.png')?.reason).toContain(
      'notes.txt:1',
    );
  });

  it('refuses it as well when that mention spells the path in another letter case', async () => {
    // Windows and macOS load `/LOGO.png` from `logo.png`, so the mention reaches the original
    // there as surely as one spelled exactly.
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'deploy.yml': 'banner: /LOGO.png\n',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'deploy.yml'],
    );

    const result = await optimize(input);

    expect(result.plan.conversions).toEqual([]);
    const declined = result.plan.declined.find((entry) => entry.path === 'public/logo.png');
    expect(declined?.reason).toContain('deploy.yml:1');
  });

  it('says the run excluded the file when only an excluded file still names the path', async () => {
    // The search reads what the run's rules left out, so the original stays, but the path
    // there is one Upfly would have rewritten had the run included the file.
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'legacy/old.html': '<img src="/logo.png">',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'legacy/old.html'],
    );

    const result = await optimize({ ...input, excludedFiles: ['legacy/old.html'] });

    expect(result.plan.conversions).toEqual([]);
    const declined = result.plan.declined.find((entry) => entry.path === 'public/logo.png');
    expect(declined?.reason).toBe(
      'converting it would delete the original, and legacy/old.html:1 still names its path, in a file this run excluded',
    );
  });

  it('names a mention in a file the run reads before one in a file it excluded', async () => {
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'deploy.yml': 'banner: /logo.png\n',
        'legacy/old.html': '<img src="/logo.png">',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'deploy.yml', 'legacy/old.html'],
    );

    const result = await optimize({ ...input, excludedFiles: ['legacy/old.html'] });

    const declined = result.plan.declined.find((entry) => entry.path === 'public/logo.png');
    expect(declined?.reason).toContain('deploy.yml:1');
    expect(declined?.reason).toContain('in a .yml file, a type Upfly does not read');
  });

  it('rewrites the path inside a comment, and converts the image', async () => {
    // A commented-out copy of an old line names the image. Nothing loads a comment, so it
    // cannot keep the conversion from happening; and the path in it names the file it names,
    // so it moves with the references rather than being left pointing at a deleted file.
    const page = '<img src="/logo.png">';
    const code = `const hero = "/logo.webp";\n// const hero = "/logo.png";\n`;
    const project = harness({
      'index.html': page,
      'src/App.jsx': code,
      'public/logo.png': 'PNG',
    });
    const input = inputFor({
      ...project,
      files: ['index.html', 'src/App.jsx'],
      graph: buildGraph({
        root: ROOT,
        assets: [asset('public/logo.png')],
        references: [resolved('index.html', '/logo.png', 'public/logo.png', page)],
        unscannedFiles: [],
        texts: [scanned('index.html', page), scanned('src/App.jsx', code)],
      }),
      probes: [probeOf('public/logo.png')],
      publicPolicy: 'replace' as const,
      servingRoots: { dirs: ['public'], declared: true },
      apply: true,
    });

    const result = await optimize(input);

    expect(result.plan.conversions.map((conversion) => conversion.asset)).toEqual([
      'public/logo.png',
    ]);
    expect(result.plan.declined).toEqual([]);
    expect(project.tree.has('public/logo.png')).toBe(false);
    expect(project.tree.get('index.html')).toBe('<img src="/logo.webp">');
    expect(project.tree.get('src/App.jsx')).toBe(
      `const hero = "/logo.webp";\n// const hero = "/logo.webp";\n`,
    );
    // Shown as an edit like any other, so the dry run previews it and `undo` reverses it.
    expect(result.plan.rewrites.map((rewrite) => rewrite.file)).toEqual([
      'index.html',
      'src/App.jsx',
    ]);
  });

  it('leaves a comment alone when the image it names is not converting', async () => {
    // A comment never makes an image convert: this one names an image nothing links to, so
    // the plan converts nothing and the comment keeps the path it has.
    const code = `// const hero = "/logo.png";\n`;
    const project = harness({ 'src/App.jsx': code, 'public/logo.png': 'PNG' });
    const input = inputFor({
      ...project,
      files: ['src/App.jsx'],
      graph: buildGraph({
        root: ROOT,
        assets: [asset('public/logo.png')],
        references: [],
        unscannedFiles: [],
        texts: [scanned('src/App.jsx', code)],
      }),
      probes: [probeOf('public/logo.png')],
      publicPolicy: 'replace' as const,
      servingRoots: { dirs: ['public'], declared: true },
      apply: true,
    });

    const result = await optimize(input);

    expect(result.plan.conversions).toEqual([]);
    expect(result.plan.rewrites).toEqual([]);
    expect(project.tree.get('src/App.jsx')).toBe(code);
  });

  it('does not refuse under keep-original, where nothing is deleted', async () => {
    // The other half of the trade. With the original left on disk the surviving mention
    // still resolves, so refusing would cost a saving to prevent nothing. Same tree as the
    // test above, one policy different, opposite answer.
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'deploy.yml': 'banner: /logo.png\n',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'deploy.yml'],
    );

    const result = await optimize({ ...input, publicPolicy: 'keep-original' });

    expect(result.plan.conversions.map((conversion) => conversion.asset)).toEqual([
      'public/logo.png',
    ]);
  });

  it('guards a dry run identically, because the preview must be the decisions', async () => {
    // `OptimizeResult.plan` is documented as identical on a dry run and an applied one.
    // A guard that fired only on apply would quietly break that, and the preview would
    // promise a conversion the real run refuses.
    const tree = {
      'index.html': '<img src="/logo.png">',
      'deploy.yml': 'banner: /logo.png\n',
      'public/logo.png': 'PNG',
    };
    const dry = servedProject(tree, ['index.html', 'deploy.yml']);
    const wet = servedProject(tree, ['index.html', 'deploy.yml']);

    const preview = await optimize({ ...dry.input, apply: false });
    const applied = await optimize({ ...wet.input, apply: true });

    expect(preview.plan.conversions).toEqual([]);
    expect(applied.plan.conversions).toEqual([]);
    // Nothing was written, because there was nothing left to do.
    expect(wet.encodes).toEqual([]);
  });

  it('searches files the graph never saw, which is the whole point', async () => {
    // Premise, asserted: `deploy.yml` holds no reference the engine recognises, so it
    // appears nowhere in the graph. A file list derived from the graph would not contain
    // it, and the guard would let the mention through.
    const { input } = servedProject(
      {
        'index.html': '<img src="/logo.png">',
        'deploy.yml': 'banner: /logo.png\n',
        'public/logo.png': 'PNG',
      },
      ['index.html', 'deploy.yml'],
    );
    const referencedFiles = new Set(input.graph.references.map((reference) => reference.file));
    expect(referencedFiles.has(`${ROOT}/deploy.yml`)).toBe(false);

    expect((await optimize(input)).plan.conversions).toEqual([]);
  });

  it('refuses the conversion when a file it had to search could not be read', async () => {
    // `locked.html` is listed but cannot be opened, so it may hold the one mention that
    // matters. Deleting over a gap in the search is a guess.
    const { input } = servedProject(
      { 'index.html': '<img src="/logo.png">', 'public/logo.png': 'PNG' },
      ['index.html', 'locked.html'],
    );

    const result = await optimize(input);

    expect(result.plan.conversions).toEqual([]);
    const declined = result.plan.declined.find((entry) => entry.path === 'public/logo.png');
    expect(declined?.reason).toContain('locked.html');
    expect(declined?.reason).toContain('could not be read');
  });

  it('refuses it too when the walk could not list a directory, and not under keep-original', async () => {
    // A directory the walk could not open is the same gap one level up: none of its files
    // reached the search. Under keep-original nothing is deleted, so the gap costs nothing.
    const { input } = servedProject(
      { 'index.html': '<img src="/logo.png">', 'public/logo.png': 'PNG' },
      ['index.html'],
    );
    const withGap = { ...input, unread: [{ file: 'private', reason: 'EACCES' }] };

    const replaced = await optimize(withGap);
    const kept = await optimize({ ...withGap, publicPolicy: 'keep-original' });

    expect(replaced.plan.conversions).toEqual([]);
    const declined = replaced.plan.declined.find((entry) => entry.path === 'public/logo.png');
    expect(declined?.reason).toContain('private');
    expect(kept.plan.conversions.map((conversion) => conversion.asset)).toEqual([
      'public/logo.png',
    ]);
  });
});

describe('replace at the seam: a new file only where a reference moves to it, a delete only where all do', () => {
  /**
   * The operations `optimize` emits, not only the plan: each test runs an applied
   * `replace` over one project holding every case, then reads the manifest and the disk.
   *
   * - Every reference moves (`logo.png`): converted, original deleted.
   * - A literal moves and the template still needs it (`theme-light.png`): converted,
   *   original kept.
   * - Linked only through references that stay (`theme-dark.png`, the icons, `hero.png`,
   *   `mark.png`) or by nothing (`orphan.png`): not converted.
   *
   * `logo.png` is the positive control: a fix that switched `replace` off would pass every
   * "not deleted" test here, and fails that one.
   */
  const INDEX = '<img src="/logo.png"><img src="/public/h%65ro.png"><img src="/mark">\n';
  const ABOUT = '<img src="/theme-light.png">\n';
  const THEME = 'const src = `/theme-${mode}.png`;\n';
  const CHAIN = "const icon = '/icon-' + size + '.png';\n";
  const PUBLIC = [
    'public/hero.png',
    'public/icon-16.png',
    'public/icon-32.png',
    'public/logo.png',
    'public/mark.png',
    'public/orphan.png',
    'public/theme-dark.png',
    'public/theme-light.png',
  ];
  /** Every asset nothing moves to: no new file may appear for any of them. */
  const UNUSED = [
    'public/hero.png',
    'public/icon-16.png',
    'public/icon-32.png',
    'public/mark.png',
    'public/orphan.png',
    'public/theme-dark.png',
  ];

  /** A pattern reference found in `text`, the way the resolver would hand one over. */
  function patternIn(
    file: string,
    text: string,
    rawPath: string,
    targets: readonly string[],
    over: Partial<RawReference> = {},
  ): Reference {
    const start = text.indexOf(rawPath);
    return {
      ...RAW,
      file: `${ROOT}/${file}`,
      rawPath,
      start,
      end: start + rawPath.length,
      ceiling: 'medium',
      resolution: 'resolved-pattern',
      confidence: 'medium',
      resolvedPaths: targets.map((target) => `${ROOT}/${target}`) as [string, ...string[]],
      resolvedVia: 'serving-root',
      ...over,
    } as Reference;
  }

  async function runEverything(publicPolicy: 'replace' | 'keep-original' = 'replace') {
    const tree: Record<string, string> = {
      'index.html': INDEX,
      'about.html': ABOUT,
      'src/theme.js': THEME,
      'src/icon.js': CHAIN,
    };
    for (const path of PUBLIC) tree[path] = `PNG ${path}`;
    const project = harness(tree);

    const references = [
      // Every reference moves: the positive control.
      resolved('index.html', '/logo.png', 'public/logo.png', INDEX),
      // Some move, some still need it: this literal moves, the template below does not.
      resolved('about.html', '/theme-light.png', 'public/theme-light.png', ABOUT),
      // Linked only through references that stay. A root-relative path that missed the
      // declared root, so its rewrite is refused, spelled so that the text search, which
      // looks for the path as written, finds none of its spellings.
      {
        ...resolved('index.html', '/public/h%65ro.png', 'public/hero.png', INDEX),
        resolvedVia: 'project-root',
        spelling: 'percent-encoded',
      } as Reference,
      // A path with no extension to swap, so a rewrite would change nothing.
      resolved('index.html', '/mark', 'public/mark.png', INDEX),
      // A template and a `+` chain, the two spellings of a pattern.
      patternIn('src/theme.js', THEME, '/theme-${mode}.png', [
        'public/theme-light.png',
        'public/theme-dark.png',
      ]),
      patternIn(
        'src/icon.js',
        CHAIN,
        "/icon-' + size + '.png",
        ['public/icon-16.png', 'public/icon-32.png'],
        {
          kind: 'string',
          shape: 'js.concat.pattern',
          asserted: false,
          assembledPath: '/icon-${}.png',
        },
      ),
      // Linked by nothing: `public/orphan.png` is an asset with no reference at all.
    ];

    const result = await optimize(
      inputFor({
        ...project,
        graph: buildGraph({
          root: ROOT,
          assets: PUBLIC.map((path) => asset(path)),
          references,
          unscannedFiles: [],
          texts: Object.entries(tree).map(([file, text]) => scanned(file, text)),
        }),
        probes: PUBLIC.map((path) => probeOf(path)),
        files: ['about.html', 'index.html', 'src/icon.js', 'src/theme.js'],
        publicPolicy,
        servingRoots: { dirs: ['public'], declared: true },
        apply: true,
      }),
    );

    const operations = result.manifest?.operations ?? [];
    const pathsOf = (kind: string) =>
      operations
        .filter((operation) => operation.kind === kind)
        .map((operation) => ('path' in operation ? operation.path : ''))
        .sort();
    return { tree: project.tree, result, creates: pathsOf('create'), deletes: pathsOf('delete') };
  }

  it('converts and deletes the original of an ordinarily rewritten literal, the positive control', async () => {
    const { tree, result, deletes, creates } = await runEverything();

    expect(result.manifest?.state).toBe('committed');
    expect(creates).toContain('public/logo.webp');
    expect(deletes).toContain('public/logo.png');
    expect(tree.has('public/logo.png')).toBe(false);
    expect(tree.get('index.html')).toContain('<img src="/logo.webp">');
  });

  it('converts and keeps the original when a literal moves and the template still needs it', async () => {
    const { tree, creates, deletes, result } = await runEverything();

    expect(creates).toContain('public/theme-light.webp');
    expect(deletes).not.toContain('public/theme-light.png');
    expect(tree.get('public/theme-light.png')).toBe('PNG public/theme-light.png');
    expect(tree.get('about.html')).toBe('<img src="/theme-light.webp">\n');
    expect(result.plan.keptOriginals).toEqual([
      {
        asset: 'public/theme-light.png',
        reason: expect.stringContaining('`src/theme.js` reaches it through `/theme-${mode}.png`'),
      },
    ]);
  });

  it('writes no new file for any asset nothing moves to, and leaves each original as it was', async () => {
    const { tree, creates, deletes } = await runEverything();

    for (const original of UNUSED) {
      const converted = original.replace(/\.png$/, '.webp');
      expect(creates, `${converted} was created`).not.toContain(converted);
      expect(tree.has(converted), `${converted} is on disk`).toBe(false);
      expect(deletes).not.toContain(original);
      expect(tree.get(original)).toBe(`PNG ${original}`);
    }
  });

  it('says why for every asset it did not convert, in the plan and in the record that outlives the run', async () => {
    const { result } = await runEverything();
    const reasons = Object.fromEntries(
      result.plan.declined.map((entry) => [entry.path, entry.reason]),
    );
    const recorded = new Set(result.manifest?.declined.map((entry) => entry.path));

    expect(reasons).toMatchObject({
      'public/hero.png': expect.stringContaining(
        '`index.html` names it as `/public/h%65ro.png`, and this run does not rewrite that reference',
      ),
      'public/icon-16.png': expect.stringContaining(
        "`src/icon.js` reaches it only through `/icon-' + size + '.png`",
      ),
      'public/mark.png': expect.stringContaining('which has no extension to change'),
      'public/orphan.png': expect.stringContaining('nothing links to it'),
      'public/theme-dark.png': expect.stringContaining(
        '`src/theme.js` reaches it only through `/theme-${mode}.png`',
      ),
    });
    for (const asset of UNUSED) {
      expect(reasons[asset]).toMatch(/used by nobody|nothing links to it/);
      expect(recorded.has(asset), `${asset} is missing from the manifest's declined`).toBe(true);
    }
  });

  it('creates exactly two files, stated as the whole run', async () => {
    // So a member added to the project without a test of its own still cannot gain an
    // unused file quietly.
    const { creates } = await runEverything();

    expect(creates).toEqual(['public/logo.webp', 'public/theme-light.webp']);
  });

  it('deletes exactly one original, stated as the whole run', async () => {
    // Its own test rather than a line in the one above, because the two halves of the
    // rule are separate code. With the conversion half removed this must stay green:
    // the deletion half alone still keeps every original a reference could need.
    const { deletes } = await runEverything();

    expect(deletes).toEqual(['public/logo.png']);
  });

  it('creates the same two files under keep-original, and deletes nothing', async () => {
    // Under either policy a file is created only where a reference moves to it.
    const { creates, deletes } = await runEverything('keep-original');

    expect(creates).toEqual(['public/logo.webp', 'public/theme-light.webp']);
    expect(deletes).toEqual([]);
  });
});

describe('what a caller is told, and when it may still say no', () => {
  const tree = () => ({ 'src/App.jsx': SOURCE, 'src/logo.png': 'PNG' });

  it('reports the plan on a dry run, and the files written once an applied run finishes', async () => {
    const dryEvents: OptimizeProgress[] = [];
    const wetEvents: OptimizeProgress[] = [];

    await optimize(
      inputFor({ ...harness(tree()), apply: false, onProgress: (e) => dryEvents.push(e) }),
    );
    await optimize(inputFor({ ...harness(tree()), onProgress: (e) => wetEvents.push(e) }));

    expect(dryEvents).toEqual([{ stage: 'planned', conversions: 1, rewrites: 1 }]);
    // The converted image and the file whose reference moved.
    expect(wetEvents).toEqual([
      { stage: 'planned', conversions: 1, rewrites: 1 },
      { stage: 'written', files: 2 },
    ]);
  });

  it('writes nothing, not even an encode, when the check before writing says no', async () => {
    const store = harness(tree());
    const before = new Map(store.tree);
    const asked: number[] = [];

    const result = await optimize(
      inputFor({
        ...store,
        beforeWrite: (plan) => {
          asked.push(plan.conversions.length);
          return false;
        },
      }),
    );

    expect(asked).toEqual([1]);
    expect(result.plan.conversions).toHaveLength(1);
    expect(result.manifest).toBeNull();
    expect([...store.tree]).toEqual([...before]);
    expect(store.encodes).toEqual([]);
  });

  it('writes when the check says yes, and never asks it on a dry run or an empty plan', async () => {
    const asked: string[] = [];
    const check = (name: string) => async () => {
      asked.push(name);
      return true;
    };

    const applied = await optimize(inputFor({ ...harness(tree()), beforeWrite: check('applied') }));
    await optimize(inputFor({ ...harness(tree()), apply: false, beforeWrite: check('dry') }));
    await optimize(
      inputFor({
        ...harness(tree()),
        probes: [probeOf('src/logo.png', { encoded: [] })],
        beforeWrite: check('empty'),
      }),
    );

    expect(asked).toEqual(['applied']);
    expect(applied.manifest?.state).toBe('committed');
  });

  it('keeps its own folder out of git with a .gitignore inside it', async () => {
    const store = harness(tree());

    await optimize(inputFor(store));

    expect(store.tree.get('.upfly/.gitignore')).toBe('*\n');
  });

  it('leaves a .gitignore already in that folder as it is, and writes none on a dry run', async () => {
    const kept = harness({ ...tree(), '.upfly/.gitignore': 'runs/\n' });
    const dry = harness(tree());

    await optimize(inputFor(kept));
    await optimize(inputFor({ ...dry, apply: false }));

    expect(kept.tree.get('.upfly/.gitignore')).toBe('runs/\n');
    expect(dry.tree.has('.upfly/.gitignore')).toBe(false);
  });
});
