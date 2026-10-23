// @ts-check
/**
 * The extension in a real VS Code, on a workspace of two fixture copies made outside the
 * checkout: vite-react, then plain-html. The same tests run on the extension from the checkout
 * and on a built package installed into the test's VS Code, which UPFLY_PACKAGE says.
 */
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const PACKAGED = process.env.UPFLY_PACKAGE === '1';

/** @param {readonly any[]} rows @param {string} label */
function row(rows, label) {
  const found = rows.find((entry) => entry.label.startsWith(label));
  assert.ok(
    found,
    `a row starting "${label}" among ${rows.map((entry) => entry.label).join(', ')}`,
  );
  return found;
}

/** @param {number} index */
function folder(index) {
  const found = vscode.workspace.workspaceFolders?.[index];
  assert.ok(found, `workspace folder ${index}`);
  return found;
}

describe('the Upfly extension', function () {
  this.timeout(180_000);
  /** @type {any} */
  let api;
  /** @type {vscode.Extension<any>} */
  let extension;

  before(async () => {
    const found = vscode.extensions.getExtension('ramin.upfly-vscode');
    assert.ok(found, 'the extension is there');
    extension = found;
    api = await extension.activate();
  });

  it(PACKAGED
    ? 'is the installed package, with the CLI it carries'
    : 'runs from the checkout', () => {
    const carried = path.join(
      extension.extensionPath,
      'engine',
      'node_modules',
      'upfly',
      'bin',
      'upfly.cjs',
    );
    assert.equal(existsSync(carried), PACKAGED);
  });

  it("runs the CLI on the editor's own Node.js", async () => {
    const engine = await api.engine();
    // The line CI prints is the measurement of which Node.js each editor carries.
    console.log(
      `    VS Code ${vscode.version}: extension host Node.js ${process.versions.node}, Electron ${process.versions.electron}, ${process.platform}-${process.arch}; upfly ${engine.cli}`,
    );
    assert.equal(engine.node?.kind, 'editor');
    assert.equal(engine.node?.version, process.versions.node);
  });

  it('audits each workspace folder in a run of its own', async () => {
    const outcomes = await vscode.commands.executeCommand('upfly.auditWorkspace');
    assert.deepEqual(
      outcomes.map((outcome) => [path.basename(outcome.folder), outcome.kind]),
      [
        ['vite-react', 'result'],
        ['plain-html', 'result'],
      ],
    );
  });

  it('shows each folder in the audit view with its images and findings', () => {
    const rows = api.auditRows();
    assert.deepEqual(
      rows.map((entry) => entry.label),
      ['vite-react', 'plain-html'],
    );
    const plain = row(rows, 'plain-html').children;
    assert.match(row(plain, '11 images').description, /in use$/);
    assert.equal(
      row(plain, 'Broken references').children[0].label,
      'images/missing-on-purpose.png',
    );
    assert.equal(row(plain, 'Possibly unused').children[0].label, 'images/removed.png');
  });

  it('opens a broken reference in its file at its line, the path as written selected', async () => {
    const broken = row(row(api.auditRows(), 'plain-html').children, 'Broken references')
      .children[0];
    await vscode.commands.executeCommand('upfly.openLocation', folder(1).uri, broken.open);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    assert.equal(path.basename(editor.document.uri.fsPath), 'about.html');
    assert.equal(editor.selection.start.line + 1, 10);
    assert.equal(editor.document.getText(editor.selection), 'images/missing-on-purpose.png');
  });

  it('opens the report of one folder as a Markdown document', async () => {
    await vscode.commands.executeCommand('upfly.showReport', folder(1).uri);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    assert.equal(editor.document.uri.scheme, 'upfly-report');
    assert.equal(editor.document.languageId, 'markdown');
    assert.match(editor.document.getText(), /^# Upfly audit: plain-html/);
    assert.match(editor.document.getText(), /`images\/missing-on-purpose\.png` in about\.html:10/);
  });

  it('lists every reference to an image at its file and line, then what optimize would do', async () => {
    const image = vscode.Uri.joinPath(folder(0).uri, 'src', 'assets', 'logo.png');
    const outcome = await vscode.commands.executeCommand('upfly.whereUsed', image);
    assert.equal(outcome.kind, 'result');
    const rows = api.refsRows();
    assert.equal(rows[0].label, 'src/assets/logo.png');
    const references = row(rows, 'References').children;
    assert.equal(references.length, outcome.result.references.length);
    for (const reference of references) assert.match(reference.label, /:\d+$/);
    assert.equal(rows.at(-1).label, 'What optimize would do');
  });

  it("says so when the image is not one Upfly found, with the CLI's exit code", async () => {
    const outcome = await vscode.commands.executeCommand(
      'upfly.whereUsed',
      vscode.Uri.joinPath(folder(0).uri, 'no-such-image.png'),
    );
    assert.equal(outcome.kind, 'stopped');
    assert.equal(api.refsRows()[0].icon, 'warning');
  });

  it('ends the CLI on Cancel, and says each folder was not audited', async () => {
    const started = api.nextRunStarted();
    const running = vscode.commands.executeCommand('upfly.auditWorkspace');
    await started;
    await vscode.commands.executeCommand('upfly.cancel');
    const outcomes = await running;
    assert.deepEqual(
      outcomes.map((outcome) => outcome.kind),
      ['cancelled', 'cancelled'],
    );
    assert.equal(
      row(api.auditRows(), 'vite-react').children[0].label,
      'Not audited: the run was cancelled.',
    );
  });
});
