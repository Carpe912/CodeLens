import { CodeLensAPIClient } from './client';
import { CallGraphResponse } from '../types';

export class CallGraphAPI {
  constructor(private client: CodeLensAPIClient) {}

  async getCallGraph(repoId: number, symbolName: string): Promise<CallGraphResponse> {
    const encodedSymbol = encodeURIComponent(symbolName);
    return this.client.request<CallGraphResponse>(`/call-graph?repoId=${repoId}&symbolName=${encodedSymbol}`);
  }
}
