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
    await vscode.commands.executeCommand('setContext', 'codelens.hasUnmatchedWorkspace', this.lastMatchResult.matched < this.lastMatchResult.total);
    this._onDidChangeTreeData.fire();
  }

  async matchCurrentWorkspace(): Promise<RepoMatchResult> {
    this.lastMatchResult = await this.syncFromRemote();
    await vscode.commands.executeCommand('setContext', 'codelens.hasUnmatchedWorkspace', this.lastMatchResult.matched < this.lastMatchResult.total);
    this._onDidChangeTreeData.fire();
    return this.lastMatchResult;
  }

  private normalizeName(value: string): string {
    return path.basename(value.trim().replace(/\/+$/g, '')).replace(/\.(git|zip)$/i, '').toLowerCase();
  }

  private async syncFromRemote(): Promise<RepoMatchResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      console.log('[RepoTreeDataProvider] No workspace folders found');
      return { matched: 0, total: 0 };
    }

    let matched = 0;

    try {
      console.log('[RepoTreeDataProvider] Fetching remote repos...');
      const remoteRepos = await this.apiService.repos.listRepos();
      console.log('[RepoTreeDataProvider] Remote repos:', remoteRepos.map(r => ({ id: r.id, name: r.name, status: r.status })));

      for (const folder of workspaceFolders) {
        const folderCandidates = new Set([
          folder.name,
          path.basename(folder.uri.fsPath),
          this.normalizeName(folder.name),
          this.normalizeName(folder.uri.fsPath),
        ].filter(Boolean));

        console.log('[RepoTreeDataProvider] Matching workspace folder:', folder.name);
        console.log('[RepoTreeDataProvider] Folder candidates:', Array.from(folderCandidates));

        const matchedRepo = remoteRepos.find((repo) => {
          const repoCandidates = new Set([
            repo.name,
            path.basename(repo.name),
            this.normalizeName(repo.name),
            this.normalizeName(repo.gitlab_url || ''),
          ].filter(Boolean));

          console.log('[RepoTreeDataProvider] Checking repo:', repo.name, 'candidates:', Array.from(repoCandidates));

          for (const candidate of folderCandidates) {
            if (repoCandidates.has(candidate)) {
              console.log('[RepoTreeDataProvider] Match found! Candidate:', candidate);
              return true;
            }
          }

          return false;
        });

        if (matchedRepo) {
          console.log('[RepoTreeDataProvider] Matched repo:', matchedRepo.name, 'id:', matchedRepo.id);
          matched += 1;
          const progress = await this.apiService.repos.getProgress(matchedRepo.id).catch(() => null);
          this.repoRegistry.registerRepo(folder.uri.toString(), matchedRepo.id, matchedRepo.name, {
            status: progress?.status || matchedRepo.status,
            totalFiles: progress?.progress?.total,
            processedFiles: progress?.progress?.processed,
            percentComplete: progress?.progress?.percentComplete,
          });
          this.repoRegistry.updateStatus(folder.uri.toString(), progress?.status || matchedRepo.status);

          // Notify search view about repo status change
          const status = progress?.status || matchedRepo.status;
          if (status === 'ready') {
            vscode.commands.executeCommand('codelens.notifySearchViewRepoReady');
          }
        } else {
          console.log('[RepoTreeDataProvider] No match found for workspace folder:', folder.name);
        }
      }
    } catch (error) {
      console.error('[RepoTreeDataProvider] Failed to sync from remote:', error);
    }

    console.log('[RepoTreeDataProvider] Match result:', { matched, total: workspaceFolders.length });
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
    public readonly percentComplete?: number
  ) {
    super(workspaceName, vscode.TreeItemCollapsibleState.None);

    const metrics = [
      typeof totalFiles === 'number' ? `文件 ${processedFiles ?? 0}/${totalFiles}` : undefined,
      typeof percentComplete === 'number' ? `进度 ${percentComplete}%` : undefined,
    ].filter(Boolean).join(' · ');

    this.tooltip = `仓库: ${repoName}\n状态: ${status}\nID: ${repoId}${metrics ? `\n${metrics}` : ''}`;
    this.description = metrics ? `${repoName} (${status}) · ${metrics}` : `${repoName} (${status})`;

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
