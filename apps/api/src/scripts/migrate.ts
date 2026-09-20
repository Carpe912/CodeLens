#!/usr/bin/env node

/**
 * Database Migration Runner
 *
 * Usage:
 *   pnpm --filter @codelens/api migrate              # 应用所有未执行的迁移
 *   pnpm --filter @codelens/api migrate -- --dry-run # 只列出将要执行的迁移
 *   pnpm --filter @codelens/api migrate -- --status  # 列出已执行 / 待执行
 *
 * ============================================
 * 2026-09 修订说明
 * ============================================
 * 原实现只读取并执行 `001_enhanced_schema.sql` 这一个文件（文件名硬编码）。
 * 后果：002（embedding 维度）与 003（ON CONFLICT 所需的唯一索引，包括
 * code_chunks 的 hash 索引）从未被这个脚本应用过，
 * 只能靠人手去 psql 里跑 —— 而没人跑。
 *
 * 现在改为：
 *   1. 扫描 migrations/ 下所有 .sql，按文件名排序执行；
 *   2. 用 schema_migrations 表记录已执行的版本，避免重复执行；
 *   3. 支持 --dry-run / --status。
 *
 * 为什么需要「已执行」台账而不是每次都跑一遍：
 * 部分迁移是破坏性的（例如 002 会清空 embedding 以改变向量维度），
 * 无条件重跑等于毁数据。台账让「重跑迁移」变成安全操作。
 */

import { Pool } from 'pg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 与 index.ts / verify-graph.ts 保持一致：先加载 .env 再读环境变量。
// dotenv 不覆盖已存在的环境变量，因此 PM2 注入的 env_production 优先。
import 'dotenv/config';
// 注意：error.message 对 AggregateError 是空串，必须用 describeError 展开底层 errors[]
import { describeError } from '../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const STATUS_ONLY = args.includes('--status');

/**
 * 连接配置解析后的目标（不含密码）
 *
 * 单独抽出来是为了**能被打印**：迁移最常见的失败原因是「连到了别的库」，
 * 而报错信息（password authentication failed）本身不告诉你它连的是哪。
 */
const dbTarget = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
};

const pool = new Pool({
  host: dbTarget.host,
  port: dbTarget.port,
  database: dbTarget.database,
  user: dbTarget.user,
  password: process.env.DB_PASSWORD || 'postgres',
});

/** 版本号 = 文件名去掉 .sql，例如 "004_fix_call_graph_and_file_dependencies" */
async function listMigrationFiles(): Promise<{ version: string; file: string }[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), file: path.join(MIGRATIONS_DIR, f) }));
}

async function ensureLedger(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function getApplied(): Promise<Set<string>> {
  const res = await pool.query('SELECT version FROM schema_migrations');
  return new Set(res.rows.map((r) => r.version));
}

async function main(): Promise<void> {
  console.log('='.repeat(64));
  console.log('CodeLens Database Migrations');
  console.log('='.repeat(64));
  console.log(`Migrations dir: ${MIGRATIONS_DIR}`);
  console.log(
    `DB: ${dbTarget.host}:${dbTarget.port}/${dbTarget.database} as ${dbTarget.user}` +
      (process.env.DB_PASSWORD ? '' : '  ⚠ 未设置 DB_PASSWORD，将使用默认口令')
  );

  const files = await listMigrationFiles();

  if (files.length === 0) {
    console.log('\n没有找到任何迁移文件。');
    return;
  }

  await ensureLedger();
  const applied = await getApplied();

  const pending = files.filter((f) => !applied.has(f.version));
  const done = files.filter((f) => applied.has(f.version));

  console.log('');
  console.log(`共 ${files.length} 个迁移：已执行 ${done.length}，待执行 ${pending.length}`);
  if (done.length > 0) {
    console.log('\n已执行：');
    for (const f of done) console.log(`  ✓ ${f.version}`);
  }

  if (STATUS_ONLY) {
    if (pending.length > 0) {
      console.log('\n待执行：');
      for (const f of pending) console.log(`  · ${f.version}`);
    } else {
      console.log('\n数据库已是最新。');
    }
    return;
  }

  if (pending.length === 0) {
    console.log('\n没有待执行的迁移，数据库已是最新。');
    return;
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] 将会执行：');
    for (const f of pending) console.log(`  · ${f.version}`);
    console.log('\n未做任何修改。去掉 --dry-run 即真正执行。');
    return;
  }

  console.log('\n开始执行：');
  for (const { version, file } of pending) {
    const sql = await fs.readFile(file, 'utf-8');
    process.stdout.write(`  → ${version} ... `);

    try {
      // 一次 pool.query 传多条语句时，PostgreSQL 会把它们放在同一个隐式事务里，
      // 因此单个迁移文件天然具备原子性。
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
      console.log('OK');
    } catch (error: any) {
      console.log('FAILED');
      console.error('');
      console.error('='.repeat(64));
      console.error(`迁移失败：${version}`);
      console.error(`目标库：${dbTarget.host}:${dbTarget.port}/${dbTarget.database} as ${dbTarget.user}`);
      console.error('='.repeat(64));
      console.error(describeError(error));
      console.error('');
      console.error('该迁移已回滚（隐式事务），数据库状态未被改变。');
      process.exit(1);
    }
  }

  console.log('');
  console.log('='.repeat(64));
  console.log(`完成：成功执行 ${pending.length} 个迁移`);
  console.log('='.repeat(64));
  console.log('');
  console.log('提醒：本迁移只修表结构，关系图数据需要单独重建。');
  console.log('      004 给 call_graph 补了 repo_id / to_chunk_id，但历史数据不会自动回填。');
  console.log('      关系图（import_relations / call_graph / file_dependencies）与 embedding 无关，');
  console.log('      因此用 rebuild-graph 即可，不需要重跑索引、不重新花钱嵌入：');
  console.log('        pnpm --filter @codelens/api rebuild-graph <repoId>');
  console.log('      仅在文件内容本身变化、需要重算向量时才用 reindex：');
  console.log('        pnpm --filter @codelens/api reindex <repoId> <repoPath>');
  console.log('');
}

main()
  .catch((error: any) => {
    console.error('');
    console.error('='.repeat(64));
    console.error('Migration Failed!');
    console.error(`目标库：${dbTarget.host}:${dbTarget.port}/${dbTarget.database} as ${dbTarget.user}`);
    console.error('='.repeat(64));
    console.error(describeError(error));
    console.error('');
    console.error('提示：若为 ECONNREFUSED，说明该地址上没有可连接的 PostgreSQL。');
    console.error('      服务器上请确认 PG 已启动，并让 .env.production 里的 DB_HOST/DB_PORT 指向它。');
    console.error('');
    process.exit(1);
  })
  .finally(() => pool.end());
