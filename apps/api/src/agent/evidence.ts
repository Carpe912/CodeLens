/**
 * Agent 证据的**统一形状与转换**。
 *
 * 存在的理由：同一个「检索结果 → 证据」映射此前散在多处
 * （/ask 路由、图节点、AgentCore 各自写一遍），字段名与兜底值各写各的。
 * 三方一旦漂移，最先坏的不是编译，而是**跨路径的一致性**：
 * 提示词（llm/qa.ts）与引用自检（llm/answer-consistency.ts）都按字段名取数，
 * 某条链路少填一个 `file_path`，那条链路的引用校验就会静默失效
 * （`checkAnswerConsistency` 会滤掉没有 file_path 的证据，判定退化成 empty_evidence）。
 *
 * 所以这里定死两件事：
 * 1. **内部流通**一律用 `EvidenceRecord`（snake_case，与 `CodeChunkRecord` 同形）
 * 2. **对外响应**（`/agent/query` 的 evidence 数组）用 `toResponseEvidence` 转成展示形状
 */

import type { CodeChunkRecord } from '../db/index.js';
import type { SearchResult } from '../retrieval/multi-strategy-search.js';
import type { Evidence } from './types.js';

/**
 * Agent 内部流通的证据记录。
 *
 * = `CodeChunkRecord`（数据库、提示词、引用自检共同认的形状）
 *   + `file_path`（检索层给出，DB 记录里没有）
 *   + `score`（相关性，只有检索层有）
 */
export type EvidenceRecord = CodeChunkRecord & {
  /** 文件路径，由 MultiStrategySearch 提供（CodeChunkRecord 本身不含） */
  file_path: string;
  /** 相关性评分，来自检索层 */
  score: number;
};

/**
 * 检索结果 → 证据记录。
 *
 * 关于 `id` / `file_id` / `symbol_type` 的兜底值：检索结果不带完整字段，
 * 而 `CodeChunkRecord` 要求它们存在。这里的取值与 `/ask` 路由、
 * 图节点此前的写法逐字段一致，不是为了让类型检查通过而随手填的。
 */
export function toEvidenceRecord(r: SearchResult): EvidenceRecord {
  return {
    // SearchResult.id 形如 "table:123"，取数字部分；取不到时回退 0
    id: parseInt(r.id.split(':')[1], 10) || 0,
    file_id: 0,
    symbol_name: r.context?.symbolName || '',
    symbol_type: r.type || 'unknown',
    line_start: r.lineStart,
    line_end: r.lineEnd,
    code_text: r.content,
    file_path: r.filePath,
    score: r.score,
  };
}

/**
 * 证据记录 → `/agent/query` 响应里的展示形状。
 *
 * `source` 是给人看的（路径与行号拼成串，历史契约，不要改成别的格式）；
 * 结构化字段一并保留，因为引用自检要用 `file_path` / `line_start`。
 * 也就是说 `source` 是冗余的展示副本，**不要**去解析它。
 */
export function toResponseEvidence(e: EvidenceRecord): Evidence {
  return {
    type: 'code',
    source: `${e.file_path}:${e.line_start}`,
    content: e.code_text,
    relevance: e.score,
    file_path: e.file_path,
    line_start: e.line_start,
    line_end: e.line_end,
  };
}

/**
 * 答案生成函数的签名（可注入）。
 *
 * 图（`agent/graph`）与 `AgentCore` 共用同一签名，所以桩件可以互相复用 ——
 * 这是两条链路都能在**不依赖 LLM 和数据库**的前提下被验证的前提。
 */
export type GenerateAnswerFn = (
  query: string,
  evidence: EvidenceRecord[]
) => Promise<string>;
