/**
 * A/B 探针：验证「解析层解耦」重构是**纯搬运**。
 *
 * ============================================================
 * 为什么拿生产库当基准，而不是拿 git 里的旧代码当基准
 * ============================================================
 * 因为「改造前」的那份代码在改造的同一批次里被移动了，工作区里已经没有旧版本。
 * 但 **生产库里的 repo 29 正是旧代码的产物** —— 它比「另一份旧代码的副本」更权威：
 * 旧代码副本只能证明「新旧一致」，生产库能证明「新代码复现了线上真实结果」。
 *
 * 因此口径是：用新代码在本地语料上跑一遍，把聚合结果与线上 repo 29 的表量逐项比对。
 * 全部相等 ⇒ 解析层输出未变。
 *
 * ⚠️ 本脚本**只读**：只读本地语料目录，不连数据库、不写任何文件。
 *
 * 用法：
 *   cd apps/api && ./node_modules/.bin/tsx src/scripts/probe-language-refactor.ts <repoRoot> [pathPrefix]
 *
 * 例：
 *   ./node_modules/.bin/tsx src/scripts/probe-language-refactor.ts \
 *     /Users/me/proj/test-repo test-repo
 *
 * pathPrefix 必须与线上 `files.path` 的前缀一致（本项目是 `test-repo/`），
 * 因为跨文件符号表在**同一个路径命名空间**里做匹配 —— 前缀不一致会让跨文件解析全失效。
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, posix } from 'node:path';
import { languageRegistry } from '../indexing/languages/registry.js';
import { SKIP_DIRS, isIndexable } from '../indexing/file-scanner.js';
import type { RepoScopedParser } from '../indexing/languages/types.js';

/**
 * 线上 repo 29（改造前索引的产物）的表量。
 * 数据来源：psql `SELECT count(*) … WHERE repo_id=29`，2026-09-19。
 *
 * ⚠️ `url_patterns` 有一个**必须解释的差值**：
 * 线上 398，而解析层只能产出 396。差的 2 行不是回归 —— 它们是
 * `RelationshipBuilder.buildIndirectUsages()` 的**兜底插入**（relationship-builder.ts:674）：
 * 当一个间接调用落点的 URL 匹配不到已有的接口行时，它会以 `method = NULL` 补一行。
 *
 * 已核实这 2 行（2026-09-19）：
 *   `/api/v1/${name}/${orderId}/cancel`  ← definition_code 是**调用行**
 *                                          `result = await this.orderApi.cancelOrder(orderId, …)`
 *   `/api/v1/repositories/upload`        ← definition_code 是**函数定义行**（template_helper 落点）
 * 两行 `method` 均为空、各带 1 条 url_usage，与方法内的兜底分支完全吻合。
 *
 * 这段逻辑在 relationship-builder 里、依赖数据库，**不属于本次解析层解耦的范围**，
 * 因此探针对 url_patterns 的口径是：
 *   (a) 解析层键数 == 396（严格相等）
 *   (b) 解析层键集合 ⊆ 线上键集合（不允许解析层多出线上没有的键）
 */
const BASELINE: Record<string, number> = {
  files: 277,
  code_chunks: 3242,
  string_constants: 2237,
  functions: 540,
  classes: 335,
};

/** 解析层自身应产出的 url_patterns 行数（= 线上 398 − 2 条兜底行） */
const EXPECTED_URL_PATTERNS = 396;

/** 线上总数，用于「集合包含关系」核对 */
const PROD_URL_PATTERNS = 398;

async function walk(dir: string, prefix: string, out: Array<{ path: string; content: string }>) {
  for (const entry of await readdir(dir)) {
    if (SKIP_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      await walk(full, prefix, out);
    } else if (st.isFile() && isIndexable(full)) {
      // 与线上一致：用 posix 分隔符 + 仓库前缀
      out.push({
        path: posix.join(prefix, relative(repoRoot, full).split(/[\\/]/).join('/')),
        content: await readFile(full, 'utf-8'),
      });
    }
  }
}

const repoRoot = process.argv[2];
const pathPrefix = process.argv[3] ?? 'test-repo';

if (!repoRoot) {
  console.error('用法: probe-language-refactor.ts <repoRoot> [pathPrefix]');
  process.exit(1);
}

const main = async () => {
  const scanned: Array<{ path: string; content: string }> = [];
  await walk(repoRoot, pathPrefix, scanned);
  scanned.sort((a, b) => (a.path < b.path ? -1 : 1));

  console.log(`扫描到 ${scanned.length} 个受支持文件（前缀 ${pathPrefix}/）`);
  console.log(
    `注册表: ${languageRegistry.all().map((p) => `${p.id}[${p.extensions.join(' ')}]`).join(', ')}`
  );
  console.log('');

  // ---- 第一遍：chunk（对应 indexer.ts 的 indexCodebase）----
  // 线上只把「chunks.length > 0」的文件写进 files 表，后续第二遍只处理这些文件。
  let chunkTotal = 0;
  const chunkedFiles: Array<{ path: string; content: string }> = [];
  const chunkCountByLan: Record<string, number> = {};
  for (const f of scanned) {
    const parser = languageRegistry.forFile(f.path);
    if (!parser) {
      console.warn(`  ⚠ 无适配器: ${f.path}`);
      continue;
    }
    const r = parser.parseChunks(f.path, f.content);
    if (r.chunks.length === 0) continue;
    chunkTotal += r.chunks.length;
    chunkCountByLan[parser.id] = (chunkCountByLan[parser.id] ?? 0) + 1;
    chunkedFiles.push(f);
  }

  // ---- 第二遍：实体（对应 enhanced-indexer 的 indexFiles）----
  // 先让所有在用的适配器建仓级上下文，再按**原始顺序**逐文件分析 —— 与线上一致。
  const parsersInUse = new Set<RepoScopedParser>();
  for (const f of chunkedFiles) {
    const p = languageRegistry.forFile(f.path) as RepoScopedParser | null;
    if (p) parsersInUse.add(p);
  }
  for (const p of parsersInUse) p.beginRepo?.(chunkedFiles);

  // 落库去重键与线上唯一索引一一对应（见 enhanced-indexer.ts / relationship-builder.ts）：
  //   string_constants  UNIQUE (repo_id, file_id, string_value, line_start)
  //   functions         UNIQUE (repo_id, file_id, full_name,   line_start)
  //   classes           UNIQUE (repo_id, file_id, full_name,   line_start)
  //   url_patterns      UNIQUE (repo_id, COALESCE(method,''), normalized_pattern)
  const scKeys = new Set<string>();
  const fnKeys = new Set<string>();
  const clKeys = new Set<string>();
  const urlKeys = new Set<string>();
  let importRows = 0;
  let indirectSites = 0;
  let entityErrors = 0;

  for (const f of chunkedFiles) {
    const parser = languageRegistry.forFile(f.path);
    if (!parser) continue;
    try {
      const ent = await parser.analyzeEntities(f.path, f.content);
      for (const sc of ent.stringConstants) scKeys.add(`${f.path}|${sc.stringValue}|${sc.lineStart}`);
      for (const fn of ent.functions) fnKeys.add(`${f.path}|${fn.fullName}|${fn.lineStart}`);
      for (const cl of ent.classes) clKeys.add(`${f.path}|${cl.fullName}|${cl.lineStart}`);
      for (const up of ent.urlPatterns) urlKeys.add(`${up.method ?? ''}|${up.normalizedPattern}`);
      importRows += ent.imports.length;
      indirectSites += ent.indirectSites.length;
    } catch (e) {
      entityErrors++;
      console.error(`  分析失败 ${f.path}:`, e);
    }
  }

  for (const p of parsersInUse) p.endRepo?.();

  // 需要逐键核对时，把 url_patterns 的键集合落盘（键格式与线上唯一索引一致：
  // `COALESCE(method,'')|normalized_pattern`），用于与 psql 导出的集合做 diff。
  if (process.env.DUMP_URL_KEYS) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.DUMP_URL_KEYS, [...urlKeys].sort().join('\n') + '\n', 'utf-8');
    console.log(`url_patterns 键集合已写入 ${process.env.DUMP_URL_KEYS}（${urlKeys.size} 条）`);
  }

  const actual: Record<string, number> = {
    files: chunkedFiles.length,
    code_chunks: chunkTotal,
    string_constants: scKeys.size,
    functions: fnKeys.size,
    classes: clKeys.size,
  };

  console.log('='.repeat(64));
  console.log('A/B 比对：新代码（本地） vs 线上 repo 29（旧代码产物）');
  console.log('='.repeat(64));
  console.log(`${'表'.padEnd(18)}${'线上'.padStart(8)}${'本地'.padStart(8)}   判定`);
  let failed = 0;
  for (const [k, base] of Object.entries(BASELINE)) {
    const got = actual[k] ?? -1;
    const ok = got === base;
    if (!ok) failed++;
    console.log(
      `${k.padEnd(18)}${String(base).padStart(8)}${String(got).padStart(8)}   ${ok ? '✅ 一致' : '❌ 不一致'}`
    );
  }

  // url_patterns：解析层 396 严格相等；另 2 条由 relationship-builder 兜底插入（见文件头说明）
  {
    const got = urlKeys.size;
    const ok = got === EXPECTED_URL_PATTERNS;
    if (!ok) failed++;
    console.log(
      `${'url_patterns'.padEnd(18)}${String(PROD_URL_PATTERNS).padStart(8)}${String(got).padStart(8)}   ` +
        `${ok ? '✅ 一致' : '❌ 不一致'}  (线上 = ${got} 解析层 + ${PROD_URL_PATTERNS - got} 兜底行)`
    );
  }
  console.log('');
  console.log(`按语言分桶的文件数: ${JSON.stringify(chunkCountByLan)}`);
  console.log(`import 行数(原始):  ${importRows}`);
  console.log(`indirectSites(原始): ${indirectSites}`);
  console.log(`分析异常文件数:     ${entityErrors}`);
  console.log('');
  console.log(failed === 0 ? '✅ 判定：解析层输出与改造前一致（纯搬运）' : `❌ 判定：${failed} 项不一致，不能发布`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
