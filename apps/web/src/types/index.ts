export type Repo = {
  id: number;
  name: string;
  source: 'gitlab' | 'zip';
  status: 'ready' | 'indexing' | 'failed';
  created_at: string;
};

export type IndexProgress = {
  total: number;
  processed: number;
  percentComplete: number;
  estimatedTimeRemaining: number | null;
  startTime: string | null;
  phase?: 'basic' | 'enhanced';
};

export type SearchHit = {
  id: number;
  file_path: string;
  symbol_name: string;
  symbol_type: string;
  line_start: number;
  line_end: number;
  code_text: string;
  similarity?: number;
};

export type QAResponse = {
  questionId?: number;
  query: string;
  answer: string;
  evidence: SearchHit[];
  historicalFeedback?: Array<{
    query: string;
    answer: string;
    feedback: Array<{ feedback_text: string; is_helpful: boolean }>;
  }>;
};

export type SearchHistoryItem = {
  id: string;
  query: string;
  mode: 'search' | 'ask' | 'root-cause';
  timestamp: number;
  repoId: string;
};
