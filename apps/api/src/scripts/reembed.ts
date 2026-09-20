#!/usr/bin/env node
/**
 * Re-embed Script —— 只重算向量，不碰其他任何数据
 *
 * ============================================
 * 为什么需要它
 * ============================================
 * 嵌入模型一旦更换（换厂商、换版本、换维度），**库里已存的向量就全部失效**：
 * 维度可能还对得上，但语义空间完全不同，拿新模型的查询向量去比对旧向量，
 * 相似度接近 0（正交），检索结果等于随机 —— 表现为「接口 200 但证据为空」。
 *
 * 而现有的脚本都做不到「只重算向量」：
 * - `reindex`  会重跑整个索引流程（AST 分析 + 关系构建 + 向量），需要**原始源码文件**
 *              在磁盘上，且开销远大于重算向量；
 * - `rebuild-graph` 明确只重建关系、不碰向量（它的文件头注释解释了原因）。
 *
 * 本脚本的定位：**从库里已有的文本列回填 embedding**，因此
 * 1. 不需要原始源码文件（仓库的 zip / 工作副本丢了也能修）；
 * 2. 不重算符号表、调用图、依赖关系，纯写 embedding 一列；
 * 3. 幂等，可反复执行；换模型后重跑一次即可。
 *
 * ============================================
 * 各表的文本构成**必须与原索引逻辑逐字一致**
 * ============================================
 * 这是本脚本唯一有技术风险的地方：如果回填时用的文本构成和当初不同，
 * 检索质量会与设计意图偏离。下表来源已在代码里逐处核对：
 * - code_chunks       ← indexing/indexer.ts:216   `${symbolName} ${symbolType}\n${code}`
 * - functions         ← indexing/enhanced-indexer.ts:497  `${signature}\n${code.slice(0,500)}`
 * - classes           ← indexing/enhanced-indexer.ts:509  `${classType} ${fullName}\n${code.slice(0,500)}`
 * - string_constants  ← indexing/enhanced-indexer.ts:484  `${symbolName}: ${stringValue} (${constantType})`
 * - url_patterns      ← indexing/enhanced-indexer.ts:541  `${method || 'HTTP'} ${pattern}\n${definitionCode}`
 *
 * 注意 functions / classes 对 code 做了 **500 字符截断**，回填时必须一并保留，
 * 否则同一份代码在两种粒度下会产出不同向量。
 *
 * ============================================
 * 用法
 * ============================================
 *   # 全部表（默认；会填入此前从未生成过向量的行，如 url_patterns）
 *   pnpm --filter @codelens/api reembed
 *
 *   # 只刷指定表（可重复；先小范围验证效果时用）
 *   pnpm --filter @codelens/api reembed -- --table=code_chunks
 *
 *   # 试跑：只统计将要处理多少行，不写库
 *   pnpm --filter @codelens/api reembed -- --dry-run
 *
 *   # 只重算「本来就有向量」的行，不补历史缺口
 *   pnpm --filter @codelens/api reembed -- --only-existing
 *
 * 服务器上（需显式带 env 文件，PM2 的 env_production 不会进到手工 shell）：
 *   node --env-file-if-exists=.env.production apps/api/dist/scripts/reembed.js
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { generateEmbedding } from '../llm/embeddings.js';
import { describeError } from '../utils/errors.js';

// 与本项目其他运维脚本（reindex / rebuild-graph）保持一致的连库方式：
// 自建连接池，而不是复用 db/index.ts 的单例，避免与长驻进程的配置纠缠。
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

interface TableSpec {
  /** 表名 */
  table: string;
  /** 人类可读的说明 */
  label: string;
  /** 取「id + 用于生成向量的文本列」的 SQL */
  selectSql: string;
  /**
   * 由数据库行拼出与当初完全一致的嵌入文本
   * @returns 文本；返回空字符串表示该行无法生成（会被跳过并计入 skipped）
   */
  buildText: (row: Record<string, unknown>) => string;
  /** 参与生成向量的字段非空判断（避免把 undefined 拼进字符串） */
  requiredFields: string[];
}

const TABLE_SPECS: TableSpec[] = [
  {
    table: 'code_chunks',
    label: '代码块（/ask、/search 向量检索的主表）',
    selectSql: `SELECT id, symbol_name, symbol_type, code_text FROM code_chunks ORDER BY id`,
    requiredFields: ['code_text'],
    buildText: (r) => `${r.symbol_name ?? ''} ${r.symbol_type ?? ''}\n${r.code_text ?? ''}`,
  },
  {
    table: 'functions',
    label: '函数',
    selectSql: `SELECT id, signature, code FROM functions ORDER BY id`,
    requiredFields: ['code'],
    // 与原逻辑一致：code 截断 500 字符
    buildText: (r) => `${r.signature ?? ''}\n${String(r.code ?? '').slice(0, 500)}`,
  },
  {
    table: 'classes',
    label: '类',
    selectSql: `SELECT id, class_type, full_name, code FROM classes ORDER BY id`,
    requiredFields: ['code'],
    buildText: (r) => `${r.class_type ?? ''} ${r.full_name ?? ''}\n${String(r.code ?? '').slice(0, 500)}`,
  },
  {
    table: 'string_constants',
    label: '字符串常量（含 URL 片段）',
    selectSql: `SELECT id, symbol_name, string_value, constant_type FROM string_constants ORDER BY id`,
    requiredFields: ['symbol_name'],
    buildText: (r) => `${r.symbol_name ?? ''}: ${r.string_value ?? ''} (${r.constant_type ?? ''})`,
  },
  {
    table: 'url_patterns',
    label: 'URL 模式',
    selectSql: `SELECT id, method, pattern, definition_code FROM url_patterns ORDER BY id`,
    requiredFields: ['pattern'],
    buildText: (r) => `${r.method || 'HTTP'} ${r.pattern ?? ''}\n${r.definition_code ?? ''}`,
  },
];

/** 命令行参数 */
interface Options {
  tables: string[] | null;
  dryRun: boolean;
  onlyExisting: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { tables: null, dryRun: false, onlyExisting: false, concurrency: 4 };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--only-existing') opts.onlyExisting = true;
    else if (arg.startsWith('--table=')) {
      (opts.tables ||= []).push(arg.slice('--table='.length));
    } else if (arg.startsWith('--concurrency=')) {
      const n = parseInt(arg.slice('--concurrency='.length), 10);
      if (Number.isFinite(n) && n > 0) opts.concurrency = n;
    } else if (arg.startsWith('--')) {
      console.warn(`忽略未知参数: ${arg}`);
    }
  }
  return opts;
}

/**
 * 带重试地生成一个向量
 *
 * 外部 API 偶发 429 / 网络抖动是常态，单次失败不应该让整轮重刷白跑。
 */
async function embedWithRetry(text: string, attempts = 3): Promise<number[]> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await generateEmbedding(text);
    } catch (error) {
      lastError = error;
      if (i < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * i));
      }
    }
  }
  throw lastError;
}

interface TableResult {
  table: string;
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  dimension: number | null;
}

async function processTable(spec: TableSpec, opts: Options): Promise<TableResult> {
  const where = opts.onlyExisting ? ` WHERE embedding IS NOT NULL` : '';
  const rows: Array<Record<string, unknown>> = (
    await pool.query(spec.selectSql.replace(/ ORDER BY id$/, `${where} ORDER BY id`))
  ).rows;

  const result: TableResult = {
    table: spec.table,
    total: rows.length,
    updated: 0,
    skipped: 0,
    failed: 0,
    dimension: null,
  };

  console.log(`\n[${spec.table}] ${spec.label}`);
  console.log(`  待处理行数: ${rows.length}${opts.onlyExisting ? '（仅已有向量的行）' : ''}`);

  if (opts.dryRun || rows.length === 0) {
    return result;
  }

  // 先算好每行的文本，把不可用的行挑出来
  const tasks: Array<{ id: number | string; text: string }> = [];
  for (const row of rows) {
    const usable = spec.requiredFields.every((f) => {
      const v = row[f];
      return typeof v === 'string' ? v.trim().length > 0 : v !== null && v !== undefined;
    });
    if (!usable) {
      result.skipped++;
      continue;
    }
    const text = spec.buildText(row);
    if (!text.trim()) {
      result.skipped++;
      continue;
    }
    tasks.push({ id: row.id as number, text });
  }

  if (result.skipped > 0) {
    console.log(`  跳过（文本为空/关键字段缺失）: ${result.skipped}`);
  }

  // 并发处理（外部 API 有速率限制，默认并发 4）
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, tasks.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      try {
        const embedding = await embedWithRetry(task.text);
        await pool.query(`UPDATE ${spec.table} SET embedding = $1 WHERE id = $2`, [
          `[${embedding.join(',')}]`,
          task.id,
        ]);
        result.updated++;
        result.dimension = embedding.length;
      } catch (error) {
        result.failed++;
        console.error(`  ✗ id=${task.id} 失败: ${describeError(error)}`);
      }
      done++;
      if (done % 25 === 0 || done === tasks.length) {
        process.stdout.write(`\r  进度 ${done}/${tasks.length}  (成功 ${result.updated}, 失败 ${result.failed})`);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write('\n');

  return result;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const specs = TABLE_SPECS.filter((s) => !opts.tables || opts.tables.includes(s.table));
  if (specs.length === 0) {
    console.error(`没有匹配的表。可选: ${TABLE_SPECS.map((s) => s.table).join(', ')}`);
    process.exit(1);
  }

  console.log('='.repeat(64));
  console.log('向量重刷（re-embed）');
  console.log('='.repeat(64));
  console.log(`嵌入模型 : ${process.env.EMBED_MODEL || '(未设置)'}`);
  console.log(`端点     : ${process.env.EMBED_BASE_URL || '(未设置)'}`);
  console.log(`目标维度 : ${process.env.EMBED_DIMENSIONS || '(未设置)'}`);
  console.log(`处理表   : ${specs.map((s) => s.table).join(', ')}`);
  console.log(`模式     : ${opts.dryRun ? '试跑（不写库）' : '实际写入'}`);

  if (!opts.dryRun && !process.env.EMBED_API_KEY) {
    console.error('\n✗ 缺少 EMBED_API_KEY，无法生成向量');
    process.exit(2);
  }

  const results: TableResult[] = [];
  for (const spec of specs) {
    results.push(await processTable(spec, opts));
  }

  console.log('\n' + '='.repeat(64));
  console.log('汇总');
  console.log('='.repeat(64));
  console.log('  ' + '表'.padEnd(20) + '总行数'.padStart(8) + '已更新'.padStart(8) + '跳过'.padStart(8) + '失败'.padStart(8));
  for (const r of results) {
    console.log(
      '  ' +
        r.table.padEnd(20) +
        String(r.total).padStart(8) +
        String(r.updated).padStart(8) +
        String(r.skipped).padStart(8) +
        String(r.failed).padStart(8)
    );
  }

  const dims = [...new Set(results.map((r) => r.dimension).filter((d): d is number => d !== null))];
  if (dims.length > 0) {
    console.log(`\n生成向量维度: ${dims.join(', ')}`);
    const expected = Number(process.env.EMBED_DIMENSIONS || 0);
    if (expected && dims.some((d) => d !== expected)) {
      console.error(`✗ 维度与 EMBED_DIMENSIONS=${expected} 不一致，请检查模型是否支持该维度`);
      process.exitCode = 1;
    }
  }

  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  if (totalFailed > 0) {
    console.error(`\n✗ 有 ${totalFailed} 行失败，请查看上方错误后重跑本脚本（幂等）`);
    process.exitCode = 1;
  } else if (!opts.dryRun) {
    console.log('\n✓ 完成。建议接着验证：/ask 普通查询应能检索到证据（不再是「证据为空」）');
  }
}

main()
  .catch((error) => {
    console.error('reembed 异常退出:');
    console.error(describeError(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
