/**
 * Short names for why an image is left as it is, so a summary can count each reason once.
 * The planner gives its reasons as sentences, so they are grouped by the phrases each kind
 * of sentence always holds; a sentence that holds none still counts, under `OTHER`, and its
 * full text is in the report file. A probe's reasons carry a code and are grouped by it.
 */

import type { EncodeFormat } from 'upfly-core';
import type { AssetProbe } from 'upfly-core/internal';

/** Why a probe skipped a measurement, as the code it gives. */
export type ProbeSkipCode = AssetProbe['skipped'][number]['code'];

/** The group for a reason none of the others names. */
export const OTHER = 'another reason, in the full plan';

/** The name a format has in a sentence. */
export function formatName(format: EncodeFormat): string {
  return format === 'avif' ? 'AVIF' : 'WebP';
}

/** Each kind of planner sentence, by a phrase only that kind holds, in the order tried. */
const DECLINES: readonly (readonly [RegExp, string])[] = [
  [/^converting it would save /, 'would save too little'],
  [/ came out no smaller,/, 'no smaller when converted'],
  [/^nothing (?:Upfly can see )?links to it/, 'nothing links to it'],
  [/ would replace a file rather than add one\./, 'its new name is taken by another file'],
  [/ could not be read to rule out a mention of it$/, 'a file that may name it could not be read'],
  [/ still names its path, in a file this run excluded$/, 'named in a file this run leaves out'],
  [/ still names its path in a form Upfly cannot rewrite$/, 'named where Upfly cannot rewrite it'],
  [/\. No reference would move to a new file,/, 'no reference would move to a new file'],
  [/ loads it through the build as /, 'its build may not load the new format'],
  [
    /, so (?:repointing )?the reference would (?:load|break)/,
    'a reference would break or load another file',
  ],
];

/**
 * The group for a reason the planner gave for not converting an image.
 *
 * @param reason the planner's sentence, from the plan's `declined` list
 */
export function declineGroup(reason: string): string {
  return DECLINES.find(([phrase]) => phrase.test(reason))?.[1] ?? OTHER;
}

/**
 * The group for an image the plan never weighed, from why it was not measured.
 *
 * @param code the first measurement the probe skipped, or null when it skipped none
 * @param format the format the run converts to
 */
export function unmeasuredGroup(code: ProbeSkipCode | null, format: EncodeFormat): string {
  switch (code) {
    case 'vector':
      return 'SVG, which Upfly does not convert';
    case 'already-target-format':
      return `already ${formatName(format)}`;
    case 'drops-animation':
      return 'converting would lose its animation';
    case 'beyond-encode-cap':
      return 'not measured, past the limit on how many are';
    case 'would-not-convert':
      return 'no reference would move to a new file';
    case 'not-an-image':
    case 'svg-unreadable':
    case 'too-large-to-encode':
    case 'encode-failed':
      return 'could not be measured';
    case null:
      return OTHER;
  }
}

/** Each kind of sentence saying why a reference to a copy stays as written. */
const STAYS: readonly (readonly [RegExp, string])[] = [
  [/^an import names a file for the bundler, /, 'an import cannot reach a folder the site serves'],
  [
    /^a URL can load only a file a folder the site is served from holds/,
    'a URL cannot reach the kept copy',
  ],
  [
    /, so a URL that finds one does not find the other$/,
    'the copies are served from different folders',
  ],
  [
    /^Upfly could not work out how to spell |^it would become `/,
    'no path to the kept copy was found',
  ],
];

/**
 * The group for why `dedupe` leaves a reference as written.
 *
 * @param why the reason on the plan's staying reference
 */
export function stayGroup(why: string): string {
  return STAYS.find(([phrase]) => phrase.test(why))?.[1] ?? 'it cannot be rewritten safely';
}

/**
 * Counts per group, the largest first and then by name, so the same run always prints the
 * same order.
 */
export function countGroups(groups: readonly string[]): { count: number; text: string }[] {
  const counts = new Map<string, number>();
  for (const group of groups) counts.set(group, (counts.get(group) ?? 0) + 1);
  return [...counts]
    .map(([text, count]) => ({ count, text }))
    .sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}
