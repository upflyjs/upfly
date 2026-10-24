/**
 * The public API of `upfly-core`: what a library user needs to run the audit and read its
 * report, to run `optimizeProject` and `dedupeProject`, to undo a run, and to write an
 * adapter. Every name here is covered by semver. The engine's other parts are in
 * `upfly-core/internal`, for this repository's CLI and tools: unstable, and outside semver.
 */

// Running the audit, and the report it produces.
export { runPipeline, servingRootsFor } from './pipeline.js';
export type { PipelineInput, PipelineOutput, PipelineProgress } from './pipeline.js';
export type { ServingRoots } from './resolve/resolve.js';
export { REPORT_SCHEMA_VERSION, buildReport } from './report/report.js';
export type {
  Caveat,
  CoverageReport,
  ReferenceEntry,
  ReferenceReport,
  Report,
  ReportInput,
  ReportSummary,
  SkipStage,
  SkippedItem,
} from './report/report.js';
export { renderReport } from './report/report-human.js';
export type {
  BrokenFinding,
  DeadFinding,
  DuplicateFinding,
  Finding,
  FormatOpportunityFinding,
  OversizeDimension,
  OversizedFinding,
  PossiblyDeadFinding,
  ServingRootUnknownFinding,
  SuppressedBroken,
} from './audit/audit.js';
export type { Confidence, Resolution } from './types.js';
export type { EncodeFormat } from './probe/probe.js';

// Converting a project's images and rewriting their references.
export { optimizeProject } from './optimize-project.js';
export type {
  OnlyImages,
  OptimizeProjectInput,
  OptimizeProjectResult,
} from './optimize-project.js';
export type { OptimizeProgress, OptimizeResult } from './write/optimize.js';
export type {
  OptimizationPlan,
  PlanRefusal,
  PlannedConversion,
  PlannedRewrite,
  PublicPolicy,
} from './plan/plan.js';
export type { Declined, Manifest } from './write/manifest.js';

// Pointing the references to identical copies at one copy.
export { dedupeProject } from './dedupe-project.js';
export type {
  DedupeCopy,
  DedupePlan,
  DedupeProjectInput,
  DedupeProjectResult,
  DedupeSet,
  KeptBecause,
  StayingReference,
} from './dedupe-project.js';

// Undoing the last run: read its record, check each file, put every file back, or one file's
// changes or one line's; and list what it changed, with what of it is undone.
export { createNodeFileStore } from './write/file-store-node.js';
export { inspect, readManifest, revert } from './write/transaction.js';
export type { FileStore, OperationState } from './write/transaction.js';
export { describeRun, undoPart } from './write/undo-part.js';
// A run made without undo (`OptimizeProjectInput.undoable`) that was cut off part way is put
// back by this, which every caller that writes runs first.
export { settleNoUndoRun } from './write/no-undo.js';
export type { SettleOptions } from './write/no-undo.js';
export type {
  ChangedPath,
  FileChanges,
  LineChanges,
  PartUndone,
  RunChanges,
  RunOriginal,
  RunPart,
  UndoPartOptions,
} from './write/undo-part.js';

// What every function above throws, with a code to branch on.
export { UpflyError } from './errors.js';
export type { UpflyErrorCode } from './errors.js';

// Writing an adapter: one file format, read into references.
export { defineAdapter, rewriteByEdits } from './adapters/define.js';
export type { AdapterDefinition } from './adapters/define.js';
export type { Adapter, Edit, RawReference, ReferenceKind } from './types.js';
