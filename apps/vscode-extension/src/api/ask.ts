import { CodeLensAPIClient } from './client';
import { QAResponse } from '../types';

export class AskAPI {
  constructor(private client: CodeLensAPIClient) {}

  async ask(repoId: number, query: string, enhanced: boolean = true): Promise<QAResponse> {
    console.log('[AskAPI] Sending ask request:', { repoId, query, enhanced });
    return this.client.request<QAResponse>('/ask', {
      method: 'POST',
      body: { repoId, query, enhanced },
      timeout: 120000, // 2 minutes for AI responses
    });
  }

  async analyzeRootCause(repoId: number, query: string): Promise<QAResponse> {
    console.log('[AskAPI] Sending root cause request:', { repoId, query });
    return this.client.request<QAResponse>('/root-cause', {
      method: 'POST',
      body: { repoId, query },
      timeout: 120000, // 2 minutes for AI responses
    });
  }
}
