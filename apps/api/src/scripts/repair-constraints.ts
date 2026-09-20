#!/usr/bin/env node

/**
 * 修复「批量清理期间被摘除、之后没能挂回」的外键约束，并顺带清理阻塞它们的孤儿行
 *
 * ============================================
 * 这个脚本要解决的问题（2026-09-19 真实事故）
 * ============================================
 * `clearRepoData()` 会把 8 个外键约束摘掉（加速批量删除），删完再挂回。
 * 旧实现用了一个 `DO $$ … ADD CONSTRAINT … $$` 块，**块内没有异常处理**：
 * 只要有一条 `ALTER` 因存量行违反约束而失败，整条 `pool.query` 就抛错，
 * 外层 `for` 循环中断 ⇒ 数组中**排在它后面的约束一个都不会创建**。
 *
 * 线上后果（实测）：
 *   - `pg_constraint` 里只剩 2 个外键，其余 **6 个永久缺失**；
 *   - `DELETE /repos/:id` 依赖 `ON DELETE CASCADE`，缺 `string_constants_repo_id_fkey`
 *     就静默不级联 ⇒ 留下 **684 行孤儿** `string_constants`（repo_id 指向已删仓库）;
 *   - 孤儿行又让 `ADD CONSTRAINT` 继续失败 ⇒ **自锁死，永远修不回来**。
 *
 * 本脚本把这条链拆开：先按每个外键的 `ON DELETE` 语义清掉违规行，
 * 再逐个（独立 try/catch）挂回约束，最后校验。
 *
 * ============================================
 * 用法
 * ============================================
 *   默认 = 挂回约束（**非破坏性**：不删任何一行）：
 *     pnpm --filter @codelens/api repair:constraints
 *
 *   注意：默认模式**确实会写库** —— 它会挂回缺失的外键。
 *   `ADD CONSTRAINT` / `ADD CONSTRAINT … NOT VALID` 都是幂等且无损的
 *   （NOT VALID 只是跳过存量行的校验），所以不需要授权即可跑。
 *   它**不会**删除或修改任何业务数据。
 *
 *   --fix = 额外按 ON DELETE 语义清理阻塞外键的孤儿行（**破坏性，会删行**）：
 *     pnpm --filter @codelens/api repair:constraints -- --fix
 *
 *   服务器上（dist 已构建）：
 *     node --env-file-if-exists=.env.production apps/api/dist/scripts/repair-constraints.js          # 挂回约束
 *     node --env-file-if-exists=.env.production apps/api/dist/scripts/repair-constraints.js --fix    # 连孤儿行一起修
 *
 *   跑 --fix 前请先备份，例如：
 *     psql -c "\copy (SELECT t.* FROM string_constants t WHERE t.repo_id IS NOT NULL
 *       AND NOT EXISTS (SELECT 1 FROM repos p WHERE p.id = t.repo_id)) TO 'orphans.csv' CSV HEADER"
 *
 * 连接参数取 DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD（会加载 .env）。
 *
 * 退出码：0 = 8 个外键齐全且全部 validated；1 = 仍有缺失/未校验；
 *         2 = 脚本自身失败（连不上库等）
 */

import 'dotenv/config';
import { pool, FK_CONSTRAINTS, ensureForeignKeyConstraints, validateForeignKeyConstraints } from '../db/index.js';
import { describeError } from '../utils/errors.js';

const FIX = process.argv.includes('--fix');

/** 从 `FOREIGN KEY (a) REFERENCES b(c) ON DELETE …` 里解析出结构 */
const FK_RE = /FOREIGN KEY \(([\w"]+)\) REFERENCES ([\w"]+)\(([\w"]+)\)(?: ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION))?/i;

interface ParsedFk {
  table: string;
  name: string;
  column: string;
  parentTable: string;
  parentColumn: string;
  onDelete: string;
}

function parseFk(c: (typeof FK_CONSTRAINTS)[number]): ParsedFk {
  const m = FK_RE.exec(c.definition);
  if (!m) throw new Error(`无法解析约束定义：${c.name} → ${c.definition}`);
  const unquote = (s: string) => s.replace(/"/g, '');
  return {
    table: c.table,
    name: c.name,
    column: unquote(m[1]),
    parentTable: unquote(m[2]),
    parentColumn: unquote(m[3]),
    onDelete: (m[4] || 'NO ACTION').toUpperCase(),
  };
}

interface OrphanReport {
  fk: ParsedFk;
  orphans: number;
  action: string;
  applied: boolean;
  error?: string;
}

/**
 * 按外键自身的 `ON DELETE` 语义决定怎么修：
 *   CASCADE    → 违规行本就该随父行消失 ⇒ 直接 DELETE
 *   SET NULL   → 把该列置空（父行还在时不允许置空？置空就等于「无父」，
 *                与 FK 的行为一致，且这些列都可空）
 *   其它       → 只报告，不动手（RESTRICT/NO ACTION 说明父行可能还在，风险高）
 */
function planFor(fk: ParsedFk): { sql: string; action: string } | null {
  const where = `t."${fk.column}" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "${fk.parentTable}" p WHERE p."${fk.parentColumn}" = t."${fk.column}")`;

  if (fk.onDelete === 'CASCADE') {
    return {
      sql: `DELETE FROM "${fk.table}" t WHERE ${where}`,
      action: 'DELETE 孤儿行',
    };
  }
  if (fk.onDelete === 'SET NULL') {
    return {
      sql: `UPDATE "${fk.table}" t SET "${fk.column}" = NULL WHERE ${where}`,
      action: 'SET NULL',
    };
  }
  return null;
}

async function countOrphans(fk: ParsedFk): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "${fk.table}" t
      WHERE t."${fk.column}" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "${fk.parentTable}" p WHERE p."${fk.parentColumn}" = t."${fk.column}")`
  );
  return parseInt(res.rows[0].n, 10);
}

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log(
    `外键约束体检与修复${FIX ? '（--fix：会删孤儿行）' : '（默认：只挂回约束，不删任何行）'}`
  );
  console.log('='.repeat(72));
  console.log(`DB: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/` +
    `${process.env.DB_NAME || 'codelens'} as ${process.env.DB_USER || 'postgres'}`);
  console.log('');

  const parsed = FK_CONSTRAINTS.map(parseFk);

  // ---- 1. 现状 ----
  const now = await pool.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint
      WHERE conname = ANY($1)`,
    [FK_CONSTRAINTS.map((c) => c.name)]
  );
  const present = new Map(now.rows.map((r) => [r.conname, r.convalidated]));

  console.log('【1】当前 8 个外键的存在情况');
  for (const c of FK_CONSTRAINTS) {
    const v = present.get(c.name);
    const state = v === undefined ? '✗ 缺失' : v ? '✓ 存在且已校验' : '△ 存在但 NOT VALID';
    console.log(`  ${state.padEnd(18)} ${c.table}.${c.name}`);
  }
  const missing = FK_CONSTRAINTS.filter((c) => !present.has(c.name));
  console.log(`  小计：存在 ${present.size}/8，缺失 ${missing.length}，未校验 ${[...present.values()].filter((v) => !v).length}`);
  console.log('');

  // ---- 2. 孤儿行 ----
  console.log('【2】阻塞外键的孤儿行');
  const reports: OrphanReport[] = [];
  for (const fk of parsed) {
    let n = 0;
    try {
      n = await countOrphans(fk);
    } catch (err) {
      reports.push({ fk, orphans: -1, action: '?', applied: false, error: describeError(err) });
      continue;
    }

    const plan = planFor(fk);
    const r: OrphanReport = { fk, orphans: n, action: plan ? plan.action : '仅报告（未定义安全动作）', applied: false };

    if (n > 0) {
      console.log(`  ⚠️  ${fk.table}.${fk.column} → ${fk.parentTable}.${fk.parentColumn}：${n} 行孤儿（ON DELETE ${fk.onDelete} / ${r.action}）`);
      if (FIX && plan) {
        try {
          const res = await pool.query(plan.sql);
          r.applied = true;
          console.log(`      → 已执行，影响 ${res.rowCount} 行`);
        } catch (err) {
          r.error = describeError(err);
          console.log(`      → 执行失败：${r.error}`);
        }
      }
    } else {
      console.log(`  ✓  ${fk.table}.${fk.column}：无孤儿`);
    }
    reports.push(r);
  }
  console.log('');

  // ---- 3. 挂回 ----
  console.log('【3】挂回缺失的外键');
  const restored = await ensureForeignKeyConstraints();
  console.log(`  正常建立 ${restored.added.length} 个：${restored.added.join(', ') || '（无）'}`);
  if (restored.notValid.length > 0) {
    console.log(`  以 NOT VALID 建立 ${restored.notValid.length} 个：${restored.notValid.join(', ')}`);
  }
  if (restored.failed.length > 0) {
    for (const f of restored.failed) console.log(`  ✗ 建立失败 ${f.name}：${f.error}`);
  }
  console.log('');

  // ---- 4. 校验 ----
  console.log('【4】校验 NOT VALID 的约束');
  const validated = await validateForeignKeyConstraints();
  if (validated.length === 0) {
    console.log('  （没有处于 NOT VALID 的约束）');
  } else {
    for (const v of validated) {
      console.log(`  ${v.ok ? '✓ 校验通过' : '✗ 仍有违规'} ${v.name}${v.error ? `：${v.error}` : ''}`);
    }
  }
  console.log('');

  // ---- 5. 收尾 ----
  const finalRows = await pool.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1)`,
    [FK_CONSTRAINTS.map((c) => c.name)]
  );
  const finalPresent = new Map(finalRows.rows.map((r) => [r.conname, r.convalidated]));
  const stillMissing = FK_CONSTRAINTS.filter((c) => !finalPresent.has(c.name));
  const stillUnvalidated = FK_CONSTRAINTS.filter((c) => finalPresent.get(c.name) === false);

  console.log('='.repeat(72));
  if (stillMissing.length === 0 && stillUnvalidated.length === 0) {
    console.log('PASS — 8 个外键全部存在且已校验');
  } else {
    const parts: string[] = [];
    if (stillMissing.length) parts.push(`缺失 ${stillMissing.length} 个（${stillMissing.map((c) => c.name).join(', ')}）`);
    if (stillUnvalidated.length) parts.push(`未校验 ${stillUnvalidated.length} 个（${stillUnvalidated.map((c) => c.name).join(', ')}）`);
    console.log(`FAIL — ${parts.join('；')}`);
    if (!FIX) console.log('提示：加 --fix 可先清理孤儿行再重试。');
  }
  console.log('='.repeat(72));

  await pool.end();
  process.exit(stillMissing.length === 0 && stillUnvalidated.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('');
  console.error('修复脚本自身失败：');
  console.error(describeError(error));
  process.exit(2);
});
