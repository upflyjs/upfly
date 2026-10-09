/** The version `upfly-mcp --version` prints and the server gives its clients. */

import { readFileSync } from 'node:fs';

/**
 * The package's version, read from its own `package.json`, which sits beside both `src` and
 * `dist`. A release then changes that file alone, never the code.
 */
export function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { readonly version?: unknown };
  return String(manifest.version);
}
