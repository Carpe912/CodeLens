import { CodeLensAPIClient } from './client';
import { RepoAPI } from './repos';
import { SearchAPI } from './search';
import { AskAPI } from './ask';
import { CallGraphAPI } from './callGraph';

export class APIService {
  public client: CodeLensAPIClient;
  public repos: RepoAPI;
  public search: SearchAPI;
  public ask: AskAPI;
  public callGraph: CallGraphAPI;

  constructor(baseUrl?: string) {
    this.client = new CodeLensAPIClient(baseUrl);
    this.repos = new RepoAPI(this.client);
    this.search = new SearchAPI(this.client);
    this.ask = new AskAPI(this.client);
    this.callGraph = new CallGraphAPI(this.client);
  }

  async healthCheck(): Promise<boolean> {
    return this.client.healthCheck();
  }

  updateBaseUrl(url: string) {
    this.client.updateBaseUrl(url);
  }
}

export * from './client';
export * from './repos';
export * from './search';
export * from './ask';
export * from './callGraph';
