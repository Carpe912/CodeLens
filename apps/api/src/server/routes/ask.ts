/**
 * 问答与根因分析 路由
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
  isEnumerationQuery, extractMethodFilter, extractPathFilter,
  getUrlInventory, formatInventoryAnswer,
} from '../deps.js';
import type { CodeLensGraph } from '../deps.js';
// 原始数据库行 → 统一出网形状（唯一实现，`/search` 的默认分支也共用它）
import { mapRawChunksToEvidence } from '../evidence-mapper.js';
import type { SearchOptions } from '../../retrieval/multi-strategy-search.js';
// 「这个查询算不算 URL」的唯一实现（`/search` 共用；修掉 /post/123 之类漏判）
import { looksLikeUrlQuery } from '../../retrieval/query-intent-parser.js';

/**
 * 「功能类问题」的检索召回配置（`/ask` 与 `/root-cause` 共用）
 *
 * ============================================
 * ⚠️ 不要退回 `MultiStrategySearch.search()` 的默认值
 * ============================================
 * 默认是 `threshold = 0.5` + `strategies = ['vector','exact','fuzzy']` + `followDependencies=false`。
 * 而 `threshold` 是在 **rerank 之前**过滤合并结果的（`multi-strategy-search.ts:289`），
 * 也就是「精排只能在一个已经被规则打分砍过的池子里重排」——
 * 这违背了该文件 204-206 行**自己写下的**宽召回原则（那里只对 `limit` 做了修正，
 * `threshold` 被漏掉了）。
 *
 * 实测（test-repo，中文提问「登录功能是怎么实现的」）：
 * - 默认配置 → 只剩 **2 条**证据，答案 2153 字
 * - 本配置   → **10 条**证据，答案 3555 字
 *
 * 证据条数是这条链路的头号指标：LLM 只依据证据作答，
 * 证据不足时它只能回答「证据中未体现」——这正是「功能是怎么实现的」最需要证据的场景。
 */
const ASK_RETRIEVAL_OPTIONS: SearchOptions = {
  threshold: 0.3,
  strategies: ['vector', 'exact', 'dependency'],
  includeContext: true,
  followDependencies: true,
};

export async function askRoutes(app: FastifyInstance): Promise<void> {

/**
 * 智能问答端点
 * POST /ask
 *
 * 功能：
 * - 基于代码上下文回答用户问题
 * - 自动搜索相关代码作为证据
 * - 利用历史问答反馈提升答案质量
 * - 支持多种搜索策略
 *
 * 工作流程：
 * 1. 检查缓存，命中则直接返回
 * 2. 根据查询类型选择搜索策略（URL/多策略/增强/默认）
 * 3. 搜索相关代码片段作为证据
 * 4. 获取相似历史问题的反馈
 * 5. 使用 LLM 生成答案
 * 6. 保存问答记录到数据库
 * 7. 缓存结果
 *
 * 搜索策略：
 * - URL 搜索：针对 URL 格式的查询
 * - 多策略搜索：结合向量、精确匹配、依赖分析
 * - 增强搜索：使用查询改写和重排序
 * - 默认搜索：语义向量搜索
 *
 * @body repoId - 仓库 ID（必需）
 * @body query - 用户问题（必需）
 * @body enhanced - 是否使用增强搜索（可选，默认 true）
 * @body strategy - 搜索策略（可选，默认 'enhanced'）
 *
 * @returns {
 *   questionId: number,
 *   query: string,
 *   answer: string,
 *   evidence: Array<CodeChunk>,
 *   historicalFeedback?: Array<Feedback>,
 *   enhanced: boolean,
 *   strategy: string
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 404 - 仓库不存在
 */
app.post<{
  Body: { repoId: number; query: string; enhanced?: boolean; strategy?: string };
}>('/ask', async (request, reply) => {
  const { repoId, query, enhanced = true, strategy = 'enhanced' } = request.body;

  if (!repoId || !query) {
    return reply.code(400).send({ error: 'Missing repoId or query' });
  }

  // 验证仓库是否存在
  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  // 先检查缓存
  const cacheKey = generateCacheKey('ask', repoId.toString(), query, enhanced.toString(), strategy);
  const cached = searchTTLCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // ============================================================
  // 分支 0：集合类问题（「列出所有接口」）→ 走结构化查询，不走检索
  // ============================================================
  // 为什么必须早于检索分支：top-K 只能保证「最相似的 10 条」，
  // **在数学上无法保证完备**。用户问「列出全部」，检索给的是「最像的几条」——
  // 这不是模型不听话，是范式错配。所以这里直接读 `url_patterns`。
  if (isEnumerationQuery(query)) {
    const method = extractMethodFilter(query);
    const q = extractPathFilter(query);
    const inventory = await getUrlInventory(repoId, { method, q });

    console.log(
      `[ask] enumeration: repo ${repoId}${method ? ` method=${method}` : ''}` +
        `${q ? ` q=${q}` : ''} -> ${inventory.rows.length} 条（原始行 ${inventory.total}）`
    );

    // 明细由代码拼装，**不经过 LLM**：让模型「总结 236 条」必然漏行，
    // 而少了几行的清单比没有清单更危险——它看起来是完备的。
    const answer = formatInventoryAnswer(inventory, { method, q });

    const evidence = inventory.rows.slice(0, 20).map((r, index) => ({
      id: index + 1,
      file_id: 0,
      file_path: r.definitionFile ?? '',
      line_start: r.definitionLine ?? 0,
      line_end: r.definitionLine ?? 0,
      content: `${r.method ?? '(未判定)'} ${r.realPath ?? r.pattern}`,
      code_text: r.pattern,
      symbol_name: r.realPath ?? r.pattern,
      symbol_type: 'url_pattern',
      score: 1,
    })) as any;

    const questionResult = await pool.query(
      'INSERT INTO questions (repo_id, query, answer, evidence_ids) VALUES ($1, $2, $3, $4) RETURNING id',
      [repoId, query, answer, evidence.map((e: any) => e.id)]
    );

    const enumResult = {
      questionId: questionResult.rows[0].id,
      query,
      answer,
      evidence,
      enhanced,
      strategy,
      // 区别于检索分支：本体是结构化结果，条数即全集
      structured: true,
      inventory: {
        total: inventory.total,
        distinctInterfaces: inventory.distinctInterfaces,
        byMethod: inventory.byMethod,
        filters: { method: method ?? null, q: q ?? null },
      },
    };

    searchTTLCache.set(cacheKey, enumResult);
    return enumResult;
  }

  let evidence;

  // 检测查询是否为 URL（唯一实现见 query-intent-parser.looksLikeUrlQuery）
  const isURL = looksLikeUrlQuery(query);

  // 对 URL 查询使用专门的 URL 搜索
  if (isURL) {
    console.log('Detected URL query in /ask, using specialized URL search');
    const { searchURL } = await import('../../retrieval/url-search.js');
    const urlResults = await searchURL(pool, repoId, query, 10);

    // 转换为统一格式
    evidence = urlResults.map((result, index) => ({
      id: index + 1,
      file_id: 0,
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      symbol_name: result.context.constantName || '',
      symbol_type: result.type || 'unknown',
      score: result.score,
    })) as any;
  } else if (strategy === 'multi') {
    console.log('Using multi-strategy search for Q&A');
    const searchResults = await multiStrategySearch.search(repoId, query, {
      limit: 10,
      ...ASK_RETRIEVAL_OPTIONS, // 跟踪依赖关系，获取更完整的上下文
    });

    // 转换为统一格式，包含必需字段
    evidence = searchResults.map((result) => ({
      id: parseInt(result.id.split(':')[1]) || 0, // 从 "table:id" 格式提取数字 ID
      file_id: 0, // 占位符
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      symbol_name: result.context.symbolName || '',
      symbol_type: result.type || 'unknown', // 曾经误读 result.metadata?.nodeType —— 该字段全仓从未被赋值，导致恒为 'unknown'
      score: result.score,
    })) as any;
  } else if (enhanced) {
    console.log('Using enhanced search for Q&A');
    // 第二个参数是历史遗留：MultiStrategySearch 内部并不使用 LLM 客户端，
    // 故不再去读某个具体厂商的密钥（换 LLM 厂商时这里会变成空字符串，容易误导）
    const multiSearch = new MultiStrategySearch(pool, '');
    const results = await multiSearch.search(repoId, query, { limit: 10, ...ASK_RETRIEVAL_OPTIONS });
    evidence = results.map((r, index) => ({
      id: index + 1, // 为每个结果生成唯一 ID
      file_id: 0, // 占位符
      file_path: r.filePath,
      line_start: r.lineStart,
      line_end: r.lineEnd,
      content: r.content,
      code_text: r.content,
      symbol_name: r.context.symbolName || '',
      symbol_type: r.type || 'unknown',
      score: r.score,
    })) as any;
  } else {
    // 原始搜索逻辑：语义向量搜索
    const embedding = await generateEmbedding(query);
    evidence = mapRawChunksToEvidence(await searchByEmbedding(repoId, embedding, 10));
  }

  // 获取相似历史问题的反馈（用于改进答案质量）
  const historicalFeedback = await getSimilarQuestionsWithFeedback(repoId, query, 3);

  // 使用 LLM 生成答案
  const answer = await answerQuestion(query, evidence, historicalFeedback);

  // 保存问答记录到数据库
  const questionResult = await pool.query(
    'INSERT INTO questions (repo_id, query, answer, evidence_ids) VALUES ($1, $2, $3, $4) RETURNING id',
    [repoId, query, answer, evidence.map((e: any) => e.id)]
  );

  const questionId = questionResult.rows[0].id;

  const result = {
    questionId,
    query,
    answer,
    evidence,
    historicalFeedback: historicalFeedback.length > 0 ? historicalFeedback : undefined,
    enhanced,
    strategy,
  };

  // 缓存结果
  searchTTLCache.set(cacheKey, result);

  return result;
});


/**
 * 根因分析端点
 * POST /root-cause
 *
 * 功能：
 * - 深度分析代码问题的根本原因
 * - 追踪依赖关系和调用链
 * - 提供更全面的代码上下文
 *
 * 与 /ask 的区别：
 * - /ask: 快速问答，返回 10 个证据
 * - /root-cause: 深度分析，返回 15 个证据，包含更多策略（图分析）
 *
 * 搜索策略：
 * - 多策略模式：向量、精确匹配、模糊匹配、依赖分析、图分析
 * - 跟踪依赖关系：自动展开相关的函数调用和依赖
 * - 更高的证据数量：15 个代码片段
 *
 * 使用场景：
 * - Bug 根因定位
 * - 性能问题分析
 * - 代码逻辑追踪
 * - 复杂问题诊断
 *
 * @body repoId - 仓库 ID（必需）
 * @body query - 问题描述（必需）
 * @body enhanced - 是否使用增强搜索（可选，默认 true）
 * @body strategy - 搜索策略（可选，默认 'enhanced'）
 *
 * @returns {
 *   query: string,
 *   rootCause: string,
 *   evidence: Array<CodeChunk>,
 *   enhanced: boolean,
 *   strategy: string
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 404 - 仓库不存在
 */
app.post<{
  Body: { repoId: number; query: string; enhanced?: boolean; strategy?: string };
}>('/root-cause', async (request, reply) => {
  const { repoId, query, enhanced = true, strategy = 'enhanced' } = request.body;

  if (!repoId || !query) {
    return reply.code(400).send({ error: 'Missing repoId or query' });
  }

  // 验证仓库是否存在
  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  let evidence;

  // 使用多策略搜索进行全面的根因分析
  if (strategy === 'multi') {
    console.log('Using multi-strategy search for root cause analysis');
    const searchResults = await multiStrategySearch.search(repoId, query, {
      limit: 15,
      threshold: 0.3,
      strategies: ['vector', 'exact', 'fuzzy', 'dependency', 'graph'], // 包含图分析
      includeContext: true,
      followDependencies: true, // 跟踪依赖关系
    });

    // 转换为统一格式，包含必需字段
    evidence = searchResults.map((result) => ({
      id: parseInt(result.id.split(':')[1]) || 0, // 从 "table:id" 格式提取数字 ID
      file_id: 0, // 占位符
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      symbol_name: result.context.symbolName || '',
      symbol_type: result.type || 'unknown', // 曾经误读 result.metadata?.nodeType —— 该字段全仓从未被赋值，导致恒为 'unknown'
      score: result.score,
    })) as any;
  } else if (enhanced) {
    console.log('Using enhanced search for root cause analysis');
    // 第二个参数是历史遗留：MultiStrategySearch 内部并不使用 LLM 客户端，
    // 故不再去读某个具体厂商的密钥（换 LLM 厂商时这里会变成空字符串，容易误导）
    const multiSearch = new MultiStrategySearch(pool, '');
    const results = await multiSearch.search(repoId, query, { limit: 15, ...ASK_RETRIEVAL_OPTIONS });
    evidence = results.map((r, index) => ({
      id: index + 1, // 为每个结果生成唯一 ID
      file_id: 0, // 占位符
      file_path: r.filePath,
      line_start: r.lineStart,
      line_end: r.lineEnd,
      content: r.content,
      code_text: r.content,
      symbol_name: r.context.symbolName || '',
      symbol_type: r.type || 'unknown',
      score: r.score,
    })) as any;
  } else {
    // 原始搜索逻辑：语义向量搜索
    const embedding = await generateEmbedding(query);
    evidence = mapRawChunksToEvidence(await searchByEmbedding(repoId, embedding, 15));
  }

  // 使用 LLM 进行根因分析
  const rootCause = await analyzeRootCause(query, evidence);

  return {
    query,
    rootCause,
    evidence,
    enhanced,
    strategy,
  };
});

}
