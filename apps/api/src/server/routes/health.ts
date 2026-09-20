/**
 * 健康检查 路由
 *
 * 由原 src/index.ts（2000+ 行）按领域拆分而来，处理函数体逐字保留，仅把
 * 顶层 `fastify` 换成本插件收到的 `app`。行为与拆分前完全一致。
 */

import type { FastifyInstance } from 'fastify';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  pool, multiStrategySearch, agent, getGraph, anthropicApiKey, anthropic,
  createRepo, getRepo, searchByKeyword, searchByEmbedding,
  addQuestionFeedback, getQuestionFeedback, getSimilarQuestionsWithFeedback,
  clearRepoData, getIndexProgress,
  enqueueIndexJob, enqueueIncrementalIndexJob, enqueueRefreshJob, enqueueReindexJob,
  generateEmbedding, answerQuestion, analyzeRootCause,
  searchTTLCache, generateCacheKey, getAllCacheStats, clearAllCaches,
  MultiStrategySearch, AgentCore, getAgentConfig,
  createCodeLensGraph, runGraphQuery,
  normalizeGitLabUrl, extractProjectName, getGitLabDefaultBranch,
} from '../deps.js';
import type { CodeLensGraph } from '../deps.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {

/**
 * 健康检查端点
 * GET /health
 *
 * 用途：
 * - 服务健康状态检查
 * - 负载均衡器探活
 * - 监控系统心跳检测
 *
 * @returns { ok: true, service: 'codelens-api' }
 */
app.get('/health', async () => {
  return { ok: true, service: 'codelens-api' };
});

}
