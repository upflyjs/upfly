// @ts-check
/**
 * The text of an `upfly.config.mjs` that leaves a mark at UPFLY_MARK when anything runs it, so
 * a test can tell whether the config was loaded.
 */
export const MARKING_CONFIG = [
  "import { writeFileSync } from 'node:fs';",
  '',
  "writeFileSync(process.env.UPFLY_MARK ?? 'config-ran.txt', 'the config ran');",
  '',
  'export default {};',
  '',
].join('\n');
