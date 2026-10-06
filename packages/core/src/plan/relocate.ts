/**
 * Move an asset and repoint every reference that names it.
 *
 * Renaming and moving are one operation, so a single-file move is the simple case of a
 * folder move. Pure, like `plan.ts`: it reads a graph and returns decisions. The moves ride
 * the same transaction and manifest as `optimize`, so `revert` undoes them too.
 *
 * A move acts on what the graph knows, so a reference the graph missed becomes a broken
 * reference this run caused; every refusal below is cheaper than that. It rewrites paths,
 * not code, so it refuses a move that changes how a file is reached, such as from an
 * import the bundler resolves to a URL a browser requests.
 * See "Moving an asset" in ARCHITECTURE.md.
 */

import { join, posix } from 'node:path';
import { spell, spellingsOf } from '../adapters/reference-path.js';
import type { Graph } from '../graph/graph.js';
import { compareStrings, extensionOf, relativePath, toPosix } from '../paths.js';
import { type AliasMap, type AliasRule, expandAlias, matchingRule } from '../resolve/aliases.js';
import { isLinked, linkedPaths } from '../resolve/reference.js';
import { type ServingRoots, resolveReferences } from '../resolve/resolve.js';
import type { Asset, RawReference, Reference } from '../types.js';
import type { Declined } from '../write/manifest.js';
import {
  type LinkedReference,
  type UnindexedFiles,
  patternCannotMove,
  rewriteRefusal,
  servingRootOf,
  unindexedFiles,
} from './plan.js';
import {
  type EditsInFile,
  type PlannedRewrite,
  type RootLinkPolicy,
  collectEdit,
  plannedRewrite,
} from './plan.js';

/** One asset's path change. Both sides POSIX-relative to the project root. */
export interface Move {
  readonly from: string;
  readonly to: string;
}

/**
 * Why a move will not be made. A refusal is an outcome, not an error: the move is
 * reported with its reason rather than dropped.
 */
export type RefusalCode =
  /** The destination is not inside the project, so we cannot rewrite what reaches it. */
  | 'outside-project'
  /**
   * The move would change how the file is reached, not only its path: between the bundled
   * source tree and a served directory, between two serving roots, or out of reach of the
   * alias an import uses.
   */
  | 'crosses-serving-boundary'
  /**
   * A pattern reference matches this asset and others. The pattern is one piece of text
   * for all of them, so moving one breaks it; moving the rest too is not the fix, because
   * the user asked for one file.
   */
  | 'binds-a-pattern'
  /** An asset is already at the destination, so the move would destroy it. */
  | 'destination-occupied'
  /** Two moves in one request target the same destination. */
  | 'destination-claimed-twice'
  /** Two moves in one request move the same file to different places. */
  | 'source-claimed-twice'
  /**
   * A reference rewritten for the move would not reach the moved file: read again from its
   * own file, among the files the moves leave, it reaches another file first, or none.
   */
  | 'rewrite-would-miss'
  /**
   * A reference the moves leave as written would load the moved file where today it loads
   * another, or none: read again among the files the moves leave, it reaches the destination.
   */
  | 'redirects-a-reference'
  /** The asset is not in the graph, so we cannot know what points at it. */
  | 'not-an-asset';

export interface RefusedMove {
  readonly from: string;
  readonly to: string;
  readonly code: RefusalCode;
  /** A sentence a user can act on, naming what is in the way. */
  readonly reason: string;
}

export interface RelocationPlan {
  /** The moves that will be made, in path order. */
  readonly moves: readonly Move[];
  /** The edits that keep every reference pointing at the moved asset. */
  readonly rewrites: readonly PlannedRewrite[];
  /** Moves not made, each with its reason. */
  readonly refused: readonly RefusedMove[];
  /**
   * References to a moved asset that could not be repointed, and why. The move still
   * happens and the other references follow it; each of these will break, so it is named
   * here rather than left to be found.
   */
  readonly declined: readonly Declined[];
}

export interface RelocateInput {
  readonly graph: Graph;
  /** What the user asked for. Order does not matter; output is sorted. */
  readonly moves: readonly Move[];
  /** The serving roots the resolver used. An asset under any of them is served. */
  readonly servingRoots: ServingRoots;
  /**
   * The aliases the resolver used, so an aliased import can be re-spelled through its alias.
   *
   * Required, so forgetting it cannot pass for having none: the graph does not record that
   * a reference came through an alias (`resolvedVia` is `serving-root`, as for a URL), and
   * without the aliases an aliased import would be re-spelled as a URL or declined. A
   * caller with no aliases passes an empty map.
   */
  readonly aliases: AliasMap;
  readonly rootLinkPolicy?: RootLinkPolicy;
  /**
   * The names in a directory, or `[]` when it cannot be listed, as the planner takes it. With
   * it, the files the walk did not index, such as images an ignore rule excluded, count: a
   * destination one of them holds is occupied, and a rewritten path that reaches one first
   * misses. No file is read. Absent, only the walk's images are counted.
   */
  readonly listDirectory?: (absolutePath: string) => readonly string[];
}

/** What rewriting one reference reads: the graph, the serving roots, the aliases, the policy. */
export type RewriteContext = Pick<
  RelocateInput,
  'graph' | 'servingRoots' | 'aliases' | 'rootLinkPolicy'
>;

/**
 * Plan a set of moves, refusing any it cannot make safely rather than guessing.
 *
 * A refused move contributes no rewrites, so a caller that ignores `refused` writes
 * nothing wrong, only less than it asked for.
 */
export function planRelocation(input: RelocateInput): RelocationPlan {
  const refused: RefusedMove[] = [];
  const assets = assetIndex(input.graph);
  const onDisk = unindexedFiles(input);
  const accepted = new Map<string, Move>();
  const claimed = new Map<string, string>();

  // Each path as it resolves, so `img/../../x.png` is judged as `../x.png` and two spellings
  // of one place are one destination.
  const requested = input.moves.map((move) => ({
    from: posix.normalize(toPosix(move.from)),
    to: posix.normalize(toPosix(move.to)),
  }));
  for (const move of requested.sort((a, b) => compareStrings(a.from, b.from))) {
    const refusal = refuse(move, input, assets, claimed, accepted, onDisk);
    if (refusal !== null) {
      refused.push(refusal);
      continue;
    }
    claimed.set(caseFolded(toPosix(move.to)), move.from);
    accepted.set(move.from, move);
  }

  // Where a rewritten reference leads depends on every file the moves leave, so it is checked
  // on the whole plan. Refusing a move changes those files and drops its rewrites, so the
  // references are repointed again without it until the check refuses nothing.
  let repointing = repointAll(input, accepted);
  let astray = astrayMoves(input, accepted, repointing.rewritten, onDisk);
  while (astray.length > 0) {
    for (const refusal of astray) {
      accepted.delete(refusal.from);
      refused.push(refusal);
    }
    repointing = repointAll(input, accepted);
    astray = astrayMoves(input, accepted, repointing.rewritten, onDisk);
  }

  return {
    moves: [...accepted.values()],
    rewrites: [...repointing.edits.entries()]
      .map(([file, collected]) => plannedRewrite(file, collected, input.graph))
      .sort((a, b) => compareStrings(a.file, b.file)),
    refused: refused.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to)),
    declined: repointing.declined.sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason),
    ),
  };
}

/** A reference an edit rewrites: its new text, and the move it follows. */
interface Rewritten {
  readonly replacement: string;
  readonly move: Move;
}

/** What a set of moves does to the references. */
interface Repointing {
  readonly edits: ReadonlyMap<string, EditsInFile>;
  readonly rewritten: ReadonlyMap<Reference, Rewritten>;
  readonly declined: Declined[];
}

/** Repoint every reference to a moved file, or record why it cannot be repointed. */
function repointAll(input: RelocateInput, accepted: ReadonlyMap<string, Move>): Repointing {
  const edits = new Map<string, EditsInFile>();
  const rewritten = new Map<Reference, Rewritten>();
  const declined: Declined[] = [];
  for (const reference of input.graph.references) {
    collectRepoint(reference, accepted, input, { edits, rewritten, declined });
  }
  return { edits, rewritten, declined };
}

/**
 * The moves a rewritten reference would not follow, each refused naming the first such
 * reference and counting the rest.
 *
 * Each new text is resolved again from the file that holds it, as a later run would read it,
 * among the files the moves leave. It can reach another file first, in a nearer serving root
 * or through a longer alias key, or reach none. Case is folded, as the planner folds it, so a
 * plan does not depend on where it runs.
 */
function misdirectedMoves(
  input: RelocateInput,
  accepted: ReadonlyMap<string, Move>,
  rewritten: ReadonlyMap<Reference, Rewritten>,
  onDisk: UnindexedFiles | undefined,
): RefusedMove[] {
  const { root } = input.graph;
  const asRewritten = (reference: Reference, { replacement }: Rewritten): RawReference => ({
    ...reference,
    rawPath: replacement,
  });
  const answers = resolveReferences(
    [...rewritten].map(([reference, entry]) => asRewritten(reference, entry)),
    {
      root,
      assets: assetsAfterMoves(input.graph, accepted),
      servingRoots: input.servingRoots,
      aliases: input.aliases,
      ...(onDisk === undefined ? {} : { unindexed: onDisk }),
      foldCase: true,
      exists: () => false,
    },
  );
  // A path that names no image is left out of the answers, so each is found by where its
  // reference sits and what it says.
  const reached = new Map(answers.map((answer) => [placeOf(answer), linkedPaths(answer)]));

  const misses = new Map<string, { reference: Reference; outcome: string; count: number }>();
  for (const [reference, entry] of rewritten) {
    const [found] = reached.get(placeOf(asRewritten(reference, entry))) ?? [];
    const lands = found === undefined ? null : relativePath(root, found);
    if (lands === entry.move.to) continue;

    const outcome =
      lands === null
        ? `would become \`${entry.replacement}\`, which names no file Upfly can find, so the reference would break.`
        : `would become \`${entry.replacement}\`, which reaches ${lands} first, so the reference would load that file instead.`;
    const first = misses.get(entry.move.from);
    misses.set(
      entry.move.from,
      first === undefined ? { reference, outcome, count: 1 } : { ...first, count: first.count + 1 },
    );
  }

  return [...misses].flatMap(([from, { reference, outcome, count }]) => {
    const move = accepted.get(from);
    if (move === undefined) return [];
    const where = `\`${reference.rawPath}\` in \`${relativePath(root, reference.file)}\``;
    const more = count === 1 ? '' : ` (and ${count - 1} more)`;
    return [
      {
        ...move,
        code: 'rewrite-would-miss' as const,
        reason: `${where}${more} ${outcome} Move it elsewhere, or change the reference by hand first.`,
      },
    ];
  });
}

/**
 * The moves the check after the plan refuses, one refusal per move: those a rewritten reference
 * would not follow, then those that would change what a reference left as written loads.
 */
function astrayMoves(
  input: RelocateInput,
  accepted: ReadonlyMap<string, Move>,
  rewritten: ReadonlyMap<Reference, Rewritten>,
  onDisk: UnindexedFiles | undefined,
): RefusedMove[] {
  const missed = misdirectedMoves(input, accepted, rewritten, onDisk);
  const refused = new Set(missed.map((refusal) => refusal.from));
  return [
    ...missed,
    ...redirectingMoves(input, accepted, rewritten, onDisk).filter(
      (refusal) => !refused.has(refusal.from),
    ),
  ];
}

/**
 * The moves that would change what a reference they leave as written loads, each refused naming
 * the first such reference and counting the rest.
 *
 * Every literal reference no move rewrites is read before and after, among the files the moves
 * leave, as a later run would read it: one that would reach a moved file's new path where today
 * it reaches another file, or none, would show a page nobody asked to change another image. A
 * file moved into a nearer serving root, or to the name a broken reference asks for, does this.
 * Patterns are left out: their text is never a promise of one file.
 */
function redirectingMoves(
  input: RelocateInput,
  accepted: ReadonlyMap<string, Move>,
  rewritten: ReadonlyMap<Reference, Rewritten>,
  onDisk: UnindexedFiles | undefined,
): RefusedMove[] {
  const { root } = input.graph;
  const untouched = input.graph.references.filter(
    (reference) =>
      !rewritten.has(reference) &&
      (reference.resolution === 'resolved' || reference.resolution === 'broken'),
  );
  if (untouched.length === 0 || accepted.size === 0) return [];
  const read = (assets: readonly Asset[]) =>
    new Map(
      resolveReferences(untouched, {
        root,
        assets,
        servingRoots: input.servingRoots,
        aliases: input.aliases,
        ...(onDisk === undefined ? {} : { unindexed: onDisk }),
        foldCase: true,
        exists: () => false,
      }).map((answer) => [placeOf(answer), linkedPaths(answer)[0]]),
    );
  const today = read(input.graph.assets.map((node) => node.asset));
  const after = read(assetsAfterMoves(input.graph, accepted));
  const destinations = new Map([...accepted.values()].map((move) => [move.to, move]));

  const found = new Map<string, { reference: Reference; loads: string; count: number }>();
  for (const reference of untouched) {
    const place = placeOf(reference);
    const lands = after.get(place);
    const move = lands === undefined ? undefined : destinations.get(relativePath(root, lands));
    if (move === undefined) continue;
    const before = today.get(place);
    const loads = before === undefined ? 'nothing' : relativePath(root, before);
    // A reference that already led to the moved file follows it, or is declined on its own.
    if (loads === move.from) continue;
    const first = found.get(move.from);
    found.set(
      move.from,
      first === undefined ? { reference, loads, count: 1 } : { ...first, count: first.count + 1 },
    );
  }

  return [...found].flatMap(([from, { reference, loads, count }]) => {
    const move = accepted.get(from);
    if (move === undefined) return [];
    const more = count === 1 ? '' : ` (and ${count - 1} more)`;
    return [
      {
        ...move,
        code: 'redirects-a-reference' as const,
        reason: `\`${reference.rawPath}\` in \`${relativePath(root, reference.file)}\`${more} loads ${loads} today, and would load ${move.to} after the move, though Upfly leaves its text as it is. Move it elsewhere, or change that reference by hand first.`,
      },
    ];
  });
}

/** Where a reference sits and what it says, the key its answer is found by. */
function placeOf(reference: RawReference): string {
  return `${reference.file}\n${reference.start}\n${reference.rawPath}`;
}

/** The assets once the moves are made, each moved file at its new path. */
function assetsAfterMoves(graph: Graph, accepted: ReadonlyMap<string, Move>): Asset[] {
  return graph.assets.map(({ asset }) => {
    const move = accepted.get(asset.relative);
    if (move === undefined) return asset;
    return {
      ...asset,
      path: join(graph.root, move.to),
      relative: move.to,
      extension: extensionOf(move.to).toLowerCase(),
    };
  });
}

/** The assets' POSIX-relative paths, as a move names them, and the same paths by `caseFolded`. */
interface AssetIndex {
  readonly exact: ReadonlySet<string>;
  readonly folded: ReadonlyMap<string, readonly string[]>;
}

function assetIndex(graph: Graph): AssetIndex {
  const exact = new Set<string>();
  const folded = new Map<string, string[]>();
  for (const { asset } of graph.assets) {
    exact.add(asset.relative);
    const key = caseFolded(asset.relative);
    folded.set(key, [...(folded.get(key) ?? []), asset.relative]);
  }
  return { exact, folded };
}

/**
 * A path as Windows and macOS compare one, whatever the case of its letters. A destination is
 * compared this way on every platform, as the planner's collision check compares, so a plan
 * does not depend on where it runs; `prepare` folds case for the same reason.
 */
function caseFolded(relative: string): string {
  return relative.toLowerCase();
}

/** Why this move will not be made, or `null` when it will. */
function refuse(
  move: Move,
  input: RelocateInput,
  assets: AssetIndex,
  claimed: ReadonlyMap<string, string>,
  accepted: ReadonlyMap<string, Move>,
  onDisk: UnindexedFiles | undefined,
): RefusedMove | null {
  const say = (code: RefusalCode, reason: string): RefusedMove => ({ ...move, code, reason });

  if (!assets.exact.has(move.from)) {
    return say(
      'not-an-asset',
      `${move.from} is not an asset in this project, so Upfly cannot know what points at it.`,
    );
  }

  // A destination that starts outside the root, on either separator. Checked on the text
  // rather than by resolving: the caller hands over project-relative paths, and one that
  // escapes the project is a request Upfly cannot honour, not a file to go looking for.
  const to = toPosix(move.to);
  if (to.startsWith('/') || to.startsWith('../') || to === '..' || /^[a-zA-Z]:/.test(move.to)) {
    return say(
      'outside-project',
      `${move.to} is outside this project. Upfly can only rewrite references to files it can see, so every reference to ${move.from} would break.`,
    );
  }

  const already = accepted.get(move.from);
  if (already !== undefined) {
    return say(
      'source-claimed-twice',
      `${move.from} is already being moved to ${already.to}, so Upfly cannot also move it to ${move.to}.`,
    );
  }

  const previous = claimed.get(caseFolded(to));
  if (previous !== undefined) {
    return say(
      'destination-claimed-twice',
      `${previous} is already being moved to ${move.to}, so this move would depend on which ran first.`,
    );
  }

  // The file that moves may be renamed to its own name in another case.
  const occupant = assets.folded.get(caseFolded(to))?.find((path) => path !== move.from);
  if (occupant !== undefined) {
    const there =
      occupant === to
        ? `${move.to} already exists`
        : `${occupant} already exists, and is the same file as ${move.to} on Windows and macOS`;
    return say(
      'destination-occupied',
      `${there}. Moving ${move.from} onto it would destroy a file Upfly can see.`,
    );
  }
  const unindexed = onDisk?.(join(input.graph.root, to)) ?? null;
  if (unindexed !== null) {
    return say(
      'destination-occupied',
      `${relativePath(input.graph.root, unindexed)} already exists, though the walk leaves it out. Moving ${move.from} onto it would destroy it.`,
    );
  }

  // One test for both directions between bundled and served, and for a move between two
  // serving roots: in each, the way the file is reached changes.
  const from = servingRootOf(move.from, input.servingRoots);
  const into = servingRootOf(to, input.servingRoots);
  if (from !== into) {
    return say('crosses-serving-boundary', crossingReason(move, from, into));
  }

  const bound = patternSiblings(move.from, input.graph);
  if (bound !== null) {
    return say('binds-a-pattern', bound);
  }

  // Within the bundled world an alias still has to be able to spell the new path:
  // `~/assets/*` cannot express `src/lib/x.png`.
  const inexpressible = aliasCannotExpress(move, input);
  if (inexpressible !== null) {
    return say('crosses-serving-boundary', inexpressible);
  }

  return null;
}

/**
 * Why a move that changes where the file is served from is refused. `null` is the bundled
 * world: code imports the file and the build emits it.
 */
function crossingReason(move: Move, from: string | null, into: string | null): string {
  if (from !== null && into !== null) {
    return `${move.from} is served from ${rootName(from)} and ${move.to} would be served from ${rootName(into)}, so a URL that finds it today would not find it there. Move it within ${rootName(from)}, or change the references by hand first.`;
  }
  const detail =
    from === null
      ? `${move.from} is bundler-managed: code imports it and the build emits it. ${move.to} is served directly, where a browser asks for it by URL.`
      : `${move.from} is served directly, where a browser asks for it by URL. ${move.to} is bundler-managed: code would have to import it and the build would emit it.`;

  return `${detail} Moving it changes how the file is referenced, not just where it lives, so an import would have to become a URL or the reverse. Upfly rewrites paths, not code. Move it within ${from === null ? 'the source tree' : 'the served directory'}, or change the references by hand first.`;
}

/** A serving root as a sentence names it. */
function rootName(root: string): string {
  return root === '' ? 'the project root' : `${root}/`;
}

/**
 * Why moving this asset alone would break a pattern, naming the other assets it matches,
 * or `null` when no pattern binds this asset to another.
 *
 * A template reference is one piece of text standing for N assets, so moving one breaks
 * it for all N. Moving the others as well is not the fix: the user asked for one file.
 */
function patternSiblings(relative: string, graph: Graph): string | null {
  for (const reference of graph.references) {
    if (reference.resolution !== 'resolved-pattern') continue;

    const bound = reference.resolvedPaths.map((path) => toPosix(relativePath(graph.root, path)));
    if (!bound.includes(relative)) continue;

    const others = bound.filter((path) => path !== relative).sort(compareStrings);
    if (others.length === 0) continue;

    return `Moving ${relative} alone would break \`${reference.rawPath}\`, which also matches ${others.join(', ')}. Move all ${bound.length}, or none.`;
  }
  return null;
}

/**
 * The refusal when some alias names the old path but none can name the new one, or `null`.
 *
 * `astro-docs` imports `~/assets/houston.png` through `~/* → src/*`. Moved to a directory
 * no target of that rule covers, the file is reached by no alias path: the import could
 * only become a different kind of reference, which this module does not do.
 */
function aliasCannotExpress(move: Move, input: RelocateInput): string | null {
  const root = input.graph.root;

  for (const reference of input.graph.references) {
    if (!isLinked(reference)) continue;
    const targets = linkedPaths(reference).map((path) => toPosix(relativePath(root, path)));
    if (!targets.includes(move.from)) continue;

    const rule = aliasRuleFor(reference, input.aliases);
    if (rule !== null) {
      if (aliasTextFor(rule, move.to, root) !== null) continue;
      return `\`${reference.rawPath}\` reaches ${move.from} through the \`${rule.prefix}\` alias, and that alias cannot express ${move.to}. The import would have to become a different kind of reference, and Upfly rewrites paths, not code.`;
    }
    const base = baseUrlOf(reference, input);
    if (base === null || nameUnder(base, move.to, root) !== null) continue;
    return `\`${reference.rawPath}\` reaches ${move.from} through the tsconfig's baseUrl, ${relativePath(root, base) || 'the project root'}, and a module name under it cannot name ${move.to}. The import would have to become a different kind of reference, and Upfly rewrites paths, not code.`;
  }
  return null;
}

/**
 * The folder a bare import was linked under through the nearest tsconfig's `baseUrl`, absolute
 * and POSIX, or `null` when it was linked another way. TypeScript looks under `baseUrl` only
 * when no `paths` key matches, so only a reference no alias rule covers can have one.
 */
function baseUrlOf(reference: Reference, input: RewriteContext): string | null {
  if (reference.kind !== 'import' || reference.resolution !== 'resolved') return null;
  if (reference.resolvedVia !== 'serving-root') return null;
  if (aliasRuleFor(reference, input.aliases) !== null) return null;
  const path = pathPartOf(reference.rawPath);
  const [expanded] = expandAlias(input.aliases, path, toPosix(reference.file), { baseUrl: true });
  if (expanded === undefined || expanded !== toPosix(reference.resolvedPath)) return null;
  return expanded.endsWith(`/${path}`) ? expanded.slice(0, -(path.length + 1)) : null;
}

/** A project path as a module name under `base`, or `null` when it is not inside it. */
function nameUnder(base: string, relative: string, root: string): string | null {
  const target = toPosix(join(root, relative));
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

/**
 * The alias rule the resolver linked this reference through, or `null` when it linked it
 * another way.
 *
 * The rule is the one `expandAlias` expands, so scope is checked as well as the prefix: a
 * rule applies only to references from inside the directory its config governs. Matching the
 * prefix alone would re-spell a `~/` reference through an alias the resolver never used,
 * producing text that looks right and reaches nothing. An alias link is recorded as
 * `serving-root`, so a relative link whose text a rule also matches keeps its relative form,
 * and the rule is asked of the spelling the lookup matched, so `%7E/` is read as `~/`.
 */
function aliasRuleFor(reference: Reference, aliases: AliasMap): AliasRule | null {
  if (!isLinked(reference) || reference.resolvedVia !== 'serving-root') return null;
  const path = pathPartOf(reference.rawPath);
  const spelling = reference.resolution === 'resolved' ? (reference.spelling ?? 'literal') : null;
  const read = spellingsOf(path, reference).find((candidate) => candidate.spelling === spelling);
  return matchingRule(aliases, read?.path ?? path, toPosix(reference.file));
}

/** The aliased spelling of a new path under this rule, or `null` if it has none. */
function aliasTextFor(rule: AliasRule, newRelative: string, root: string): string | null {
  if (!rule.wildcard) return null;

  for (const [index, target] of rule.targets.entries()) {
    const base = toPosix(relativePath(root, target));
    // `''` is a target at the project root, under which every path sits.
    const inside = base === '' || newRelative === base || newRelative.startsWith(`${base}/`);
    if (!inside) continue;
    const rest = base === '' ? newRelative : newRelative.slice(base.length + 1);
    // The new path has to have the text the target writes around its `*`, and a target with
    // no `*` names one file whatever the path says.
    const pattern = rule.targetPatterns?.[index] ?? '*';
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const before = pattern.slice(0, star);
    const after = pattern.slice(star + 1);
    if (rest.length < before.length + after.length) continue;
    if (!rest.startsWith(before) || !rest.endsWith(after)) continue;
    return `${rule.prefix}${rest.slice(before.length, rest.length - after.length)}${rule.suffix ?? ''}`;
  }
  return null;
}

/** Repoint one reference, or record why it cannot be repointed. */
function collectRepoint(
  reference: Reference,
  accepted: ReadonlyMap<string, Move>,
  input: RelocateInput,
  into: {
    edits: Map<string, EditsInFile>;
    rewritten: Map<Reference, Rewritten>;
    declined: Declined[];
  },
): void {
  const { edits, rewritten, declined } = into;
  const root = input.graph.root;
  const file = toPosix(relativePath(root, reference.file));

  if (!isLinked(reference)) return;
  const targets = linkedPaths(reference).map((path) => toPosix(relativePath(root, path)));
  const moved = targets.filter((target) => accepted.has(target));
  if (moved.length === 0) return;

  // A pattern that binds a moved asset should already have been refused, so reaching
  // here means the pattern binds exactly the one asset that moved. Its text is still a
  // template rather than a path, so it cannot be repointed by replacing text.
  if (reference.resolution === 'resolved-pattern') {
    declined.push({
      path: file,
      line: null,
      reason: `${patternCannotMove(reference)} after ${moved.join(', ')} moved`,
    });
    return;
  }

  const refusal = rewriteRefusal(reference, input);
  if (refusal !== null) {
    declined.push({
      path: file,
      line: null,
      reason: `${refusal}, so ${moved.join(', ')} moved without this reference following it`,
    });
    return;
  }

  const move = accepted.get(targets[0] ?? '');
  if (move === undefined) return;

  const replacement = repointed(reference, move, input);
  if (replacement === null) {
    declined.push({
      path: file,
      line: null,
      reason: `Upfly could not work out how to spell ${move.to} from this reference, so ${move.from} moved without it following`,
    });
    return;
  }
  // Checked even when the text stays as it is: it has to reach the file at its new path.
  rewritten.set(reference, { replacement, move });
  if (replacement === reference.rawPath) return;

  collectEdit(edits, file, reference, replacement);
}

/**
 * The new text for one reference, as expressed from the file that holds it.
 *
 * A root-relative reference stays root-relative, a relative one is re-derived from the
 * referencing file's directory, and an aliased one keeps its alias. The original spelling
 * survives too, because a diff full of `./` appearing and disappearing is a diff nobody
 * can review.
 */
function repointed(reference: Reference, move: Move, input: RewriteContext): string | null {
  const { rawPath } = reference;
  const suffix = rawPath.slice(pathPartOf(rawPath).length);
  const path = pathPartOf(rawPath);

  // Every return below builds the new text from `move.to`, an on-disk path, so it is
  // re-encoded the way the author wrote the old one: a file named `hero image.png` is
  // written `hero%20image.png` in HTML, and a raw space would break the reference. The
  // spelling comes from `reference.spelling`, not from `rawPath`, because `enc%20name.png`
  // can be a file's real name or an encoding of `enc name.png`, and only the resolver's
  // lookup knows which one matched.
  const spelling =
    reference.resolution === 'resolved' ? (reference.spelling ?? 'literal') : 'literal';
  const asWritten = (target: string): string => spell(target, spelling, reference);

  const rule = aliasRuleFor(reference, input.aliases);
  if (rule !== null) {
    const aliased = aliasTextFor(rule, move.to, input.graph.root);
    if (aliased === null) return null;
    // Only what follows the alias is spelled: the prefix is written as the rule writes it,
    // whatever spelling hid it in the old text.
    return `${rule.prefix}${asWritten(aliased.slice(rule.prefix.length))}${suffix}`;
  }

  // A bare import stays a bare module name, never a URL: through `baseUrl`, it is the path
  // under that folder.
  const base = baseUrlOf(reference, input);
  if (base !== null) {
    const named = nameUnder(base, move.to, input.graph.root);
    return named === null ? null : `${asWritten(named)}${suffix}`;
  }

  if (reference.resolution === 'resolved' && reference.resolvedVia === 'serving-root') {
    const base = servingRootOf(move.to, input.servingRoots);
    if (base === null) return null;
    const rest = base === '' ? move.to : move.to.slice(base.length + 1);
    return `/${asWritten(rest)}${suffix}`;
  }

  if (reference.resolution === 'resolved' && reference.resolvedVia === 'project-root') {
    return `/${asWritten(move.to)}${suffix}`;
  }

  const from = directoryOf(toPosix(relativePath(input.graph.root, reference.file)));
  const relative = posixRelative(from, move.to);
  // `./` is kept when the original had it and not invented when it did not, so the
  // edit changes the path and nothing else about the line.
  const dotted = path.startsWith('./') && !relative.startsWith('../') ? `./${relative}` : relative;
  return `${asWritten(dotted)}${suffix}`;
}

/** The path part of a raw reference, without any `?query` or `#fragment`. */
function pathPartOf(rawPath: string): string {
  const cut = rawPath.search(/[?#]/);
  return cut === -1 ? rawPath : rawPath.slice(0, cut);
}

/** The directory holding a POSIX-relative file, or `''` at the project root. */
function directoryOf(relative: string): string {
  const cut = relative.lastIndexOf('/');
  return cut === -1 ? '' : relative.slice(0, cut);
}

/** `to`, expressed from `from`. Both POSIX-relative to the project root. */
function posixRelative(from: string, to: string): string {
  const fromParts = from === '' ? [] : from.split('/');
  const toParts = to.split('/');

  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1;
  }

  const up = fromParts.length - shared;
  const down = toParts.slice(shared);
  return [...Array.from({ length: up }, () => '..'), ...down].join('/');
}

/** Every reference to `from` pointed at `to`, a file that already exists. Nothing moves. */
export interface Repoint {
  /** POSIX-relative path of the file the references name now. */
  readonly from: string;
  /** POSIX-relative path of the file they are to name. */
  readonly to: string;
}

export interface RepointInput extends RewriteContext {
  readonly repoints: readonly Repoint[];
  /** As `RelocateInput.listDirectory`: the files the walk left out count in the check. */
  readonly listDirectory?: (absolutePath: string) => readonly string[];
}

/** What became of one reference to a `from`: its new text, or why it stays as written. */
export interface RepointOutcome {
  readonly reference: Reference;
  readonly repoint: Repoint;
  /** The new text, when the reference moves to `to`. */
  readonly replacement?: string;
  /** Why it stays as written, when it does. */
  readonly why?: string;
}

export interface RepointPlan {
  /** The edits that point the references at their `to`, one entry per file, in path order. */
  readonly rewrites: readonly PlannedRewrite[];
  /** Every reference to a `from`, in the graph's order: moved, or staying with its reason. */
  readonly outcomes: readonly RepointOutcome[];
}

/**
 * Plan pointing every reference to one file at another that already exists, as for two
 * identical copies of an image, rewriting paths the way a move does and moving no file.
 *
 * A reference follows only where the new file is reachable the way the reference loads
 * files: a URL only to a file a folder the site is served from holds, the same folder as
 * today; an import only to a file no such folder holds. Every new text is read again, among
 * the files as they are, and must reach its `to`; one that would not stays as written.
 */
export function planRepoint(input: RepointInput): RepointPlan {
  const { root } = input.graph;
  const repoints = new Map(input.repoints.map((repoint) => [repoint.from, repoint]));
  const outcomes: RepointOutcome[] = [];
  const candidates = new Map<Reference, { replacement: string; repoint: Repoint }>();

  for (const reference of input.graph.references) {
    if (!isLinked(reference)) continue;
    const repoint = linkedPaths(reference)
      .map((path) => repoints.get(toPosix(relativePath(root, path))))
      .find((found) => found !== undefined);
    if (repoint === undefined) continue;
    const why = whyStaysAsWritten(reference, repoint, input);
    if (why !== null) {
      outcomes.push({ reference, repoint, why });
      continue;
    }
    const replacement = repointed(reference, repoint, input);
    if (replacement === null) {
      outcomes.push({
        reference,
        repoint,
        why: `Upfly could not work out how to spell ${repoint.to} from this reference`,
      });
      continue;
    }
    candidates.set(reference, { replacement, repoint });
  }

  const onDisk = unindexedFiles(input);
  const answers = resolveReferences(
    [...candidates].map(([reference, { replacement }]) => ({ ...reference, rawPath: replacement })),
    {
      root,
      assets: input.graph.assets.map((node) => node.asset),
      servingRoots: input.servingRoots,
      aliases: input.aliases,
      ...(onDisk === undefined ? {} : { unindexed: onDisk }),
      foldCase: true,
      exists: () => false,
    },
  );
  const reached = new Map(answers.map((answer) => [placeOf(answer), linkedPaths(answer)[0]]));

  const edits = new Map<string, EditsInFile>();
  for (const [reference, { replacement, repoint }] of candidates) {
    const lands = reached.get(placeOf({ ...reference, rawPath: replacement }));
    const at = lands === undefined ? null : relativePath(root, lands);
    if (at !== repoint.to) {
      outcomes.push({
        reference,
        repoint,
        why:
          at === null
            ? `it would become \`${replacement}\`, which names no file Upfly can find`
            : `it would become \`${replacement}\`, which reaches ${at} first`,
      });
      continue;
    }
    outcomes.push({ reference, repoint, replacement });
    if (replacement !== reference.rawPath) {
      collectEdit(edits, toPosix(relativePath(root, reference.file)), reference, replacement);
    }
  }

  const order = new Map(input.graph.references.map((reference, index) => [reference, index]));
  return {
    rewrites: [...edits.entries()]
      .map(([file, collected]) => plannedRewrite(file, collected, input.graph))
      .sort((a, b) => compareStrings(a.file, b.file)),
    outcomes: outcomes.sort(
      (a, b) => (order.get(a.reference) ?? 0) - (order.get(b.reference) ?? 0),
    ),
  };
}

/**
 * Why a reference to `from` cannot be pointed at `to` by changing its text, or `null` when it
 * can: the tests a move's rewrite applies, and whether `to` is reachable the way the reference
 * loads files, which a move decides once for the file and a repoint for each reference.
 */
function whyStaysAsWritten(
  reference: LinkedReference,
  repoint: Repoint,
  input: RewriteContext,
): string | null {
  if (reference.resolution === 'resolved-pattern') return patternCannotMove(reference);
  const refusal = rewriteRefusal(reference, input);
  if (refusal !== null) return refusal;
  const from = servingRootOf(repoint.from, input.servingRoots);
  const into = servingRootOf(repoint.to, input.servingRoots);
  if (from === into) return null;
  if (from !== null && into !== null) {
    return `${repoint.to} is served from ${rootName(into)} and ${repoint.from} from ${rootName(from)}, so a URL that finds one does not find the other`;
  }
  return from !== null
    ? `a URL can load only a file a folder the site is served from holds, and ${repoint.to} is in none`
    : `an import names a file for the bundler, and ${repoint.to} is in a folder the site serves as it is, which bundlers such as Vite do not import from`;
}

/** Everything the transaction needs to carry out an accepted move. */
export function moveOperationsFor(plan: RelocationPlan, hashOf: (relative: string) => string) {
  return plan.moves.map((move) => ({
    kind: 'move' as const,
    from: move.from,
    to: move.to,
    hash: hashOf(move.from),
  }));
}
