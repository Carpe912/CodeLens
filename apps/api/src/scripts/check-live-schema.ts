#!/usr/bin/env node

/**
 * 真实数据库 ↔ 代码期望 schema 的**反向**漂移检查
 *
 * ============================================
 * 这个脚本要解决的问题（2026-09-18 真实事故）
 * ============================================
 * `check:sql` 做的是「源码里的 SQL → 静态还原的 schema」。
 * 它假定「代码里 CREATE TABLE 写了这列，库里就有这列」。
 *
 * 但 `CREATE TABLE IF NOT EXISTS` 在**表已存在**时是彻底的 no-op ——
 * 它既不会建表，也不会把后加的列补进去。
 * 于是出现这一类事故：
 *
 *   1) call_graph 缺 repo_id / to_chunk_id
 *      → 8 处代码引用它们，写入被 try/catch 吞掉，表永远为空且不报错
 *   2) repos 缺 gitlab_url / branch / is_base_branch / parent_repo_id / default_branch
 *      → initDatabase 里 `CREATE INDEX ON repos(gitlab_url)` 抛 42703，
 *        而 catch 只忽略 23505，异常冒到调用方 → **整个服务起不来**
 *
 * 两次都是同一个形状：**代码假定某列存在，真实库没有**。
 * `check:sql` 对这类问题完全无感，因为它的输入（静态 schema）本身就把这些列算了进去。
 *
 * 本脚本补上这个缺口：连上真实数据库，逐表比对列，报告「期望有、实际没有」的列，
 * 并且区分两种情况：
 *
 *   [自愈] 代码里有 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS <col>`
 *          → 启动时会自动补上，不算故障
 *   [地雷] 没有任何 ALTER 兜底
 *          → 一旦该列被 SQL 引用就会失败（或被 catch 静默吞掉）
 *
 * ============================================
 * 用法
 * ============================================
 *   pnpm --filter @codelens/api check:live-schema
 *
 * 连接参数取 DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD（会加载 .env）。
 * 服务器上请用：
 *   node --env-file-if-exists=.env.production apps/api/dist/scripts/check-live-schema.js
 *
 * 退出码：发现「地雷」= 1；只有自愈项 = 0；连不上库 = 2
 *
 * ⚠️ 与 check:sql 的关系：两者互补，都该跑。
 *    check:sql        抓「SQL 引用了不存在的列」（静态）
 *    check:live-schema 抓「代码假定存在的列在真库缺失」（动态）
 */

import 'dotenv/config';
import pg from 'pg';
import { buildSchema, collectAlterSources } from './check-sql-schema.js';
import { describeError } from '../utils/errors.js';

const VERBOSE = process.argv.includes('--verbose');

/** 这些是 Postgres 自带/由扩展管理、不由本项目建表语句声明的表，不参与比对 */
const IGNORED_TABLES = new Set([
  'schema_migrations',
  'spatial_ref_sys',
  'geography_columns',
  'geometry_columns',
  'raster_columns',
  'raster_overviews',
]);

/**
 * 判断某列是否有 `ADD COLUMN IF NOT EXISTS` 兜底。
 *
 * 只看 ALTER 语句里的加法：`IF NOT EXISTS` 是「幂等补列」的标志，
 * 有它意味着应用启动或迁移会把列补上，不需要人工干预。
 */
function hasSelfHealingAlter(sources: string, table: string, column: string): string | null {
  const re = new RegExp(
    `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${table}\\b[^;]{0,2000}?ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}\\b`,
    'is'
  );
  const hit = re.exec(sources);
  if (!hit) return null;
  // 返回一小段上下文，便于人工确认
  return hit[0].replace(/\s+/g, ' ').slice(0, 120);
}

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('真实数据库 ↔ 代码期望 schema 一致性检查');
  console.log('='.repeat(72));

  const target = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'codelens',
    user: process.env.DB_USER || 'postgres',
  };
  console.log(`DB: ${target.host}:${target.port}/${target.database} as ${target.user}`);
  console.log('');

  const expected = buildSchema();
  console.log(`代码期望：${expected.size} 张表`);

  // 所有可能含 ADD COLUMN 的文本（建表文件 + migrations）。
  // 注意：不能去遍历 src/** —— 部署态只有 dist，遍历会落空。
  const sources = collectAlterSources();

  const pool = new pg.Pool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: process.env.DB_PASSWORD || 'postgres',
    connectionTimeoutMillis: 10000,
  });

  let actual: Map<string, Set<string>>;
  try {
    const res = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`
    );
    actual = new Map();
    for (const r of res.rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
    }
  } catch (error) {
    console.error('');
    console.error('无法连接数据库，检查未执行。');
    console.error(describeError(error));
    await pool.end();
    process.exit(2);
  }

  console.log(`真实数据库：${actual.size} 张表`);
  console.log('');

  const missingTables: string[] = [];
  const landmines: Array<{ table: string; column: string }> = [];
  const selfHealing: Array<{ table: string; column: string; how: string }> = [];
  const extraTables: string[] = [];

  for (const t of actual.keys()) {
    if (!IGNORED_TABLES.has(t) && !expected.has(t)) extraTables.push(t);
  }

  for (const [table, expCols] of expected) {
    const actCols = actual.get(table);
    if (!actCols) {
      missingTables.push(table);
      continue;
    }
    for (const col of expCols) {
      if (actCols.has(col)) continue;
      const how = hasSelfHealingAlter(sources, table, col);
      if (how) selfHealing.push({ table, column: col, how });
      else landmines.push({ table, column: col });
    }
  }

  // ---- 报告 ----
  if (missingTables.length > 0) {
    console.log('【整张表缺失】代码期望但库里没有：');
    for (const t of missingTables) console.log(`  ✗ ${t}`);
    console.log('  → 通常是「从未执行过建表」，启动时 CREATE TABLE 会补上。');
    console.log('');
  }

  if (landmines.length > 0) {
    console.log('【地雷】代码假定存在、真实库缺失，且没有任何 ALTER 兜底：');
    for (const { table, column } of landmines) console.log(`  ✗ ${table}.${column}`);
    console.log('');
    console.log('  → 这些列一旦被 SQL 引用就会失败；若被 try/catch 包住则会静默吞掉。');
    console.log('  → 修法：在 db/index.ts 的建表后补一段');
    console.log('         ALTER TABLE <表> ADD COLUMN IF NOT EXISTS <列> <类型>;');
    console.log('');
  }

  if (selfHealing.length > 0) {
    console.log('【自愈】库里缺失，但代码有 ADD COLUMN IF NOT EXISTS 兜底（启动时自动补）：');
    for (const { table, column } of selfHealing) console.log(`  · ${table}.${column}`);
    console.log('');
  }

  if (VERBOSE && extraTables.length > 0) {
    console.log('【额外】库里有、代码未声明的表（可能是历史遗留）：');
    for (const t of extraTables) console.log(`  ? ${t}`);
    console.log('');
  }

  const ok = landmines.length === 0 && missingTables.length === 0;
  console.log('='.repeat(72));
  if (ok) {
    console.log('PASS — 代码假定的列在真实数据库中全部存在');
  } else {
    console.log(
      `FAIL — ${landmines.length} 处地雷、${missingTables.length} 张缺失表` +
        (selfHealing.length ? `（另有 ${selfHealing.length} 处会自愈）` : '')
    );
  }
  console.log('='.repeat(72));

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error('');
  console.error('检查脚本自身失败：');
  console.error(describeError(error));
  process.exit(2);
});
