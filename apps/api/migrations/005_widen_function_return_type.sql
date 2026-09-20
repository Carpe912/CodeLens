-- ============================================
-- Migration 005: 放宽 functions.return_type 到 TEXT
-- Version: 1.0
-- Date: 2026-09-19
-- ============================================
--
-- 背景（一次「一列太窄，整个文件的实体层全没了」的事故）
--
-- `functions.return_type` 自 001 起是 `VARCHAR(255)`。但第二遍索引存的是
-- **ts-morph 推断出来的**返回类型，而 Vue 组合式函数的返回值是结构化类型：
--
--   { name: string; props: string[]; setup: ({ context }: { context: ImportMeta }) => ... }
--
-- 实测（repo 33 testwire-frontend）最长的一条是 241 字符，而失败的那批都超过了 255。
-- 超限的报错是：`value too long for type character varying(255)`。
--
-- ⚠️ 真正的伤害不在「这一列写不进去」，而在**它所在的写入是事务**：
-- `EnhancedIndexer.storeEntities` 把 string_constants / functions / classes 的写入
-- 包在同一个 BEGIN…COMMIT 里，任何一条 INSERT 失败 → `ROLLBACK` → 抛给上层的
-- per-file catch → 日志只留一行 `✗ Error indexing <file>`。
-- 结果：**该文件在第一遍（code_chunks）正常入库，在第二遍（实体层）整体消失** ——
-- functions / classes / string_constants 三张表一条都没有。
--
-- 实测影响面（repo 33 一次全量 + repo 30 fastify 一次全量，日志累计）：
--   `source: ./useContext.ts` / `useTabsContext.ts` / `useTree.ts` / `useDrag.ts` /
--   `useScheduleConfig.ts` / `useApiRun.ts` / `model/Interface/BaseForm.ts` … 共 24 个文件。
--   形态高度雷同：**Vue 组合式函数**（返回一个大对象字面量）与 **类型定义密集的文件**。
--
-- 为什么选「放宽到 TEXT」而不是「截断到 255」：
-- `return_type` 是给人看、给检索用的描述性元数据，截断后的类型表达式是**语法非法**的
-- 半截文本（`{ name: string; props: stri` ），比没有更误导。这一列不参与任何
-- 唯一键/索引/等值比较（只有 `idx_functions_*` 上的 name / full_name 等），
-- 放宽为 TEXT 没有任何成本。
--
-- ⚠️ 同类风险仍在别处：`functions.name` / `classes.name` / `classes.extends_class` /
-- `string_constants.symbol_name` / `string_constants.parent_object` 仍是 VARCHAR(255)。
-- 它们存的是**标识符**，超 255 的概率极低（实测全库最大 48 字符），故本次不动。
-- 但判断依据是「实测」，不是「不可能」—— 再加宽之前先按同样方式量一遍。
--
-- 可重放性：`ALTER COLUMN ... TYPE TEXT` 重复执行是幂等的（不是 ADD COLUMN，
-- 不需要 IF NOT EXISTS —— 那种写法在 Postgres 里本来也不存在，见 004 的教训）。

ALTER TABLE functions ALTER COLUMN return_type TYPE TEXT;

-- 回执：让执行迁移的人一眼看到结果，而不是靠「没报错」推断成功
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'functions' AND column_name = 'return_type';

  IF col_type = 'text' THEN
    RAISE NOTICE '005 完成：functions.return_type 已是 TEXT';
  ELSE
    RAISE EXCEPTION '005 未生效：functions.return_type 仍是 %', col_type;
  END IF;
END $$;
