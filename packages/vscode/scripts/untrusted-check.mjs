#!/usr/bin/env node
// @ts-check
/**
 * Runs the integration tests for a workspace VS Code does not trust. `@vscode/test-electron`
 * always starts VS Code with `--disable-workspace-trust`, so this starts it the same way but
 * without that flag, with trust's startup question turned off, so the workspace opens in
 * Restricted Mode.
 *
 * Usage: `node scripts/untrusted-check.mjs`, after `node scripts/build.mjs`. As for
 * `.vscode-test.mjs`, UPFLY_VSCODE_EXECUTABLE names an installation on disk, or
 * UPFLY_VSCODE_VERSION a version to download (the current release by default). On Linux, run
 * it under `xvfb-run -a`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { MARKING_CONFIG } from '../test/integration/config-mark.mjs';
import { fixtureWorkspace } from '../test/integration/workspace.mjs';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(PACKAGE, 'test', 'integration');

const executable =
  process.env.UPFLY_VSCODE_EXECUTABLE ??
  (await downloadAndUnzipVSCode(process.env.UPFLY_VSCODE_VERSION ?? 'stable'));
const { root, workspaceFile } = fixtureWorkspace(['plain-html', 'vite-react'], {
  'plain-html': { 'upfly.config.mjs': MARKING_CONFIG },
});
const user = path.join(root, 'user-data');
mkdirSync(path.join(user, 'User'), { recursive: true });
writeFileSync(
  path.join(user, 'User', 'settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'never',
  }),
);

// Set inside VS Code's own terminals, where it would start VS Code as plain Node.js.
const { ELECTRON_RUN_AS_NODE: _, ...inherited } = process.env;
/** @type {NodeJS.ProcessEnv} */
const env = {
  ...inherited,
  UPFLY_TESTS: path.join(TESTS, 'untrusted.test.cjs'),
  UPFLY_MARK: path.join(root, 'config-ran.txt'),
};

const child = spawn(
  executable,
  [
    workspaceFile,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-extensions',
    `--extensionDevelopmentPath=${PACKAGE}`,
    `--extensionTestsPath=${path.join(TESTS, 'mocha-runner.cjs')}`,
    `--user-data-dir=${user}`,
    `--extensions-dir=${path.join(root, 'extensions')}`,
  ],
  { env, stdio: 'inherit' },
);
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
