import { CodeLensAPIClient } from './client';
import { CreateRepoResponse, ProgressResponse } from '../types';
import * as fs from 'fs';

export class RepoAPI {
  constructor(private client: CodeLensAPIClient) {}

  async createZipRepo(name: string): Promise<CreateRepoResponse> {
    return this.client.request<CreateRepoResponse>('/repos', {
      method: 'POST',
      body: { name, source: 'zip' },
    });
  }

  async uploadZip(zipPath: string): Promise<CreateRepoResponse> {
    const baseUrl = (this.client as any).baseUrl;
    const url = `${baseUrl}/repos/upload`;

    // Read file as buffer
    const fileBuffer = fs.readFileSync(zipPath);
    const fileName = zipPath.split('/').pop() || 'workspace.zip';

    // Create FormData using native fetch API
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: 'application/zip' });
    formData.append('file', blob, fileName);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${response.status} ${errorText}`);
    }

    return await response.json() as CreateRepoResponse;
  }

  async getProgress(repoId: number): Promise<ProgressResponse> {
    return this.client.request<ProgressResponse>(`/repos/${repoId}/progress`);
  }

  async incrementalIndex(repoId: number, files: string[]): Promise<void> {
    return this.client.request<void>(`/repos/${repoId}/incremental-index`, {
      method: 'POST',
      body: { files },
    });
  }

  async reindex(repoId: number): Promise<void> {
    return this.client.request<void>(`/repos/${repoId}/reindex`, {
      method: 'POST',
    });
  }

  async deleteRepo(repoId: number): Promise<void> {
    return this.client.request<void>(`/repos/${repoId}`, {
      method: 'DELETE',
    });
  }

  /**
   * 检查GitLab仓库是否已索引
   */
  async checkByGitLabUrl(gitlabUrl: string, branch?: string): Promise<{
    exists: boolean;
    hasBaseBranch?: boolean;
    repo?: any;
    baseBranch?: any;
  }> {
    const encodedUrl = encodeURIComponent(gitlabUrl);
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : '';
    return this.client.request(`/repos/check?gitlabUrl=${encodedUrl}${branchParam}`);
  }

  /**
   * 通过仓库名检查是否已索引
   */
  async checkByRepoName(repoName: string): Promise<{
    exists: boolean;
    repos?: any[];
  }> {
    const encodedName = encodeURIComponent(repoName);
    return this.client.request(`/repos/check-by-name?name=${encodedName}`);
  }

  /**
   * 从GitLab创建基础分支索引
   */
  async createFromGitLab(
    gitlabUrl: string,
    gitlabToken?: string,
    branch?: string
  ): Promise<{
    repoId: number;
    status: string;
    branch: string;
  }> {
    return this.client.request('/repos/from-gitlab', {
      method: 'POST',
      body: { gitlabUrl, gitlabToken, branch }
    });
  }

  /**
   * 创建分支增量索引
   */
  async createBranchIndex(
    gitlabUrl: string,
    branch: string,
    gitlabToken?: string
  ): Promise<{
    repoId: number;
    status: string;
    branch: string;
    baseBranch: string;
  }> {
    return this.client.request('/repos/branch-index', {
      method: 'POST',
      body: { gitlabUrl, branch, gitlabToken }
    });
  }
}
