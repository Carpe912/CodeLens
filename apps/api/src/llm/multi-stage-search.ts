import { pool, type CodeChunkRecord } from '../db/index.js';
import { enhancedSearch } from './enhanced-search.js';
import { rerankResults } from './reranker.js';

/**
 * 多阶段检索：粗召回 → 调用图扩展 → 精细重排
 *
 * 原理：
 * 1. Stage 1: 粗召回 top 50 个相关代码块
 * 2. Stage 2: 基于调用图扩展相关代码（调用者和被调用者）
 * 3. Stage 3: 使用 rerank 精细重排 top 10
 *
 * 适用场景：
 * - Bug 分析（需要看调用链）
 * - 功能理解（需要看上下游）
 * - 代码审查（需要看影响范围）
 */
export async function multiStageSearch(
  repoId: number,
  query: string,
  options: {
    topK?: number;
    expandCallGraph?: boolean;
  } = {}
): Promise<Array<CodeChunkRecord & { file_path?: string; similarity?: number; rerank_score?: number }>> {
  const { topK = 10, expandCallGraph = true } = options;

  console.log('Multi-stage search started');

  // Stage 1: 粗召回（获取更多候选）
  const candidates = await enhancedSearch(repoId, query, {
    useQueryRewrite: true,
    useReranking: false, // 先不 rerank，等扩展后再 rerank
    useHyDE: true,
    topK: 50, // 粗召回 50 个
  });

  console.log(`Stage 1: Retrieved ${candidates.length} candidates`);

  if (!expandCallGraph || candidates.length === 0) {
    // 如果不需要扩展，直接 rerank 返回
    return rerankResults(query, candidates, topK);
  }

  // Stage 2: 基于调用图扩展相关代码
  const expandedChunks = await expandByCallGraph(candidates);
  console.log(`Stage 2: Expanded to ${expandedChunks.length} chunks (including call graph)`);

  // Stage 3: 精细重排
  const finalResults = await rerankResults(query, expandedChunks, topK);
  console.log(`Stage 3: Reranked to top ${finalResults.length} results`);

  return finalResults;
}

/**
 * 基于调用图扩展相关代码
 *
 * 扩展策略：
 * 1. 获取当前代码块调用的函数（callees）
 * 2. 获取调用当前代码块的函数（callers）
 * 3. 去重并合并
 */
async function expandByCallGraph(
  chunks: Array<CodeChunkRecord & { file_path?: string }>
): Promise<Array<CodeChunkRecord & { file_path?: string }>> {
  if (chunks.length === 0) {
    return chunks;
  }

  const chunkIds = chunks.map(c => c.id);

  try {
    // 1. 获取被调用的函数（callees）
    const calleesResult = await pool.query(
      `SELECT DISTINCT cc.*, f.path as file_path
       FROM call_graph cg
       JOIN code_chunks cc ON cc.symbol_name = cg.to_symbol
       JOIN files f ON cc.file_id = f.id
       WHERE cg.from_chunk_id = ANY($1)
       LIMIT 50`,
      [chunkIds]
    );

    // 2. 获取调用者（callers）
    const callersResult = await pool.query(
      `SELECT DISTINCT cc.*, f.path as file_path
       FROM call_graph cg
       JOIN code_chunks cc ON cc.id = cg.from_chunk_id
       JOIN files f ON cc.file_id = f.id
       WHERE cg.to_symbol IN (
         SELECT symbol_name FROM code_chunks WHERE id = ANY($1)
       )
       LIMIT 50`,
      [chunkIds]
    );

    const callees = calleesResult.rows;
    const callers = callersResult.rows;

    console.log(`Call graph expansion: +${callees.length} callees, +${callers.length} callers`);

    // 3. 合并并去重
    const allChunks = [...chunks, ...callees, ...callers];
    const seen = new Set<number>();
    const deduplicated = allChunks.filter(chunk => {
      if (seen.has(chunk.id)) {
        return false;
      }
      seen.add(chunk.id);
      return true;
    });

    return deduplicated;
  } catch (error) {
    console.error('Call graph expansion failed:', error);
    return chunks; // 失败时返回原始结果
  }
}

/**
 * 判断查询是否适合使用多阶段检索
 */
export function shouldUseMultiStage(query: string): boolean {
  // Bug 分析、调用链、影响范围类问题
  const patterns = [
    /bug/i,
    /错误/,
    /报错/,
    /失败/,
    /调用/,
    /依赖/,
    /影响/,
    /为什么/,
    /怎么会/,
    /调用链/,
    /调用关系/,
  ];

  return patterns.some(pattern => pattern.test(query));
}
