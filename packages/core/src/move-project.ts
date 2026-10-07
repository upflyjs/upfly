/**
 * `move` over a project on disk: move images, or every image in a folder, and point every
 * reference Upfly can rewrite at the new place, through the same transaction and manifest as
 * `optimize`, so `revert` puts every file back. Before anything is written it lists, for each
 * image that moves, every other line that names its old path, which no move rewrites. No
 * image is deleted: each moves, and nothing else is removed.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { StayingReference } from './dedupe-project.js';
import type { Graph } from './graph/graph.js';
import { toPosix } from './paths.js';
import {
  type PipelineOutput,
  type PipelineProgress,
  runPipeline,
  servingRootsFor,
} from './pipeline.js';
import { commentEditsFor, editsByFile } from './plan/comment-edits.js';
import type { Unsearchable } from './plan/old-path-search.js';
import type { PlannedRewrite } from './plan/plan.js';
import { withExtraEdits } from './plan/plan.js';
import { type Move, type RefusedMove, planRelocation } from './plan/relocate.js';
import type { UnfollowedLine } from './plan/unfollowed.js';
import { unfollowedLines } from './project-search.js';
import type { ServingRoots } from './resolve/resolve.js';
import { citeReferences } from './scan/citation.js';
import type { Reference } from './types.js';
import { createNodeFileStore } from './write/file-store-node.js';
import type { Manifest } from './write/manifest.js';
import { newRunId, writeRewrites } from './write/optimize.js';
import type { LockPorts } from './write/transaction.js';

/** What `moveProject` needs: the project, what to move where, and whether to write. */
export interface MoveProjectInput {
  /** The project directory. */
  readonly root: string;
  /** The folders the project says it is served from. Absent, Upfly decides them. */
  readonly declared?: ServingRoots;
  /** Nothing is written unless this is true. */
  readonly apply: boolean;
  /**
   * What to move, POSIX paths relative to the project. A `from` that is a folder rather than
   * an image moves every image under it, each to the same place under `to`.
   */
  readonly moves: readonly Move[];
  /** More paths to leave out, in `.gitignore` syntax, on top of `.upflyignore`. */
  readonly extraIgnores?: readonly string[];
  readonly onProgress?: (event: PipelineProgress) => void;
  /** Called with the finished plan before anything is written; `false` writes nothing. */
  readonly beforeWrite?: (plan: MovePlan) => boolean | Promise<boolean>;
  /** The run's id. A fresh one from the clock when absent. */
  readonly runId?: string;
  /** The clock the manifest's times come from. */
  readonly now?: () => string;
  readonly lock?: LockPorts;
}

/** What a move changes, what it refuses, and what still names the old paths afterwards. */
export interface MovePlan {
  /** The moves that will be made, in path order. */
  readonly moves: readonly Move[];
  /** The edits that point each reference at the new place, one entry per file. */
  readonly rewrites: readonly PlannedRewrite[];
  /** Moves not made, each with its reason. */
  readonly refused: readonly RefusedMove[];
  /**
   * References to a moved image that cannot follow it, each cited with why. The move still
   * happens, so each of these breaks unless it is changed by hand.
   */
  readonly declined: readonly StayingReference[];
  /** Every other line that names a moved image's old path, which Upfly does not follow. */
  readonly unfollowed: readonly UnfollowedLine[];
}

/** What `moveProject` returns: the engine's findings, the plan, and the run's record. */
export interface MoveProjectResult {
  /** What the plan was made from. */
  readonly pipeline: PipelineOutput;
  readonly plan: MovePlan;
  /** The record of the run, or `null` when nothing was written. */
  readonly manifest: Manifest | null;
  /** Files the search for the old paths could not read. */
  readonly unsearchable: readonly Unsearchable[];
}

/**
 * Plans moving the images and, when `apply` is true, moves them and points the references at
 * the new places.
 *
 * @param input the project, the moves, and whether to write
 * @returns the pipeline's output, the plan, and the run's record when it wrote
 * @throws {UpflyError} `TRANSACTION_LOCKED` when another run holds the project, and the
 * transaction's other codes when a file changed under the run
 */
export async function moveProject(input: MoveProjectInput): Promise<MoveProjectResult> {
  const pipeline = await runPipeline({
    root: input.root,
    servingRoots: servingRootsFor(input.declared),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: null,
    ...(input.extraIgnores === undefined ? {} : { extraIgnores: input.extraIgnores }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  const { graph, servingRoots, aliases } = pipeline;
  const relocation = planRelocation({
    graph,
    moves: input.moves.flatMap((move) => imagesIn(move, graph)),
    servingRoots,
    aliases,
    listDirectory,
  });
  const search = await unfollowedLines(
    pipeline,
    relocation.moves.map((move) => move.from),
  );
  // A path written inside a comment moves with the references: no page loads a comment, so
  // it never makes an image move, and after the move the path in it names nothing.
  const comments = commentEditsFor({
    comments: search.comments,
    destinations: new Map(relocation.moves.map((move) => [move.from, move.to])),
    servingDirs: servingRoots.dirs,
  });
  const rewritten = new Set(
    comments.map(
      (entry) => `${entry.image}
${entry.file}
${entry.line}`,
    ),
  );
  const plan: MovePlan = {
    moves: relocation.moves,
    rewrites: withExtraEdits(relocation.rewrites, editsByFile(comments)),
    refused: relocation.refused,
    declined: await cited(relocation.declined, relocation.declinedReferences, graph.root),
    unfollowed: search.lines.filter(
      (line) =>
        !rewritten.has(`${line.image}
${line.file}
${line.line}`),
    ),
  };
  const result = { pipeline, plan, unsearchable: search.unsearchable };

  if (!input.apply || plan.moves.length === 0) return { ...result, manifest: null };
  if (input.beforeWrite !== undefined && !(await input.beforeWrite(plan))) {
    return { ...result, manifest: null };
  }
  const manifest = await writeRewrites({
    moves: plan.moves,
    rewrites: plan.rewrites,
    store: createNodeFileStore(pipeline.discovery.root),
    runId: input.runId ?? newRunId(new Date()),
    now: input.now ?? (() => new Date().toISOString()),
    // What the run leaves naming an old path is kept in its record with each reason.
    declined: [
      ...plan.declined.map((entry) => ({ path: entry.file, line: entry.line, reason: entry.why })),
      ...plan.unfollowed.map((line) => ({ path: line.file, line: line.line, reason: line.why })),
    ],
    ...(input.lock === undefined ? {} : { lock: input.lock }),
  });
  return { ...result, manifest };
}

/**
 * The moves one request stands for: the image itself, or, for a folder, each image under it
 * to the same place under the destination. A path that is neither stays one move, which the
 * plan refuses as naming no image.
 */
function imagesIn(move: Move, graph: Graph): Move[] {
  const from = posix.normalize(toPosix(move.from));
  if (graph.assets.some((node) => node.asset.relative === from)) return [move];
  const prefix = from === '.' ? '' : `${from}/`;
  const inside = graph.assets
    .map((node) => node.asset.relative)
    .filter((path) => prefix !== '' && path.startsWith(prefix));
  if (inside.length === 0) return [move];
  return inside.map((path) => ({
    from: path,
    to: posix.join(toPosix(move.to), path.slice(prefix.length)),
  }));
}

/** Each declined reference, cited with its line so a reader can open it. */
async function cited(
  declined: readonly { readonly path: string; readonly reason: string }[],
  references: readonly Reference[],
  root: string,
): Promise<StayingReference[]> {
  const { citations } = await citeReferences({
    references: [...references],
    root,
    readFile: (path) => readFile(path, 'utf8'),
  });
  return declined.map((entry, index) => {
    const reference = references[index];
    const citation = reference === undefined ? undefined : citations.get(reference);
    const file = citation?.file ?? entry.path;
    return {
      file,
      line: citation?.line ?? null,
      where: citation?.where ?? file,
      text: reference?.rawPath ?? '',
      why: entry.reason,
    };
  });
}

/**
 * The names in a directory, for the check on where a new path leads, which counts the files
 * an ignore rule kept out of the walk. Only names are read, never a file.
 */
function listDirectory(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
