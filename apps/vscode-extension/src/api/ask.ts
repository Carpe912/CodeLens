import { CodeLensAPIClient } from './client';
import { QAResponse } from '../types';

export class AskAPI {
  constructor(private client: CodeLensAPIClient) {}

  async ask(repoId: number, query: string, enhanced: boolean = true): Promise<QAResponse> {
    return this.client.request<QAResponse>('/ask', {
      method: 'POST',
      body: { repoId, query, enhanced },
    });
  }

  async analyzeRootCause(repoId: number, query: string): Promise<QAResponse> {
    return this.client.request<QAResponse>('/root-cause', {
      method: 'POST',
      body: { repoId, query },
    });
  }
}
