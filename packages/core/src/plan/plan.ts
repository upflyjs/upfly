/**
 * Deciding what to convert and which references to repoint.
 *
 * Pure: it reads a graph and a set of measurements and returns decisions. Nothing here
 * touches a disk or encodes anything, so a wrong decision shows in a test before it is a
 * written byte.
 *
 * A reference is rewritten only when Upfly can prove where it points and how it is
 * spelled. Everything declined leaves with a reason, because a skip nobody is told about
 * cannot be told apart from a decision nobody made.
 */

import { dirname, isAbsolute, join } from 'node:path';
import { splitPathSuffix } from '../adapters/reference-path.js';
import { whyFormatKept } from '../adapters/shapes.js';
import { whySavingTooSmall } from '../audit/audit.js';
import { fewResolvedIn, resolutionHealth } from '../audit/resolution-health.js';
import type { AssetNode, Graph } from '../graph/graph.js';
import { compareStrings, extensionOf, relativePath, toPosix } from '../paths.js';
import type { AssetProbe, EncodeFormat, EncodeSetting } from '../probe/probe.js';
import type { AliasMap } from '../resolve/aliases.js';
import { isLinked, linkedPaths } from '../resolve/reference.js';
import { type ServingRoots, resolveReferences } from '../resolve/resolve.js';
import type { Asset, Edit, RawReference, Reference } from '../types.js';
import type { Declined } from '../write/manifest.js';
import { type Build, type ProjectBuilds, buildOf } from './builds.js';

/** What happens to the original when a public asset is converted. */
export type PublicPolicy =
  /** Write the converted file alongside and leave the original in place. */
  | 'keep-original'
  /**
   * Convert an asset only when this run moves at least one reference to the new file,
   * and remove the original only when it moves every reference that links to it.
   *
   * An asset no reference would move to is declined with a reason, so `replace` never
   * writes a copy nobody uses beside an original that has to stay. An original that a
   * pattern or another unmoved reference still needs is kept and listed in
   * `keptOriginals`. See "The transaction" in ARCHITECTURE.md.
   */
  | 'replace';

/**
 * Whether a root-relative path that resolved against the project root may be edited.
 *
 * On a plain static site that is the ordinary case, because there is no serving root to
 * declare. On a project that declares one, the path missed it and happened to exist at
 * the project root, which may be coincidence rather than a link. The default,
 * `when-no-serving-root`, edits such a path only when the project declared no serving
 * root. It keys on the declaration, not on whether the resolver used a root: a detected
 * root is a guess, and declining a link because of a guess is as wrong as trusting a
 * coincidence.
 */
export type RootLinkPolicy = 'when-no-serving-root' | 'always' | 'never';

/**
 * The phrase that marks a decline because a literal mention of the path would survive the
 * rewrite, in a form Upfly cannot rewrite or in a file the run excluded. `report.ts` finds
 * those declines by matching this text to raise a run-level caveat, so the wording lives in
 * one place and the caveat follows any rewording.
 */
export const MENTION_SURVIVES = 'still names its path';

export interface PlanInput {
  readonly graph: Graph;
  /** Measurements. An asset with no entry here was never measured. */
  readonly probes: readonly AssetProbe[];
  readonly format: EncodeFormat;
  readonly publicPolicy: PublicPolicy;
  /**
   * Assets nothing links to that a file Upfly could not read mentions by name: the audit's
   * `possibly-dead` findings. Converting one changes a file on disk and rewrites nothing,
   * because no reference Upfly can see points at it.
   */
  readonly hedged: ReadonlySet<string>;
  /**
   * Assets not to convert because a literal mention of their path would survive the
   * rewrite, each mapped to where the mention is (`file:line`, and a count of any others).
   *
   * A surviving mention costs a lost saving and a deleted original costs a broken page, so
   * the asset is declined. `optimize` fills this only for assets whose original the plan
   * would delete: under `keep-original` the original stays and an unrewritten mention still
   * resolves. The search reads files and this module is pure, so `optimize` plans once,
   * searches against that plan, and plans again with this set.
   */
  readonly blockedByMention?: ReadonlyMap<string, string>;
  /**
   * Assets not to convert because converting would delete the original while a file the
   * run excluded still names it, each mapped to where (`file:line`). Filled by `optimize`.
   */
  readonly blockedByExclusion?: ReadonlyMap<string, string>;
  /**
   * Assets not to convert because converting would delete the original while something
   * the search could not read may still name it, each mapped to what that is (a path, and
   * a count of any others). Filled by `optimize`, under `replace` only.
   */
  readonly blockedByUnread?: ReadonlyMap<string, string>;
  /**
   * The serving roots the resolver used, carrying whether the project declared them.
   *
   * The same value the resolver was given, not a boolean derived beside it, so the
   * planner cannot be told the project declared a serving root while the resolver
   * resolved against a guess. It is also the planner's only notion of which assets are
   * served: an asset under any of these directories is.
   */
  readonly servingRoots: ServingRoots;
  /**
   * The aliases the resolver used. Each rewritten path is resolved again under them, so an
   * import is checked against the rules that linked it. Absent means none were loaded, as
   * for `resolveReferences`, and a rewrite that only an alias could resolve is declined.
   */
  readonly aliases?: AliasMap;
  /**
   * The names in a directory, or `[]` when it cannot be listed. With it, the check on where
   * references lead also counts files the walk did not index, such as images an ignore rule
   * excluded, by listing the directories on the way to each place a path could lead. No file
   * is read. Absent, only the walk's images are counted.
   */
  readonly listDirectory?: (absolutePath: string) => readonly string[];
  readonly rootLinkPolicy?: RootLinkPolicy;
  /**
   * The build of each package, which decides whether an image the build loads may convert:
   * only for a build known to load the new format by itself. Required, so no caller leaves
   * the rule out; a project with no package passes `{ packages: [] }`.
   */
  readonly builds: ProjectBuilds;
}

/** One asset that will be encoded. */
export interface PlannedConversion {
  /** POSIX-relative path of the source. */
  readonly asset: string;
  /** POSIX-relative path the encode will be written to. */
  readonly target: string;
  readonly format: EncodeFormat;
  /**
   * The setting the saving was measured at, and the one the write must use.
   *
   * `'lossless'` is an instruction, not a label: the probe measured the lossless encode
   * smaller than the lossy one. `optimize` passes it to `encodeToFile`, so the file written
   * is the one whose saving was reported.
   */
  readonly quality: EncodeSetting;
  readonly savedBytes: number;
  /**
   * True when the original is removed: under `replace`, an asset at least one reference
   * links to, every one of which this plan rewrites, in a served folder or among the images a
   * build loads, once the project's website folder is known.
   */
  readonly replacesOriginal: boolean;
}

/** The edits for one source file, already checked for overlap by the caller. */
export interface PlannedRewrite {
  /** POSIX-relative path of the file holding the references. */
  readonly file: string;
  /** In offset order, each carrying the reference's text as its `expected`. */
  readonly edits: readonly Edit[];
  /**
   * SHA-256 of the text the scan read from `file`, encoded as UTF-8: the text every offset
   * in `edits` counts into. `optimize` applies the edits only to a file that still holds it, and
   * refuses a rewrite without one. Absent when the graph recorded no text for the file.
   */
  readonly textHash?: string;
}

/** A file's edits while a plan is being made, and the file's absolute path. */
export interface EditsInFile {
  /** As in `Reference.file`, which is how `Graph.texts` is keyed. */
  readonly path: string;
  readonly edits: Edit[];
}

/**
 * A file's collected edits as a `PlannedRewrite`: in offset order, and carrying the hash
 * of the text they were counted in when the graph recorded one.
 */
export function plannedRewrite(file: string, collected: EditsInFile, graph: Graph): PlannedRewrite {
  const edits = [...collected.edits].sort((a, b) => a.start - b.start);
  const text = graph.texts.get(collected.path);
  return text === undefined ? { file, edits } : { file, edits, textHash: text.hash };
}

/**
 * Record the edit that repoints `reference`, under its file. The edit carries the text it
 * replaces as `expected`, so it can never land on different text.
 */
export function collectEdit(
  edits: Map<string, EditsInFile>,
  file: string,
  reference: Reference,
  replacement: string,
): void {
  const collected = edits.get(file) ?? { path: reference.file, edits: [] };
  collected.edits.push({
    start: reference.start,
    end: reference.end,
    replacement,
    expected: reference.rawPath,
  });
  edits.set(file, collected);
}

/**
 * Why the planner will not act at all.
 *
 * Returned rather than thrown, so the caller holds a finding with a reason: the audit still
 * reports on the repository and only the write path stops. It replaces the per-asset
 * `declined` list: when the engine does not know where files are served from, every asset
 * would decline for the same reason, and one sentence repeated per asset buries it.
 * See "When the serving root cannot be found at all" in ARCHITECTURE.md.
 */
export interface PlanRefusal {
  readonly code: 'serving-root-unknown';
  /** A sentence a user can act on, naming what to do next. */
  readonly reason: string;
  readonly linked: number;
  readonly checkable: number;
}

/**
 * An asset converted under `replace` whose original was left in place, and why.
 *
 * Either a reference this run does not rewrite still needs the original, such as a pattern,
 * or no website folder was found, so Upfly cannot tell which images a browser loads by URL.
 * An asset no reference moves to is not converted under `replace`, so it is never here.
 *
 * Kept apart from `declined`, which the report prints under "Examined and not converted":
 * these assets were converted. An asset is in one list or the other, never both, and
 * `conversions` still holds every conversion.
 */
export interface KeptOriginal {
  /** POSIX-relative path of the asset whose original survives. */
  readonly asset: string;
  /** Why it survives, in a sentence a user can act on. */
  readonly reason: string;
}

/**
 * What a run converts and rewrites, what it declines and why, and which originals it keeps, or the
 * refusal that stopped it.
 */
export interface OptimizationPlan {
  readonly conversions: readonly PlannedConversion[];
  readonly rewrites: readonly PlannedRewrite[];
  /** Everything the planner decided against, each with the reason it decided. */
  readonly declined: readonly Declined[];
  /**
   * Conversions under `replace` whose original was kept anyway, and why. A user who asked
   * for `replace` is told about every original that stays.
   */
  readonly keptOriginals: readonly KeptOriginal[];
  /**
   * Set when the planner refused to plan anything, and null on an ordinary run.
   *
   * A caller that writes must check this. When it is set, every list in the plan is empty,
   * so a caller that forgets writes nothing rather than something wrong.
   */
  readonly refusal: PlanRefusal | null;
}

/**
 * Why a pattern's text cannot be repointed, as the start of a reason: a template is assembled
 * at runtime, while a bundler's glob names its files by pattern when the project builds, and a
 * bundler's context by a directory and a filter.
 */
export function patternCannotMove(reference: Reference): string {
  if (reference.glob !== undefined) {
    return 'a glob names its files by pattern when the bundler builds, so its text cannot be repointed';
  }
  if (reference.bundlerContext !== undefined) {
    return 'a context names its files by directory and filter when the bundler builds, so its text cannot be repointed';
  }
  return 'a template reference is assembled at runtime, so its text cannot be repointed';
}

/** What a pattern's text is, and that no run rewrites it, for a reason that quotes it. */
function unrewritable(reference: Reference): string {
  if (reference.glob !== undefined) {
    return 'a glob the bundler expands when it builds, which no run can rewrite';
  }
  if (reference.bundlerContext !== undefined) {
    return 'a directory the bundler loads files from when it builds, which no run can rewrite';
  }
  return 'a path assembled at runtime that no run can rewrite';
}

/**
 * The plan for one run: which images convert, which references move to the converted
 * files, what is declined and why, and which originals `replace` keeps. Pure: it reads the
 * graph and the measurements and touches no disk.
 */
export function planOptimization(input: PlanInput): OptimizationPlan {
  // Before anything else. Rewriting references on a graph whose root-relative paths
  // did not resolve means repointing whatever did resolve while the majority stays
  // broken, and the engine has no basis for believing either half.
  const health = resolutionHealth(input.graph);
  if (health.servingRootUnknown) {
    // A folder the project named is not asked for again: the reason says what resolved there.
    const reason = input.servingRoots.declared
      ? `${capitalised(fewResolvedIn(health, input.servingRoots.dirs))}. Upfly rewrites nothing while so few resolve.`
      : `Only ${health.linked} of ${health.checkable} root-relative references resolved, so Upfly cannot tell where this project serves files from. Declare the directory your site serves from and run again.`;
    return {
      conversions: [],
      rewrites: [],
      declined: [],
      keptOriginals: [],
      refusal: {
        code: 'serving-root-unknown',
        reason,
        linked: health.linked,
        checkable: health.checkable,
      },
    };
  }

  const declined: Declined[] = [];
  const relativeOf = new Map(
    input.graph.assets.map((node) => [node.asset.path, node.asset.relative]),
  );
  const savings = measuredSavings(input);

  const converting = new Map<string, PlannedConversion>();
  for (const node of input.graph.assets) {
    const decision = convertDecision(node, input, savings);
    if (decision.convert) converting.set(node.asset.relative, decision.conversion);
    else if (decision.reason !== null) {
      declined.push({ path: node.asset.relative, line: null, reason: decision.reason });
    }
  }

  // Before everything that asks which assets convert. A literal repointed at a
  // conversion that is withdrawn afterwards names a file that is never written, and a
  // pattern's decline would count the wrong targets as not converting.
  const onDisk = unindexedFiles(input);
  for (const asset of vetoCollisions(input, converting, declined, onDisk)) {
    converting.delete(asset);
  }

  // Where a reference leads depends on every file the plan writes and removes, so it is
  // checked on a whole plan. Withdrawing a conversion changes those files and drops its
  // rewrites, so the plan is made again without it until the check withdraws nothing.
  const before = leadsTo(
    input,
    input.graph.references.filter(isLinked),
    input.graph.assets.map((node) => node.asset),
    onDisk,
  );
  const inAnotherCase = reachedOnlyInAnotherCase(input, onDisk);
  let repointed = repoint(input, converting, relativeOf, inAnotherCase);
  let misdirected = misdirectedConversions(input, repointed, before, onDisk);
  while (misdirected.size > 0) {
    for (const [asset, reason] of misdirected) {
      converting.delete(asset);
      declined.push({ path: asset, line: null, reason });
    }
    repointed = repoint(input, converting, relativeOf, inAnotherCase);
    misdirected = misdirectedConversions(input, repointed, before, onDisk);
  }
  declined.push(...repointed.declined);

  return {
    conversions: [...repointed.conversions].sort((a, b) => compareStrings(a.asset, b.asset)),
    rewrites: [...repointed.edits.entries()]
      .map(([file, collected]) => plannedRewrite(file, collected, input.graph))
      .sort((a, b) => compareStrings(a.file, b.file)),
    declined: declined.sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason),
    ),
    // Derived from the surviving conversions rather than collected as decisions were
    // made, so an asset `vetoCollisions` withdrew cannot claim a kept original for a file
    // that never converted.
    keptOriginals: keptOriginals(repointed.conversions, repointed.stillNeeded, input),
    refusal: null,
  };
}

/** A reference a plan repoints: the text it is given, and the conversion it follows. */
interface Repointing {
  readonly replacement: string;
  readonly conversion: PlannedConversion;
}

/** What a plan does with the references, for one set of conversions. */
interface Repointed {
  /** The conversions, each saying whether its original is removed. */
  readonly conversions: readonly PlannedConversion[];
  readonly edits: ReadonlyMap<string, EditsInFile>;
  /** Every reference an edit moves, in the graph's order. */
  readonly rewritten: ReadonlyMap<Reference, Repointing>;
  /** The originals `replace` keeps because a reference still needs them, and why. */
  readonly stillNeeded: ReadonlyMap<string, string>;
  /** What these conversions leave as written, and why. */
  readonly declined: readonly Declined[];
}

/**
 * Decide every reference against these conversions, then which originals may go.
 *
 * @param inAnotherCase the references that reach each asset only in another letter case,
 *   from `reachedOnlyInAnotherCase`
 */
function repoint(
  input: PlanInput,
  converting: ReadonlyMap<string, PlannedConversion>,
  relativeOf: ReadonlyMap<string, string>,
  inAnotherCase: ReadonlyMap<string, readonly Reference[]>,
): Repointed {
  const declined: Declined[] = [];
  declinePartialPatterns(input, converting, relativeOf, declined);

  const edits = new Map<string, EditsInFile>();
  const rewritten = new Map<Reference, Repointing>();
  for (const reference of input.graph.references) {
    const repointing = collectRewrite(reference, {
      input,
      root: input.graph.root,
      converting,
      relativeOf,
      edits,
      declined,
    });
    if (repointing !== null) rewritten.set(reference, repointing);
  }

  // Last, because whether an original may go depends on which references this plan
  // rewrites, and that is known only once every reference has been decided.
  const stillNeeded = originalsStillNeeded(input, converting, rewritten, inAnotherCase);
  const conversions = [...converting.values()].map((conversion) =>
    stillNeeded.has(conversion.asset) ? { ...conversion, replacesOriginal: false } : conversion,
  );
  return { conversions, edits, rewritten, stillNeeded, declined };
}

/**
 * The conversions that would change where a reference leads, each with the sentence saying
 * where it would lead instead.
 *
 * A rewritten reference has to lead to its converted file, and every other linked reference
 * to the files it leads to now. From the file holding it, a new name can reach a file the old
 * one never did, in a nearer serving root or where an alias looks first, and a converted file
 * is new, so a reference left as written can find it first in the same places. So every
 * linked reference is resolved as it will read once the plan is applied: from its own file,
 * among the files the plan leaves. See "The transaction" in ARCHITECTURE.md.
 */
function misdirectedConversions(
  input: PlanInput,
  repointed: Repointed,
  before: Destinations,
  onDisk: UnindexedFiles | undefined,
): Map<string, string> {
  const linked = input.graph.references.filter(isLinked);
  const asLeft = (reference: Reference): RawReference => {
    const repointing = repointed.rewritten.get(reference);
    return repointing === undefined ? reference : { ...reference, rawPath: repointing.replacement };
  };
  const after = leadsTo(
    input,
    linked.map(asLeft),
    assetsAfter(input.graph, repointed.conversions),
    onDisk,
  );
  const changes: Changes = {
    writing: new Map(repointed.conversions.map((conversion) => [conversion.target, conversion])),
    removing: new Map(
      repointed.conversions
        .filter((conversion) => conversion.replacesOriginal)
        .map((conversion) => [conversion.asset, conversion]),
    ),
  };

  // The first miss for each conversion is named and the rest counted, as the kept-original
  // sentences do, so the reason stays one sentence and names a line to look at.
  const misses = new Map<string, { reference: Reference; outcome: string; count: number }>();
  const miss = (asset: string, reference: Reference, outcome: string): void => {
    const first = misses.get(asset);
    misses.set(
      asset,
      first === undefined ? { reference, outcome, count: 1 } : { ...first, count: first.count + 1 },
    );
  };

  for (const reference of linked) {
    const reached = after.get(placeOf(asLeft(reference))) ?? [];
    const repointing = repointed.rewritten.get(reference);
    if (repointing !== undefined) {
      const [lands = null] = reached;
      if (lands !== repointing.conversion.target) {
        miss(repointing.conversion.asset, reference, missedRewrite(repointing.replacement, lands));
      }
      continue;
    }
    const was = before.get(placeOf(reference)) ?? [];
    for (const { conversion, outcome } of movedBy(reference, was, reached, changes)) {
      miss(conversion.asset, reference, outcome);
    }
  }

  const misdirected = new Map<string, string>();
  for (const [asset, { reference, outcome, count }] of misses) {
    const where = `\`${reference.rawPath}\` in \`${relativePath(input.graph.root, reference.file)}\``;
    const more = count === 1 ? '' : ` (and ${count - 1} more)`;
    misdirected.set(asset, `${where}${more} ${outcome}`);
  }
  return misdirected;
}

/** The files a plan writes and the originals it removes, each with its conversion. */
interface Changes {
  readonly writing: ReadonlyMap<string, PlannedConversion>;
  readonly removing: ReadonlyMap<string, PlannedConversion>;
}

/**
 * The conversions that move a reference the plan leaves as written off a file it leads to
 * now, each with the sentence saying how. It may gain files, as a pattern gains a converted
 * file beside those it matches, but must not lose one: to a file the plan writes that is
 * found first, or because the plan removes the file.
 */
function movedBy(
  reference: Reference,
  was: readonly string[],
  reached: readonly string[],
  changes: Changes,
): { conversion: PlannedConversion; outcome: string }[] {
  const lost = was.filter((path) => !reached.includes(path));
  const [first] = lost;
  if (first === undefined) return [];
  const written = reached.flatMap((path) => {
    const conversion = changes.writing.get(path);
    return conversion === undefined
      ? []
      : [{ conversion, outcome: captured(reference, first, path) }];
  });
  const removed = lost.flatMap((path) => {
    const conversion = changes.removing.get(path);
    return conversion === undefined
      ? []
      : [{ conversion, outcome: gone(reference, path, reached) }];
  });
  return [...written, ...removed];
}

/** What a rewritten reference would do instead of reaching its converted file. */
function missedRewrite(replacement: string, reached: string | null): string {
  return reached === null
    ? `would become \`${replacement}\`, which names no file Upfly can find, so repointing the reference would break it.`
    : `would become \`${replacement}\`, which reaches ${reached} first${anyCase(replacement, reached)}, so the reference would load that file instead. Rename one of the two images and run again.`;
}

/** What a reference left as written would do once a converted file is found before its own. */
function captured(reference: Reference, lost: string, converted: string): string {
  return `reaches ${lost}, and once this image converts it would reach ${converted} first${anyCase(reference.rawPath, converted)}, so the reference would load the converted image instead. Rename one of the two images and run again.`;
}

/** What a reference left as written would do once the file it reaches now is removed. */
function gone(reference: Reference, lost: string, reached: readonly string[]): string {
  const [instead] = reached;
  const reaches = `reaches ${lost}${anyCase(reference.rawPath, lost)}, and converting this image removes it`;
  return instead === undefined
    ? `${reaches}, so the reference would break.`
    : `${reaches}, so the reference would load ${instead} instead. Rename one of the two images and run again.`;
}

/** Where a path reaches a file it names in another letter case, and why. */
const WHATEVER_THE_CASE =
  'on Windows and macOS, where a file is found whatever the case of its name';

/**
 * The clause saying why a path reaches a file whose name, or a folder's name, it spells in
 * another case, and nothing when it spells them as they are. The check finds a file whatever
 * the case, as the collision check does, so a plan is the same on every platform.
 */
function anyCase(text: string, file: string): string {
  const written = splitPathSuffix(text).path.split('/');
  const found = file.split('/');
  for (let back = 1; back <= Math.min(written.length, found.length); back += 1) {
    const [spelled, named] = [written[written.length - back], found[found.length - back]];
    if (spelled === named) continue;
    if (spelled?.toLowerCase() !== named?.toLowerCase()) return '';
    return ` ${WHATEVER_THE_CASE}`;
  }
  return '';
}

/** The files each linked reference leads to, project-relative, keyed by `placeOf`. */
type Destinations = ReadonlyMap<string, readonly string[]>;

/**
 * Where a reference sits and what it says, the key its answer is found by. With the text in
 * it, two references at one offset share a key only when they name the same path.
 */
function placeOf(reference: RawReference): string {
  return `${reference.file}\n${reference.start}\n${reference.rawPath}`;
}

/**
 * Where each of these references leads among `files`, and among the files on disk the walk
 * did not index when `onDisk` can find them: the one file a literal reaches, or every file a
 * pattern matches.
 */
function leadsTo(
  input: PlanInput,
  references: readonly RawReference[],
  files: readonly Asset[],
  onDisk: UnindexedFiles | undefined,
): Destinations {
  const answers = resolveReferences(references, {
    root: input.graph.root,
    assets: files,
    servingRoots: input.servingRoots,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    ...(onDisk === undefined ? {} : { unindexed: onDisk }),
    // Windows and macOS find a file whatever the case of its name. Folded on every platform,
    // as the collision check folds, so a plan does not depend on where it runs.
    foldCase: true,
    // The question is where a path leads among these files, which the disk as it stands
    // cannot answer.
    exists: () => false,
  });
  // A path that names no image is left out of the answers, so each is found by where its
  // reference sits.
  return new Map(
    answers.map((answer) => [
      placeOf(answer),
      linkedPaths(answer).map((path) => relativePath(input.graph.root, path)),
    ]),
  );
}

/**
 * The references that link nothing as written yet reach an asset in another letter case,
 * keyed by the asset's POSIX-relative path.
 *
 * Read by case, as a Linux server reads it, `img/lvm.jpg` links nothing when the file is
 * `img/LVM.jpg`, while Windows and macOS load the file through it. So every reference the
 * resolver did not link is resolved again as `leadsTo` resolves one, case folded, whatever it
 * is: a literal, a guess or a pattern. An original one of them reaches is never removed.
 */
function reachedOnlyInAnotherCase(
  input: PlanInput,
  onDisk: UnindexedFiles | undefined,
): ReadonlyMap<string, readonly Reference[]> {
  const unlinked = input.graph.references.filter((reference) => !isLinked(reference));
  const reached = leadsTo(
    input,
    unlinked,
    input.graph.assets.map((node) => node.asset),
    onDisk,
  );
  const byAsset = new Map<string, Reference[]>();
  for (const reference of unlinked) {
    for (const asset of reached.get(placeOf(reference)) ?? []) {
      const holding = byAsset.get(asset) ?? [];
      holding.push(reference);
      byAsset.set(asset, holding);
    }
  }
  return byAsset;
}

/** The file at a path that exists on disk but is not one of the walk's images, or null. */
export type UnindexedFiles = (absolutePath: string) => string | null;

/**
 * The files inside the project that the walk did not index, such as those an ignore rule
 * excluded, found by listing each directory on the way to a path rather than by reading any
 * file. Undefined when the caller gave no way to list a directory. A name matches whatever
 * its case, as the resolver's folded index does. A walk image is never answered here: the
 * plan's own list says whether it is still there.
 */
export function unindexedFiles(
  input: Pick<PlanInput, 'graph' | 'aliases' | 'listDirectory'>,
): UnindexedFiles | undefined {
  const list = input.listDirectory;
  if (list === undefined) return undefined;

  const { root } = input.graph;
  const indexed = new Set(input.graph.assets.map((node) => node.asset.relative.toLowerCase()));
  // Many paths share their directories, so each is listed once, in an order that does not
  // depend on the filesystem.
  const listings = new Map<string, readonly string[]>();
  const names = (directory: string): readonly string[] => {
    const known = listings.get(directory) ?? [...list(directory)].sort(compareStrings);
    listings.set(directory, known);
    return known;
  };
  // A folder can hold two names that differ only in case where the filesystem allows it,
  // so each is followed until one leads to a file.
  const find = (directory: string, segments: readonly string[]): string | null => {
    const [segment, ...rest] = segments;
    if (segment === undefined) {
      return indexed.has(relativePath(root, directory).toLowerCase()) ? null : directory;
    }
    for (const name of names(directory)) {
      if (name.toLowerCase() !== segment.toLowerCase()) continue;
      const found = find(join(directory, name), rest);
      if (found !== null) return found;
    }
    return null;
  };

  // An alias can point outside the project, as `../shared/*` does in a monorepo package, and a
  // file there can take a rewritten reference first. Such a path is listed from the alias
  // target it is under; no other path outside the project is listed.
  const outsideTargets = (input.aliases?.rules ?? [])
    .flatMap((rule) => rule.targets)
    .filter((target) => isOutside(relativePath(root, target)));

  return (path) => {
    const relative = relativePath(root, path);
    if (relative === '') return null;
    if (!isOutside(relative)) return find(root, relative.split('/'));
    const at = toPosix(path);
    const target = outsideTargets.find((base) => at === base || at.startsWith(`${base}/`));
    if (target === undefined) return null;
    // An exact alias names a file, so its folder is where the listing starts. Joined, so the
    // listing is asked for the native path, as it is for every folder inside the project.
    const from = at === target ? dirname(target) : target;
    return find(join(from), relativePath(from, at).split('/'));
  };
}

function isOutside(relative: string): boolean {
  return relative === '..' || relative.startsWith('../') || isAbsolute(relative);
}

/**
 * The assets once a plan is applied: each converted file added, and each original the plan
 * removes taken away.
 */
function assetsAfter(graph: Graph, conversions: readonly PlannedConversion[]): Asset[] {
  const conversionOf = new Map(conversions.map((conversion) => [conversion.asset, conversion]));
  return graph.assets.flatMap(({ asset }) => {
    const conversion = conversionOf.get(asset.relative);
    if (conversion === undefined) return [asset];
    const converted: Asset = {
      ...asset,
      path: withExtension(asset.path, conversion.format),
      relative: conversion.target,
      extension: `.${conversion.format}`,
    };
    return conversion.replacesOriginal ? [converted] : [asset, converted];
  });
}

interface Saving {
  readonly savedBytes: number;
  readonly quality: EncodeSetting;
}

/**
 * The measured saving for each asset in the requested format.
 *
 * A measurement that came back no smaller than the source is dropped here: the point of
 * converting is a smaller file, and writing a bigger one makes the repository worse.
 */
function measuredSavings(input: PlanInput): Map<string, Saving> {
  const sizeOf = new Map(input.graph.assets.map((node) => [node.asset.relative, node.asset.bytes]));
  const savings = new Map<string, Saving>();

  for (const probe of input.probes) {
    const original = sizeOf.get(probe.relative);
    if (original === undefined) continue;

    for (const encoded of probe.encoded) {
      if (encoded.format !== input.format) continue;
      const savedBytes = original - encoded.bytes;
      if (savedBytes <= 0) continue;
      savings.set(probe.relative, { savedBytes, quality: encoded.quality });
    }
  }
  return savings;
}

/**
 * Whether this asset was encoded in the target format at all, which separates "measured,
 * nothing to gain" from "never measured". Only the second is reported elsewhere.
 */
function wasMeasured(relative: string, input: PlanInput): boolean {
  const probe = input.probes.find((entry) => entry.relative === relative);
  return probe?.encoded.some((encoded) => encoded.format === input.format) ?? false;
}

/** What `convertibleImages` reads: the plan's input, less the measurements. */
export type ConvertibleInput = Pick<
  PlanInput,
  'graph' | 'servingRoots' | 'rootLinkPolicy' | 'format' | 'builds' | 'aliases'
>;

/**
 * The images a plan with this input could convert, whatever they measure: those with a
 * reference that would move to the new file. Every other image is declined for a reason no
 * measurement changes, so measuring only these gives the plan every saving it can use.
 *
 * These are the checks `convertDecision` makes that need no measurement and no other
 * conversion; the plan still declines some of these images, on their measurement, a
 * collision or a mention a removed original would leave.
 *
 * @param input the graph and what the plan's rules read, without measurements
 * @returns the POSIX-relative paths of those images
 */
export function convertibleImages(input: ConvertibleInput): ReadonlySet<string> {
  const rules: PlanInput = {
    ...input,
    probes: [],
    publicPolicy: 'keep-original',
    hedged: new Set(),
  };
  const convertible = new Set<string>();
  for (const node of input.graph.assets) {
    const relative = node.asset.relative;
    if (withExtension(relative, input.format) === relative) continue;
    if (node.references.length === 0 || usedByNoMove(node, rules) !== null) continue;
    convertible.add(relative);
  }
  return convertible;
}

type ConvertDecision =
  | { readonly convert: true; readonly conversion: PlannedConversion }
  | { readonly convert: false; readonly reason: string | null };

/**
 * Whether one asset is converted, and why not when it is not.
 *
 * `reason: null` is only for an asset there was no decision to make about, such as one
 * nothing measured, which the audit already reports as a probe skip naming the cap, the
 * vector or the format. An asset measured and found no smaller gets a reason, because
 * nothing else reports it: a `format-opportunity` finding exists only when there is an
 * opportunity, and the audit's skip list holds only measurements that were not taken.
 */
function convertDecision(
  node: AssetNode,
  input: PlanInput,
  savings: ReadonlyMap<string, Saving>,
): ConvertDecision {
  const relative = node.asset.relative;
  const saving = savings.get(relative);
  if (saving === undefined) {
    return wasMeasured(relative, input)
      ? {
          convert: false,
          reason: `measured as ${input.format} and came out no smaller, so converting it would cost bytes rather than save them`,
        }
      : { convert: false, reason: null };
  }

  const target = withExtension(relative, input.format);
  if (target === relative) return { convert: false, reason: null };

  // A new file has to be one some reference moves to, under either policy: otherwise no
  // visitor downloads fewer bytes, and a saving counted for it would be a saving nobody gets.
  // An asset nothing links to is the plainest case, with its own sentences.
  if (node.references.length === 0) {
    const why = input.hedged.has(relative)
      ? 'nothing links to it and something we could not read mentions it, so converting would change a file whose references we cannot see'
      : noServingRootFound(input.servingRoots)
        ? `nothing links to it, and ${NO_WEBSITE_FOLDER}; converting it would gain only bytes. ${NAME_THE_WEBSITE_FOLDER}`
        : 'nothing links to it, so converting it would rewrite no reference and gain only bytes';
    return { convert: false, reason: why };
  }

  // Decided here, before collisions and before any reference is repointed. See "The
  // transaction" in ARCHITECTURE.md.
  const unused = usedByNoMove(node, input);
  if (unused !== null) return { convert: false, reason: unused };

  // A literal mention of the path would outlive the rewrite. `optimize` fills this set only
  // with assets its first plan converted, so none of the checks above declines them here.
  const surviving = input.blockedByMention?.get(relative);
  if (surviving !== undefined) {
    return {
      convert: false,
      // Names where the mention is, so the user does not have to search the repository
      // for a path the search already found.
      reason: `converting it would delete the original, and ${surviving} ${MENTION_SURVIVES} in a form Upfly cannot rewrite`,
    };
  }

  const excluded = input.blockedByExclusion?.get(relative);
  if (excluded !== undefined) {
    return {
      convert: false,
      reason: `converting it would delete the original, and ${excluded} ${MENTION_SURVIVES}, in a file this run excluded`,
    };
  }

  const unread = input.blockedByUnread?.get(relative);
  if (unread !== undefined) {
    return {
      convert: false,
      reason: `converting it would delete the original, and ${unread} could not be read to rule out a mention of it`,
    };
  }

  // Last, so that this reason is given only for an image nothing else keeps, and the plan
  // converts exactly the savings the report counts.
  const tooSmall = whySavingTooSmall(node.asset.bytes, saving.savedBytes);
  if (tooSmall !== null) return { convert: false, reason: tooSmall };

  return {
    convert: true,
    conversion: {
      asset: relative,
      target,
      format: input.format,
      quality: saving.quality,
      savedBytes: saving.savedBytes,
      replacesOriginal: input.publicPolicy === 'replace' && !noServingRootFound(input.servingRoots),
    },
  };
}

/** A file already at a conversion's target, and whether the walk left it out. */
interface ExistingFile {
  readonly path: string;
  readonly excluded: boolean;
}

/**
 * Why one asset in a colliding set is declined, naming everything in its way.
 *
 * Every obstacle, not the first one that matched: a pair that collides with each other and
 * with a file already there is still blocked after one of the pair is renamed, and naming
 * only the pair would send somebody round twice.
 *
 * Assets heading for the identically spelled target share a clause, so a three-way
 * collision stays readable. A target that differs only in case gets its own clause saying
 * why two names are one file, since a reader looking at `Reaktor.webp` and `reaktor.webp`
 * would otherwise conclude the engine is broken.
 */
function collisionReason(
  asset: string,
  colliding: readonly string[],
  existing: ExistingFile | undefined,
  converting: ReadonlyMap<string, PlannedConversion>,
  key: string,
): string {
  const targetOf = (path: string) => converting.get(path)?.target ?? key;
  const target = targetOf(asset);
  const sameFile = `which is the same file as ${target} on Windows and macOS`;

  const sameSpelling = colliding.filter((other) => other !== asset && targetOf(other) === target);
  const blockers: string[] = [];
  if (sameSpelling.length > 0) {
    blockers.push(`${sameSpelling.join(' and ')} would also convert to ${target}`);
  }
  for (const other of colliding) {
    if (other === asset || targetOf(other) === target) continue;
    blockers.push(`${other} would convert to ${targetOf(other)}, ${sameFile}`);
  }
  if (existing !== undefined) {
    const excluded = existing.excluded ? ' and this run excludes it' : '';
    blockers.push(
      existing.path === target
        ? `${target} already exists${excluded}`
        : `${existing.path} already exists${excluded}, and is the same file as ${target} on Windows and macOS`,
    );
  }

  return `${blockers.join(', and ')}, so converting it would replace a file rather than add one. Rename one of them and run again.`;
}

/**
 * Drop the conversions that would write over each other, or over a file already there.
 *
 * Swapping an extension is not injective: `distance.png` and `distance.gif` both become
 * `distance.webp`, and converting `logo.png` where `logo.webp` exists destroys a file
 * somebody made. Every asset involved is declined, naming the others, because which file
 * should win, or what to rename it to, is the user's choice. Only planned conversions
 * collide: an asset that was never going to convert overwrites nothing. Targets are
 * compared case-insensitively on every platform. A file the walk did not index, such as
 * one an ignore rule excludes, is found through `onDisk`: left to the transaction, it would
 * stop the whole run rather than this one conversion.
 * See "Two paths are the same file more often than they look" in ARCHITECTURE.md.
 */
function vetoCollisions(
  input: PlanInput,
  converting: ReadonlyMap<string, PlannedConversion>,
  declined: Declined[],
  onDisk: UnindexedFiles | undefined,
): ReadonlySet<string> {
  const { root } = input.graph;
  const alreadyThere = new Map(
    input.graph.assets.map((node) => [node.asset.relative.toLowerCase(), node.asset.relative]),
  );
  const unindexedAt = (target: string): ExistingFile | undefined => {
    const found = onDisk?.(join(root, target)) ?? null;
    return found === null ? undefined : { path: relativePath(root, found), excluded: true };
  };

  const claimants = new Map<string, string[]>();
  for (const conversion of converting.values()) {
    const key = conversion.target.toLowerCase();
    const list = claimants.get(key) ?? [];
    list.push(conversion.asset);
    claimants.set(key, list);
  }

  const withdraw = new Set<string>();
  for (const [key, assets] of claimants) {
    const contested = assets.length > 1;
    const indexed = alreadyThere.get(key);
    const existing =
      indexed === undefined
        ? unindexedAt(converting.get(assets[0] ?? '')?.target ?? key)
        : { path: indexed, excluded: false };

    if (!contested && existing === undefined) continue;

    const sorted = [...assets].sort();
    for (const asset of sorted) {
      declined.push({
        path: asset,
        line: null,
        reason: collisionReason(asset, sorted, existing, converting, key),
      });
      withdraw.add(asset);
    }
  }
  return withdraw;
}

/**
 * Say which pattern references match an asset that does not convert.
 *
 * A pattern is never rewritten (`collectRewrite` declines every one), so this changes no
 * decision. It reports one: this reference matches N assets and M of them do not convert,
 * which is where a reader looks to find out why a pattern still names the old format.
 * Under `replace`, a target only patterns reach is not converted and counts among the M,
 * as does a target declined for its own reason; a target a literal also names converts
 * and keeps its original while the pattern needs it.
 */
function declinePartialPatterns(
  input: PlanInput,
  converting: ReadonlyMap<string, PlannedConversion>,
  relativeOf: ReadonlyMap<string, string>,
  declined: Declined[],
): void {
  for (const reference of input.graph.references) {
    if (reference.resolution !== 'resolved-pattern') continue;

    const targets = reference.resolvedPaths.map((path) => relativeOf.get(path) ?? toPosix(path));
    const unmeasured = targets.filter((target) => !converting.has(target));
    if (unmeasured.length === 0) continue;

    const counted = notConverting(unmeasured.length, targets.length);
    const reason = `${patternCannotMove(reference)}, and ${counted}`;
    declined.push({ path: relativePath(input.graph.root, reference.file), line: null, reason });
  }
}

/** How many of a pattern's targets do not convert, worded to read right at any count. */
function notConverting(missing: number, of: number): string {
  if (missing < of) {
    return `${missing} of the ${of} assets it matches ${missing === 1 ? 'does' : 'do'} not convert`;
  }
  return of === 1
    ? 'the one asset it matches does not convert'
    : `none of the ${of} assets it matches converts`;
}

interface RewriteContext {
  readonly input: PlanInput;
  /** Absolute project root, so a reference's file becomes a root-relative path. */
  readonly root: string;
  readonly converting: ReadonlyMap<string, PlannedConversion>;
  readonly relativeOf: ReadonlyMap<string, string>;
  readonly edits: Map<string, EditsInFile>;
  readonly declined: Declined[];
}

/**
 * Decide whether one reference is repointed, and record why when it is not.
 *
 * Returns the repointing when an edit was recorded, and null otherwise. The deletion check
 * needs exactly that: an original may go only once every reference to it has moved, and
 * "moved" means an edit this plan holds, not what kind of reference it is.
 */
function collectRewrite(reference: Reference, context: RewriteContext): Repointing | null {
  if (!isLinked(reference)) return null;

  const targets = linkedPaths(reference).map(
    (path) => context.relativeOf.get(path) ?? toPosix(path),
  );
  const converted = targets.flatMap((target) => context.converting.get(target) ?? []);
  const [conversion] = converted;
  if (conversion === undefined) return null;

  const obstacle = obstacleTo(reference, context.input);
  if (obstacle?.kind === 'refused') {
    context.declined.push({
      path: relativePath(context.root, reference.file),
      line: null,
      reason: `${obstacle.why}, so ${converted.map((each) => each.asset).join(', ')} was converted without this reference moving`,
    });
    return null;
  }
  if (obstacle?.kind === 'build') {
    context.declined.push({
      path: relativePath(context.root, reference.file),
      line: null,
      reason: `the build loads this path, and ${obstacle.which}, so ${converted.map((each) => each.asset).join(', ')} was converted without this reference moving`,
    });
    return null;
  }

  // A pattern is never rewritten: its text is a template, not a path with a range to
  // replace. Its originals stay under either policy, so it keeps resolving. The sentence
  // below says every target converted, so it is written only when that is true; a partial
  // pattern is already reported by `declinePartialPatterns`.
  if (obstacle?.kind === 'pattern') {
    if (converted.length === targets.length) {
      context.declined.push({
        path: relativePath(context.root, reference.file),
        line: null,
        reason: `${patternCannotMove(reference)} even though every asset it matches converted`,
      });
    }
    return null;
  }

  if (obstacle !== null) return null;

  // Past the pattern test the reference is a literal, which links one asset: `conversion`.
  const replacement = withExtension(reference.rawPath, context.input.format);
  collectEdit(context.edits, relativePath(context.root, reference.file), reference, replacement);
  return { replacement, conversion };
}

/** A reference that links at least one asset: the only kind a plan could move. */
/** A reference the resolver linked to one asset, or to several through a pattern. */
export type LinkedReference = Extract<Reference, { resolution: 'resolved' | 'resolved-pattern' }>;

/** What the rules for moving one reference read from the plan's input. */
type RuleInput = Pick<PlanInput, 'graph' | 'servingRoots' | 'rootLinkPolicy' | 'format' | 'builds'>;

/** Why a plan leaves a linked reference where it is, even when its asset converts. */
type Obstacle =
  /** A rule forbids editing this text; `why` is the sentence saying which. */
  | { readonly kind: 'refused'; readonly why: string }
  /** The text is a template standing for several files, not a path with a range to edit. */
  | { readonly kind: 'pattern' }
  /** The path has no extension, so swapping it would change nothing. */
  | { readonly kind: 'unchanged' }
  /**
   * The project's build loads the path and is not known to load the new format; `which`
   * says what Upfly found about that build.
   */
  | { readonly kind: 'build'; readonly which: string };

/**
 * What stops this plan moving a linked reference to the converted file, or null when
 * nothing does.
 *
 * One function answers two questions: whether `collectRewrite` records an edit, and,
 * under `replace`, whether an asset is worth converting at all. Answered in two places,
 * the answers would drift, and the first sign would be a converted file nothing points
 * at. Nothing here depends on which other assets convert, which is what lets the second
 * question be asked before the plan exists.
 */
function obstacleTo(reference: LinkedReference, input: RuleInput): Obstacle | null {
  // The shape's rule sits apart from `rewriteRefusal`, whose tests `relocate.ts` repeats:
  // a move keeps the file's format, so a link preview still follows its image there.
  const refusal = rewriteRefusal(reference, input) ?? whyFormatKept(reference.shape);
  if (refusal !== null) return { kind: 'refused', why: refusal };
  if (reference.resolution === 'resolved-pattern') return { kind: 'pattern' };
  if (withExtension(reference.rawPath, input.format) === reference.rawPath) {
    return { kind: 'unchanged' };
  }
  // Apart from `rewriteRefusal` for the same reason as the shape's rule: a move keeps the
  // format, which the build already loads.
  if (loadedByBuild(reference, input)) {
    const build = buildOf(input.builds, relativePath(input.graph.root, reference.file));
    if (build.kind !== 'known') return { kind: 'build', which: whichBuild(build, input.format) };
  }
  return null;
}

/** The files a stylesheet's `url()` can be read from, as the CSS reader claims them. */
const STYLESHEETS: ReadonlySet<string> = new Set(['.css', '.scss', '.less']);

/**
 * Whether the project's build resolves this reference, rather than a browser.
 *
 * A module import always is, wherever its image sits. Any other path is when its image sits
 * outside every folder the site serves, since no browser can fetch that image by its URL.
 * Where no website folder was found, served and bundled images cannot be told apart by
 * folder, so the reference's kind decides: an import is the build's, a stylesheet's `url()`
 * is when its package names a build, since a site with no build serves its stylesheets as
 * written, and an HTML `src` never is. See "Images a build loads" in ARCHITECTURE.md.
 */
function loadedByBuild(reference: LinkedReference, input: RuleInput): boolean {
  if (reference.kind === 'import' || reference.shape === 'js.new-url') return true;
  const { root } = input.graph;
  if (noServingRootFound(input.servingRoots)) {
    return (
      reference.kind === 'css-url' &&
      STYLESHEETS.has(extensionOf(reference.file).toLowerCase()) &&
      buildOf(input.builds, relativePath(root, reference.file)).kind !== 'none'
    );
  }
  return linkedPaths(reference).some(
    (path) => servingRootOf(relativePath(root, path), input.servingRoots) === null,
  );
}

/** How a format is written in a sentence. */
const FORMAT_NAMES: Readonly<Record<EncodeFormat, string>> = { webp: 'WebP', avif: 'AVIF' };

/** What Upfly found about a build it is not sure loads `format`, as a clause. */
function whichBuild(build: Exclude<Build, { kind: 'known' }>, format: EncodeFormat): string {
  if (build.kind === 'none') return 'Upfly found no build settings naming that build';
  const setUp =
    build.command === undefined
      ? `set up in \`${build.file}\``
      : `run as \`${build.command}\` from \`${build.file}\``;
  return `that build is ${setUp}, which may have no rule for ${FORMAT_NAMES[format]} files`;
}

/** The rule the build sentences end with. */
function onlyKnownBuilds(format: EncodeFormat): string {
  return `Upfly converts an image a build loads only for Vite, Next.js and Astro, which load ${FORMAT_NAMES[format]} by themselves`;
}

/**
 * Why a plan converting this reference's image would leave the reference as it is, or null
 * when it would move the reference to the converted file: the rule the planner applies, for a
 * caller that explains one image's references.
 *
 * @param reference a reference the resolver linked
 * @param input the graph, serving roots, root-link policy and format the plan is made with
 * @returns a sentence a user can act on, or null
 */
export function whyReferenceStays(reference: LinkedReference, input: RuleInput): string | null {
  const obstacle = obstacleTo(reference, input);
  if (obstacle === null) return null;
  switch (obstacle.kind) {
    case 'refused':
      return obstacle.why;
    case 'pattern':
      return patternCannotMove(reference);
    case 'unchanged':
      return 'the path has no extension, so there is nothing in it to change';
    case 'build':
      return `the build loads this path, and ${obstacle.which}; ${onlyKnownBuilds(input.format)}`;
  }
}

/**
 * Why a reference in a file that did not read cleanly as UTF-8 stays as it is. Shared with
 * `relocate.ts`, whose refusals must match these.
 */
export const NOT_UTF8 =
  'the file is not valid UTF-8 or holds U+FFFD, and writing it back as UTF-8 could change bytes this edit does not touch';

/** The end of every sentence `usedByNoMove` writes: the rule. */
const CONVERTS_ONLY_WHAT_MOVES =
  'Upfly converts an image only when a reference moves to the new file';

/**
 * Why converting this asset would give it a new file nobody uses, or null when at least one
 * reference moves to it.
 *
 * The conversion half of the rule whose deletion half is `originalsStillNeeded`. The
 * sentence names the first reference holding the asset and counts the rest, in the form
 * the kept-original sentences use, so a reader can find the line to change.
 * See "The transaction" in ARCHITECTURE.md.
 */
function usedByNoMove(node: AssetNode, input: PlanInput): string | null {
  const blocked: { reference: LinkedReference; obstacle: Obstacle }[] = [];
  for (const reference of node.references) {
    if (!isLinked(reference)) continue;
    const obstacle = obstacleTo(reference, input);
    if (obstacle === null) return null;
    blocked.push({ reference, obstacle });
  }

  const [first] = blocked;
  if (first === undefined) {
    const held = input.hedged.has(node.asset.relative)
      ? 'nothing Upfly can see links to it, and something it could not read mentions it by its current name'
      : 'nothing Upfly can see links to it';
    return `${held}, so a new file would be used by nobody. ${CONVERTS_ONLY_WHAT_MOVES}`;
  }

  const where = `\`${relativePath(input.graph.root, first.reference.file)}\``;
  const more = blocked.length === 1 ? '' : ` (and ${blocked.length - 1} more)`;
  const text = `\`${first.reference.rawPath}\`${more}`;
  // Its own sentence: a user deciding what to do needs the build named, not the rule that
  // a new file nobody uses is not written.
  if (first.obstacle.kind === 'build') {
    return `${where} loads it through the build as ${text}, and ${first.obstacle.which}; ${onlyKnownBuilds(input.format)}`;
  }
  const held =
    first.obstacle.kind === 'pattern'
      ? `${where} reaches it only through ${text}, ${unrewritable(first.reference)}`
      : first.obstacle.kind === 'refused'
        ? `${where} names it as ${text}, and this run does not rewrite that reference: ${first.obstacle.why}`
        : `${where} names it as ${text}, which has no extension to change`;
  return `${held}. No reference would move to a new file, so it would be used by nobody. ${CONVERTS_ONLY_WHAT_MOVES}`;
}

/**
 * Why this reference may not be rewritten, or null when it may.
 *
 * An unsafe reference has no static path to replace. A guess that happened to resolve
 * against the project root shows the asset is alive and nothing more, because the code may
 * join that string to a different directory. A move asks the same, through `relocate.ts`.
 */
export function rewriteRefusal(
  reference: LinkedReference,
  input: Pick<RuleInput, 'graph' | 'servingRoots' | 'rootLinkPolicy'>,
): string | null {
  if (reference.confidence === 'unsafe') {
    return 'the reference has no static path to replace';
  }
  if (input.graph.texts.get(reference.file)?.holdsReplacementCharacter === true) {
    return NOT_UTF8;
  }
  if (reference.resolvedVia === 'speculative-root') {
    return 'the path is a guess that happened to resolve against the project root, which shows the asset is alive but not that this text may be edited';
  }
  if (reference.resolvedVia === 'project-root') {
    const policy = input.rootLinkPolicy ?? 'when-no-serving-root';
    if (policy === 'never' || (policy === 'when-no-serving-root' && input.servingRoots.declared)) {
      return 'the path is root-relative and missed the configured serving root, so its existing at the project root may be coincidence rather than a link';
    }
  }
  return null;
}

/**
 * Which originals `replace` must keep because a reference Upfly knows about still needs
 * them, and why, keyed by asset.
 *
 * An original is deleted only when at least one reference links to it, this plan rewrites
 * every reference that does, and no reference reaches it in another letter case. Stated as
 * a property rather than as cases, it covers a pattern (a template or a `+` chain), a
 * literal whose rewrite is refused (the old-path search misses one with an encoded
 * spelling), a path with no extension to change, a path Windows and macOS follow to it
 * whatever its letter case, and an asset nothing links to. The conversion rule declines
 * that last case before it gets here, and it is kept so this rule never depends on that one.
 * See "The transaction" in ARCHITECTURE.md.
 */
function originalsStillNeeded(
  input: PlanInput,
  converting: ReadonlyMap<string, PlannedConversion>,
  rewritten: ReadonlyMap<Reference, Repointing>,
  inAnotherCase: ReadonlyMap<string, readonly Reference[]>,
): ReadonlyMap<string, string> {
  const needed = new Map<string, string>();
  for (const node of input.graph.assets) {
    if (converting.get(node.asset.relative)?.replacesOriginal !== true) continue;
    const reason = whyStillNeeded(
      node.references,
      rewritten,
      input.graph.root,
      inAnotherCase.get(node.asset.relative) ?? [],
    );
    if (reason !== null) needed.set(node.asset.relative, reason);
  }
  return needed;
}

/** The sentence for one original `replace` keeps, or null when every reference to it moves. */
function whyStillNeeded(
  references: readonly Reference[],
  rewritten: ReadonlyMap<Reference, Repointing>,
  root: string,
  inAnotherCase: readonly Reference[],
): string | null {
  // Unreachable while the conversion rule declines every unlinked asset first. Kept so
  // this rule never depends on that one: see `originalsStillNeeded`.
  if (references.length === 0) {
    return (
      'converted, but the original was kept: nothing Upfly can see links to it, so no ' +
      'reference moved to the replacement. Upfly removes an original only once every ' +
      'reference to it has moved, and whatever loads this one is somewhere Upfly cannot read'
    );
  }

  const missed = references.filter((reference) => !rewritten.has(reference));
  const holding = [...missed, ...inAnotherCase];
  const [first] = holding;
  if (first === undefined) return null;

  // One location plus a count, as the surviving-mention reason does: the sentence stays
  // readable, and a reader who opens the named file finds the rest by searching for it.
  const where = `\`${relativePath(root, first.file)}\``;
  const text = `\`${first.rawPath}\`${holding.length === 1 ? '' : ` (and ${holding.length - 1} more)`}`;
  if (missed.length === 0) {
    // Only a pattern has a medium ceiling, and it matches files rather than naming one.
    const reaches =
      first.ceiling === 'medium'
        ? `reaches it through ${text}`
        : `names it as ${text}, which reaches it`;
    return `converted, but the original was kept: ${where} ${reaches} ${WHATEVER_THE_CASE}: deleting the original would break it there. Fix the letter case.`;
  }
  return first.resolution === 'resolved-pattern'
    ? `converted, but the original was kept: ${where} reaches it through ${text}, ${unrewritable(first)}: deleting the original would break it`
    : `converted, but the original was kept: ${where} names it as ${text}, and this run does not rewrite that reference: deleting the original would break it`;
}

/**
 * The conversions under `replace` whose originals survive, and why.
 *
 * An original stays when a reference still needs it, with the sentence `originalsStillNeeded`
 * wrote, wherever the asset sits: a served folder or the images a build loads. Where no
 * website folder was found, served and bundled images cannot be told apart, so every original
 * stays and the reason says how to name the folder. A user who asked for `replace` and gets
 * originals back is told why for each. Empty under `keep-original`, where every original is
 * kept and saying so for each would bury the cases that mean something.
 */
function keptOriginals(
  conversions: readonly PlannedConversion[],
  stillNeeded: ReadonlyMap<string, string>,
  input: PlanInput,
): KeptOriginal[] {
  if (input.publicPolicy !== 'replace') return [];

  const noFolder =
    `converted, but the original was kept: ${NO_WEBSITE_FOLDER}, and Upfly removes an ` +
    `original only once it knows that. ${NAME_THE_WEBSITE_FOLDER}.`;
  return conversions
    .filter((conversion) => !conversion.replacesOriginal)
    .map((conversion) => ({
      asset: conversion.asset,
      reason: stillNeeded.get(conversion.asset) ?? noFolder,
    }))
    .sort((a, b) => compareStrings(a.asset, b.asset));
}

/** Said wherever no root was found, so served and bundled images cannot be told apart. */
const NO_WEBSITE_FOLDER =
  'no website folder was found in this project, so Upfly cannot tell which images a browser loads by URL';
const NAME_THE_WEBSITE_FOLDER =
  'Name the folder the site is served from with `--public <dir>` or `publicDirs` in the config file, using "." for the project root itself, as on a plain HTML site';

/**
 * The serving root an asset is under: the deepest root that contains it, or `null` when
 * none does. Every root counts, so an image in a monorepo's second website folder is as
 * served as one in its first.
 *
 * @param relative the asset's POSIX path, relative to the project root
 * @param servingRoots the roots the resolver used
 */
export function servingRootOf(relative: string, servingRoots: ServingRoots): string | null {
  let found: string | null = null;
  for (const dir of servingRoots.dirs) {
    if (!isUnderPublicDir(relative, dir)) continue;
    if (found === null || dir.length > found.length) found = dir;
  }
  return found;
}

/**
 * Whether the run has no serving root at all and the project did not declare that. Every
 * image then counts as not served, which keeps every original under `replace`, and the
 * report says how to name the folder rather than guessing the project root.
 */
export function noServingRootFound(servingRoots: ServingRoots): boolean {
  return servingRoots.dirs.length === 0 && !servingRoots.declared;
}

/**
 * Whether an asset is under a serving directory, where something outside the repository
 * may load it.
 *
 * `''` is answered before the prefix test: appending a slash to it gives `/`, which no
 * project-relative path starts with, so a site served from its own root would count none
 * of its assets as served.
 *
 * @param relative the asset's POSIX path, relative to the project root
 * @param publicDir the serving directory: `null` when nothing is served, `''` when the
 *   project serves from its own root, as a hand-written static site does
 */
export function isUnderPublicDir(relative: string, publicDir: string | null): boolean {
  if (publicDir === null) return false;
  if (publicDir === '') return true;
  const prefix = publicDir.endsWith('/') ? publicDir : `${publicDir}/`;
  return relative === publicDir || relative.startsWith(prefix);
}

/** The text with its first letter in upper case, to start a sentence. */
function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Swap the extension, preserving everything before it exactly as written. */
function withExtension(path: string, format: EncodeFormat): string {
  const extension = extensionOf(path);
  if (extension === '') return path;
  return `${path.slice(0, path.length - extension.length)}.${format}`;
}
