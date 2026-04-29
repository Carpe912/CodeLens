import { generateEmbedding } from './embeddings.js';
import { searchByKeyword, searchByEmbedding, type CodeChunkRecord } from '../db/index.js';
import { generateQueryVariants } from './query-rewrite.js';
import { rerankResults, reciprocalRankFusion, deduplicateResults } from './reranker.js';
import { hydeEnhancedEmbedding, shouldUseHyDE } from './hyde.js';
import { queryResultCache, generateQueryCacheKey, cacheStatsTracker } from '../cache.js';

/**
 * Enhanced search with query rewriting, hybrid retrieval, and reranking
 * 支持查询缓存，显著提升性能和降低成本
 */
export async function enhancedSearch(
  repoId: number,
  query: string,
  options: {
    useQueryRewrite?: boolean;
    useReranking?: boolean;
    useHyDE?: boolean;
    useCache?: boolean;
    topK?: number;
  } = {}
): Promise<Array<CodeChunkRecord & { file_path?: string; similarity?: number; rerank_score?: number }>> {
  const {
    useQueryRewrite = true,
    useReranking = true,
    useHyDE = true,
    useCache = true,
    topK = 10,
  } = options;

  // 检查缓存
  if (useCache) {
    const cacheKey = generateQueryCacheKey(repoId, query, { useQueryRewrite, useReranking, useHyDE, topK });
    const cached = queryResultCache.get(cacheKey);

    if (cached) {
      cacheStatsTracker.recordHit('queryResult');
      console.log(`Query cache hit: "${query}"`);
      return cached;
    }

    cacheStatsTracker.recordMiss('queryResult');
  }

  console.log(`Enhanced search for: "${query}"`);

  // Step 1: Query rewriting (generate multiple query variants)
  let queries = [query];
  if (useQueryRewrite) {
    try {
      queries = await generateQueryVariants(query);
      console.log(`Generated ${queries.length} query variants`);
    } catch (error) {
      console.log('Query rewrite unavailable, using original query only');
    }
  }

  // Step 2: Hybrid retrieval (keyword + vector search)
  const keywordResults: CodeChunkRecord[] = [];
  const vectorResults: CodeChunkRecord[] = [];

  // Perform searches for each query variant
  for (const q of queries) {
    // Keyword search
    try {
      const kwResults = await searchByKeyword(repoId, q);
      keywordResults.push(...kwResults);
    } catch (error) {
      console.error(`Keyword search failed for "${q}":`, error);
    }

    // Vector search
    try {
      const embedding = await generateEmbedding(q);
      const vecResults = await searchByEmbedding(repoId, embedding, 20);
      vectorResults.push(...vecResults);
    } catch (error) {
      console.error(`Vector search failed for "${q}":`, error);
    }
  }

  // Step 2.5: HyDE (Hypothetical Document Embeddings) for "how-to" queries
  if (useHyDE && shouldUseHyDE(query)) {
    try {
      console.log('Using HyDE for enhanced retrieval');
      const { codeEmbedding } = await hydeEnhancedEmbedding(query);

      // Search with hypothetical code embedding
      if (codeEmbedding) {
        const hydeResults = await searchByEmbedding(repoId, codeEmbedding, 30);
        vectorResults.push(...hydeResults);
        console.log(`HyDE added ${hydeResults.length} results`);
      }
    } catch (error) {
      console.log('HyDE unavailable, continuing with standard search');
    }
  }

  console.log(`Keyword results: ${keywordResults.length}, Vector results: ${vectorResults.length}`);

  // Step 3: Reciprocal Rank Fusion (merge keyword and vector results)
  const fusedResults = reciprocalRankFusion([keywordResults, vectorResults]);
  console.log(`Fused results: ${fusedResults.length}`);

  // Step 4: Deduplication (remove similar code chunks)
  const deduplicated = deduplicateResults(fusedResults);

  // Step 5: Reranking (use rerank model with more candidates)
  // 优化：增加候选数量从 topK * 2 到 topK * 5，让 rerank 有更多选择
  let finalResults = deduplicated.slice(0, topK * 5); // 获取更多候选（例如 50 个）

  if (useReranking && finalResults.length > 0) {
    try {
      finalResults = await rerankResults(query, finalResults, topK);
      console.log(`Reranked ${finalResults.length} results from ${deduplicated.length} candidates`);
    } catch (error) {
      console.error('Reranking failed:', error);
      finalResults = finalResults.slice(0, topK);
    }
  } else {
    finalResults = finalResults.slice(0, topK);
  }

  // 缓存结果
  if (useCache) {
    const cacheKey = generateQueryCacheKey(repoId, query, { useQueryRewrite, useReranking, useHyDE, topK });
    queryResultCache.set(cacheKey, finalResults);
    console.log(`Query result cached: "${query}"`);
  }

  return finalResults;
}

/**
 * Simple search (backward compatible with existing code)
 */
export async function simpleSearch(
  repoId: number,
  query: string,
  limit: number = 10
): Promise<CodeChunkRecord[]> {
  // Hybrid search: keyword + vector
  const keywordResults = await searchByKeyword(repoId, query);
  const embedding = await generateEmbedding(query);
  const vectorResults = await searchByEmbedding(repoId, embedding, limit);

  // Simple merge and deduplicate
  const allResults = [...keywordResults, ...vectorResults];
  const seen = new Set<number>();
  const deduplicated = allResults.filter((result) => {
    if (seen.has(result.id)) {
      return false;
    }
    seen.add(result.id);
    return true;
  });

  return deduplicated.slice(0, limit);
}
