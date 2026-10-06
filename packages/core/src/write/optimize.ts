/**
 * The wiring: a graph and its measurements in, a committed transaction out. The order is
 * fixed: plan, stage, prepare, commit.
 *
 * It carries no policy of its own. What converts, what is repointed and what is declined
 * is decided in `plan.ts`, which is pure; what is safe to write is decided in
 * `transaction.ts`. A condition here about whether to convert something belongs in the
 * planner, so that each rule has one implementation.
 */

import type { AuditResult } from '../audit/audit.js';
import { UpflyError } from '../errors.js';
import type { Graph } from '../graph/graph.js';
import { isBinaryExtension } from '../graph/unscanned.js';
import { compareStrings, extensionOf } from '../paths.js';
import type { ProjectBuilds } from '../plan/builds.js';
import {
  type Survivor,
  type Unsearchable,
  findSurvivingPaths,
  foldCase,
  spellingsFor,
} from '../plan/old-path-search.js';
import {
  MENTION_SURVIVES,
  type OptimizationPlan,
  type PlanRefusal,
  type PlannedRewrite,
  type PublicPolicy,
  type RootLinkPolicy,
  planOptimization,
} from '../plan/plan.js';
import type { AssetProbe, EncodeFormat, ImageProbe } from '../probe/probe.js';
import type { AliasMap } from '../resolve/aliases.js';
import type { ServingRoots } from '../resolve/resolve.js';
import { hashText } from '../scan/text-hash.js';
import { applyEdits } from './edits.js';
import { acquireLock } from './lock.js';
import { type Declined, type Manifest, UPFLY_DIRECTORY, pathsTouched } from './manifest.js';
import {
  type FileStore,
  type LockPorts,
  type PlannedEdit,
  type PlannedOperation,
  type RunContext,
  commit,
  prepare,
} from './transaction.js';

export interface OptimizeInput {
  /**
   * The graph the audit reported on, not one built separately. A second graph could
   * disagree with the report the user saw, and nothing would fail.
   */
  readonly graph: Graph;
  /**
   * The audit of that same graph, read only for its `possibly-dead` assets. Taken rather
   * than worked out again, so the rule that hedges an asset has one implementation.
   */
  readonly audit: AuditResult;
  /** The measurements the audit used, so a saving is never quoted from a new number. */
  readonly probes: readonly AssetProbe[];
  /** The writing half of the port that produced `probes`. */
  readonly probe: ImageProbe;
  readonly store: FileStore;
  /**
   * Every file in the project, POSIX-relative, scanned or not: the text searched for
   * mentions of an original the plan would delete.
   *
   * It has to come from the walk, not the graph. The search is for references the graph
   * never found, and a file holding only such a reference is not in the graph at all.
   * Required, and `[]` is a real answer: a caller that forgot it would get an empty search
   * and a confident delete.
   */
  readonly files: readonly string[];
  /**
   * What the walk could not read, so the search never saw it: a directory it could not
   * list. Any entry keeps every original the plan would delete, as a file the search
   * cannot open does, since a mention inside it cannot be ruled out. Required for the
   * reason `files` is: a caller that forgot it would delete over the gap.
   */
  readonly unread: readonly Unsearchable[];
  /**
   * The files in `files` that the run's ignore rules excluded. A mention in one keeps its
   * original all the same, and the decline says the run excluded the file. It changes
   * wording only: `files` stays the whole search, so a delete never depends on it.
   */
  readonly excludedFiles?: readonly string[];
  /**
   * Lists the project's files again after the images are encoded, which can take minutes, so
   * the search for mentions of an original about to be deleted also reads a page saved or
   * created meanwhile. Without it that search reads `files` again: it sees a page saved since,
   * not a new one.
   */
  readonly listFiles?: () => Promise<Pick<OptimizeInput, 'files' | 'unread' | 'excludedFiles'>>;
  readonly servingRoots: ServingRoots;
  /** The aliases the resolver used. See `PlanInput.aliases`. */
  readonly aliases?: AliasMap;
  /** The build of each package. See `PlanInput.builds`. */
  readonly builds: ProjectBuilds;
  /**
   * Lists a directory, so the plan counts the files the walk did not index. See
   * `PlanInput.listDirectory`.
   */
  readonly listDirectory?: (absolutePath: string) => readonly string[];
  readonly format: EncodeFormat;
  readonly publicPolicy: PublicPolicy;
  readonly rootLinkPolicy?: RootLinkPolicy;
  /** False for a dry run, which plans and writes nothing. */
  readonly apply: boolean;
  readonly runId: string;
  readonly now: () => string;
  /**
   * Test seams for the project lock, defaulting to the real process id and liveness check,
   * so leaving this out is correct. The same value goes to `optimize`'s own hold and to the
   * one `commit` takes inside it, so the two agree on which process this is, which re-entry
   * needs.
   */
  readonly lock?: LockPorts;
  /** Called as each stage finishes, with what it counted, so a caller can show progress. */
  readonly onProgress?: (event: OptimizeProgress) => void;
  /**
   * Called on an applied run once the plan is final, before anything is written, and only
   * when the plan has something to write. Returning false stops the run there: nothing is
   * written, and the result carries the plan with no manifest, as a dry run's does.
   *
   * A caller uses it for checks that need the finished plan, such as whether a version
   * control system will accept every file the run is about to write.
   */
  readonly beforeWrite?: (plan: OptimizationPlan) => boolean | Promise<boolean>;
}

/** One stage of an `optimize` run finished. The numbers say what that stage counted. */
export type OptimizeProgress =
  /** The decisions are made: images to convert, and files whose references move. */
  | { readonly stage: 'planned'; readonly conversions: number; readonly rewrites: number }
  /** An applied run finished writing: project files created, rewritten or removed. */
  | { readonly stage: 'written'; readonly files: number };

/**
 * Written inside Upfly's folder on the first applied run, so that git never lists the
 * folder and the project's own `.gitignore` never has to mention it. An existing file is
 * left as it is.
 */
const FOLDER_GITIGNORE = `${UPFLY_DIRECTORY}/.gitignore`;

/**
 * What a run did, or would do: its plan and, when it wrote, its record, or the refusal that
 * stopped it.
 */
export interface OptimizeResult {
  /** Every decision, identical on a dry run and an applied one. */
  readonly plan: OptimizationPlan;
  readonly runId: string;
  /** POSIX-relative, and where staged bytes and backups live. */
  readonly runDir: string;
  /** Written only by an applied run that had something to do. */
  readonly manifest: Manifest | null;
  /** Set when the planner declined to act at all, and nothing was written. */
  readonly refusal: PlanRefusal | null;
}

/** What stops a delete: a mention the plan would not rewrite, or a gap in the search. */
interface Blocked {
  /** Each asset a surviving mention names, mapped to where it is (`file:line`). */
  readonly assets: ReadonlyMap<string, string>;
  /** Each asset only files the run excluded still name, mapped to where (`file:line`). */
  readonly excluded: ReadonlyMap<string, string>;
  /** Each asset the plan would delete, mapped to what could not be read. */
  readonly unread: ReadonlyMap<string, string>;
  readonly occurrences: readonly Survivor[];
  /** Each asset in `assets` or `excluded`, mapped to the file its sentence names. */
  readonly namedIn: ReadonlyMap<string, string>;
}

/**
 * Which assets have a literal mention of their path that this plan would not rewrite.
 *
 * The planner already keeps any original that a reference the graph found still needs.
 * This searches the text for references the graph never found, such as a custom JSX prop
 * or a config value, before anything is written. A mention inside a range the plan
 * rewrites is not a survivor, or every conversion would be refused. Only originals the
 * plan deletes are searched: under `keep-original` a mention still resolves. A path built
 * at runtime (`'/images/' + name + '.png'`) is not written down, so it is never found.
 * See "The transaction" in ARCHITECTURE.md.
 */
async function mentionsThatWouldSurvive(
  plan: OptimizationPlan,
  input: OptimizeInput,
  scope: Pick<OptimizeInput, 'files' | 'unread' | 'excludedFiles'> = input,
  /** Filled with the hash of each file's text as the search read it. */
  read?: Map<string, string>,
): Promise<Blocked> {
  const deleting = plan.conversions.filter((conversion) => conversion.replacesOriginal);
  if (deleting.length === 0) {
    return {
      assets: new Map(),
      excluded: new Map(),
      unread: new Map(),
      occurrences: [],
      namedIn: new Map(),
    };
  }

  // Every range this plan will rewrite, so an occurrence inside one can be discounted.
  const planned = new Map<string, [number, number][]>();
  for (const rewrite of plan.rewrites) {
    planned.set(
      rewrite.file,
      rewrite.edits.map((edit) => [edit.start, edit.end] as [number, number]),
    );
  }

  const found = await findSurvivingPaths({
    moves: deleting.map((conversion) => ({ from: conversion.asset, to: conversion.target })),
    // A binary format holds no text a path could be written in, and reading a project's
    // PDFs and videos as text would take most of the run.
    files: scope.files.filter((file) => !isBinaryExtension(extensionOf(file))),
    readFile: async (relative) => {
      const text = await input.store.readText(relative);
      read?.set(relative, hashText(text));
      return text;
    },
    servingDirs: input.servingRoots.dirs,
  });

  const occurrences = found.survivors.filter((survivor) => {
    const ranges = planned.get(survivor.file);
    if (ranges === undefined) return true;
    return !ranges.some(([start, end]) => start <= survivor.offset && survivor.offset < end);
  });

  // An occurrence names a spelling, not an asset, so map back through each asset's
  // spellings, in any letter case as the search matched them. Two assets can share one (the
  // suffix `img/hero.png`, or `/hero.png` under two serving roots), and a mention of it then
  // blocks both: a lost saving, never a lost file.
  const excludedFiles = new Set(scope.excludedFiles ?? []);
  const assets = new Map<string, string>();
  const excluded = new Map<string, string>();
  const namedIn = new Map<string, string>();
  for (const conversion of deleting) {
    const spellings = new Set(
      spellingsFor(conversion.asset, input.servingRoots.dirs).map(foldCase),
    );
    const mine = occurrences.filter((survivor) => spellings.has(foldCase(survivor.spelling)));
    // A mention in a file the run reads is the one to name. Where only excluded files name
    // the path, the exclusion is why the mention stays as written, and the reason says so.
    const read = mine.filter((survivor) => !excludedFiles.has(survivor.file));
    const [into, named] = read.length > 0 ? [assets, read] : [excluded, mine];
    const first = named[0];
    if (first === undefined) continue;
    // One location plus a count, so the reason stays one readable sentence. Searching for
    // the same path finds the rest.
    const more = named.length === 1 ? '' : ` (and ${named.length - 1} more)`;
    into.set(conversion.asset, `${first.file}:${first.line}${more}`);
    namedIn.set(conversion.asset, first.file);
  }

  // A file the search could not open, or a directory the walk could not list, may hold the
  // mention that matters, so every original the plan would delete stays.
  const gaps = [...scope.unread, ...found.unsearchable].sort((a, b) =>
    compareStrings(a.file, b.file),
  );
  const unread = new Map<string, string>();
  const gap = gaps[0];
  if (gap !== undefined) {
    const more = gaps.length === 1 ? '' : ` (and ${gaps.length - 1} more)`;
    for (const conversion of deleting) unread.set(conversion.asset, `${gap.file}${more}`);
  }

  return { assets, excluded, unread, occurrences, namedIn };
}

/**
 * A run directory name: sortable, readable, and not derived from content. The suffix is
 * random because two runs over an unchanged repository must not share a directory, as
 * they would if it were a content hash.
 */
export function newRunId(now: Date, random: () => number = Math.random): string {
  const stamp = now
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\.\d+Z$/, '');
  const suffix = Math.floor(random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${stamp}-${suffix}`;
}

export async function optimize(input: OptimizeInput): Promise<OptimizeResult> {
  const runDir = `.upfly/runs/${input.runId}`;

  const planWith = (blocked?: Blocked) =>
    planOptimization({
      graph: input.graph,
      probes: input.probes,
      format: input.format,
      publicPolicy: input.publicPolicy,
      hedged: hedgedAssets(input.audit),
      servingRoots: input.servingRoots,
      builds: input.builds,
      ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
      ...(input.listDirectory === undefined ? {} : { listDirectory: input.listDirectory }),
      ...(blocked === undefined
        ? {}
        : {
            blockedByMention: blocked.assets,
            blockedByExclusion: blocked.excluded,
            blockedByUnread: blocked.unread,
          }),
      ...(input.rootLinkPolicy === undefined ? {} : { rootLinkPolicy: input.rootLinkPolicy }),
    });

  const first = planWith();

  // Searched on a dry run too, or the preview would make different decisions from the run
  // it previews. Planned again rather than filtered: dropping a conversion also drops the
  // rewrites it caused, which share files with other assets' rewrites, and the planner is
  // pure and cheap. What each file held then is kept, so a mention found again after the
  // encodes can be told apart from one in a page that changed meanwhile.
  const readBefore = new Map<string, string>();
  const blocked = await mentionsThatWouldSurvive(first, input, input, readBefore);
  const nothingBlocked =
    blocked.assets.size === 0 && blocked.excluded.size === 0 && blocked.unread.size === 0;
  const plan = nothingBlocked ? first : planWith(blocked);

  if (plan.refusal !== null) {
    return { plan, runId: input.runId, runDir, manifest: null, refusal: plan.refusal };
  }
  input.onProgress?.({
    stage: 'planned',
    conversions: plan.conversions.length,
    rewrites: plan.rewrites.length,
  });

  // A dry run stops here, with every decision made and no byte written. It does not
  // encode: the decisions are all above this line, and encoding every image would make
  // the default mode as slow as an applied run.
  const unwritten: OptimizeResult = {
    plan,
    runId: input.runId,
    runDir,
    manifest: null,
    refusal: null,
  };
  if (!input.apply) return unwritten;
  if (plan.conversions.length === 0 && plan.rewrites.length === 0) return unwritten;
  if (input.beforeWrite !== undefined && !(await input.beforeWrite(plan))) return unwritten;

  await input.store.createExclusive(FOLDER_GITIGNORE, '*\n');

  // Held from before the encodes until after `commit`, not only inside `commit`: a run that
  // started and finished while this one encoded, or between `prepare` and `commit`, would
  // have its committed manifest replaced by this run's pending one, leaving its backups
  // with nothing pointing at them. `commit` re-enters this hold, and releasing that inner
  // hold does nothing.
  const held = await acquireLock({
    store: input.store,
    runId: input.runId,
    now: input.now,
    ...input.lock,
  });

  let written: { readonly plan: OptimizationPlan; readonly manifest: Manifest };
  try {
    const staging: string[] = [];
    let final: Awaited<ReturnType<typeof keepOriginalsNamedSince>>;
    try {
      const staged = await stage(plan, runDir, input, staging);
      final = await keepOriginalsNamedSince(plan, staged, runDir, input, readBefore);
      await prepare(final.operations, input.store, runDir);
    } catch (error) {
      // Refused before any file in the project was written, so nothing will ever read what
      // was staged for it: each encode is a full-size image.
      await removeEach(input.store, staging);
      throw error;
    }
    written = {
      plan: final.plan,
      manifest: await commitUnderLock(final.plan, final.operations, runDir, input),
    };
  } finally {
    await held.release();
  }
  input.onProgress?.({ stage: 'written', files: pathsTouched(written.manifest).length });
  return { ...written, runId: input.runId, runDir, refusal: null };
}

/**
 * The plan and its operations once the search for mentions has run again, after the encodes
 * and under the lock, over the files as they are now. The encodes can take minutes, and a
 * page saved or created meanwhile can name an original the plan deletes. Such an original is
 * kept, with the reason, and the run goes on: the new file is still written and the
 * references the plan read still move to it, as under `keep-original`.
 *
 * A mention can also be found here in a page nobody touched: the first search read each line
 * as the longest spelling it holds, and a line the plan no longer rewrites can name this
 * original by a shorter one, as `team/diana.jpg` ends two images' paths. So the reason says
 * the page was written meanwhile only when its text differs from what the first search read.
 *
 * @param readBefore the hash of each file's text as the search before the encodes read it
 */
async function keepOriginalsNamedSince(
  plan: OptimizationPlan,
  operations: readonly PlannedOperation[],
  runDir: string,
  input: OptimizeInput,
  readBefore: ReadonlyMap<string, string>,
): Promise<{ readonly plan: OptimizationPlan; readonly operations: readonly PlannedOperation[] }> {
  if (!plan.conversions.some((conversion) => conversion.replacesOriginal)) {
    return { plan, operations };
  }
  const scope = input.listFiles === undefined ? input : await input.listFiles();
  const readNow = new Map<string, string>();
  const blocked = await mentionsThatWouldSurvive(plan, input, scope, readNow);

  const kept = new Map<string, string>();
  for (const { asset } of plan.conversions) {
    const why = whyKeptSince(asset, blocked, (file) => readBefore.get(file) !== readNow.get(file));
    if (why !== null) kept.set(asset, `converted, but the original was kept: ${why}`);
  }
  if (kept.size === 0) return { plan, operations };

  // Each backup was taken for a delete that no longer happens.
  for (const operation of operations) {
    if (operation.kind === 'delete' && kept.has(operation.path)) {
      await input.store.remove(`${runDir}/${operation.backup}`);
    }
  }
  return {
    plan: {
      ...plan,
      conversions: plan.conversions.map((conversion) =>
        kept.has(conversion.asset) ? { ...conversion, replacesOriginal: false } : conversion,
      ),
      keptOriginals: [
        ...plan.keptOriginals,
        ...[...kept].map(([asset, reason]) => ({ asset, reason })),
      ].sort((a, b) => compareStrings(a.asset, b.asset)),
    },
    operations: operations.filter(
      (operation) => !(operation.kind === 'delete' && kept.has(operation.path)),
    ),
  };
}

/**
 * Why the search after the encodes keeps this original, or null when it found nothing.
 *
 * @param changed whether a file's text differs from what the search before the encodes read,
 *   which is true of a file created since, since that search never read it
 */
function whyKeptSince(
  asset: string,
  blocked: Blocked,
  changed: (file: string) => boolean,
): string | null {
  const file = blocked.namedIn.get(asset);
  const since =
    file !== undefined && changed(file) ? ', written while Upfly was converting,' : null;
  const named = blocked.assets.get(asset);
  if (named !== undefined) {
    return `${named} ${MENTION_SURVIVES}${since ?? ''} in a form Upfly cannot rewrite`;
  }
  const excluded = blocked.excluded.get(asset);
  if (excluded !== undefined) {
    return `${excluded} ${MENTION_SURVIVES}${since ?? ','} in a file this run excluded`;
  }
  const unread = blocked.unread.get(asset);
  return unread === undefined ? null : `${unread} could not be read to rule out a mention of it`;
}

/** Remove each file a refused run staged; one already gone is no reason to stop. */
async function removeEach(store: FileStore, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await store.remove(path);
    } catch {
      // The refusal being thrown is what the caller needs to see.
    }
  }
}

/** Commit a prepared plan, recording what it declined. */
async function commitUnderLock(
  plan: OptimizationPlan,
  operations: readonly PlannedOperation[],
  runDir: string,
  input: OptimizeInput,
): Promise<Manifest> {
  const context: RunContext = {
    runId: input.runId,
    runDir,
    now: input.now,
    // Both lists: a kept original is something the run chose not to do, which is what the
    // manifest's `declined` records, and the manifest outlives the run. The plan keeps them
    // apart only because the report shows `declined` under "Examined and not converted",
    // and these assets were converted.
    declined: [
      ...plan.declined,
      ...plan.keptOriginals.map((kept) => ({
        path: kept.asset,
        line: null,
        reason: kept.reason,
      })),
    ],
  };

  return commit(operations, input.store, context, input.lock ?? {});
}

/** The `possibly-dead` set, taken from the audit rather than worked out again. */
function hedgedAssets(audit: AuditResult): ReadonlySet<string> {
  const hedged = new Set<string>();
  for (const finding of audit.findings) {
    if (finding.kind === 'possibly-dead') hedged.add(finding.asset);
  }
  return hedged;
}

/**
 * Encode into the run directory and back up anything that will be removed, then
 * describe the whole thing as operations.
 *
 * Staged files mirror the project tree under `<runDir>/staged/` rather than being
 * named by a hash, so a person looking into a run directory recognises what they are
 * seeing. They cannot collide, because the planner declines every conversion whose target
 * another conversion shares.
 */
async function stage(
  plan: OptimizationPlan,
  runDir: string,
  input: OptimizeInput,
  staging: string[],
): Promise<PlannedOperation[]> {
  const operations: PlannedOperation[] = [];
  const animated = animatedAssets(input.probes);

  for (const conversion of plan.conversions) {
    const staged = `staged/${conversion.target}`;
    const source = input.graph.assets.find((node) => node.asset.relative === conversion.asset);
    if (source === undefined) {
      throw new Error(`the plan names ${conversion.asset}, which is not in the graph`);
    }

    // Hashed before the encode and checked after each step that reads the original, so the
    // file encoded, the file backed up and the file the delete expects are one file.
    const original = await input.store.hash(conversion.asset);
    if (original === null) {
      throw originalMoved(conversion.asset, 'was removed after Upfly read the project');
    }

    // Recorded before the step that writes it, so a refusal part way removes it too.
    staging.push(`${runDir}/${staged}`);
    await unlessOriginalMoved(input.store, conversion.asset, original, () =>
      input.probe.encodeToFile({
        path: source.asset.path,
        format: conversion.format,
        // Getting this wrong keeps one frame of an animation, for a saving only
        // achievable by destroying it.
        animated: animated.has(conversion.asset),
        // The setting the saving was measured at. The probe's default quality would put a
        // different file on disk from the one whose saving the user was shown.
        lossless: conversion.quality === 'lossless',
        destination: `${input.graph.root}/${runDir}/${staged}`,
      }),
    );

    const afterHash = await input.store.hash(`${runDir}/${staged}`);
    if (afterHash === null) {
      throw new Error(`the encode of ${conversion.asset} produced no file at ${staged}`);
    }
    operations.push({ kind: 'create', path: conversion.target, staged, afterHash });

    if (!conversion.replacesOriginal) continue;

    // Before `prepare`, which refuses a delete whose backup is not actually there.
    const backup = `backup/${conversion.asset}`;
    staging.push(`${runDir}/${backup}`);
    await unlessOriginalMoved(input.store, conversion.asset, original, () =>
      input.store.copy(conversion.asset, `${runDir}/${backup}`),
    );
    operations.push({ kind: 'delete', path: conversion.asset, beforeHash: original, backup });
  }

  operations.push(...(await editOperations(plan.rewrites, input.store)));
  return operations;
}

/**
 * Run a step that reads an original, then refuse the run if the original is no longer the
 * file hashed before it, whether or not the step failed because of that. A failure with
 * the original unchanged is the step's own and is thrown as it is.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when the original was removed or changed
 */
async function unlessOriginalMoved(
  store: FileStore,
  path: string,
  expected: string,
  step: () => Promise<unknown>,
): Promise<void> {
  let failure: { error: unknown } | null = null;
  try {
    await step();
  } catch (error) {
    failure = { error };
  }
  const now = await store.hash(path);
  if (now !== expected) {
    throw originalMoved(
      path,
      `${now === null ? 'was removed' : 'changed'} while Upfly was converting it`,
    );
  }
  if (failure !== null) throw failure.error;
}

/** The refusal for an original that is not the file the plan was made from. */
function originalMoved(path: string, happened: string): UpflyError {
  return new UpflyError(
    'TRANSACTION_FOREIGN_CHANGE',
    `${path} ${happened}, so no file in the project was changed. Run Upfly again to plan from the project as it is now.`,
  );
}

/**
 * Each rewrite as the edit the transaction applies, read from the file as it is now.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when a file changed since the scan
 */
async function editOperations(
  rewrites: readonly PlannedRewrite[],
  store: FileStore,
): Promise<PlannedEdit[]> {
  const operations: PlannedEdit[] = [];
  for (const rewrite of rewrites) {
    const before = await store.readText(rewrite.file);
    // Read after every encode, which can take minutes, so this is the last moment to find
    // that the file was saved since the scan. Its edits' offsets count into the scanned
    // text: applied to any other, they would land in the wrong place, and every later check
    // would compare against this read and pass.
    refuseUnlessScannedText(rewrite, before);
    operations.push({
      kind: 'edit',
      path: rewrite.file,
      beforeHash: hashText(before, store.hashAlgorithm),
      // Applied here only to hash it. Handing the edited text to commit instead would
      // have commit write bytes without re-reading the source.
      afterHash: hashText(applyEdits(before, rewrite.edits), store.hashAlgorithm),
      edits: rewrite.edits,
    });
  }
  return operations;
}

/** What `writeRewrites` needs: the edits, the disk, and the run's identity. */
export interface WriteRewritesInput {
  /**
   * Files to move, POSIX paths relative to the project, before the edits that name them at
   * their new place. Each is checked against the bytes on disk as the run starts.
   */
  readonly moves?: readonly { readonly from: string; readonly to: string }[];
  readonly rewrites: readonly PlannedRewrite[];
  readonly store: FileStore;
  readonly runId: string;
  readonly now: () => string;
  /** What the plan left as it was, recorded in the manifest with each reason. */
  readonly declined: readonly Declined[];
  readonly lock?: LockPorts;
}

/**
 * Writes a plan that moves files and edits references, such as pointing identical copies at
 * one file or moving an image, through the same transaction, lock and manifest as
 * `optimize`, so `revert` undoes it the same way. Each file is checked against the text the
 * scan read before anything is written.
 *
 * @returns the manifest the run left
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when a file changed since the scan or a
 * file to move is gone, `TRANSACTION_LOCKED` while another run holds the project, and the
 * transaction's other codes
 */
export async function writeRewrites(input: WriteRewritesInput): Promise<Manifest> {
  const runDir = `.upfly/runs/${input.runId}`;
  await input.store.createExclusive(FOLDER_GITIGNORE, '*\n');
  const held = await acquireLock({
    store: input.store,
    runId: input.runId,
    now: input.now,
    ...input.lock,
  });
  try {
    const operations: PlannedOperation[] = [
      ...(await moveOperations(input.moves ?? [], input.store)),
      ...(await editOperations(input.rewrites, input.store)),
    ];
    await prepare(operations, input.store, runDir);
    return await commit(
      operations,
      input.store,
      { runId: input.runId, runDir, now: input.now, declined: input.declined },
      input.lock ?? {},
    );
  } finally {
    await held.release();
  }
}

/**
 * Each move as the transaction carries it out, with the hash of the bytes it moves, which the
 * transaction checks again before the first write.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when a file to move is no longer there
 */
async function moveOperations(
  moves: readonly { readonly from: string; readonly to: string }[],
  store: FileStore,
): Promise<PlannedOperation[]> {
  const operations: PlannedOperation[] = [];
  for (const move of moves) {
    const hash = await store.hash(move.from);
    if (hash === null) {
      throw new UpflyError(
        'TRANSACTION_FOREIGN_CHANGE',
        `${move.from} is no longer where Upfly read it, so nothing was moved and no file in the project was changed. Run Upfly again to plan from the project as it is now.`,
      );
    }
    operations.push({ kind: 'move', from: move.from, to: move.to, hash });
  }
  return operations;
}

/**
 * Refuse a rewrite unless the file holds the text the scan read.
 *
 * @throws {UpflyError} `TRANSACTION_FOREIGN_CHANGE` when the file changed since the scan
 * @throws {UpflyError} `TRANSACTION_PLAN_INVALID` when the plan recorded no text to compare
 */
function refuseUnlessScannedText(rewrite: PlannedRewrite, text: string): void {
  if (rewrite.textHash === undefined) {
    throw new UpflyError(
      'TRANSACTION_PLAN_INVALID',
      `The plan has no record of the text ${rewrite.file} held when it was read, so its edits cannot be checked against the file, and nothing was written. Plan from a graph that runPipeline built.`,
    );
  }
  if (hashText(text) !== rewrite.textHash) {
    throw new UpflyError(
      'TRANSACTION_FOREIGN_CHANGE',
      `${rewrite.file} changed after Upfly read it, so its references are no longer where the plan found them, and no file in the project was changed. Run Upfly again to plan from the file as it is now.`,
    );
  }
}

/**
 * Which assets have more than one frame, from the measurements already taken.
 *
 * From the probe rather than from the extension: a `.gif` may well be a still, and a
 * `.webp` may not be.
 */
function animatedAssets(probes: readonly AssetProbe[]): ReadonlySet<string> {
  const animated = new Set<string>();
  for (const probe of probes) {
    if ((probe.metadata?.pages ?? 1) > 1) animated.add(probe.relative);
  }
  return animated;
}
