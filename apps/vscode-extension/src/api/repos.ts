import { CodeLensAPIClient } from './client';
import { CreateRepoResponse, ProgressResponse } from '../types';
import FormData from 'form-data';
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

    const formData = new FormData();
    formData.append('file', fs.createReadStream(zipPath));

    const response = await fetch(url, {
      method: 'POST',
      body: formData as any,
      headers: formData.getHeaders(),
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
}
