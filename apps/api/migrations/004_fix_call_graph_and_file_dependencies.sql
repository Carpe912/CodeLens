-- ============================================
-- Migration 004: Fix call_graph schema + materialize file_dependencies
-- Version: 1.0
-- Date: 2026-09-18
-- ============================================
--
-- 背景（这是一次「修坏账」的迁移，不是加新功能）
--
-- 1) call_graph 表缺少两列，但代码里有 8 处在引用它们：
--      - repo_id      ← relationship-builder 写入、clearRepoData 删除、getIndexingStats 统计
--      - to_chunk_id  ← multi-strategy-search 2 处、dependency-tracker 2 处、写入方
--    由于写入语句被 try/catch 包裹（为了「不中断索引」），
--    实际后果是：整张表一行都插不进去，且全程没有任何报错。
--    调用图/依赖检索因此长期返回空结果。
--
-- 2) import_relations 的写入使用 `ON CONFLICT DO NOTHING`，
--    但从未为它建立唯一索引 —— 没有唯一索引就没有「冲突」，
--    该子句等于装饰品，重复行会静默堆积（增量重索引路径尤其明显）。
--
-- 3) file_dependencies 表自迁移 001 建好后就一直是空的。
--    原代码注释声称「由 import_relations 的触发器自动聚合」——
--    这个触发器**确实**定义在 001 的第 514-536 行
--    （trigger_update_file_dependency，AFTER INSERT ON import_relations）。
--    它之所以从未生效，是因为 **001 自身无法执行**：
--       a) 001 里 44 处 CREATE INDEX 没写 IF NOT EXISTS
--       b) CREATE TRIGGER 也没有 IF NOT EXISTS（Postgres 本就无此语法）
--    于是 001 在任何「表已存在」的库上都会中途报错回滚，
--    触发器和索引一起没被创建（001 在 2026-09-18 才第一次被真正执行）。
--    → 教训：一个「只写来从零建库」的脚本不算迁移。它必须可重放，
--      否则在已有数据的库上永远跑不过去，而失败又只在手工执行时才看得见。
--
--    本迁移只负责把表结构准备好；数据由应用层
--    RelationshipBuilder.rebuildFileDependencies() 显式物化（用于回填历史数据）。
--    触发器就位后，新增的 import_relations 会自动增量聚合。
--
-- 本迁移是幂等的：可重复执行。
-- ============================================

BEGIN;

-- ============================================
-- 1. call_graph: 补齐缺失的两列
-- ============================================
-- repo_id: 让调用图可以按仓库隔离（此前只能靠 JOIN code_chunks → files 绕行）
-- to_chunk_id: 调用目标的「实体」ID（to_symbol 是名字，两者都保留，见下方注释）
ALTER TABLE call_graph
  ADD COLUMN IF NOT EXISTS repo_id INT REFERENCES repos(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS to_chunk_id INT REFERENCES code_chunks(id) ON DELETE SET NULL;

COMMENT ON COLUMN call_graph.repo_id IS 'Owning repository. Added in 004: the column was referenced by code but never existed.';
COMMENT ON COLUMN call_graph.to_chunk_id IS 'Resolved callee chunk id. NULL means the call target could not be resolved to a definition (to_symbol still holds the raw name).';

-- ============================================
-- 2. 回填历史行（如果某个库里恰好有数据）
-- ============================================

-- 2.1 回填 repo_id：调用者 chunk → file → repo
UPDATE call_graph cg
SET repo_id = f.repo_id
FROM code_chunks cc
JOIN files f ON cc.file_id = f.id
WHERE cg.from_chunk_id = cc.id
  AND cg.repo_id IS NULL;

-- 2.2 尽力回填 to_chunk_id：仅在同名定义唯一时解析，避免跨文件同名歧义被写成「确定答案」
--     （宁可留 NULL 让读取方知道「未解析」，也不要写一个可能是错的实体）
UPDATE call_graph cg
SET to_chunk_id = matched.id
FROM (
  SELECT
    cg2.id AS edge_id,
    MIN(cc2.id) AS id
  FROM call_graph cg2
  JOIN code_chunks cc2 ON cc2.symbol_name = cg2.to_symbol
  JOIN files f2 ON cc2.file_id = f2.id
  WHERE cg2.to_chunk_id IS NULL
    AND f2.repo_id = cg2.repo_id
  GROUP BY cg2.id
  HAVING COUNT(*) = 1
) AS matched
WHERE cg.id = matched.edge_id;

-- ============================================
-- 3. call_graph: 索引 + 唯一索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_call_graph_from_chunk_id ON call_graph(from_chunk_id);
CREATE INDEX IF NOT EXISTS idx_call_graph_to_chunk_id ON call_graph(to_chunk_id);
CREATE INDEX IF NOT EXISTS idx_call_graph_repo_id ON call_graph(repo_id);
CREATE INDEX IF NOT EXISTS idx_call_graph_to_symbol ON call_graph(to_symbol);

-- 先去重，再建唯一索引（否则唯一索引会因历史重复行而创建失败）
DELETE FROM call_graph a
USING call_graph b
WHERE a.id > b.id
  AND a.from_chunk_id IS NOT DISTINCT FROM b.from_chunk_id
  AND a.to_symbol = b.to_symbol
  AND COALESCE(a.call_line, -1) = COALESCE(b.call_line, -1);

-- 让写入方的 `ON CONFLICT DO NOTHING` 真正生效
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_graph_unique
  ON call_graph (from_chunk_id, to_symbol, COALESCE(call_line, -1));

-- ============================================
-- 4. import_relations: 去重 + 唯一索引
-- ============================================
DELETE FROM import_relations a
USING import_relations b
WHERE a.id > b.id
  AND a.repo_id = b.repo_id
  AND a.importer_file_id = b.importer_file_id
  AND a.import_path = b.import_path
  AND COALESCE(a.imported_symbol, '') = COALESCE(b.imported_symbol, '')
  AND COALESCE(a.import_type, '') = COALESCE(b.import_type, '')
  AND COALESCE(a.importer_line, -1) = COALESCE(b.importer_line, -1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_relations_unique
  ON import_relations (
    repo_id,
    importer_file_id,
    import_path,
    COALESCE(imported_symbol, ''),
    COALESCE(import_type, ''),
    COALESCE(importer_line, -1)
  );

-- ============================================
-- 5. 清理遗留索引
-- ============================================
-- code_chunks 从来没有 repo_id 列（仓库归属统一走 files.repo_id）。
-- 这个索引若存在，说明它是在更早的 schema 版本下建的；留着会持续误导。
DROP INDEX IF EXISTS idx_code_chunks_repo;

-- ============================================
-- 6. file_dependencies: 保证有唯一键以支持 upsert
-- ============================================
-- migration 001 已建 UNIQUE(source_file_id, target_file_id)，这里兜底确认
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_dependencies_unique
  ON file_dependencies (source_file_id, target_file_id);

DO $$
BEGIN
  RAISE NOTICE 'Migration 004 completed';
  RAISE NOTICE '  call_graph      : +repo_id, +to_chunk_id, +indexes, +unique index';
  RAISE NOTICE '  import_relations: deduplicated, +unique index (makes ON CONFLICT meaningful)';
  RAISE NOTICE '  dropped         : idx_code_chunks_repo (column never existed)';
  RAISE NOTICE '';
  RAISE NOTICE 'NEXT STEP (data, not schema):';
  RAISE NOTICE '  file_dependencies is still empty by design.';
  RAISE NOTICE '  Re-index a repo to populate it, or run rebuildFileDependencies(repoId) directly.';
END $$;

COMMIT;
