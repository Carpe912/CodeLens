import { CodeLensAPIClient } from './client';
import { SearchResult } from '../types';

export class SearchAPI {
  constructor(private client: CodeLensAPIClient) {}

  async search(repoId: number, query: string): Promise<SearchResult[]> {
    const encodedQuery = encodeURIComponent(query);
    return this.client.request<SearchResult[]>(`/search?repoId=${repoId}&q=${encodedQuery}`);
  }
}
