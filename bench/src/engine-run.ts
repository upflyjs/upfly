/**
 * The engine over one tree, and the two runs that write.
 *
 * `runEngine` only reads, deciding serving roots as a first run does. `optimizeTree`
 * converts images through the same entry point as `upfly optimize --apply`, and
 * `relocateTree` moves them. Both refuse the pinned validation corpus before anything
 * else.
 */

import { createHash } from 'node:crypto';
import {
  type Manifest,
  type OptimizeResult,
  type PublicPolicy,
  type ServingRoots,
  createNodeFileStore,
  optimizeProject,
  runPipeline,
  servingRootsFor,
} from 'upfly-core';
import {
  type AliasMap,
  type AssetProbe,
  type AuditResult,
  type DiscoveryResult,
  type Graph,
  type Move,
  type PlannedOperation,
  type RelocationPlan,
  applyEdits,
  commit,
  newRunId,
  planRelocation,
  prepare,
  searchScope,
} from 'upfly-core/internal';
import { refuseValidationCorpus } from './repos.js';

export interface EngineRun {
  readonly graph: Graph;
  readonly audit: AuditResult;
  readonly servingRoots: ServingRoots;
  /** The measurements the audit used, so nothing downstream measures again. */
  readonly probes: readonly AssetProbe[];
  /** The alias map the resolver used, which `relocate` needs in order to invert it. */
  readonly aliases: AliasMap;
  /**
   * What the walk found, for the directories it refused to enter.
   *
   * A move's broken-before-and-after count cannot see a reference inside a directory
   * nothing opened, and those files are missing from the unread count too. Stating that
   * gap needs `excludedRoots`, which only discovery has.
   */
  readonly discovery: DiscoveryResult;
}

/**
 * Everything up to the plan: graph, measurements, findings.
 *
 * Serving roots come from detection and inference, the path a first-time user takes,
 * unless `declared` states them as a configured project does. Measuring has no encode
 * cap.
 */
export async function runEngine(
  root: string,
  declared?: ServingRoots,
  /**
   * Whether to measure every asset by encoding it.
   *
   * A caller that never reads `probes` should pass `false`. Measuring encodes every
   * image, thousands of them on the larger validation repositories, and the graph, the
   * serving roots and the broken counts do not depend on it.
   */
  probe = true,
): Promise<EngineRun> {
  const output = await runPipeline({
    root,
    servingRoots: servingRootsFor(declared),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: probe ? { formats: ['webp'] } : null,
  });

  return {
    graph: output.graph,
    audit: output.audit,
    servingRoots: output.servingRoots,
    probes: output.probes ?? [],
    aliases: output.aliases,
    discovery: output.discovery,
  };
}

/**
 * The files the search after a move reads for each old path, from the walk: every file it
 * found, read or not, and the files the run's ignore rules excluded, which a page can still
 * be. A scope limits what a run changes, never what it reads.
 */
export async function filesAfterMove(discovery: DiscoveryResult): Promise<readonly string[]> {
  return (await searchScope(discovery, true)).files;
}

/**
 * Run the engine over `root` and apply what it plans, through the same core entry point
 * as `upfly optimize --apply`.
 *
 * The refusal comes first. This converts images and rewrites files under whatever path
 * it is handed, and the corpus path is an exported constant of this package, one wrong
 * argument away.
 */
export async function optimizeTree(
  root: string,
  declared?: ServingRoots,
  publicPolicy: PublicPolicy = 'keep-original',
): Promise<OptimizeResult> {
  refuseValidationCorpus(root);

  const { optimize } = await optimizeProject({
    root,
    ...(declared === undefined ? {} : { declared }),
    format: 'webp',
    publicPolicy,
    apply: true,
  });
  return optimize;
}

/**
 * Plan a set of moves over a real tree and carry them out.
 *
 * This answers what `relocate`'s tests cannot. A fixture is a tree whose every reference
 * the graph finds, because it was written for the engine. A move acts on what the graph
 * knows, so a reference the graph missed becomes a dangling reference the move caused,
 * and only a repository nobody wrote for Upfly has those.
 *
 * It refuses the pinned corpus first, as `optimizeTree` does.
 */
export async function relocateTree(
  root: string,
  moves: readonly Move[],
): Promise<{ plan: RelocationPlan; manifest: Manifest | null }> {
  refuseValidationCorpus(root);

  // `false`: a move converts nothing, so nobody would read the measurements.
  const { graph, servingRoots, aliases } = await runEngine(root, undefined, false);
  const store = createNodeFileStore(root);

  const plan = planRelocation({
    graph,
    moves,
    servingRoots,
    aliases,
  });

  if (plan.moves.length === 0) return { plan, manifest: null };

  const runId = newRunId(new Date());
  const runDir = `.upfly/runs/${runId}`;
  const operations: PlannedOperation[] = [];

  for (const move of plan.moves) {
    const hash = await store.hash(move.from);
    if (hash === null) throw new Error(`${move.from} vanished between planning and staging`);
    operations.push({ kind: 'move', from: move.from, to: move.to, hash });
  }

  for (const rewrite of plan.rewrites) {
    const before = await store.readText(rewrite.file);
    operations.push({
      kind: 'edit',
      path: rewrite.file,
      beforeHash: hashText(before, store.hashAlgorithm),
      afterHash: hashText(applyEdits(before, rewrite.edits), store.hashAlgorithm),
      edits: rewrite.edits,
    });
  }

  await prepare(operations, store, runDir);
  const manifest = await commit(operations, store, {
    runId,
    runDir,
    now: () => new Date().toISOString(),
    // Every reference the move could not follow goes into the manifest with its reason,
    // which outlives the run, rather than being printed once and lost.
    declined: plan.declined,
  });

  return { plan, manifest };
}

/** The same digest the store uses, so a manifest never names an algorithm twice. */
function hashText(text: string, algorithm: string): string {
  return createHash(algorithm).update(text, 'utf8').digest('hex');
}
