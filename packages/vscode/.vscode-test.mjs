// @ts-check
/**
 * The integration tests' configuration for `vscode-test`. `extension` runs them on the
 * extension from this checkout; `package` runs the same tests on a built package, installed
 * into the test's VS Code, when UPFLY_VSIX names one. UPFLY_VSCODE_VERSION picks the VS Code
 * version (the current release by default), and UPFLY_VSCODE_EXECUTABLE an installation
 * already on disk.
 */
import { defineConfig } from '@vscode/test-cli';
import { fixtureWorkspace } from './test/integration/workspace.mjs';

const { workspaceFile } = fixtureWorkspace(['vite-react', 'plain-html']);
const executable = process.env.UPFLY_VSCODE_EXECUTABLE;
const vsix = process.env.UPFLY_VSIX;

/** @type {import('@vscode/test-cli').TestConfiguration} */
const common = {
  files: 'test/integration/extension.test.cjs',
  workspaceFolder: workspaceFile,
  mocha: { ui: 'bdd', timeout: 180_000 },
  ...(executable === undefined
    ? { version: process.env.UPFLY_VSCODE_VERSION ?? 'stable' }
    : { useInstallation: { fromPath: executable } }),
};

export default defineConfig([
  { ...common, label: 'extension', launchArgs: ['--disable-extensions'] },
  ...(vsix === undefined
    ? []
    : [
        {
          ...common,
          label: 'package',
          extensionDevelopmentPath: 'test/integration/driver',
          installExtensions: [vsix],
          env: { UPFLY_PACKAGE: '1' },
        },
      ]),
]);
