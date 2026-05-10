import * as vscode from 'vscode';
import { RepoInfo } from '../types';

export class RepoRegistry {
  private repos: Map<string, RepoInfo> = new Map();

  constructor(private context: vscode.ExtensionContext) {
    this.load();
  }

  registerRepo(workspaceUri: string, repoId: number, repoName: string, extras?: Partial<RepoInfo>) {
    this.repos.set(workspaceUri, {
      repoId,
      repoName,
      status: extras?.status || 'indexing',
      totalFiles: extras?.totalFiles,
      processedFiles: extras?.processedFiles,
      percentComplete: extras?.percentComplete,
    });
    this.save();
  }

  getRepoId(workspaceUri: string): number | undefined {
    return this.repos.get(workspaceUri)?.repoId;
  }

  getRepoInfo(workspaceUri: string): RepoInfo | undefined {
    return this.repos.get(workspaceUri);
  }

  updateStatus(workspaceUri: string, status: 'ready' | 'indexing' | 'failed') {
    const repo = this.repos.get(workspaceUri);
    if (repo) {
      repo.status = status;
      this.save();
    }
  }

  removeRepo(workspaceUri: string) {
    this.repos.delete(workspaceUri);
    this.save();
  }

  getAllRepos(): Map<string, RepoInfo> {
    return new Map(this.repos);
  }

  private load() {
    const data = this.context.globalState.get<Record<string, RepoInfo>>('codelens.repos', {});
    this.repos = new Map(Object.entries(data));
  }

  private save() {
    this.context.globalState.update('codelens.repos', Object.fromEntries(this.repos));
  }
}
