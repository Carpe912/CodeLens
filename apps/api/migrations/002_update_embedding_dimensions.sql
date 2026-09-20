-- Migration: Update embedding dimensions from 1024 to 1536
-- This ensures consistency with text-embedding-v4 model output
--
-- ============================================
-- 2026-09 修订：改为幂等 + 失败安全
-- ============================================
-- 原版是无条件执行的：
--     UPDATE code_chunks SET embedding = NULL ...;
--     ALTER TABLE code_chunks DROP COLUMN IF EXISTS embedding;
--     ALTER TABLE code_chunks ADD COLUMN embedding vector(1536);
-- 这意味着「只要再跑一次迁移，全部向量就被清空」。
-- 由于 migrate 脚本现在会按顺序执行 migrations 目录下的所有文件，
-- 一次无条件重跑就等于毁掉整个索引的向量数据。
--
-- 现在改为：先探测 embedding 列的真实类型，只在确实是旧维度（1024）时才执行
-- 破坏性迁移；类型不明时一律跳过并打印 NOTICE，宁可不动也不误删。
-- ============================================

DO $$
DECLARE
  current_type text;
BEGIN
  -- 取 embedding 列的类型描述（pgvector 的 typmod 输出形如 vector(1536)）
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO current_type
  FROM pg_attribute a
  WHERE a.attrelid = 'code_chunks'::regclass
    AND a.attname = 'embedding'
    AND NOT a.attisdropped;

  IF current_type IS NULL THEN
    RAISE NOTICE '[002] code_chunks.embedding 不存在 → 新增 vector(1536)';
    ALTER TABLE code_chunks ADD COLUMN embedding vector(1536);

  ELSIF current_type = 'vector(1536)' THEN
    RAISE NOTICE '[002] code_chunks.embedding 已是 vector(1536) → 跳过，不动数据';

  ELSIF current_type = 'vector(1024)' THEN
    RAISE NOTICE '[002] code_chunks.embedding 为 vector(1024) → 迁移到 1536（向量将被清空，需重新索引）';
    UPDATE code_chunks SET embedding = NULL WHERE embedding IS NOT NULL;
    ALTER TABLE code_chunks DROP COLUMN embedding;
    ALTER TABLE code_chunks ADD COLUMN embedding vector(1536);

  ELSE
    -- 未知类型（例如别的扩展或非预期维度）：不猜、不动
    RAISE NOTICE '[002] 检测到非预期类型 % → 跳过以避免数据丢失', current_type;
  END IF;
END $$;

-- Recreate the HNSW index for vector search (better performance than IVFFlat)
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding_hnsw ON code_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Note: if the destructive branch above ran, embeddings must be regenerated:
-- Run: pnpm --filter @codelens/api reindex <repo_id> <repo_path>
