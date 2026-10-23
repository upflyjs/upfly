import * as vscode from 'vscode';
import type { Location } from './audit-model.js';

const IMAGE = /\.(avif|gif|jpe?g|png|svg|tiff?|webp)$/i;

/**
 * Opens a place a row names: an image in VS Code's own viewer, any other file at its line
 * with the path as written selected. When the line is not known, the first place the path
 * appears is selected; when it does not appear, the file opens at its top.
 *
 * @param folder the workspace folder the location's path is relative to
 * @param location the file, its line, and the text to select
 */
export async function openLocation(folder: vscode.Uri, location: Location): Promise<void> {
  const uri = vscode.Uri.joinPath(folder, ...location.file.split('/'));
  if (IMAGE.test(location.file) && location.line === null) {
    await vscode.commands.executeCommand('vscode.open', uri);
    return;
  }
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    // A file that is not text, such as a database, opens in whatever VS Code uses for it.
    await vscode.commands.executeCommand('vscode.open', uri);
    return;
  }
  const range = rangeFor(document, location);
  await vscode.window.showTextDocument(document, { selection: range, preview: true });
}

function rangeFor(document: vscode.TextDocument, location: Location): vscode.Range {
  const search = location.search;
  if (location.line !== null && location.line <= document.lineCount) {
    const line = document.lineAt(location.line - 1);
    const column = search === undefined ? -1 : line.text.indexOf(search);
    return search === undefined || column === -1
      ? new vscode.Range(line.range.start, line.range.start)
      : new vscode.Range(line.lineNumber, column, line.lineNumber, column + search.length);
  }
  if (search !== undefined) {
    const offset = document.getText().indexOf(search);
    if (offset !== -1) {
      return new vscode.Range(
        document.positionAt(offset),
        document.positionAt(offset + search.length),
      );
    }
  }
  return new vscode.Range(0, 0, 0, 0);
}
