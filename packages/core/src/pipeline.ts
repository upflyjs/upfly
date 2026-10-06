/**
 * The engine wired end to end: discovery, scan, aliases, serving roots, resolution, graph,
 * sweep, probe and audit.
 *
 * Every caller that measures or writes runs this one function, so the accuracy figures and
 * the write path describe the same engine. What callers legitimately decide differently is a
 * parameter: where files are served from, and whether to probe.
 *
 * This is where the pure stages get their filesystem ports: `readFile` for the scan and the
 * sweep, `exists` for aliases and resolution.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { defaultAdapters } from './adapters/default-adapters.js';
import { type AuditResult, audit } from './audit/audit.js';
import { detectConventionRoots } from './audit/conventions.js';
import { hashCandidates } from './audit/duplicates.js';
import { type SweepResult, sweepForMentions } from './audit/sweep.js';
import { discover } from './discover/discover.js';
import { type Graph, buildGraph } from './graph/graph.js';
import { type ProjectBuilds, detectBuilds } from './plan/builds.js';
import { createSharpProbe } from './probe/probe-sharp.js';
import {
  type AssetProbe,
  type ProbeDiagnostic,
  type ProbeOptions,
  probeAssets,
} from './probe/probe.js';
import { type AliasMap, loadAliases } from './resolve/aliases.js';
import { type ServingRoots, resolveReferences } from './resolve/resolve.js';
import { decideServingRoots } from './resolve/serving-root-decision.js';
import { type ScanDiagnostic, scanSources } from './scan/scan.js';
import type { Adapter, Asset, DiscoveryResult, Reference } from './types.js';

const ADAPTERS: readonly Adapter[] = defaultAdapters;

/**
 * What `runPipeline` reads: the project, where it serves files from, what to measure, and what to
 * leave out.
 */
export interface PipelineInput {
  readonly root: string;
  /**
   * Where root-relative paths are served from. A function because detection needs the
   * finished walk and inference needs the finished scan, so it is called after both.
   */
  readonly servingRoots: (
    discovery: DiscoveryResult,
    scanned: Awaited<ReturnType<typeof scanSources>>,
  ) => ServingRoots;
  /**
   * The directories the sweep and the audit treat as served. Callers pass the serving
   * roots' own list; it stays a parameter because what the resolver tries and what the
   * audit considers served are separate questions.
   */
  readonly publicDirs: (servingRoots: ServingRoots) => readonly string[];
  /**
   * Probe options, or `null` to skip probing.
   *
   * A value rather than a function, so that an object literal naming `alwaysMeasure` is a
   * compile error: the cap applies to every asset alike, and excess-property checks apply
   * only to a fresh literal. `null` rather than an empty object, because `audit` reads the
   * presence of probes as "was probed".
   */
  readonly probeOptions: Omit<
    ProbeOptions,
    'probe' | 'alwaysMeasure' | 'onDiagnostic' | 'onMeasured' | 'encodeOnly'
  > | null;
  /**
   * Which images to measure, by POSIX-relative path; every image when absent. The rest are
   * still walked, read for references and audited, only never measured.
   */
  readonly measureOnly?: (relative: string) => boolean;
  /**
   * The only images to encode, by POSIX-relative path, worked out once the graph is built;
   * every measured image when absent. The rest have their header read and are not encoded,
   * and a cap chooses among these. `convertibleImages` gives the images a plan could convert.
   */
  readonly encodeOnly?: (built: EncodeContext) => ReadonlySet<string>;
  /** More paths to leave out, in `.gitignore` syntax, on top of the project's `.upflyignore`. */
  readonly extraIgnores?: readonly string[];
  /**
   * Called as each stage finishes, with what it counted, and while images are measured, with
   * how many are done, so a caller can show progress.
   */
  readonly onProgress?: (event: PipelineProgress) => void;
}

/** What `PipelineInput.encodeOnly` decides from: the graph and what a plan's rules read. */
export interface EncodeContext {
  readonly graph: Graph;
  readonly servingRoots: ServingRoots;
  readonly builds: ProjectBuilds;
  readonly aliases: AliasMap;
}

/** One stage of the run finished. The numbers say what that stage counted. */
export type PipelineProgress =
  | { readonly stage: 'discovered'; readonly images: number; readonly files: number }
  | { readonly stage: 'scanned'; readonly references: number }
  | { readonly stage: 'resolved'; readonly linked: number }
  /**
   * While images are measured: how many are done, of how many, as each image finishes. A
   * caller that writes a line per event can keep the ones `reportsMeasuring` names, so a big
   * project gives twenty lines.
   */
  | { readonly stage: 'measuring'; readonly done: number; readonly total: number }
  | { readonly stage: 'measured'; readonly images: number }
  | { readonly stage: 'audited'; readonly findings: number };

/**
 * Whether a writer of lines reports the measuring count at `done` of `total`: when `done`
 * enters a new twentieth of `total`, and always at the last. A project of twenty images or
 * fewer reports each one. The same counts every run, whichever image finishes first.
 *
 * @param done how many images are measured, from 1
 * @param total how many there are
 */
export function reportsMeasuring(done: number, total: number): boolean {
  return done === total || Math.floor((done * 20) / total) > Math.floor(((done - 1) * 20) / total);
}

/**
 * The serving roots a run uses: the folders the project declared, or, when it declared none,
 * what `decideServingRoots` works out from the walk and the references.
 *
 * Every caller that runs the engine on a real project decides its roots through this, so a
 * command and the measurements behind it cannot decide them differently.
 *
 * @param declared the project's own serving roots, when it states them
 */
export function servingRootsFor(declared?: ServingRoots): PipelineInput['servingRoots'] {
  return (discovery, scanned) =>
    declared ??
    decideServingRoots({
      root: discovery.root,
      directories: discovery.directories,
      assets: discovery.assets,
      sourceFiles: discovery.sourceFiles,
      unscannedFiles: discovery.unscannedFiles,
      references: scanned.references,
    }).servingRoots;
}

/**
 * Everything one run of the engine found, which `buildReport` turns into a report.
 */
export interface PipelineOutput {
  readonly discovery: DiscoveryResult;
  readonly scanned: Awaited<ReturnType<typeof scanSources>>;
  readonly references: readonly Reference[];
  readonly graph: Graph;
  readonly servingRoots: ServingRoots;
  readonly audit: AuditResult;
  /** Returned because `buildReport` needs it, and sweeping again would read every file twice. */
  readonly sweep: SweepResult;
  /** Absent for an unprobed run, which is what makes the report say so. */
  readonly probes: readonly AssetProbe[] | undefined;
  /**
   * What the imaging library said about the files it could not read. Kept out of the report,
   * because libvips words the same failure differently between runs and the report must be
   * byte-identical for identical input.
   */
  readonly diagnostics: readonly ProbeDiagnostic[];
  /**
   * What the parsers said, kept out of the report for the same reason: their wording changes
   * between versions, and the report carries Upfly's own classification instead.
   */
  readonly scanDiagnostics: readonly ScanDiagnostic[];
  /**
   * The aliases the resolver used, so a move can invert them. The graph does not record that
   * a reference came through an alias.
   */
  readonly aliases: AliasMap;
  /** The build of each package, which decides whether an image the build loads may convert. */
  readonly builds: ProjectBuilds;
  /** Milliseconds to build the graph, not counting the probe. */
  readonly graphMs: number;
}

function basenamesOf(assets: readonly Asset[]): Set<string> {
  return new Set(assets.map((asset) => asset.relative.split('/').pop()?.toLowerCase() ?? ''));
}

/**
 * Whether a file exists with every name below `root` spelled as given, letter case included:
 * the resolver's question to the disk.
 *
 * Windows and macOS find `img/LVM.jpg` by `img/lvm.jpg` and a Linux server does not, so asking
 * the disk alone would give a report that differs by machine. Each folder is listed at most
 * once, and only for a path the disk finds. The root's own spelling is taken as given.
 *
 * @param root the project root
 * @returns the check, for one absolute path at a time
 */
export function existsAsSpelled(root: string): (absolutePath: string) => boolean {
  const listings = new Map<string, ReadonlySet<string>>();
  const namesIn = (directory: string): ReadonlySet<string> => {
    let names = listings.get(directory);
    if (names === undefined) {
      try {
        names = new Set(readdirSync(directory));
      } catch {
        names = new Set();
      }
      listings.set(directory, names);
    }
    return names;
  };

  return (absolutePath) => {
    if (!existsSync(absolutePath)) return false;
    const below = relative(root, absolutePath);
    // On another drive there is no folder of the project's to compare against.
    if (isAbsolute(below)) return true;
    let directory = root;
    for (const name of below.split(sep)) {
      if (name === '') continue;
      if (name === '..') {
        directory = dirname(directory);
        continue;
      }
      if (!namesIn(directory).has(name)) return false;
      directory = join(directory, name);
    }
    return true;
  };
}

/**
 * Runs the engine over one project, reading it and changing nothing.
 *
 * @param input the project root, how to decide its serving roots, and whether to probe
 * @returns everything a report, a plan or a move is built from
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const readFileText = (path: string) => readFile(path, 'utf8');

  const started = performance.now();
  const progress = input.onProgress ?? (() => {});
  const discovery = await discover({
    root: input.root,
    adapters: ADAPTERS,
    ...(input.extraIgnores === undefined ? {} : { extraIgnores: input.extraIgnores }),
  });
  progress({
    stage: 'discovered',
    images: discovery.assets.length,
    files: discovery.sourceFiles.length + discovery.unscannedFiles.length,
  });
  const scanDiagnostics: ScanDiagnostic[] = [];
  const scanned = await scanSources({
    sourceFiles: discovery.sourceFiles,
    adapters: ADAPTERS,
    readFile: readFileText,
    assetBasenames: basenamesOf(discovery.assets),
    onDiagnostic: (entry) => scanDiagnostics.push(entry),
  });
  progress({ stage: 'scanned', references: scanned.references.length });
  // Alias configs are ordinary discovered files, so reading them needs no second walk.
  const aliases = await loadAliases({
    root: discovery.root,
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
    readFile: readFileText,
    isFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true,
  });
  // The same files, for the same reason: a settings file or a `package.json` is in the walk.
  const builds = await detectBuilds({
    files: [...discovery.sourceFiles, ...discovery.unscannedFiles],
    readFile: readFileText,
  });
  const servingRoots = input.servingRoots(discovery, scanned);
  const references = resolveReferences(scanned.references, {
    root: discovery.root,
    assets: discovery.assets,
    servingRoots,
    excludedRoots: discovery.excludedRoots,
    aliases,
    exists: existsAsSpelled(discovery.root),
  });
  const graph = buildGraph({
    root: discovery.root,
    assets: discovery.assets,
    references,
    unscannedFiles: [...discovery.unscannedFiles, ...scanned.unscanned],
    texts: scanned.texts,
  });
  const graphMs = Math.round(performance.now() - started);
  progress({
    stage: 'resolved',
    linked: graph.assets.filter((node) => node.references.length > 0).length,
  });

  const publicDirs = input.publicDirs(servingRoots);
  const sweep = await sweepForMentions({
    graph,
    readFile: readFileText,
    sizeOf: async (path) => (await stat(path)).size,
    // Read only when the cheaper two sources leave something unexplained.
    scannedMentions: scanned.mentions,
    publicDirs,
  });
  const diagnostics: ProbeDiagnostic[] = [];
  const probes =
    input.probeOptions === null
      ? undefined
      : await probeAssets(
          graph.assets
            .map((node) => node.asset)
            .filter((asset) => input.measureOnly?.(asset.relative) ?? true),
          {
            probe: await createSharpProbe(),
            ...input.probeOptions,
            ...(input.encodeOnly === undefined
              ? {}
              : { encodeOnly: input.encodeOnly({ graph, servingRoots, builds, aliases }) }),
            onDiagnostic: (entry) => diagnostics.push(entry),
            onMeasured: (done, total) => progress({ stage: 'measuring', done, total }),
          },
        );
  if (probes !== undefined) progress({ stage: 'measured', images: probes.length });
  // Directories whose framework reads certain filenames without being told to, taken from
  // the file list `discover` produced so that `audit` stays off the disk.
  const conventionRoots = detectConventionRoots([
    ...discovery.sourceFiles.map((file) => file.relative),
    ...discovery.unscannedFiles.map((file) => file.relative),
  ]);
  // Only assets whose size another asset shares are hashed: byte-identical files have equal
  // sizes, so a unique size rules a file out without reading it.
  const contentHashes = new Map<string, string>();
  for (const candidate of hashCandidates(discovery.assets)) {
    contentHashes.set(
      candidate.relative,
      createHash('sha256')
        .update(await readFile(candidate.path))
        .digest('hex'),
    );
  }

  // Spread rather than `probes: probes`: under `exactOptionalPropertyTypes` an explicit
  // `undefined` is not an absent key, and `audit` reads the key's presence as "was probed".
  const auditResult = await audit({
    contentHashes,
    graph,
    conventionRoots,
    sweep,
    readFile: readFileText,
    publicDirs,
    ...(probes === undefined ? {} : { probes }),
  });
  progress({ stage: 'audited', findings: auditResult.findings.length });

  return {
    discovery,
    scanned,
    references,
    graph,
    servingRoots,
    audit: auditResult,
    sweep,
    probes,
    diagnostics,
    scanDiagnostics,
    aliases,
    builds,
    graphMs,
  };
}
