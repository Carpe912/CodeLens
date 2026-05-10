import * as vscode from 'vscode';
import { RepoRegistry } from '../state';

export class RepoTreeDataProvider implements vscode.TreeDataProvider<RepoTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<RepoTreeItem | undefined | null | void> = new vscode.EventEmitter<RepoTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<RepoTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private repoRegistry: RepoRegistry) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RepoTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RepoTreeItem): Thenable<RepoTreeItem[]> {
    if (!element) {
      // Root level - show all workspaces
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return Promise.resolve([]);
      }

      const items: RepoTreeItem[] = [];
      for (const folder of workspaceFolders) {
        const repoInfo = this.repoRegistry.getRepoInfo(folder.uri.toString());
        if (repoInfo) {
          items.push(new RepoTreeItem(
            folder.name,
            repoInfo.repoName,
            repoInfo.status,
            repoInfo.repoId
          ));
        } else {
          // Show workspace that hasn't been indexed yet
          items.push(new RepoTreeItem(
            folder.name,
            '未索引',
            'not-indexed',
            0
          ));
        }
      }

      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }
}

class RepoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceName: string,
    public readonly repoName: string,
    public readonly status: string,
    public readonly repoId: number
  ) {
    super(workspaceName, vscode.TreeItemCollapsibleState.None);

    this.tooltip = `仓库: ${repoName}\n状态: ${status}\nID: ${repoId}`;
    this.description = `${repoName} (${status})`;

    // Set icon based on status
    if (status === 'ready') {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
    } else if (status === 'indexing') {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('testing.iconQueued'));
    } else if (status === 'failed') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    } else if (status === 'not-indexed') {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
      this.command = {
        command: 'codelens.indexWorkspace',
        title: '索引工作区',
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('database');
    }
  }
}
