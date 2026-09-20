/**
 * 逐表 A/B 闸门：**增量索引的结果** 与 **全量重建的结果** 是否一致
 *
 * ============================================
 * 为什么必须跑它，而不是「探针通过 + 类型检查通过」就算完
 * ============================================
 * 真增量（`indexMultipleFiles`）与全量重建（`indexCodebase`）是**两条独立实现的写库路径**。
 * 它们要产出同一份索引，但走的是完全不同的编排：
 *   全量：逐文件 `indexFileWith`（解析→实体→关系→向量），末尾统一物化 file_dependencies；
 *   增量：删旧的实体/关系 → 逐文件重建 → **整仓**重算 call_graph → 回收孤儿接口行。
 * 只要有一处「增量忘了做、全量做了」或者「增量多删了」，检索就会给出**看起来正常但错误**的结果：
 * 幽灵函数、指向别处的证据、缺边的调用图。这类问题不会抛异常，只会安静地烂掉。
 * 所以唯一可信的判据是：**同一份磁盘内容，两条路走完，每一张表逐行一致。**
 *
 * ============================================
 * 四个必须踩对的点（错了会得到「假阳性的一致」）
 * ============================================
 * 1. **「重跑 indexCodebase」不是全量重建。** 它自带断点续传，`files` 表里登记过的路径
 *    会被跳过 —— 重跑等于什么都没做，两边都拿空快照互比，报「完全一致」。
 *    必须先 `clearRepoData(repoId)` 再 `indexCodebase(repoId, repoPath)`。
 * 2. **快照的键里不能出现任何 id。** `code_chunks.id` / `functions.id` / `file_id` 在重建后
 *    全部会变，拿它们做键会让两次重建之间「处处不同」。全部解析成**路径 + 行号**。
 * 3. **`code_chunks.repo_id` 全是 NULL**（既有数据如此）⇒ 归属一律 JOIN `files.repo_id`。
 *    按 `code_chunks.repo_id` 过滤会把两边都过滤成空集，又是一次假一致。
 * 4. **call_graph 的 `from_chunk_id` 会随 chunk 重写而变** ⇒ 键取
 *    `(from 文件路径, from 符号名, to_symbol, call_line, call_type)`，不取 chunk id。
 *
 * ============================================
 * 允许的差异（必须逐条解释，不是「忽略」）
 * ============================================
 * - `constant_references`：跨文件引用有**顺序依赖** —— A 导出常量、B 引用它，
 *   若 A 的重建排在 B 之前，A 看不到 B 的 import 行。全量重建有同样的问题
 *   （不是增量引入的退化），见 TECHNICAL-NOTES §20。
 * - `call_graph`：`to_chunk_id` 的解析结果可能不同（同名符号多处定义时取哪一个是
 *   依赖插入顺序的）。但 `to_symbol` 必须一致 —— 不一致就是真 bug。
 * 本脚本**不自动豁免**任何表：差异全部打出来，由人判断属于哪一类。
 * 自动豁免等于把闸门关掉。
 *
 * ============================================
 * 用法
 * ============================================
 *   # 在服务器上（库只监听服务器本机）
 *   cd /root/CodeLens/apps/api
 *   node --env-file-if-exists=.env.production dist/scripts/ab-incremental-gate.js --repo=30
 *
 *   # 本地用 tsx（需要库可达，本机连不上 ⇒ 只能连本地/隧道）
 *   ./node_modules/.bin/tsx src/scripts/ab-incremental-gate.ts --repo=30
 *
 * 参数：
 *   --repo=<id>   要测的仓库（默认 30）。**不要用 29**（那是人工维护的基线语料）
 *   --path=<dir>  仓库在磁盘上的目录（默认 /tmp/codelens-repos/<repo>）
 *   --keep        跑完不还原磁盘、不做收尾重建（快，但会把该仓库留在「磁盘已改、
 *                 索引是最后一次全量」的状态；只在你不在乎这个仓库时用）
 *
 * ⚠️ 这个脚本会 **清空并重建** 指定仓库的索引（这是它的工作原理）。
 *    别对不想动的仓库跑。
 */

import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { clearRepoData } from '../db/index.js';
import { indexCodebase, indexMultipleFiles } from '../indexing/indexer.js';

// ---------------------------------------------------------------- 参数

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const REPO_ID = parseInt(arg('repo', '30'), 10);
const REPO_PATH = arg('path', `/tmp/codelens-repos/${REPO_ID}`);
const KEEP = process.argv.includes('--keep');

if (!Number.isFinite(REPO_ID)) {
  console.error('--repo 必须是数字');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ---------------------------------------------------------------- 快照

/**
 * 每张表的规范化投影。
 *
 * 全部解析成**路径 + 行号 + 名字**，一个 id 都不出现 —— 理由见文件头第 2 点。
 * 每行拼成一个字符串，最后整体排序：比对集合时不需要关心插入顺序。
 */
const PROJECTIONS: Array<{ table: string; sql: string }> = [
  {
    table: 'code_chunks',
    sql: `SELECT f.path || ' | ' || cc.symbol_name || ' | ' || cc.symbol_type || ' | ' ||
                 cc.line_start || '-' || cc.line_end AS k
          FROM code_chunks cc
          JOIN files f ON f.id = cc.file_id
          WHERE f.repo_id = $1`,
  },
  {
    table: 'functions',
    sql: `SELECT f.path || ' | ' || fu.name || ' | ' || fu.line_start || '-' || fu.line_end || ' | ' ||
                 COALESCE(fu.function_type,'') || ' | ' || COALESCE(fu.is_exported::text,'') || ' | ' ||
                 COALESCE(fu.full_name,'') AS k
          FROM functions fu
          JOIN files f ON f.id = fu.file_id
          WHERE fu.repo_id = $1`,
  },
  {
    table: 'classes',
    sql: `SELECT f.path || ' | ' || cl.name || ' | ' || cl.line_start || '-' || cl.line_end || ' | ' ||
                 COALESCE(cl.class_type,'') AS k
          FROM classes cl
          JOIN files f ON f.id = cl.file_id
          WHERE cl.repo_id = $1`,
  },
  {
    table: 'string_constants',
    sql: `SELECT f.path || ' | ' || COALESCE(sc.symbol_name,'∅') || ' | ' || sc.string_value ||
                 ' | ' || sc.line_start AS k
          FROM string_constants sc
          JOIN files f ON f.id = sc.file_id
          WHERE sc.repo_id = $1`,
  },
  {
    // url_patterns 是**跨文件共享**的（一个接口一行），所以键里带 definition 路径
    table: 'url_patterns',
    sql: `SELECT COALESCE(up.method,'') || ' ' || COALESCE(up.normalized_pattern,'') ||
                 ' | def=' || COALESCE(fd.path,'∅') || ':' || COALESCE(up.definition_line::text,'-') AS k
          FROM url_patterns up
          LEFT JOIN files fd ON fd.id = up.definition_file_id
          WHERE up.repo_id = $1`,
  },
  {
    table: 'url_usages',
    sql: `SELECT fu.path || ' | ' || COALESCE(uu.usage_line::text,'-') || ' | ' ||
                 COALESCE(uu.usage_context,'') || ' | ' || COALESCE(uu.http_method,'') || ' => ' ||
                 COALESCE(up.method,'') || ' ' || COALESCE(up.normalized_pattern,'') AS k
          FROM url_usages uu
          JOIN files fu ON fu.id = uu.usage_file_id
          JOIN url_patterns up ON up.id = uu.url_pattern_id
          WHERE uu.repo_id = $1`,
  },
  {
    table: 'import_relations',
    sql: `SELECT fi.path || ' | ' || COALESCE(ir.importer_line::text,'-') || ' => ' ||
                 COALESCE(ft.path,'(external)') || ' | ' || COALESCE(ir.imported_symbol,'') ||
                 ' | ' || COALESCE(ir.import_type,'') || ' | ' || ir.import_path AS k
          FROM import_relations ir
          JOIN files fi ON fi.id = ir.importer_file_id
          LEFT JOIN files ft ON ft.id = ir.imported_file_id
          WHERE ir.repo_id = $1`,
  },
  {
    table: 'constant_references',
    sql: `SELECT fr.path || ' | ' || COALESCE(cr.referrer_line::text,'-') || ' => ' ||
                 COALESCE(sc.symbol_name,'∅') || '=' || sc.string_value || ' @' || fc.path || ':' ||
                 sc.line_start || ' | ' || COALESCE(cr.reference_type,'') AS k
          FROM constant_references cr
          JOIN string_constants sc ON sc.id = cr.constant_id
          JOIN files fc ON fc.id = sc.file_id
          JOIN files fr ON fr.id = cr.referrer_file_id
          WHERE cr.repo_id = $1`,
  },
  {
    // ⚠️ 键里**不能**出现 from_chunk_id（重建后必变）⇒ 用 from 文件 + from 符号名定位
    table: 'call_graph',
    sql: `SELECT ff.path || ' | ' || cc.symbol_name || ' | ' || cc.line_start || ' ==> ' ||
                 cg.to_symbol || ' @' || COALESCE(cg.call_line::text,'-') || ' [' ||
                 COALESCE(cg.call_type,'') || ']' AS k
          FROM call_graph cg
          JOIN code_chunks cc ON cc.id = cg.from_chunk_id
          JOIN files ff ON ff.id = cc.file_id
          WHERE ff.repo_id = $1`,
  },
  {
    table: 'file_dependencies',
    sql: `SELECT fs.path || ' => ' || ft.path || ' | n=' || d.dependency_count || ' | ' ||
                 COALESCE(d.dependency_types::text,'') AS k
          FROM file_dependencies d
          JOIN files fs ON fs.id = d.source_file_id
          JOIN files ft ON ft.id = d.target_file_id
          WHERE d.repo_id = $1`,
  },
];

type Snapshot = Record<string, string[]>;

async function dump(): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const p of PROJECTIONS) {
    const res = await pool.query(p.sql, [REPO_ID]);
    out[p.table] = res.rows.map((r: { k: string }) => r.k).sort();
  }
  return out;
}

/**
 * 逐表比集合。
 *
 * 刻意**只报差异、不做任何自动豁免**：如果把「允许的差异」写成代码里的白名单，
 * 这个闸门就等于关掉了 —— 真正的 bug 也会落进白名单里安静地通过。
 * 差异全部打出来，由人判断属于「顺序依赖」还是真 bug。
 */
function diff(
  nameA: string,
  nameB: string,
  a: Snapshot,
  b: Snapshot
): { table: string; same: boolean; text: string }[] {
  const rows: { table: string; same: boolean; text: string }[] = [];
  for (const p of PROJECTIONS) {
    const t = p.table;
    const setA = new Map<string, number>();
    for (const k of a[t]) setA.set(k, (setA.get(k) ?? 0) + 1);
    const setB = new Map<string, number>();
    for (const k of b[t]) setB.set(k, (setB.get(k) ?? 0) + 1);

    const onlyA: string[] = [];
    const onlyB: string[] = [];
    for (const [k, n] of setA) {
      const m = setB.get(k) ?? 0;
      for (let i = n; i > m; i--) onlyA.push(k);
    }
    for (const [k, n] of setB) {
      const m = setA.get(k) ?? 0;
      for (let i = n; i > m; i--) onlyB.push(k);
    }

    const same = onlyA.length === 0 && onlyB.length === 0;
    const lines: string[] = [];
    lines.push(
      `${same ? '  OK  ' : '  DIFF'} ${t.padEnd(20)} ${nameA}=${String(a[t].length).padStart(6)}  ` +
        `${nameB}=${String(b[t].length).padStart(6)}`
    );
    if (!same) {
      lines.push(`       只在 ${nameA} 里（${onlyA.length} 条）：`);
      for (const k of onlyA.slice(0, 8)) lines.push(`         A> ${k}`);
      if (onlyA.length > 8) lines.push(`         … 其余 ${onlyA.length - 8} 条`);
      lines.push(`       只在 ${nameB} 里（${onlyB.length} 条）：`);
      for (const k of onlyB.slice(0, 8)) lines.push(`         B> ${k}`);
      if (onlyB.length > 8) lines.push(`         … 其余 ${onlyB.length - 8} 条`);
    }
    rows.push({ table: t, same, text: lines.join('\n') });
  }
  return rows;
}

// ---------------------------------------------------------------- 磁盘改动

interface Mutation {
  kind: 'modify' | 'delete' | 'rename' | 'create';
  path: string;
  toPath?: string;
  /** 还原用 */
  originalContent?: string;
}

const STAMP = `gate${Date.now().toString(36)}`;

/**
 * 在磁盘上造出「修改 / 删除 / 重命名 / 新增」四类改动。
 *
 * 只挑 `.ts/.js/.tsx/.jsx`：`.vue` 的内容改动要落在 `<script>` 里，
 * 用文本追加很容易造出语法坏掉的文件，那样测的就变成「解析器容错」而不是「增量正确性」。
 * 删除与重命名对 `.vue` 是安全的，但为了可复现性这里也一并限制。
 */
async function mutate(): Promise<Mutation[]> {
  const candidates = await pool.query(
    `SELECT path FROM files
     WHERE repo_id = $1 AND path ~ '\\.(ts|tsx|js|jsx)$'
     ORDER BY path`,
    [REPO_ID]
  );
  const paths: string[] = candidates.rows.map((r: { path: string }) => r.path);
  if (paths.length < 6) {
    throw new Error(`可改动的候选文件太少（${paths.length}），无法构造有意义的 A/B`);
  }

  const mutations: Mutation[] = [];

  // ---- 1) 修改：往文件末尾追加一个新函数（应当产生新的 functions / code_chunks / 可能的调用边）----
  const p1 = paths[0];
  const c1 = await readFile(join(REPO_PATH, p1), 'utf-8');
  await writeFile(
    join(REPO_PATH, p1),
    `${c1}\n/** ${STAMP} 追加 */\nexport function ${STAMP}Added(x: number) {\n  return x + 1;\n}\n`
  );
  mutations.push({ kind: 'modify', path: p1, originalContent: c1 });

  // ---- 2) 修改：把文件里已有的一个函数改名，并再加一个（应当同时产生「删除」与「新增」）----
  const p2 = paths[1];
  const c2 = await readFile(join(REPO_PATH, p2), 'utf-8');
  const fnRow = await pool.query(
    `SELECT fu.name FROM functions fu
     JOIN files f ON f.id = fu.file_id
     WHERE f.repo_id = $1 AND f.path = $2
     ORDER BY fu.line_start LIMIT 1`,
    [REPO_ID, p2]
  );
  const existing = fnRow.rows[0]?.name as string | undefined;
  let c2new = c2;
  if (existing && /^[A-Za-z_$][\w$]*$/.test(existing)) {
    // 只替换标识符出现处，避免误伤字符串里的同名词
    c2new = c2.replace(new RegExp(`\\b${existing}\\b`, 'g'), `${STAMP}Renamed`);
  }
  await writeFile(
    join(REPO_PATH, p2),
    `${c2new}\n/** ${STAMP} 追加 */\nexport function ${STAMP}Second() {\n  return 2;\n}\n`
  );
  mutations.push({ kind: 'modify', path: p2, originalContent: c2 });

  // ---- 3) 删除：整文件消失（最能暴露「删除后残留」的问题）----
  const p3 = paths[2];
  const c3 = await readFile(join(REPO_PATH, p3), 'utf-8');
  await rm(join(REPO_PATH, p3));
  mutations.push({ kind: 'delete', path: p3, originalContent: c3 });

  // ---- 4) 重命名：旧路径消失 + 新路径出现（增量要同时删旧行、建新行）----
  const p4 = paths[3];
  const p4new = p4.replace(/\.(ts|tsx|js|jsx)$/, `.${STAMP}$1`);
  const c4 = await readFile(join(REPO_PATH, p4), 'utf-8');
  await rename(join(REPO_PATH, p4), join(REPO_PATH, p4new));
  mutations.push({ kind: 'rename', path: p4, toPath: p4new, originalContent: c4 });

  // ---- 5) 新增：一个全新的文件 ----
  const p5 = `src/__${STAMP}__.ts`;
  await writeFile(
    join(REPO_PATH, p5),
    `export const ${STAMP}Value = '${STAMP}';\nexport function ${STAMP}Fresh() { return ${STAMP}Value; }\n`
  );
  mutations.push({ kind: 'create', path: p5 });

  return mutations;
}

/** 把改动还原回磁盘原状 */
async function restore(mutations: Mutation[]): Promise<void> {
  for (const m of mutations) {
    if (m.kind === 'create') {
      await rm(join(REPO_PATH, m.path), { force: true });
    } else if (m.kind === 'rename') {
      await rename(join(REPO_PATH, m.toPath!), join(REPO_PATH, m.path));
    } else {
      await writeFile(join(REPO_PATH, m.path), m.originalContent!);
    }
  }
}

/** 改动涉及的**相对路径**集合（增量接口吃这个）——重命名要同时给旧路径与新路径 */
function changedPaths(mutations: Mutation[]): string[] {
  const out = new Set<string>();
  for (const m of mutations) {
    out.add(m.path);
    if (m.toPath) out.add(m.toPath);
  }
  return [...out];
}

// ---------------------------------------------------------------- 主流程

async function fullRebuild(tag: string): Promise<void> {
  const t0 = Date.now();
  console.log(`\n[${tag}] 全量重建：clearRepoData → indexCodebase …`);
  await clearRepoData(REPO_ID);
  await indexCodebase(REPO_ID, REPO_PATH);
  console.log(`[${tag}] 全量重建完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function main(): Promise<void> {
  console.log('='.repeat(78));
  console.log(`增量 vs 全量 逐表 A/B 闸门   repo=${REPO_ID}  path=${REPO_PATH}`);
  console.log(`keep(不还原)=${KEEP}`);
  console.log('='.repeat(78));

  const st = await stat(REPO_PATH).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(`仓库目录不存在：${REPO_PATH}`);
  }

  // ---------- 基线：真正的全量重建，然后快照 A ----------
  await fullRebuild('A/基线');
  const snapA = await dump();

  // ---------- 造改动 ----------
  console.log('\n[M] 在磁盘上造改动 …');
  const mutations = await mutate();
  for (const m of mutations) {
    console.log(
      `  ${m.kind.padEnd(7)} ${m.path}${m.toPath ? ` → ${m.toPath}` : ''}`
    );
  }
  const touched = changedPaths(mutations);
  console.log(`  送进增量接口的路径（${touched.length} 条）：${touched.join(', ')}`);

  // ---------- 增量 ----------
  console.log('\n[I] 走增量：indexMultipleFiles …');
  const t1 = Date.now();
  const outcome = await indexMultipleFiles(REPO_ID, REPO_PATH, touched);
  console.log(`[I] 增量完成，用时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (!outcome) {
    // 这一步返回 null 说明「内容与库里一致」——改动在磁盘上真的发生了，不该出现
    console.log('  ⚠️ indexMultipleFiles 返回 null（判定为无变更）——检查磁盘改动是否真的落盘了');
  } else {
    console.log(
      `  增量自报：新增 ${outcome.added.length} / 修改 ${outcome.modified.length} / ` +
        `删除 ${outcome.deleted.length} / 传导重建 ${outcome.propagated.length}，` +
        `实体层重建 ${outcome.rebuiltFiles} 个文件`
    );
    console.log(
      `  实体差集：+${outcome.entities.counts.added} / -${outcome.entities.counts.removed} / ` +
        `~${outcome.entities.counts.moved}（truncated=${outcome.entities.truncated}）`
    );
  }
  const snapInc = await dump();

  // ---------- 收尾：再全量重建一次，得到「正确答案」----------
  await fullRebuild('B/参照');
  const snapFull = await dump();

  // ---------- 主比对：增量结果 vs 全量重建结果 ----------
  console.log('\n' + '='.repeat(78));
  console.log('主比对：B_inc（增量结果） vs B_full（全量重建结果）');
  console.log('='.repeat(78));
  let rows = diff('B_inc', 'B_full', snapInc, snapFull);
  for (const r of rows) console.log(r.text);
  const bad = rows.filter((r) => !r.same);

  if (!KEEP) {
    // 还原磁盘 → 再全量重建 → 应当与基线 A 完全一致。
    // 这一步同时证明两件事：全量重建是确定性的；增量没有留下无法清除的残渣。
    console.log('\n[R] 还原磁盘并收尾重建（验证「还原后 == 基线」）…');
    await restore(mutations);
    await fullRebuild('C/收尾');
    const snapC = await dump();

    console.log('\n' + '='.repeat(78));
    console.log('副比对：C（还原后全量） vs A（基线全量）——用来证明全量重建是确定性的');
    console.log('='.repeat(78));
    const rows2 = diff('C', 'A', snapC, snapA);
    for (const r of rows2) console.log(r.text);
    const bad2 = rows2.filter((r) => !r.same);
    console.log(
      bad2.length === 0
        ? '\n还原后与基线完全一致 ⇒ 全量重建可重复，磁盘已复原。'
        : `\n⚠️ 还原后与基线仍有 ${bad2.length} 张表不同（见上）。这本身不一定是 bug，` +
          `但「全量重建」若不可重复，上面主比对的结论就不能当作定论。`
    );
  } else {
    console.log('\n（--keep：磁盘改动未还原，该仓库的索引停留在「磁盘已改」的状态）');
  }

  console.log('\n' + '='.repeat(78));
  if (bad.length === 0) {
    // ⚠️ 不要写死「8/8 张表」这种数字 —— PROJECTIONS 一开始是 8 张表，
    // 后来加了 constant_references / file_dependencies 变成 10 张，
    // 文案没跟着改就会显示「逐表一致（8/8）」却列出 10 张表，
    // 让读的人怀疑闸门本身是不是也在自欺。数量一律由 PROJECTIONS 推出来。
    console.log(
      `结论：✅ 增量结果与全量重建逐表一致（${rows.length}/${PROJECTIONS.length} 张表）`
    );
  } else {
    console.log(
      `结论：❌ 有 ${bad.length} 张表不一致：${bad.map((r) => r.table).join(', ')}\n` +
        '      逐一判断属于「允许的差异（顺序依赖）」还是真 bug —— 自动豁免等于关掉闸门。'
    );
  }
  console.log('='.repeat(78));
  console.log(`表清单：${PROJECTIONS.map((p) => p.table).join(' / ')}`);

  await pool.end();
  if (bad.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('闸门执行失败：', error);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
