#!/usr/bin/env node
// @ts-check
/**
 * Bundles the extension's source into one CommonJS file, `dist/extension.cjs`, which VS Code
 * loads. `vscode` is the editor's own module and stays outside. The CLI is not bundled: the
 * extension starts it as a separate process from the copy it carries.
 *
 * Usage: `node scripts/build.mjs`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(PACKAGE, 'src', 'extension.ts')],
  outfile: path.join(PACKAGE, 'dist', 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // The Node.js inside VS Code 1.101, the oldest version the extension supports.
  target: 'node22.15',
  external: ['vscode'],
  logLevel: 'warning',
});
