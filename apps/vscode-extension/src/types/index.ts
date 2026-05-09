export interface RepoInfo {
  repoId: number;
  repoName: string;
  status: 'ready' | 'indexing' | 'failed';
}

export interface CreateRepoResponse {
  repoId: number;
  status: string;
}

export interface ProgressResponse {
  status: 'ready' | 'indexing' | 'failed';
  progress?: {
    total: number;
    processed: number;
    percentComplete: number;
    estimatedTimeRemaining?: number;
    phase?: 'basic' | 'enhanced';
  };
}

export interface SearchResult {
  id: number;
  filePath: string;
  symbolName: string;
  symbolType: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  similarity?: number;
}

export interface QAResponse {
  answer: string;
  evidence: SearchResult[];
  confidence?: number;
}

export interface CallGraphNode {
  symbolName: string;
  filePath: string;
  lineStart: number;
  symbolType: string;
}

export interface CallGraphResponse {
  target: CallGraphNode;
  calledBy: CallGraphNode[];
  calls: CallGraphNode[];
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
  timeout?: number;
}
