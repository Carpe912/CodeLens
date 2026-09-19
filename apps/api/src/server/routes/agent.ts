/**
 * Agent 智能查询 路由
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

export async function agentRoutes(app: FastifyInstance): Promise<void> {

/**
 * Agent 查询端点
 * POST /agent/query
 *
 * 功能：
 * - 支持多轮对话式代码查询
 * - 自动维护会话上下文
 * - 智能理解用户意图
 *
 * Agent 特性：
 * - 上下文感知：记住之前的对话内容
 * - 多步推理：可以分步骤解决复杂问题
 * - 工具调用：自动选择合适的搜索策略
 * - 会话管理：支持多个独立的对话会话
 *
 * 使用场景：
 * - 复杂的代码探索任务
 * - 需要多轮交互的问题
 * - 渐进式的代码理解
 *
 * @body query - 用户查询（必需）
 * @body repoId - 仓库 ID（必需）
 * @body sessionId - 会话 ID（可选，用于继续之前的对话）
 *
 * @returns {
 *   sessionId: string,
 *   response: string,
 *   evidence?: Array<CodeChunk>,
 *   metadata?: object
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 500 - 执行失败
 */
app.post('/agent/query', async (request, reply) => {
  const { query, repoId, sessionId } = request.body as { query: string; repoId: number; sessionId?: string };

  if (!query || !repoId) {
    return reply.code(400).send({ error: 'Missing required fields: query, repoId' });
  }

  try {
    const result = await agent.executeQuery(query, repoId, sessionId);
    return result;
  } catch (error: any) {
    console.error('[Agent] Query error:', error);
    return reply.code(500).send({ error: error.message });
  }
});


/**
 * 图编排查询端点（实验性）
 * POST /agent/v2/query
 *
 * 与 /agent/query 的差别：
 * - /agent/query    → 单轮线性：分类 → 检索一次 → 生成一次
 * - /agent/v2/query → 图编排：  检索 → 评分 → 若证据不足则换策略重检索 → 生成
 *
 * 开关：需设置 AGENT_GRAPH_ENABLED=true。
 * 未开启时返回 404 并附上原因和开启方式，而不是让路由静默消失 ——
 * 这样调用方能区分「功能没开」和「路由写错了」。
 *
 * 旧路由行为完全不受影响，两者可并存对拍。
 *
 * @body query - 用户查询（必需）
 * @body repoId - 仓库 ID（必需）
 * @body sessionId - 会话 ID（可选，同时作为 checkpointer 的 thread_id）
 *
 * @returns {
 *   answer, evidence, confidence, sufficiency,
 *   rounds, strategiesUsed, trace, executionTime, sessionId
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 404 - 功能未开启，或仓库不存在
 * @throws 500 - 执行失败
 */
app.post('/agent/v2/query', async (request, reply) => {
  if (process.env.AGENT_GRAPH_ENABLED !== 'true') {
    return reply.code(404).send({
      error: 'Graph orchestration is disabled',
      hint: 'Set AGENT_GRAPH_ENABLED=true to enable /agent/v2/query. The legacy /agent/query remains available.',
    });
  }

  const { query, repoId, sessionId } = request.body as {
    query: string;
    repoId: number;
    sessionId?: string;
  };

  if (!query || !repoId) {
    return reply.code(400).send({ error: 'Missing required fields: query, repoId' });
  }

  // 与 /ask、/root-cause 一致：仓库不存在时返回 404 而非 500
  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  try {
    const graph = await getGraph();
    const result = await runGraphQuery(graph, { query, repoId, sessionId });
    return result;
  } catch (error: any) {
    console.error('[Graph] Query error:', error);
    return reply.code(500).send({ error: error.message });
  }
});


/**
 * 获取 Agent 会话信息
 * GET /agent/sessions/:sessionId
 *
 * 功能：
 * - 查询指定会话的详细信息
 * - 包含会话状态、创建时间等
 *
 * @param sessionId - 会话 ID
 *
 * @returns Session 对象
 * @throws 404 - 会话不存在
 * @throws 500 - 查询失败
 */
app.get('/agent/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  try {
    const session = await agent.getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return session;
  } catch (error: any) {
    console.error('[Agent] Get session error:', error);
    return reply.code(500).send({ error: error.message });
  }
});


/**
 * 获取 Agent 会话的执行历史
 * GET /agent/sessions/:sessionId/history
 *
 * 功能：
 * - 返回会话中的所有查询和响应历史
 * - 用于回顾对话过程
 *
 * @param sessionId - 会话 ID
 *
 * @returns {
 *   history: Array<{
 *     query: string,
 *     response: string,
 *     timestamp: Date
 *   }>
 * }
 *
 * @throws 500 - 查询失败
 */
app.get('/agent/sessions/:sessionId/history', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  try {
    const history = await agent.getExecutionHistory(sessionId);
    return { history };
  } catch (error: any) {
    console.error('[Agent] Get history error:', error);
    return reply.code(500).send({ error: error.message });
  }
});


/**
 * 获取 Agent 统计信息
 * GET /agent/stats
 *
 * 功能：
 * - 返回 Agent 的运行统计
 * - 包含会话数、查询数等指标
 *
 * 使用场景：
 * - 监控 Agent 使用情况
 * - 性能分析
 * - 使用量统计
 *
 * @returns {
 *   totalSessions: number,
 *   totalQueries: number,
 *   averageResponseTime: number,
 *   ...
 * }
 */
app.get('/agent/stats', async () => {
  try {
    const stats = await agent.getStats();
    return stats;
  } catch (error: any) {
    console.error('[Agent] Get stats error:', error);
    return { error: error.message };
  }
});

}
