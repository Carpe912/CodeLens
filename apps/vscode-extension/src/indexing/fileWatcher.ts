import * as vscode from 'vscode';
import { APIService } from '../api';
import { RepoRegistry } from '../state';

export class FileWatcher {
  private watcher: vscode.FileSystemWatcher | undefined;
  private pendingFiles: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly debounceDelay = 3000; // 3 seconds

  constructor(
    private apiService: APIService,
    private repoRegistry: RepoRegistry
  ) {}

  start() {
    // Watch for file changes in frontend languages (TypeScript, JavaScript, Vue)
    // Backend only supports frontend code analysis
    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{ts,tsx,js,jsx,vue}'
    );

    this.watcher.onDidChange((uri) => this.onFileChanged(uri));
    this.watcher.onDidCreate((uri) => this.onFileChanged(uri));
    this.watcher.onDidDelete((uri) => this.onFileChanged(uri));
  }

  private onFileChanged(uri: vscode.Uri) {
    // Get workspace folder for this file
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return;
    }

    // Check if workspace is indexed
    const repoInfo = this.repoRegistry.getRepoInfo(workspaceFolder.uri.toString());
    if (!repoInfo || repoInfo.status !== 'ready') {
      return;
    }

    // Add to pending files
    this.pendingFiles.add(uri.fsPath);
    this.scheduleUpdate();
  }

  private scheduleUpdate() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.performIncrementalUpdate();
    }, this.debounceDelay);
  }

  private async performIncrementalUpdate() {
    if (this.pendingFiles.size === 0) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const repoId = this.repoRegistry.getRepoId(workspaceFolder.uri.toString());
    if (!repoId) {
      return;
    }

    const files = Array.from(this.pendingFiles);
    this.pendingFiles.clear();

    try {
      console.log(`[FileWatcher] Incrementally indexing ${files.length} files`);
      await this.apiService.repos.incrementalIndex(repoId, files);
      console.log(`[FileWatcher] Successfully indexed ${files.length} files`);
    } catch (error: any) {
      console.error('[FileWatcher] Incremental indexing failed:', error);
      // Don't show error to user for background updates
    }
  }

  dispose() {
    this.watcher?.dispose();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }
}
