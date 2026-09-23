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
  pool, multiStrategySearch, agent, getGraph,
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
// 跨轮会话记忆：读最近 N 轮 / 写本轮 / 压缩成提示词上下文
import {
  loadRecentTurns,
  appendTurn,
  formatConversationContext,
  normalizeSessionId,
} from '../../agent/conversation-memory.js';
// 答案 ↔ 证据一致性自检（只观测，不改写答案）
import { checkAnswerConsistency, describeConsistencyIssue } from '../../llm/answer-consistency.js';

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
 * 2. 若带 sessionId：读取该会话此前轮次，压缩成上下文
 * 3. 根据查询类型选择搜索策略（URL/多策略/增强/默认）
 * 4. 搜索相关代码片段作为证据
 * 5. 获取相似历史问题的反馈
 * 6. 使用 LLM 生成答案
 * 7. 做一次「答案引用的文件行号是否在本轮证据里」自检
 * 8. 保存问答记录到数据库（questions）+ 追加会话轮次（agent_conversations）
 * 9. 缓存结果（仅无会话态的请求）
 *
 * 搜索策略：
 * - URL 搜索：针对 URL 格式的查询
 * - 多策略搜索：结合向量、精确匹配、依赖分析
 * - 增强搜索：使用查询改写和重排序
 * - 默认搜索：语义向量搜索
 *
 * ============================================
 * 跨轮会话记忆（sessionId）
 * ============================================
 * 传入 `sessionId` 即开启会话态：链路会读回该会话此前轮次，注入提示词，
 * 使用户可以说「那它呢？」「再往下看一层」这类依赖上文的追问。
 * 不传则行为与开启前**完全一致**（无记忆读写、走缓存）。
 *
 * ⚠️ 会话态会**跳过缓存**。原因见下方 cacheKey 处的注释：
 * 缓存键不含会话历史，命中它会让第 3 轮拿到第 1 轮的答案。
 *
 * @body repoId - 仓库 ID（必需）
 * @body query - 用户问题（必需）
 * @body enhanced - 是否使用增强搜索（可选，默认 true）
 * @body strategy - 搜索策略（可选，默认 'enhanced'）
 * @body sessionId - 会话 ID（可选；传入即启用跨轮记忆）
 *
 * @returns {
 *   questionId: number,
 *   query: string,
 *   answer: string,
 *   evidence: Array<CodeChunk>,
 *   historicalFeedback?: Array<Feedback>,
 *   enhanced: boolean,
 *   strategy: string,
 *   consistency: ConsistencyReport,   // 答案↔证据自检报告
 *   memory?: {                       // 仅提供 sessionId 时出现
 *     sessionId: string,
 *     turnsUsed: number,
 *     loadError?: string,
 *     writeError?: string
 *   }
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 404 - 仓库不存在
 */
app.post<{
  Body: {
    repoId: number;
    query: string;
    enhanced?: boolean;
    strategy?: string;
    sessionId?: string;
  };
}>('/ask', async (request, reply) => {
  const {
    repoId,
    query,
    enhanced = true,
    strategy = 'enhanced',
    sessionId: rawSessionId,
  } = request.body;

  if (!repoId || !query) {
    return reply.code(400).send({ error: 'Missing repoId or query' });
  }

  // 验证仓库是否存在
  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  // 规范化会话 ID：非字符串 / 空白 / 超长都会被处理；为 null 表示本次无会话态。
  // 裁剪长度是必要的 —— 该值直接进 `VARCHAR(128)` 与索引，不能由客户端无限撑大。
  const sessionId = normalizeSessionId(rawSessionId);
  const startedAt = Date.now();

  /**
   * 会话记忆使用情况。只在提供 sessionId 时返回，让「记忆到底有没有生效」
   * 成为一个可观测字段，而不是需要去猜的隐式行为。
   * 读/写失败分别记在 loadError / writeError 上（失败不阻断回答）。
   */
  const memory = sessionId
    ? ({ sessionId, turnsUsed: 0 } as {
        sessionId: string;
        turnsUsed: number;
        loadError?: string;
        writeError?: string;
      })
    : undefined;

  // 先检查缓存
  const cacheKey = generateCacheKey('ask', repoId.toString(), query, enhanced.toString(), strategy);

  // ⚠️ 会话态必须绕过缓存。
  // 缓存键是 (repoId, query, enhanced, strategy)，**不含会话历史**；而会话态下
  // 同一个问题在第 1 轮和第 3 轮的正确答案是**不同的**（第 3 轮要结合上文）。
  // 键相同 ⇒ 第 3 轮会直接命中第 1 轮的缓存，返回一个「无视上文」的答案，
  // 且响应里看不出任何异常 —— 表现为「会话记忆时灵时不灵」，极难定位。
  // 会话态本就是少数请求，这里宁可多花一次 LLM 调用换取正确性。
  if (!sessionId) {
    const cached = searchTTLCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // 读取该会话此前轮次（有 sessionId 时）。注意时序：
  // 必须在写入本轮之前读，否则本轮问题会作为「历史」被注入给自己，
  // 模型会看到同一个问题出现两次。
  let conversationContext = '';
  if (sessionId && memory) {
    const loaded = await loadRecentTurns(pool, repoId, sessionId);
    if (loaded.ok) {
      memory.turnsUsed = loaded.turns.length;
      conversationContext = formatConversationContext(loaded.turns);
      console.log(
        `[ask] session ${sessionId}: 注入历史 ${loaded.turns.length} 轮` +
          `（上下文 ${conversationContext.length} 字符）`
      );
    } else {
      // 读失败不阻断回答，但**不能静默** —— 否则「记忆没生效」永远没人发现
      memory.loadError = loaded.error;
      console.error(`[ask] 会话记忆读取失败 (session=${sessionId}): ${loaded.error}`);
    }
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

    // 集合类问题同样记入会话：否则用户接着问「那第 3 个呢」时，
    // 会话里会缺一轮，模型看到的上下文是**不连续**的 —— 那比没有上下文更误导。
    // 由 formatConversationContext 在读取侧做长度截断（清单可能上百行）。
    if (sessionId && memory) {
      try {
        await appendTurn(pool, {
          repoId,
          sessionId,
          query,
          answer,
          executionTimeMs: Date.now() - startedAt,
        });
      } catch (error: any) {
        memory.writeError = error?.message || String(error);
        console.error(`[ask] 会话记忆写入失败 (session=${sessionId}):`, error);
      }
    }

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
      // 会话记忆使用情况；未提供 sessionId 时为 undefined。
      // 这一支的答案由代码按 url_patterns 拼装，引用天然真实，
      // 因此不做答案↔证据自检（没有可核验的 LLM 引用）。
      memory,
    };

    if (!sessionId) {
      searchTTLCache.set(cacheKey, enumResult);
    }
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
    const multiSearch = new MultiStrategySearch(pool);
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

  // 使用 LLM 生成答案。
  // 第 5 个参数是会话上下文（无会话态时为空串，提示词与开启前逐字一致）。
  // 第 4 个参数 `useExtendedContext` 显式传 true，与默认值相同，仅为可读性。
  const answer = await answerQuestion(query, evidence, historicalFeedback, true, conversationContext);

  // 答案 ↔ 证据一致性自检。
  // 提示词要求模型「给出具体的文件路径和行号」，而编造出来的引用在形式上
  // 与真实引用完全一样（甚至更像模像样）—— 这里把对不上的挑出来放进响应，
  // 让前端/评测脚本有机会提示「该引用不在本次检索到的证据中」。
  // 只报告、不改写答案（改写会把「编了行号」变成「没有行号」，把问题藏起来）。
  const consistency = checkAnswerConsistency(answer, evidence as any);
  const consistencyWarning = describeConsistencyIssue(consistency, '[ask]');
  if (consistencyWarning) console.warn(consistencyWarning);

  // 保存问答记录到数据库
  const questionResult = await pool.query(
    'INSERT INTO questions (repo_id, query, answer, evidence_ids) VALUES ($1, $2, $3, $4) RETURNING id',
    [repoId, query, answer, evidence.map((e: any) => e.id)]
  );

  const questionId = questionResult.rows[0].id;

  // 追加本轮到会话（在生成之后写入，保证存的是最终答案）
  if (sessionId && memory) {
    try {
      await appendTurn(pool, {
        repoId,
        sessionId,
        query,
        answer,
        executionTimeMs: Date.now() - startedAt,
      });
    } catch (error: any) {
      memory.writeError = error?.message || String(error);
      console.error(`[ask] 会话记忆写入失败 (session=${sessionId}):`, error);
    }
  }

  const result = {
    questionId,
    query,
    answer,
    evidence,
    historicalFeedback: historicalFeedback.length > 0 ? historicalFeedback : undefined,
    enhanced,
    strategy,
    consistency,
    // 未提供 sessionId 时为 undefined（字段存在但为空，便于前端做统一判断）
    memory,
  };

  // 缓存结果（仅无会话态；会话态的答案依赖历史，缓存键表达不了这层依赖）
  if (!sessionId) {
    searchTTLCache.set(cacheKey, result);
  }

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
 *   strategy: string,
 *   consistency: ConsistencyReport   // 答案↔证据自检报告
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
    const multiSearch = new MultiStrategySearch(pool);
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

  // 与 `/ask` 同源的答案↔证据自检：根因分析的提示词同样要求
  // 「给出具体的文件路径和行号」，因此也有编造引用的风险。
  const consistency = checkAnswerConsistency(rootCause, evidence as any);
  const consistencyWarning = describeConsistencyIssue(consistency, '[root-cause]');
  if (consistencyWarning) console.warn(consistencyWarning);

  return {
    query,
    rootCause,
    evidence,
    enhanced,
    strategy,
    consistency,
  };
});

}
