import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// A full collection on demand, as `node --expose-gc` gives one: the flag is read when a
// context is made, so a new context carries the function.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

/** About the size of `megabyteOfText`, in bytes of heap. */
export const MEGABYTE = 1 << 20;

/**
 * How many bytes of heap a call leaves in use while its result is still held, measured after
 * a full collection on either side, so what a function keeps alive is told apart from what it
 * only used on the way.
 *
 * @param make the call; its result is held until the second measurement
 * @returns the result, and the bytes it holds
 * @example
 * const { bytes } = await heapHeldBy(() => findSurvivingPaths(input));
 */
export async function heapHeldBy<T>(
  make: () => T | Promise<T>,
): Promise<{ readonly result: T; readonly bytes: number }> {
  collect();
  const before = process.memoryUsage().heapUsed;
  const result = await make();
  collect();
  return { result, bytes: process.memoryUsage().heapUsed - before };
}

/** The bytes of heap still in use after a full collection: what something still holds. */
export function heapInUse(): number {
  collect();
  return process.memoryUsage().heapUsed;
}

/**
 * Text of about a megabyte holding `line` once, made anew on each call and decoded from bytes as
 * a file's text is, so each call's text is a string of its own that only what keeps it holds.
 *
 * @param line the line to hold, such as one naming an image
 */
export function megabyteOfText(line: string): string {
  return Buffer.from(`${'x'.repeat(MEGABYTE)}\n${line}\n`).toString();
}
