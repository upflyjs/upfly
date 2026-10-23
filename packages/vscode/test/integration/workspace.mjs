// @ts-check
/**
 * The workspaces the integration tests open: copies of fixtures in a fresh folder under the
 * system's temporary folder, outside the checkout, and a `.code-workspace` file naming them.
 * The tests then run on copies, so nothing they do can reach the repository.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

/**
 * Copies fixtures and writes a workspace file that opens them as one folder each.
 *
 * @param {readonly string[]} fixtures the fixtures' folder names, in the workspace's order
 * @param {Record<string, Record<string, string>>} [extra] files to add to a copy, by fixture
 *   name and then by path inside it
 * @returns {{ root: string, workspaceFile: string }}
 */
export function fixtureWorkspace(fixtures, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-'));
  for (const name of fixtures) {
    const copy = path.join(root, name);
    // pnpm fills a fixture's node_modules with links, which Windows lets only some users make.
    cpSync(path.join(FIXTURES, name), copy, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
    for (const [file, text] of Object.entries(extra[name] ?? {})) {
      mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      writeFileSync(path.join(copy, file), text);
    }
  }
  const workspaceFile = path.join(root, 'fixtures.code-workspace');
  writeFileSync(
    workspaceFile,
    JSON.stringify({ folders: fixtures.map((name) => ({ path: name })) }),
  );
  return { root, workspaceFile };
}
