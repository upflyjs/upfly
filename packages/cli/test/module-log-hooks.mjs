// The hooks `module-log.mjs` registers: each module's address, one per line, before it loads.
import { appendFileSync } from 'node:fs';

/** @type {string | undefined} */
let log;

/** @param {{ log?: string } | undefined} data */
export function initialize(data) {
  log = data?.log;
}

/**
 * @param {string} url
 * @param {unknown} context
 * @param {(url: string, context: unknown) => unknown} nextLoad
 */
export function load(url, context, nextLoad) {
  if (log) appendFileSync(log, `${url}\n`);
  return nextLoad(url, context);
}
