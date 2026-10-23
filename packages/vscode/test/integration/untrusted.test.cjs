// @ts-check
/**
 * The extension in a workspace VS Code does not trust: a copy of plain-html holding an
 * `upfly.config.mjs` that leaves a mark at UPFLY_MARK when it runs, and a copy of vite-react
 * with no config. `scripts/untrusted-check.mjs` opens it.
 */
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** @param {number} index */
function folder(index) {
  const found = vscode.workspace.workspaceFolders?.[index];
  assert.ok(found, `workspace folder ${index}`);
  return found;
}

describe('the Upfly extension in a workspace VS Code does not trust', function () {
  this.timeout(180_000);
  /** @type {any} */
  let api;

  before(async () => {
    const extension = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(extension, 'the extension is enabled in Restricted Mode');
    api = await extension.activate();
  });

  it('is in a workspace VS Code does not trust', () => {
    assert.equal(vscode.workspace.isTrusted, false);
  });

  it('does not read a folder whose config would run code, says why, and reads the other', async () => {
    const outcomes = await vscode.commands.executeCommand('upfly.auditWorkspace');
    assert.deepEqual(
      outcomes.map((outcome) => [path.basename(outcome.folder), outcome.kind]),
      [
        ['plain-html', 'unavailable'],
        ['vite-react', 'result'],
      ],
    );
    const plain = api.auditRows().find((/** @type {any} */ entry) => entry.label === 'plain-html');
    assert.equal(
      plain.children[0].label,
      'This workspace is not trusted, and reading upfly.config.mjs would run code from the project. Trust the workspace to let Upfly read this folder.',
    );
  });

  it('does not search that folder for an image either', async () => {
    const image = vscode.Uri.joinPath(folder(0).uri, 'images', 'logo.png');
    const outcome = await vscode.commands.executeCommand('upfly.whereUsed', image);
    assert.equal(outcome.kind, 'unavailable');
  });

  it('never ran the config', () => {
    assert.equal(existsSync(String(process.env.UPFLY_MARK)), false);
  });
});
