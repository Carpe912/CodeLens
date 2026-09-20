/**
 * 调用树相关的共享类型
 *
 * 后端两个接口（/symbol-call-tree 与 /query-call-tree 里的 tree 字段）返回**同一个树形状**，
 * 因此前端只维护一份类型，避免两边字段漂移。
 * 对应后端 apps/api/src/analysis/symbol-call-tree.ts 的 SymbolTreeNode。
 */

export interface CallTreeNode {
  key: string;
  symbol: string;
  symbolType: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  chunkId: number | null;
  /** 这条边在「调用方」的哪一行发生 */
  callLine: number | null;
  resolved: boolean;
  ambiguous: boolean;
  candidateCount: number;
  candidates?: Array<{ filePath: string; lineStart: number | null }>;
  cyclic: boolean;
  truncated: boolean;
  codeText: string;
  children: CallTreeNode[];
}

export interface CallTreeStats {
  callersNodes: number;
  calleesNodes: number;
  totalNodes: number;
  resolvedEdges: number;
  unresolvedEdges: number;
  ambiguousNodes: number;
  selfLoopEdgesFiltered: number;
  cyclesDetected: number;
  truncated: boolean;
  maxDepth: number;
}

export interface CallTreeWarning {
  code: string;
  message: string;
}

/** 可被 SymbolTreeView 直接渲染的载荷 */
export interface CallTreePayload {
  root: CallTreeNode | null;
  callers: CallTreeNode[];
  callees: CallTreeNode[];
  stats: CallTreeStats;
  warnings: CallTreeWarning[];
}

export type CallDirection = 'callers' | 'callees' | 'both';

/** POST /query-call-tree 的返回 */
export interface QueryCallTreeResponse {
  repoId: number;
  query: string;
  intent: {
    direction: CallDirection;
    level: 'symbol' | 'file';
    reason: string;
    tokens: string[];
    matchedBy: 'url-segment' | 'query-token' | 'evidence-top' | 'none';
  };
  root: { symbol: string; filePath: string; lineStart: number; chunkId: number } | null;
  tree: CallTreePayload | null;
  alternatives: Array<{ symbol: string; filePath: string; lineStart: number; chunkId: number }>;
  warnings: CallTreeWarning[];
}
