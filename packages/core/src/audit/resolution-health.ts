/**
 * Whether a run found its serving root, and so whether its `broken` findings can be
 * believed. When almost no root-relative reference resolves, the finding is not that those
 * references are broken but that the engine could not work out where the project serves
 * files from. Only root-relative references depend on a serving root, so only they are
 * counted, and a project whose relative imports are genuinely broken keeps its findings.
 * A run told where the site is served from still stops short of rewriting, but says what
 * resolved there rather than asking for the folder again (`fewResolvedIn`).
 * See "When the serving root cannot be found at all" in ARCHITECTURE.md.
 */

import type { Graph } from '../graph/graph.js';
import { isLinked, provenPath } from '../resolve/reference.js';
import type { Reference } from '../types.js';

/**
 * The share of checkable root-relative references that must link for the serving root to
 * count as found. Below it, given at least `MINIMUM_ROOT_RELATIVE` of them, the audit
 * replaces the root-relative `broken` findings with one `serving-root-unknown` finding, and
 * the planner refuses.
 *
 * Measured on the five validation repositories, with a serving root and with none found:
 * the two populations do not come close to overlapping, and this sits in the gap. See
 * "When the serving root cannot be found at all" in ARCHITECTURE.md.
 */
export const RESOLUTION_FLOOR = 0.25;

/**
 * Fewer checkable root-relative references than this and the share is not a measurement,
 * so the floor does not apply. Otherwise a project whose one root-relative reference is
 * genuinely broken would score zero and see that true finding replaced by a wrong
 * diagnosis. A judgement rather than a measurement.
 */
export const MINIMUM_ROOT_RELATIVE = 10;

export interface ResolutionHealth {
  /** Root-relative references that found their asset. */
  readonly linked: number;
  /**
   * Root-relative references the engine could check at all: linked plus broken.
   *
   * Excludes dynamic, speculative-and-discarded, alias-shaped and out-of-scope
   * references. None of those is evidence about a serving root: a discarded guess
   * from a lockfile says nothing about whether the site serves from `public/`, and
   * counting it would make a repository with a large `package.json` look misconfigured.
   */
  readonly checkable: number;
  /** `linked / checkable`, and 1 when there is nothing to check. */
  readonly rate: number;
  /**
   * True when the run resolved too little for its `broken` findings to be believed.
   *
   * Two conditions, both required: the share is below the floor, and there were
   * enough root-relative references for that share to mean something.
   */
  readonly servingRootUnknown: boolean;
}

export function resolutionHealth(graph: Graph): ResolutionHealth {
  let linked = 0;
  let checkable = 0;

  for (const reference of graph.references) {
    // The only references a serving root can decide. A file-relative path resolves
    // the same way whatever the serving root is.
    if (!dependsOnServingRoot(provenPath(reference))) continue;

    if (isLinked(reference)) {
      linked += 1;
      checkable += 1;
    } else if (reference.resolution === 'broken') {
      checkable += 1;
    }
  }

  const rate = checkable === 0 ? 1 : linked / checkable;

  return {
    linked,
    checkable,
    rate,
    servingRootUnknown: checkable >= MINIMUM_ROOT_RELATIVE && rate < RESOLUTION_FLOOR,
  };
}

/**
 * What a run says when it was told where the site is served from and too few root-relative
 * references resolved there: how many did, and that the rest name no file there if that is
 * the right folder. It never asks for the folder, which was named. Lower case and without a
 * full stop, so a caller can start a sentence with it or end one on it.
 *
 * @param health how many resolved, of how many could be checked
 * @param dirs the folders named, relative to the project root, `''` being the root itself
 * @example
 * fewResolvedIn({ linked: 2, checkable: 12 }, ['public']);
 * // 'only 2 of 12 root-relative references resolved in public, named as the folder the
 * // site is served from; if it is, the other 10 name no file there'
 */
export function fewResolvedIn(
  health: Pick<ResolutionHealth, 'linked' | 'checkable'>,
  dirs: readonly string[],
): string {
  const resolved =
    health.linked === 0
      ? `none of the ${health.checkable}`
      : `only ${health.linked} of ${health.checkable}`;
  // An empty list is a statement too: nothing is served by path from the project's folders.
  if (dirs.length === 0) {
    return `${resolved} root-relative references resolved, and no folder was named as the one the site is served from`;
  }
  const names = dirs.map((dir) => (dir === '' ? 'the project root' : dir));
  const last = names.at(-1);
  const folders = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${last}` : last;
  const rest =
    health.linked === 0
      ? `all ${health.checkable}`
      : `the other ${health.checkable - health.linked}`;
  const one = names.length === 1;
  return `${resolved} root-relative references resolved in ${folders}, named as the ${one ? 'folder' : 'folders'} the site is served from; if ${one ? 'it is' : 'they are'}, ${rest} name no file there`;
}

/**
 * The `broken` references whose findings a run that could not find its serving root
 * withholds: the root-relative ones. Their target is unknown rather than missing, so an
 * asset one of them names may be in use. Empty when the serving root was found.
 */
export function withheldReferences(graph: Graph): readonly Reference[] {
  if (!resolutionHealth(graph).servingRootUnknown) return [];
  return graph.byResolution.broken.filter((reference) =>
    dependsOnServingRoot(provenPath(reference)),
  );
}

/**
 * The patterns a run that could not find its serving root had no base to glob: the
 * root-relative `dynamic` references with a `medium` ceiling, the only ones the resolver
 * globs. Like a withheld reference, each one's target is unknown rather than absent. Empty
 * when the serving root was found.
 */
export function patternsWithoutServingRoot(graph: Graph): readonly Reference[] {
  if (!resolutionHealth(graph).servingRootUnknown) return [];
  return graph.byResolution.dynamic.filter(
    (reference) => reference.ceiling === 'medium' && dependsOnServingRoot(provenPath(reference)),
  );
}

/**
 * Whether a serving root decides where this path points: whether it is root-relative. Asked
 * of the path a reference's text proves (`provenPath`), so `'/img' + '/x.png'` counts though
 * its text starts with a quote.
 */
export function dependsOnServingRoot(path: string): boolean {
  return path.startsWith('/');
}
