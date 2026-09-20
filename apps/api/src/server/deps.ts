/**
 * 路由依赖聚合出口（deps）
 *
 * 原 index.ts 是一个单文件，所有处理函数直接闭包引用模块顶层的导入与单例。
 * 拆分成 routes/* 后，各路由模块从本文件一次性取用这些依赖，避免每个文件
 * 重复维护一长串 import，也保证它们拿到的是与拆分前同一批实例。
 */

// —— 数据访问层 ——
export {
  initDatabase,
  createRepo,
  getRepo,
  searchByKeyword,
  searchByEmbedding,
  addQuestionFeedback,
  getQuestionFeedback,
  getSimilarQuestionsWithFeedback,
  clearRepoData,
  deleteRepoChildRows,
  getIndexProgress,
} from '../db/index.js';

// —— 索引任务队列 ——
export {
  enqueueIndexJob,
  enqueueIncrementalIndexJob,
  enqueueRefreshJob,
  enqueueReindexJob,
  enqueueResumeJob,
  startIndexWorker,
} from '../indexing/queue.js';

// —— Git 上游差异：增量更新的「预览」入口 ——
// `getUpstreamStatus` 只做 `fetch`（更新远端引用）+ 本地对比，
// **不动工作区、不动数据库**，所以可以安全地在 HTTP 请求里同步调用。
export {
  getUpstreamStatus,
  assertGitWorkTree,
  redactCredentials,
  type GitFileChange,
  type GitCommit,
  type UpstreamStatus,
} from '../indexing/git-upstream.js';

// —— LLM：向量与问答 ——
export { generateEmbedding } from '../llm/embeddings.js';
export { answerQuestion, analyzeRootCause, classifyQueryType, isEnumerationQuery } from '../llm/qa.js';

// —— URL 接口清单：集合类问题（「列出所有 N 个」）唯一能给出完备答案的出口 ——
// 检索只能给 top-K，这里走结构化查询，条数即全集。
export {
  getUrlInventory,
  expandUrlPattern,
  buildHelperIndex,
  clearHelperIndexCache,
  extractMethodFilter,
  extractPathFilter,
  formatInventoryAnswer,
  classifyUndecidedRow,
  type UrlPatternRow,
  type UrlInventory,
  type UrlInventoryOptions,
  type UndecidedClassification,
  type UndecidedKind,
} from '../analysis/url-inventory.js';

// —— 缓存 ——
export {
  searchTTLCache,
  generateCacheKey,
  getAllCacheStats,
  clearAllCaches,
} from '../cache/index.js';

// —— 检索 ——
export { MultiStrategySearch } from '../retrieval/multi-strategy-search.js';

// —— 影响面分析（基于 file_dependencies / call_graph 的传递闭包）——
export {
  analyzeFileImpact,
  analyzeSymbolImpact,
  resolveSymbolCandidates,
  ImpactError,
  MAX_DEPTH_LIMIT,
  type ImpactReport,
  type AffectedFile,
  type AffectedSymbol,
} from '../analysis/impact.js';

// —— 证据调用树（把 /ask 的 evidence 平铺列表长成调用树）——
export {
  buildEvidenceCallTree,
  CALL_TREE_MAX_DEPTH,
  CALL_TREE_DEFAULT_DEPTH,
  CALL_TREE_MAX_NODES,
  type CallTreeResult,
  type CallTreeNode,
  type CallTreeSymbolInput,
  type CallTreeCaller,
  type CallTreeWarning,
} from '../analysis/evidence-call-tree.js';

// —— 符号调用树（以单个符号为根的双向调用树）——
export {
  buildSymbolCallTree,
  SYMBOL_TREE_MAX_DEPTH,
  SYMBOL_TREE_DEFAULT_DEPTH,
  SYMBOL_TREE_MAX_NODES,
  type SymbolCallTreeResult,
  type SymbolTreeNode,
  type SymbolCallTreeWarning,
} from '../analysis/symbol-call-tree.js';

// —— 提问语义 → 调用关系（从原始提问解析根符号与方向）——
export {
  buildQueryCallTree,
  parseCallIntent,
  extractSymbolTokens,
  type CallDirection,
  type CallIntent,
  type QueryCallTreeResult,
  type ResolvedRoot,
} from '../analysis/query-call-tree.js';

// —— Agent 与编排图 ——
export { AgentCore, getAgentConfig } from '../agent/index.js';
export { createCodeLensGraph, runGraphQuery, type CodeLensGraph } from '../agent/graph/index.js';

// —— 工具 ——
export { normalizeGitLabUrl, extractProjectName, getGitLabDefaultBranch } from '../utils/gitlab.js';

// —— 服务级单例（见 context.ts）——
export { pool, multiStrategySearch, agent, llm, anthropic, anthropicApiKey, getGraph } from './context.js';
