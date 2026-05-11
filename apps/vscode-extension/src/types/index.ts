export interface RepoInfo {
  repoId: number;
  repoName: string;
  status: 'ready' | 'indexing' | 'failed';
  totalFiles?: number;
  processedFiles?: number;
  percentComplete?: number;
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
  file_path: string;
  symbol_name: string;
  symbol_type: string;
  line_start: number;
  line_end: number;
  content: string;
  score?: number;
  code_text?: string;
  metadata?: any;
}

export interface QAResponse {
  answer: string;
  evidence: SearchResult[];
  confidence?: number;
}

export interface CallGraphNode {
  symbol_name: string;
  file_path: string;
  line_start: number;
  symbol_type: string;
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
