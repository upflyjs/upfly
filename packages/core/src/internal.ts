/**
 * The engine's parts that `upfly-core`'s public entry does not promise, for this
 * repository's CLI, benchmarks and accuracy suite. Unstable and outside semver: any name
 * here can change or go in any release. A library user wants the public entry,
 * `upfly-core`.
 */

export { loadAliases } from './resolve/aliases.js';
export type { AliasMap } from './resolve/aliases.js';
export type { Asset, DiscoveryResult, Reference, UnscannedExtension } from './types.js';
export { buildGraph } from './graph/graph.js';
export type { AssetNode, Graph } from './graph/graph.js';
export { probeAssets } from './probe/probe.js';
export type { AssetProbe, ProbeDiagnostic } from './probe/probe.js';
export { audit } from './audit/audit.js';
export type { AuditResult } from './audit/audit.js';
export { CONVENTIONAL_SERVING_ROOTS, resolveReferences } from './resolve/resolve.js';
export { DEFAULT_IGNORED_DIRECTORIES, discover } from './discover/discover.js';
export {
  IMAGE_EXTENSIONS,
  compareStrings,
  imageFilenameCandidates,
  relativePath,
} from './paths.js';
export { LOCK_PATH, processIsAlive, readLockHolder } from './write/lock.js';
export { convertibleImages, servingRootOf, whyReferenceStays } from './plan/plan.js';
export { optimizeFromPipeline } from './optimize-project.js';
export type { LinkedReference } from './plan/plan.js';
export { sweepForMentions } from './audit/sweep.js';
export type { Mention } from './audit/sweep.js';
export { planRelocation } from './plan/relocate.js';
export type { Move, RelocationPlan } from './plan/relocate.js';
export { PROJECT_MARKERS, detectServingRoots } from './resolve/serving-roots.js';
export { commit, prepare } from './write/transaction.js';
export type { PlannedOperation } from './write/transaction.js';
export { scanSources } from './scan/scan.js';
export type { ScanDiagnostic } from './scan/scan.js';
export {
  decideServingRoots,
  isRootRelative,
  looksLikeAsset,
} from './resolve/serving-root-decision.js';
export type { ServingRootDecision } from './resolve/serving-root-decision.js';
export { UPFLY_DIRECTORY, pathsTouched } from './write/manifest.js';
export { applyEdits } from './write/edits.js';
export { checkMoveRegression } from './plan/move-check.js';
export { citeReferences } from './scan/citation.js';
export { createSharpProbe } from './probe/probe-sharp.js';
export { defaultAdapters } from './adapters/default-adapters.js';
export { detectConventionRoots } from './audit/conventions.js';
export { findSurvivingPaths } from './plan/old-path-search.js';
export { formatBytes } from './format.js';
export { isLinked, linkedPaths } from './resolve/reference.js';
export { newRunId } from './write/optimize.js';
export { resolutionHealth } from './audit/resolution-health.js';
export { shapeById } from './adapters/shapes.js';
export { spell, spellingsOf } from './adapters/reference-path.js';
export { existsAsSpelled, reportsMeasuring } from './pipeline.js';
