/**
 * `optimize` over a project on disk: the pipeline with every image measured, then the plan
 * and, when asked, the write. The CLI and the benchmark package's fixture builds both run
 * this, so what those builds prove is what users run.
 */

import { readdirSync } from 'node:fs';
import ignore from 'ignore';
import { defaultAdapters } from './adapters/default-adapters.js';
import { discover } from './discover/discover.js';
import {
  type PipelineOutput,
  type PipelineProgress,
  runPipeline,
  servingRootsFor,
} from './pipeline.js';
import type { PublicPolicy } from './plan/plan.js';
import { createSharpProbe } from './probe/probe-sharp.js';
import type { EncodeFormat } from './probe/probe.js';
import { searchScope } from './project-search.js';
import type { ServingRoots } from './resolve/resolve.js';
import { createNodeFileStore } from './write/file-store-node.js';
import {
  type OptimizeInput,
  type OptimizeProgress,
  type OptimizeResult,
  newRunId,
  optimize,
} from './write/optimize.js';
import type { LockPorts } from './write/transaction.js';

/**
 * What `optimizeProject` needs: the project, the format, what happens to originals, and whether to
 * write.
 */
export interface OptimizeProjectInput {
  /** The project directory. */
  readonly root: string;
  /** The folders the project says it is served from. Absent, Upfly decides them. */
  readonly declared?: ServingRoots;
  readonly format: EncodeFormat;
  readonly publicPolicy: PublicPolicy;
  /** Nothing is written unless this is true. */
  readonly apply: boolean;
  /** More paths to leave out, in `.gitignore` syntax, on top of `.upflyignore`. */
  readonly extraIgnores?: readonly string[];
  /** Called as each stage finishes: the pipeline's stages, then the plan's and the write's. */
  readonly onProgress?: (event: PipelineProgress | OptimizeProgress) => void;
  /** See `OptimizeInput.beforeWrite`. */
  readonly beforeWrite?: OptimizeInput['beforeWrite'];
  /** The run's id. A fresh one from the clock when absent. */
  readonly runId?: string;
  /** The clock the manifest's times come from. */
  readonly now?: () => string;
  readonly lock?: LockPorts;
  /**
   * The images the run may convert, when not every one. The whole project is still read, so
   * every reference is known and every other rule holds; the rest are never measured, and
   * an image that is not measured never converts.
   */
  readonly only?: OnlyImages;
}

/** Images named by exact path, by pattern, or both. */
export interface OnlyImages {
  /** POSIX paths relative to the project, each naming one image exactly. */
  readonly paths?: readonly string[];
  /** Patterns in `.gitignore` syntax, relative to the project, as `extraIgnores` takes them. */
  readonly patterns?: readonly string[];
}

/**
 * What `optimizeProject` returns: the engine's findings, the run with its plan, and the images
 * `only` named.
 */
export interface OptimizeProjectResult {
  /** What the plan was made from: the graph, audit and measurements a report is built on. */
  readonly pipeline: PipelineOutput;
  readonly optimize: OptimizeResult;
  /** With `only`: the images it named, sorted, and each path or pattern that named none. */
  readonly only?: { readonly images: readonly string[]; readonly unmatched: readonly string[] };
}

/**
 * Plans the optimization of the project at `root` and, when `apply` is true, carries it out.
 *
 * Every image is measured, or every one `only` names, with no cap: an image converts only on
 * a measured saving, so a cap would leave every image past it unconverted.
 *
 * @param input the project, the format and policy, and whether to write
 * @returns the pipeline's output and the run's result, whose plan is the same on a dry run
 * @throws {UpflyError} `TRANSACTION_LOCKED` when another run holds the project, and the
 * transaction's other codes when the tree changed under the run
 */
export async function optimizeProject(input: OptimizeProjectInput): Promise<OptimizeProjectResult> {
  const only = input.only === undefined ? undefined : namedBy(input.only);
  const pipeline = await runPipeline({
    root: input.root,
    servingRoots: servingRootsFor(input.declared),
    publicDirs: (servingRoots) => servingRoots.dirs,
    probeOptions: { formats: [input.format] },
    ...(only === undefined ? {} : { measureOnly: only }),
    ...(input.extraIgnores === undefined ? {} : { extraIgnores: input.extraIgnores }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  const result = await optimizeFromPipeline(pipeline, input);
  if (input.only === undefined || only === undefined) return { pipeline, optimize: result };
  const images = pipeline.graph.assets.map((node) => node.asset.relative);
  return {
    pipeline,
    optimize: result,
    only: {
      images: images.filter(only),
      unmatched: [
        ...(input.only.paths ?? []).filter((path) => !images.includes(path)),
        ...(input.only.patterns ?? []).filter(
          (pattern) => !images.some(namedBy({ patterns: [pattern] })),
        ),
      ],
    },
  };
}

/**
 * The plan, and when asked the write, from a pipeline run that already measured the images:
 * what `optimizeProject` does after its own pipeline. `upfly audit` plans with it on its own
 * measurements, so the savings it states are the ones a dry run of `optimize` would plan.
 *
 * @param pipeline the project as `runPipeline` read and measured it
 * @param input the format, the policy, whether to write, and the run's other settings
 * @returns the run's result, whose plan is the same on a dry run
 * @throws {UpflyError} as `optimizeProject` does
 */
export async function optimizeFromPipeline(
  pipeline: PipelineOutput,
  input: Omit<OptimizeProjectInput, 'root' | 'declared' | 'only' | 'onProgress'> & {
    readonly onProgress?: (event: OptimizeProgress) => void;
  },
): Promise<OptimizeResult> {
  const { discovery } = pipeline;
  return optimize({
    graph: pipeline.graph,
    audit: pipeline.audit,
    probes: pipeline.probes ?? [],
    probe: await createSharpProbe(),
    store: createNodeFileStore(discovery.root),
    // Under replace, the search reads past the run's exclusions: they limit what the run
    // changes, and a page one left out may still show the original.
    ...(await searchScope(discovery, input.publicPolicy === 'replace')),
    // The same walk again, for the search made after the encodes.
    listFiles: async () =>
      searchScope(
        await discover({
          root: discovery.root,
          adapters: defaultAdapters,
          ...(input.extraIgnores === undefined ? {} : { extraIgnores: input.extraIgnores }),
        }),
        input.publicPolicy === 'replace',
      ),
    servingRoots: pipeline.servingRoots,
    aliases: pipeline.aliases,
    builds: pipeline.builds,
    listDirectory,
    format: input.format,
    publicPolicy: input.publicPolicy,
    apply: input.apply,
    runId: input.runId ?? newRunId(new Date()),
    now: input.now ?? (() => new Date().toISOString()),
    ...(input.lock === undefined ? {} : { lock: input.lock }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.beforeWrite === undefined ? {} : { beforeWrite: input.beforeWrite }),
  });
}

/** Whether an image's POSIX-relative path is one `only` names. */
function namedBy(only: OnlyImages): (relative: string) => boolean {
  const paths = new Set(only.paths ?? []);
  const patterns = ignore().add([...(only.patterns ?? [])]);
  return (relative) => paths.has(relative) || patterns.ignores(relative);
}

/**
 * The names in a directory, for the plan's count of the files an ignore rule kept out of the
 * walk. Only names are read, never a file. A directory that cannot be listed, most often one
 * that does not exist, holds nothing the plan can count.
 */
function listDirectory(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
