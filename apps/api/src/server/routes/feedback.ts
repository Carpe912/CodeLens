/**
 * 问题反馈 路由
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

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {

/**
 * 获取历史问题列表
 * GET /questions
 *
 * 功能：
 * - 返回最近的 50 个问答记录
 * - 按创建时间倒序排列
 *
 * 使用场景：
 * - 查看问答历史
 * - 分析常见问题
 * - 问答质量评估
 *
 * @returns Array<QuestionRecord>
 */
app.get('/questions', async () => {
  const result = await pool.query('SELECT * FROM questions ORDER BY created_at DESC LIMIT 50');
  return result.rows;
});


/**
 * 添加问题反馈
 * POST /questions/feedback
 *
 * 功能：
 * - 为问答添加用户反馈
 * - 标记答案是否有帮助
 * - 用于改进未来的答案质量
 *
 * 反馈机制：
 * - 收集用户对答案的评价
 * - 存储反馈文本和有用性标记
 * - 在生成新答案时参考历史反馈
 *
 * @body questionId - 问题 ID（必需）
 * @body feedbackText - 反馈文本（必需）
 * @body isHelpful - 是否有帮助（必需）
 *
 * @returns {
 *   feedbackId: number,
 *   success: true
 * }
 *
 * @throws 400 - 缺少必需参数
 */
app.post<{
  Body: { questionId: number; feedbackText: string; isHelpful: boolean };
}>('/questions/feedback', async (request, reply) => {
  const { questionId, feedbackText, isHelpful } = request.body;

  if (!questionId || !feedbackText) {
    return reply.code(400).send({ error: 'Missing questionId or feedbackText' });
  }

  const feedbackId = await addQuestionFeedback(questionId, feedbackText, isHelpful);

  return { feedbackId, success: true };
});


/**
 * 获取问题的反馈
 * GET /questions/feedback
 *
 * 功能：
 * - 查询指定问题的所有反馈
 *
 * @query questionId - 问题 ID（必需）
 *
 * @returns {
 *   feedback: Array<Feedback>
 * }
 *
 * @throws 400 - 缺少 questionId 参数
 */
app.get<{
  Querystring: { questionId: string };
}>('/questions/feedback', async (request, reply) => {
  const { questionId } = request.query;

  if (!questionId) {
    return reply.code(400).send({ error: 'Missing questionId' });
  }

  const feedback = await getQuestionFeedback(parseInt(questionId));

  return { feedback };
});

}
