import type { CodeChunkRecord } from '../db/index.js';

/**
 * Rerank provider type
 */
type RerankProvider = 'cohere' | 'jina' | 'bce' | 'dashscope';

/**
 * Detect rerank provider from environment variables
 */
function detectRerankProvider(): RerankProvider | null {
  if (process.env.COHERE_API_KEY) return 'cohere';
  if (process.env.JINA_API_KEY) return 'jina';
  if (process.env.BCE_RERANK_API_KEY) return 'bce';
  if (process.env.DASHSCOPE_API_KEY || process.env.EMBED_API_KEY) return 'dashscope';
  return null;
}

/**
 * Rerank using Cohere API
 */
async function rerankWithCohere(
  query: string,
  documents: string[],
  topK: number
): Promise<Array<{ index: number; relevance_score: number }>> {
  const response = await fetch('https://api.cohere.ai/v1/rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'rerank-english-v3.0',
      query: query,
      documents: documents,
      top_n: topK,
      return_documents: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Cohere API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  return data.results;
}

/**
 * Rerank using Jina AI Reranker API (国内可用)
 * https://jina.ai/reranker
 */
async function rerankWithJina(
  query: string,
  documents: string[],
  topK: number
): Promise<Array<{ index: number; relevance_score: number }>> {
  const response = await fetch('https://api.jina.ai/v1/rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'jina-reranker-v2-base-multilingual',
      query: query,
      documents: documents,
      top_n: topK,
    }),
  });

  if (!response.ok) {
    throw new Error(`Jina API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  return data.results;
}

/**
 * Rerank using BCE Reranker (百度 BCE，国内可用)
 * 使用开源模型 maidalun1020/bce-reranker-base_v1
 */
async function rerankWithBCE(
  query: string,
  documents: string[],
  topK: number
): Promise<Array<{ index: number; relevance_score: number }>> {
  const baseUrl = process.env.BCE_RERANK_BASE_URL || 'http://localhost:8000';

  const response = await fetch(`${baseUrl}/rerank`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.BCE_RERANK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: query,
      documents: documents,
      top_n: topK,
    }),
  });

  if (!response.ok) {
    throw new Error(`BCE Rerank API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  return data.results;
}

/**
 * Rerank using Alibaba Cloud DashScope (阿里云灵积，国内可用)
 * 支持模型: gte-rerank, gte-rerank-hybrid, qwen3-rerank
 * https://help.aliyun.com/zh/dashscope/developer-reference/text-rerank-api
 *
 * 优化策略：
 * - 增加候选数量：从 10 增加到 30-50，提高召回率
 * - qwen3-rerank 支持最多 100 个文档，我们使用 50 个
 */
async function rerankWithDashScope(
  query: string,
  documents: string[],
  topK: number
): Promise<Array<{ index: number; relevance_score: number }>> {
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.EMBED_API_KEY;
  const model = process.env.DASHSCOPE_RERANK_MODEL || 'gte-rerank';

  // 优化：增加候选数量，让 rerank 有更多选择
  // qwen3-rerank 支持最多 100 个文档，我们使用 50 个
  const candidateCount = Math.min(documents.length, 50);

  const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-embedding/text-rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model,
      input: {
        query: query,
        documents: documents.slice(0, candidateCount), // 限制候选数量
      },
      parameters: {
        top_n: topK,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DashScope API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data: any = await response.json();

  // Check for API errors
  if (data.code && data.code !== '200') {
    throw new Error(`DashScope API error: ${data.code} - ${data.message}`);
  }

  // Transform DashScope response format to standard format
  return data.output.results.map((item: any) => ({
    index: item.index,
    relevance_score: item.relevance_score,
  }));
}

/**
 * Rerank search results using various rerank providers
 * Supports: Cohere, Jina AI, BCE, Alibaba DashScope
 * Falls back to similarity-based ranking if no provider is configured
 */
export async function rerankResults(
  query: string,
  results: Array<CodeChunkRecord & { file_path?: string; similarity?: number }>,
  topK: number = 10
): Promise<Array<CodeChunkRecord & { file_path?: string; similarity?: number; rerank_score?: number }>> {
  const provider = detectRerankProvider();

  // If no rerank provider, use simple similarity-based ranking
  if (!provider) {
    console.log('No rerank API configured, using similarity-based ranking');
    return results
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, topK);
  }

  try {
    // Prepare documents for reranking
    const documents = results.map((result) => {
      return `File: ${result.file_path || 'unknown'}
Symbol: ${result.symbol_name} (${result.symbol_type})
Code:
${result.code_text}`;
    });

    console.log(`Using ${provider} reranker for ${results.length} results`);

    // Call appropriate rerank API
    let rerankResults: Array<{ index: number; relevance_score: number }>;

    switch (provider) {
      case 'cohere':
        rerankResults = await rerankWithCohere(query, documents, topK);
        break;
      case 'jina':
        rerankResults = await rerankWithJina(query, documents, topK);
        break;
      case 'bce':
        rerankResults = await rerankWithBCE(query, documents, topK);
        break;
      case 'dashscope':
        rerankResults = await rerankWithDashScope(query, documents, topK);
        break;
      default:
        throw new Error(`Unknown rerank provider: ${provider}`);
    }

    // Map reranked results back to original records
    const rerankedResults = rerankResults.map((item: any) => {
      const originalResult = results[item.index];
      return {
        ...originalResult,
        rerank_score: item.relevance_score,
      };
    });

    console.log(`Reranked ${results.length} results to top ${rerankedResults.length} using ${provider}`);
    return rerankedResults;
  } catch (error) {
    console.error(`Reranking with ${provider} failed, falling back to similarity ranking:`, error);
    // Fallback to similarity-based ranking
    return results
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, topK);
  }
}

/**
 * Reciprocal Rank Fusion (RRF) for combining multiple ranked lists
 * Used to merge keyword search and vector search results
 */
export function reciprocalRankFusion<T extends { id: number }>(
  rankedLists: T[][],
  k: number = 60
): T[] {
  const scoreMap = new Map<number, { item: T; score: number }>();

  // Calculate RRF score for each item
  rankedLists.forEach((list) => {
    list.forEach((item, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      const existing = scoreMap.get(item.id);

      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(item.id, { item, score: rrfScore });
      }
    });
  });

  // Sort by RRF score and return items
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

/**
 * Remove duplicate results based on code similarity
 * Helps reduce redundant context in RAG
 */
export function deduplicateResults<T extends { code_text: string }>(
  results: T[],
  similarityThreshold: number = 0.9
): T[] {
  const deduplicated: T[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    // Simple deduplication based on normalized code text
    const normalized = result.code_text
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // Check if we've seen very similar code
    let isDuplicate = false;
    for (const seenCode of seen) {
      const similarity = calculateStringSimilarity(normalized, seenCode);
      if (similarity > similarityThreshold) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      deduplicated.push(result);
      seen.add(normalized);
    }
  }

  console.log(`Deduplicated ${results.length} results to ${deduplicated.length}`);
  return deduplicated;
}

/**
 * Calculate Jaccard similarity between two strings
 */
function calculateStringSimilarity(str1: string, str2: string): number {
  const tokens1 = new Set(str1.split(' '));
  const tokens2 = new Set(str2.split(' '));

  const intersection = new Set([...tokens1].filter((x) => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.size / union.size;
}
