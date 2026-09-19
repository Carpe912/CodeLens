/**
 * 代码搜索 路由
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
// 原始数据库行 → 统一出网形状（唯一实现，`/ask` 也共用它）
import { mapRawChunksToEvidence } from '../evidence-mapper.js';
// 「这个查询算不算 URL」的唯一实现（`/ask` 共用；修掉 /post/123 之类漏判）
import { looksLikeUrlQuery } from '../../retrieval/query-intent-parser.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {

/**
 * 代码搜索端点
 * GET /search
 *
 * 功能：
 * - 支持多种搜索策略（关键词、向量、URL、多策略）
 * - 自动检测查询类型（URL 或普通查询）
 * - 结果缓存以提升性能
 *
 * 搜索策略：
 * 1. URL 搜索：检测到 URL 格式时，使用专门的 URL 搜索
 * 2. 多策略搜索（strategy=multi）：结合向量、精确匹配、模糊匹配、依赖搜索
 * 3. 增强搜索（enhanced=true）：使用查询改写和重排序
 * 4. 默认搜索：关键词搜索 + 语义向量搜索
 *
 * 缓存机制：
 * - 使用 TTL 缓存（15 分钟）
 * - 缓存键包含 repoId、查询、策略等参数
 * - 命中缓存时直接返回，避免重复计算
 *
 * @query repoId - 仓库 ID（必需）
 * @query q - 查询字符串（必需）
 * @query enhanced - 是否使用增强搜索（可选，默认 false）
 * @query strategy - 搜索策略：'default' | 'multi'（可选）
 *
 * @returns {
 *   query: string,
 *   hits: Array<{
 *     id: number,
 *     file_path: string,
 *     line_start: number,
 *     line_end: number,
 *     content: string,
 *     score: number,
 *     symbol_name: string,
 *     metadata: object
 *   }>,
 *   enhanced: boolean,
 *   strategy: string
 * }
 *
 * @throws 400 - 缺少必需参数
 */
app.get<{
  Querystring: { repoId: string; q: string; enhanced?: string; strategy?: string };
}>('/search', async (request, reply) => {
  const { repoId, q, enhanced, strategy } = request.query;

  if (!repoId || !q) {
    return reply.code(400).send({ error: 'Missing repoId or q' });
  }

  // 先检查缓存
  const cacheKey = generateCacheKey('search', repoId, q, enhanced || 'false', strategy || 'default');
  const cached = searchTTLCache.get(cacheKey);
  if (cached) {
    console.log('Search cache hit');
    return cached;
  }

  let unique;

  // 检测查询是否为 URL（唯一实现见 query-intent-parser.looksLikeUrlQuery）
  const isURL = looksLikeUrlQuery(q);

  // 对 URL 查询使用专门的 URL 搜索
  if (isURL) {
    console.log('Detected URL query, using specialized URL search');
    const { searchURL } = await import('../../retrieval/url-search.js');
    // 40 而不是 20：url_patterns 一条接口只有一行，其余出现位置都在 url_usages 里，
    // 一条路径往往同时命中「定义 + 多个调用点 + 路由注册」，20 个位置会被
    // 同文件邻近行占满，把真正的另一半位置（例如 routes/ 里的注册行）截掉。
    const urlResults = await searchURL(pool, parseInt(repoId), q, 40);

    // 转换为统一格式
    unique = urlResults.map((result) => ({
      id: result.id,
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      score: result.score,
      symbol_name: result.context.constantName,
      metadata: result.context,
    }));
  } else if (strategy === 'multi') {
    console.log('Using multi-strategy search (vector + exact + fuzzy + dependency)');
    const searchResults = await multiStrategySearch.search(parseInt(repoId), q, {
      limit: 20,
      threshold: 0.3,
      strategies: ['vector', 'exact', 'fuzzy', 'dependency'],
      includeContext: true,
      followDependencies: false,
    });

    // 转换为统一格式
    // ⚠️ `code_text` 是 web 前端（RepoPage 的代码块）读的字段，`similarity` 是它读的百分比；
    // 之前只给了 `content`，于是 web 上这条分支会渲染出空代码块。
    unique = searchResults.map((result) => ({
      id: result.id,
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      score: result.score,
      similarity: result.score,
      symbol_name: result.context.symbolName,
      symbol_type: result.type || 'unknown',
      metadata: result.metadata,
    }));
  } else if (enhanced === 'true') {
    console.log('Using enhanced search with query rewriting and reranking');
    // 第二个参数是历史遗留：MultiStrategySearch 内部并不使用 LLM 客户端
    const multiSearch = new MultiStrategySearch(pool, '');
    const results = await multiSearch.search(parseInt(repoId), q, { limit: 20 });
    // 曾经这里给的是 `code: r.content` —— 字段名不在任何消费方的契约里
    // （web 读 `code_text`，vscode 扩展读 `content`），于是两边都是空白。
    unique = results.map(r => ({
      id: r.id,
      file_path: r.filePath,
      line_start: r.lineStart,
      line_end: r.lineEnd,
      content: r.content,
      code_text: r.content,
      symbol_name: r.context.symbolName || '',
      symbol_type: r.type || 'unknown',
      score: r.score,
      similarity: r.score,
    }));
  } else {
    // 原始搜索逻辑：关键词搜索 + 语义搜索
    const keywordResults = await searchByKeyword(parseInt(repoId), q);
    const embedding = await generateEmbedding(q);
    const semanticResults = await searchByEmbedding(parseInt(repoId), embedding, 10);

    // 合并结果并去重
    const combined = [...keywordResults, ...semanticResults];
    const deduped = Array.from(new Map(combined.map((item) => [item.id, item])).values()).slice(0, 20);
    // ⚠️ 必须走白名单：这两个搜索函数是 `SELECT c.*` 且直接 `return rows`，
    // 原样出网会带上 1536 维 `embedding`（实测 10 条命中 = 198 KB，URL 分支只有 16.7 KB），
    // 而且缺 `content`（vscode 扩展必填）与 `score`。详见 server/evidence-mapper.ts 的说明。
    unique = mapRawChunksToEvidence(deduped);
  }

  const result = {
    query: q,
    hits: unique,
    enhanced: enhanced === 'true',
    strategy: strategy || 'default',
  };

  // 缓存结果
  searchTTLCache.set(cacheKey, result);

  return result;
});


/**
 * 获取符号的调用图
 * GET /call-graph
 *
 * 功能：
 * - 查询指定符号的调用关系
 * - 返回该符号调用了哪些函数（出边）
 * - 返回哪些函数调用了该符号（入边）
 *
 * 调用图说明：
 * - 出边（calls）：当前符号调用的其他符号
 * - 入边（calledBy）：调用当前符号的其他符号
 * - 用于理解代码的依赖关系和影响范围
 *
 * 使用场景：
 * - 分析函数的调用链
 * - 评估代码变更的影响范围
 * - 理解模块间的依赖关系
 * - 重构时的影响分析
 *
 * @query repoId - 仓库 ID（必需）
 * @query symbolName - 符号名称（必需）
 *
 * @returns {
 *   symbol: {
 *     name: string,
 *     type: string,
 *     file: string
 *   },
 *   calls: Array<{
 *     name: string,
 *     type: string,
 *     file: string
 *   }>,
 *   calledBy: Array<{
 *     name: string,
 *     type: string,
 *     file: string
 *   }>
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 404 - 符号不存在
 * @throws 500 - 查询失败
 */
app.get<{
  Querystring: { repoId: string; symbolName: string };
}>('/call-graph', async (request, reply) => {
  const { repoId, symbolName } = request.query;

  if (!repoId || !symbolName) {
    return reply.code(400).send({ error: 'Missing repoId or symbolName' });
  }

  try {
    // 查找符号
    const symbolResult = await pool.query(
      `SELECT c.id, c.symbol_name, c.symbol_type, f.path as file_path
       FROM code_chunks c
       JOIN files f ON c.file_id = f.id
       WHERE f.repo_id = $1 AND c.symbol_name = $2
       LIMIT 1`,
      [parseInt(repoId), symbolName]
    );

    if (symbolResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Symbol not found' });
    }

    const symbol = symbolResult.rows[0];

    // 获取出边调用（该符号调用了哪些符号）
    const outgoingResult = await pool.query(
      `SELECT DISTINCT cg.to_symbol, c2.symbol_type, f2.path as file_path
       FROM call_graph cg
       LEFT JOIN code_chunks c2 ON c2.symbol_name = cg.to_symbol
       LEFT JOIN files f2 ON c2.file_id = f2.id
       WHERE cg.from_chunk_id = $1 AND f2.repo_id = $2`,
      [symbol.id, parseInt(repoId)]
    );

    // 获取入边调用（哪些符号调用了该符号）
    const incomingResult = await pool.query(
      `SELECT DISTINCT c.symbol_name, c.symbol_type, f.path as file_path
       FROM call_graph cg
       JOIN code_chunks c ON cg.from_chunk_id = c.id
       JOIN files f ON c.file_id = f.id
       WHERE cg.to_symbol = $1 AND f.repo_id = $2`,
      [symbolName, parseInt(repoId)]
    );

    return {
      symbol: {
        name: symbol.symbol_name,
        type: symbol.symbol_type,
        file: symbol.file_path,
      },
      calls: outgoingResult.rows.map((row: any) => ({
        name: row.to_symbol,
        type: row.symbol_type,
        file: row.file_path,
      })),
      calledBy: incomingResult.rows.map((row: any) => ({
        name: row.symbol_name,
        type: row.symbol_type,
        file: row.file_path,
      })),
    };
  } catch (error) {
    console.error('Call graph error:', error);
    return reply.code(500).send({ error: 'Failed to fetch call graph' });
  }
});

}
