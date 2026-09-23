/**
 * 管理运维 路由
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
} from '../deps.js';
import type { CodeLensGraph } from '../deps.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {

/**
 * 管理员端点：迁移向量维度
 * POST /admin/migrate-vector-dimension
 *
 * 功能：
 * - 将向量维度从 1024 迁移到 1536
 * - 重建向量索引
 * - 清空现有嵌入数据
 *
 * 迁移步骤：
 * 1. 删除现有向量索引
 * 2. 删除旧的 embedding 列
 * 3. 创建新的 1536 维 embedding 列
 * 4. 重建 HNSW 索引
 *
 * 注意：
 * - 迁移后需要重新索引所有仓库
 * - 所有现有的向量嵌入会被清空
 * - 这是一次性操作，谨慎使用
 *
 * @returns {
 *   success: boolean,
 *   message: string
 * }
 *
 * @throws 500 - 迁移失败
 */
app.post('/admin/migrate-vector-dimension', async (request, reply) => {
  try {
    console.log('Starting migration: changing embedding vector dimension from 1024 to 1536...');

    // 删除索引
    console.log('Dropping index...');
    await pool.query('DROP INDEX IF EXISTS idx_code_chunks_embedding');
    await pool.query('DROP INDEX IF EXISTS idx_code_chunks_embedding_hnsw');

    // 删除旧的 embedding 列
    console.log('Dropping old embedding column...');
    await pool.query('ALTER TABLE code_chunks DROP COLUMN IF EXISTS embedding');

    // 添加新的 1536 维 embedding 列
    console.log('Adding new embedding column with 1536 dimensions...');
    await pool.query('ALTER TABLE code_chunks ADD COLUMN embedding vector(1536)');

    // 重建索引（使用 HNSW 索引以获得更好的性能）
    console.log('Recreating HNSW index...');
    await pool.query('CREATE INDEX idx_code_chunks_embedding_hnsw ON code_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)');

    console.log('Migration completed successfully!');

    return {
      success: true,
      message: 'Vector dimension migrated from 1024 to 1536. All existing embeddings have been cleared. You need to re-index your repositories.'
    };
  } catch (error: any) {
    console.error('Migration failed:', error);
    return reply.code(500).send({ error: 'Migration failed', details: error.message });
  }
});


/**
 * 获取缓存统计信息
 * GET /admin/cache/stats
 *
 * 功能：
 * - 返回所有缓存的统计信息
 * - 包含命中率、大小、容量等指标
 *
 * 统计指标：
 * - hits: 缓存命中次数
 * - misses: 缓存未命中次数
 * - hitRate: 命中率（0-1）
 * - size: 当前缓存大小
 * - maxSize: 最大容量
 *
 * 使用场景：
 * - 监控缓存性能
 * - 优化缓存策略
 * - 容量规划
 *
 * @returns Record<string, CacheStats>
 */
app.get('/admin/cache/stats', async () => {
  return getAllCacheStats();
});


/**
 * 清空所有缓存
 * POST /admin/cache/clear
 *
 * 功能：
 * - 清空所有缓存数据
 * - 重置缓存统计
 *
 * 使用场景：
 * - 代码库更新后清除旧缓存
 * - 缓存数据异常时重置
 * - 手动释放内存
 *
 * 注意：清空缓存会导致短期性能下降
 *
 * @returns { message: string }
 */
app.post('/admin/cache/clear', async () => {
  clearAllCaches();
  return { message: 'All caches cleared successfully' };
});

}
