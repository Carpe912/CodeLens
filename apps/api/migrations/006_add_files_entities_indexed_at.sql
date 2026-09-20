-- ============================================
-- Migration 006: 给 files 加「实体层已完成」标记
-- Version: 1.0
-- Date: 2026-09-20
-- ============================================
--
-- 背景：索引失败后只能整仓重来
--
-- 索引分两遍，但两遍的「断点续传」能力**不对等**：
--
--   第一遍（code_chunks + 向量，indexer.ts 的 indexCodebase）
--     ✅ 自带断点续传：`SELECT path FROM files WHERE repo_id = $1` 之后
--        跳过已登记的路径。
--
--   第二遍（实体层 / 关系层，enhanced-indexer.ts 的 reindexRepository）
--     ❌ 完全没有：先 `cleanupRepository(repoId)` 清空 10 张表，再处理全部文件。
--
-- 所以第二遍跑到 1037/1051 挂掉之后，**没有任何办法从 1037 继续** ——
-- 而 `POST /repos/:id/reindex` 还会在最前面额外调一次 `clearRepoData(repoId)`，
-- 把第一遍的成果（含已经花钱生成好的向量）一起清掉。
-- 结果：一次失败 = 一次完整重来，全量仓库约 6 分钟起。
--
-- 本迁移是「让第二遍也能续跑」所需的**唯一**新状态：
-- 每个文件是否已经完成过实体层分析。
--
-- 为什么不用「该文件在 functions/classes/string_constants 里有没有行」来判：
-- 有大量文件**合法地产出 0 条实体**（barrel index.ts、纯模板 .vue、i18n 字典、
-- *.d.ts —— 实测 repo 33 有 237 个）。用「有没有行」判，这些文件每次续跑都会被
-- 重新处理一遍；而用「有没有标记」判，跑过一次就不再碰。
--
-- 语义：`NULL` = 尚未完成（含失败）；非 NULL = 该文件的
-- analyzeEntities → storeEntities → buildRelationships → generateEmbeddings
-- 四步全部成功返回过。取 now() 而非布尔值，是为了顺带留下「什么时候做的」。
--
-- ⚠️ **历史数据不回溯填充**（这是刻意的，不是遗漏）：
-- 已经索引好的老仓库此列全是 NULL，因此第一次对它们执行「续跑」会把第二遍
-- 完整重做一遍（第一遍的 chunk 与向量保留不动，代价远小于全量重建）。
-- 想避免这一次重做，就**别对老仓库点续跑** —— 它本来就是为「失败恢复」准备的。
--
-- 可重放性：`ADD COLUMN IF NOT EXISTS` 在 PostgreSQL 里是合法且幂等的。
-- （注意这与 `CREATE TRIGGER IF NOT EXISTS` 不同 —— 后者不存在，见 004 的教训。）

ALTER TABLE files ADD COLUMN IF NOT EXISTS entities_indexed_at TIMESTAMPTZ;

-- 续跑要按「哪些还没做完」筛选，走部分索引避免全表扫
CREATE INDEX IF NOT EXISTS idx_files_pending_entities
  ON files (repo_id)
  WHERE entities_indexed_at IS NULL;

-- 回执：让执行迁移的人一眼看到结果
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'files' AND column_name = 'entities_indexed_at';

  IF col_type = 'timestamp with time zone' THEN
    RAISE NOTICE '006 完成：files.entities_indexed_at 已就位（TIMESTAMPTZ）';
  ELSE
    RAISE EXCEPTION '006 未生效：files.entities_indexed_at 为 %', coalesce(col_type, '不存在');
  END IF;
END $$;
