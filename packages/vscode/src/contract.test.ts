/**
 * The runner against the real CLI, started as the extension starts it, on a copy of a fixture
 * outside the workspace: every line it hands on is checked against the schema the CLI
 * publishes for it, and the results build the views without a gap.
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MARKING_CONFIG } from '../test/integration/config-mark.mjs';
import { auditNodes } from './audit-model.js';
import type { AuditResult, RefsResult } from './contract.js';
import { refsNodes } from './refs-model.js';
import { renderReport } from './report.js';
import { type Engine, type RunOutcome, type RunRequest, startRun } from './runner.js';

const CLI = fileURLToPath(new URL('../../cli/', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../fixtures/vite-react/', import.meta.url));

const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addVocabulary(['patternErrorMessage']);
for (const file of readdirSync(path.join(CLI, 'schema'))) {
  ajv.addSchema(JSON.parse(readFileSync(path.join(CLI, 'schema', file), 'utf8')), file);
}

/** The test's own Node.js, standing in for the editor's, running the CLI from the checkout. */
const ENGINE: Engine = {
  node: { kind: 'system', execPath: process.execPath, version: process.versions.node, env: {} },
  cliBin: path.join(CLI, 'bin', 'upfly.cjs'),
};

let project = '';

beforeAll(() => {
  project = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-contract-'));
  cpSync(FIXTURE, project, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

/** Runs a command and checks every line the runner hands on against its schema. */
async function run(request: Omit<RunRequest, 'onProgress' | 'onDiagnostic'>): Promise<RunOutcome> {
  const lines: unknown[] = [];
  const outcome = await startRun(ENGINE, {
    ...request,
    onProgress: (line) => lines.push(line),
    onDiagnostic: (line) => lines.push(line),
  }).outcome;
  if (outcome.kind === 'result') lines.push(outcome.result);
  if (outcome.kind === 'stopped') lines.push(outcome.error);
  for (const line of lines) {
    const { type, command } = line as { type: string; command: string };
    const name = type === 'result' ? `${command}.json` : 'events.json';
    const validate = ajv.getSchema(name);
    if (validate === undefined || !validate(line)) {
      throw new Error(
        `${name}: ${ajv.errorsText(validate?.errors)}\n${JSON.stringify(line).slice(0, 1000)}`,
      );
    }
  }
  return outcome;
}

describe('the runner on the real CLI', () => {
  it("reads an audit's progress and result, each as its schema describes it", async () => {
    const outcome = await run({ command: 'audit', args: [], cwd: project });
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    const result = outcome.result as AuditResult;
    expect(auditNodes(result).find((node) => node.icon === 'file-media')?.label).toBe(
      `${result.report.summary.assets} images`,
    );
    expect(
      renderReport(result, { folder: 'f', path: project, when: 'now', cliVersion: '3' }),
    ).toContain('# Upfly audit: f');
  });

  it("reads one image's references, each as the schema describes them", async () => {
    const outcome = await run({ command: 'refs', args: ['src/assets/logo.png'], cwd: project });
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    const result = outcome.result as RefsResult;
    expect(result.references.length).toBeGreaterThan(0);
    expect(refsNodes(result)[1]?.children?.length).toBe(result.references.length);
  });

  it('ends as stopped, with exit code 2, for an image the project does not have', async () => {
    const outcome = await run({ command: 'refs', args: ['no/such.png'], cwd: project });
    expect(outcome.kind === 'stopped' && outcome.error.exitCode).toBe(2);
  });

  it("ends as stopped, with exit code 3 and the CLI's reason, for the old extension's config", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-v2-'));
    try {
      writeFileSync(path.join(folder, 'upfly.config.json'), '{ "watchTargets": ["public"] }');
      const outcome = await run({ command: 'audit', args: [], cwd: folder });
      expect(outcome.kind === 'stopped' && [outcome.error.exitCode, outcome.error.reason]).toEqual([
        3,
        'V2_EXTENSION_CONFIG',
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('runs a code config when it reads the folder, which is why an untrusted folder holding one is not read', async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upfly-vscode-code-config-'));
    const mark = path.join(folder, 'config-ran.txt');
    try {
      writeFileSync(path.join(folder, 'upfly.config.mjs'), MARKING_CONFIG);
      const marking: Engine = { ...ENGINE, node: { ...ENGINE.node, env: { UPFLY_MARK: mark } } };
      await startRun(marking, { command: 'audit', args: [], cwd: folder }).outcome;
      expect(existsSync(mark)).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
