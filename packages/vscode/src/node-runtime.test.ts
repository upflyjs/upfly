import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { type NodeProbe, chooseNode, nodeOnPath } from './node-runtime.js';

// The CLI's own check, as the extension loads it from the CLI it carries.
const { tooOld } = createRequire(import.meta.url)('../../cli/bin/upfly.cjs') as {
  tooOld: (version: string) => string | null;
};

function probe(overrides: Partial<NodeProbe> = {}): NodeProbe {
  return {
    editor: { execPath: '/editor/Code', version: '24.21.0' },
    tooOld,
    onPath: () => [],
    versionOf: async () => null,
    ...overrides,
  };
}

describe('chooseNode', () => {
  it("runs the CLI with the editor's own Node.js when the CLI accepts its version", async () => {
    const choice = await chooseNode(probe());
    expect(choice).toEqual({
      kind: 'found',
      runtime: {
        kind: 'editor',
        execPath: '/editor/Code',
        version: '24.21.0',
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    });
  });

  it("does not look for another Node.js when the editor's own is new enough", async () => {
    const versionOf = vi.fn(async () => '22.0.0');
    await chooseNode(probe({ onPath: () => ['/usr/bin/node'], versionOf }));
    expect(versionOf).not.toHaveBeenCalled();
  });

  it("uses the first Node.js on the PATH the CLI accepts when the editor's is too old", async () => {
    const versions: Record<string, string> = { '/old/node': '20.11.0', '/new/node': '22.12.0' };
    const choice = await chooseNode(
      probe({
        editor: { execPath: '/editor/Code', version: '20.18.3' },
        onPath: () => ['/old/node', '/new/node'],
        versionOf: async (path) => versions[path] ?? null,
      }),
    );
    expect(choice).toEqual({
      kind: 'found',
      runtime: { kind: 'system', execPath: '/new/node', version: '22.12.0', env: {} },
    });
  });

  it('skips a Node.js on the PATH that does not run', async () => {
    const choice = await chooseNode(
      probe({
        editor: { execPath: '/editor/Code', version: '20.18.3' },
        onPath: () => ['/broken/node', '/good/node'],
        versionOf: async (path) => (path === '/good/node' ? '24.11.0' : null),
      }),
    );
    expect(choice.kind === 'found' && choice.runtime.execPath).toBe('/good/node');
  });

  it('says what is needed, and what this editor and the PATH have, when nothing is new enough', async () => {
    const choice = await chooseNode(
      probe({
        editor: { execPath: '/editor/Code', version: '20.18.3' },
        onPath: () => ['/old/node'],
        versionOf: async () => '20.11.0',
      }),
    );
    expect(choice).toEqual({
      kind: 'missing',
      message:
        "Upfly needs Node.js 22.0.0 or later. This editor runs Node.js 20.18.3, and the Node.js on this computer's PATH is 20.11.0. Install Node.js 22.0.0 or later from https://nodejs.org, then run the command again.",
    });
  });

  it('says there is no Node.js on the PATH when there is none', async () => {
    const choice = await chooseNode(
      probe({ editor: { execPath: '/editor/Code', version: '20.18.3' } }),
    );
    expect(choice.kind === 'missing' && choice.message).toContain(
      "and there is no Node.js on this computer's PATH.",
    );
  });
});

describe('nodeOnPath', () => {
  it('lists node.exe in each folder of a Windows PATH, in order, once each', () => {
    const present = new Set(['C:\\nodejs\\node.exe', 'D:\\tools\\node.exe']);
    const found = nodeOnPath(
      { Path: 'C:\\nodejs;;D:\\tools;C:\\nodejs;E:\\empty' },
      'win32',
      (path) => present.has(path),
    );
    expect(found).toEqual(['C:\\nodejs\\node.exe', 'D:\\tools\\node.exe']);
  });

  it('lists node in each folder of a POSIX PATH', () => {
    const found = nodeOnPath(
      { PATH: '/usr/local/bin:/usr/bin' },
      'linux',
      (path) => path === '/usr/bin/node',
    );
    expect(found).toEqual(['/usr/bin/node']);
  });

  it('finds nothing without a PATH', () => {
    expect(nodeOnPath({}, 'darwin', () => true)).toEqual([]);
  });
});
