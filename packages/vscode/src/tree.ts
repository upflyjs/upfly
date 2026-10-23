import * as vscode from 'vscode';
import type { TreeNode } from './audit-model.js';

/** A row in a view, with the workspace folder its paths are relative to. */
export interface ViewNode {
  readonly node: TreeNode;
  readonly folder: vscode.Uri | null;
  readonly children: readonly ViewNode[];
}

/**
 * Wraps rows for a view: each row and its children get the folder their paths are read from.
 *
 * @param nodes the rows
 * @param folder the workspace folder, or null for rows that name no path
 */
export function viewNodes(nodes: readonly TreeNode[], folder: vscode.Uri | null): ViewNode[] {
  return nodes.map((node) => ({ node, folder, children: viewNodes(node.children ?? [], folder) }));
}

/** A tree view over rows that change as a whole whenever a run ends. */
export class NodeTree implements vscode.TreeDataProvider<ViewNode> {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: readonly ViewNode[] = [];

  /** Replaces every row. */
  show(roots: readonly ViewNode[]): void {
    this.roots = roots;
    this.changed.fire(undefined);
  }

  /** The rows shown at the top. */
  get current(): readonly ViewNode[] {
    return this.roots;
  }

  getChildren(element?: ViewNode): ViewNode[] {
    return [...(element === undefined ? this.roots : element.children)];
  }

  getTreeItem(element: ViewNode): vscode.TreeItem {
    const { node, folder } = element;
    const item = new vscode.TreeItem(
      node.label,
      element.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : this.roots.includes(element) && element.children.length <= 20
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    if (node.description !== undefined) item.description = node.description;
    if (node.tooltip !== undefined) item.tooltip = node.tooltip;
    if (node.icon !== undefined) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.open !== undefined && folder !== null) {
      item.command = {
        command: 'upfly.openLocation',
        title: 'Open',
        arguments: [folder, node.open],
      };
    }
    if (node.image !== undefined && folder !== null) {
      item.contextValue = 'upfly.image';
      item.resourceUri = vscode.Uri.joinPath(folder, ...node.image.split('/'));
    }
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
