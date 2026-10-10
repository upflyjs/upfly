/**
 * The three packages are released together: one version, one range of Node.js versions, and
 * each depending on the one it runs through the workspace, which packing turns into that exact
 * version. So `upfly-mcp` runs the `upfly` released with it, and `upfly` the `upfly-core`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function manifest(folder: string) {
  return JSON.parse(readFileSync(new URL(`../../${folder}/package.json`, import.meta.url), 'utf8'));
}

describe('upfly-mcp beside upfly and upfly-core', () => {
  it('has their version and their range of Node.js versions', () => {
    const [core, cli, mcp] = ['core', 'cli', 'mcp'].map(manifest);

    expect(cli.version).toBe(core.version);
    expect(mcp.version).toBe(core.version);
    expect(mcp.engines).toEqual(core.engines);
  });

  it('depends on the upfly of its own release, as upfly does on upfly-core', () => {
    expect(manifest('mcp').dependencies.upfly).toBe('workspace:*');
    expect(manifest('cli').dependencies['upfly-core']).toBe('workspace:*');
  });
});
