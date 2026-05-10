import * as vscode from 'vscode';
import * as path from 'path';
import { RepoRegistry } from '../state';
import { APIService } from '../api';

export interface RepoMatchResult {
  matched: number;
  total: number;
}

export class RepoTreeDataProvider implements vscode.TreeDataProvider<RepoTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<RepoTreeItem | undefined | null | void> = new vscode.EventEmitter<RepoTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<RepoTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  private lastMatchResult: RepoMatchResult = { matched: 0, total: 0 };

  constructor(
    private repoRegistry: RepoRegistry,
    private apiService: APIService
  ) {}

  async refresh(): Promise<void> {
    this.lastMatchResult = await this.syncFromRemote();
    this._onDidChangeTreeData.fire();
  }

  async matchCurrentWorkspace(): Promise<RepoMatchResult> {
    this.lastMatchResult = await this.syncFromRemote();
    this._onDidChangeTreeData.fire();
    return this.lastMatchResult;
  }

  private normalizeName(value: string): string {
    return path.basename(value.trim().replace(/\/+$/g, '')).replace(/\.(git|zip)$/i, '').toLowerCase();
  }

  private async syncFromRemote(): Promise<RepoMatchResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return { matched: 0, total: 0 };
    }

    let matched = 0;

    try {
      const remoteRepos = await this.apiService.repos.listRepos();
      for (const folder of workspaceFolders) {
        const folderCandidates = new Set([
          folder.name,
          path.basename(folder.uri.fsPath),
          this.normalizeName(folder.name),
          this.normalizeName(folder.uri.fsPath),
        ].filter(Boolean));

        const matchedRepo = remoteRepos.find((repo) => {
          const repoCandidates = new Set([
            repo.name,
            path.basename(repo.name),
            this.normalizeName(repo.name),
            this.normalizeName(repo.gitlab_url || ''),
          ].filter(Boolean));

          for (const candidate of folderCandidates) {
            if (repoCandidates.has(candidate)) {
              return true;
            }
          }

          return false;
        });

        if (matchedRepo) {
          matched += 1;
          const progress = await this.apiService.repos.getProgress(matchedRepo.id).catch(() => null);
          this.repoRegistry.registerRepo(folder.uri.toString(), matchedRepo.id, matchedRepo.name, {
            status: progress?.status || matchedRepo.status,
            totalFiles: progress?.progress?.total,
            processedFiles: progress?.progress?.processed,
            percentComplete: progress?.progress?.percentComplete,
          });
          this.repoRegistry.updateStatus(folder.uri.toString(), progress?.status || matchedRepo.status);
        }
      }
    } catch (error) {
      console.error('[RepoTreeDataProvider] Failed to sync from remote:', error);
    }

    return { matched, total: workspaceFolders.length };
  }

  getTreeItem(element: RepoTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RepoTreeItem): Thenable<RepoTreeItem[]> {
    if (!element) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return Promise.resolve([]);
      }

      const items: RepoTreeItem[] = [];
      const hasUnmatchedWorkspace = workspaceFolders.some((folder) => !this.repoRegistry.getRepoInfo(folder.uri.toString()));

      if (hasUnmatchedWorkspace) {
        items.push(new RepoTreeItem(
          '手动匹配当前项目',
          '点击以请求远程仓库并执行匹配',
          'match-action',
          0,
          undefined,
          undefined,
          undefined,
          async () => {
            const result = await this.matchCurrentWorkspace();
            if (result.matched > 0) {
              vscode.window.showInformationMessage(`已匹配到 ${result.matched}/${result.total} 个工作区的远程仓库`);
            } else {
              vscode.window.showWarningMessage('没有找到可匹配的远程仓库');
            }
          }
        ));
      }

      for (const folder of workspaceFolders) {
        const repoInfo = this.repoRegistry.getRepoInfo(folder.uri.toString());
        if (repoInfo) {
          items.push(new RepoTreeItem(
            folder.name,
            repoInfo.repoName,
            repoInfo.status,
            repoInfo.repoId,
            repoInfo.totalFiles,
            repoInfo.processedFiles,
            repoInfo.percentComplete
          ));
        } else {
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
    public readonly repoId: number,
    public readonly totalFiles?: number,
    public readonly processedFiles?: number,
    public readonly percentComplete?: number,
    commandHandler?: () => Promise<void>
  ) {
    super(workspaceName, vscode.TreeItemCollapsibleState.None);

    const metrics = [
      typeof totalFiles === 'number' ? `文件 ${processedFiles ?? 0}/${totalFiles}` : undefined,
      typeof percentComplete === 'number' ? `进度 ${percentComplete}%` : undefined,
    ].filter(Boolean).join(' · ');

    this.tooltip = `仓库: ${repoName}\n状态: ${status}\nID: ${repoId}${metrics ? `\n${metrics}` : ''}`;
    this.description = metrics ? `${repoName} (${status}) · ${metrics}` : `${repoName} (${status})`;

    // Set icon based on status
    if (status === 'ready') {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
    } else if (status === 'indexing') {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('testing.iconQueued'));
    } else if (status === 'failed') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    } else if (status === 'match-action') {
      this.iconPath = new vscode.ThemeIcon('search');
      this.command = {
        command: 'codelens.matchWorkspace',
        title: '手动匹配当前项目',
      };
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
