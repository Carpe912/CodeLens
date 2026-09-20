/**
 * A/B 探针：把 `.vue` 规范化成「只留 script 块」之后，跨文件符号表的产出会不会变？
 *
 * 用法（要放在能解析到 ts-morph 的地方，例如 `apps/api/`）：
 *   node apps/api/dist/scripts/probe-resolver-sfc.js /tmp/codelens-repos/29
 *
 * 为什么需要它：
 * 「修一个崩溃」很容易顺手改掉正常仓库的产出。符号表是**增强层所有路径解析的地基**
 * ——provider / indirect site / import 三条线都从它出来，数字一变，
 * `url_patterns`、`url_usages`、间接调用点全都会跟着变。所以：
 *   A = 喂 `.vue` 原文（旧行为）
 *   B = 喂「只留 script 块、其余空行」（新行为）
 * 同语料、只开关这一个分支，diff 三条线的数量与明细。
 *
 * 判读：
 * - **A == B** ⇒ 本语料上行为中性 ⇒ 不需要为这次改动重建该仓库的索引。
 * - **A ≠ B** ⇒ 需要重建（并且要人看一眼差异是不是「变干净了」而不是「丢东西了」）。
 *
 * 只读仓库、不碰数据库、不写任何东西。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Project, ts } from 'ts-morph';
import { URLResolver } from '../indexing/languages/typescript/url-resolver.js';
import { toResolverSource } from '../indexing/languages/typescript/index.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', '.turbo', '.nuxt', '.output', 'out', '.vercel',
  'vendor', 'target', '__pycache__', '.pytest_cache',
]);
const EXT = ['.ts', '.tsx', '.js', '.jsx', '.vue'];
/** 只在 guard 之后真正会入库的目录闸门，和 file-scanner 的层③ 保持一致 */
const BUILD_OUTPUT = /(^|\/)public\/(static|assets|build|dist)\/|\.min\.[cm]?[jt]sx?$|\.bundle\.[cm]?[jt]s$|\.chunk\.[cm]?[jt]s$/i;

async function walk(dir: string, root: string, out: Array<{ path: string; content: string }>) {
  for (const entry of await readdir(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      await walk(full, root, out);
    } else if (EXT.some((e) => entry.endsWith(e))) {
      const rel = relative(root, full);
      if (BUILD_OUTPUT.test(rel)) continue;
      out.push({ path: rel, content: await readFile(full, 'utf-8') });
    }
  }
}

function makeResolver() {
  const project = new Project({
    compilerOptions: {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.CommonJS,
      allowJs: true,
      checkJs: false,
      noEmit: true,
    },
    skipAddingFilesFromTsConfig: true,
  });
  return new URLResolver(project);
}

interface Snapshot {
  providers: number;
  indirect: number;
  /** provider 明细的稳定指纹，用来比对「数量一样但内容变了」 */
  providerKeys: Set<string>;
  indirectKeys: Set<string>;
  /** 抛异常的文件（只在 A 侧可能出现） */
  crashed: string[];
}

function runOne(files: Array<{ path: string; content: string }>, normalize: boolean): Snapshot {
  const resolver = makeResolver();
  const prepared = normalize ? files.map((f) => toResolverSource(f.path, f.content)) : files;

  const crashed: string[] = [];
  const providers: Array<{ file: string; kind: string; value: string; line: number }> = [];
  const indirect: Array<{ file: string; line: number; kind: string }> = [];

  try {
    resolver.registerFiles(prepared);
  } catch (error) {
    // 旧行为下整批会挂在这里；新行为下 registerFiles 内部已逐文件兜住，不会走到这
    crashed.push(`registerFiles: ${(error as Error).message}`);
  }

  try {
    for (const p of resolver.collectProviders()) {
      providers.push({ file: p.file, kind: p.kind, value: p.value, line: p.line });
    }
  } catch (error) {
    crashed.push(`collectProviders: ${(error as Error).message}`);
  }
  try {
    for (const s of resolver.collectIndirectSites()) {
      indirect.push({ file: s.file, line: s.line, kind: s.kind });
    }
  } catch (error) {
    crashed.push(`collectIndirectSites: ${(error as Error).message}`);
  }

  return {
    providers: providers.length,
    indirect: indirect.length,
    providerKeys: new Set(providers.map((p) => `${p.file}|${p.kind}|${p.value}|${p.line}`)),
    indirectKeys: new Set(indirect.map((s) => `${s.file}|${s.line}|${s.kind}`)),
    crashed,
  };
}

function diffSets(a: Set<string>, b: Set<string>, label: string, limit = 12) {
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  if (onlyA.length === 0 && onlyB.length === 0) {
    console.log(`  ${label}: 完全一致（${a.size} 条）`);
    return true;
  }
  console.log(`  ${label}: 有差异 —— 仅旧行为 ${onlyA.length} 条 / 仅新行为 ${onlyB.length} 条`);
  for (const x of onlyA.slice(0, limit)) console.log(`    − ${x}`);
  for (const x of onlyB.slice(0, limit)) console.log(`    + ${x}`);
  return false;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法: node probe-resolver-sfc.js <仓库目录>');
    process.exit(1);
  }

  const files: Array<{ path: string; content: string }> = [];
  await walk(dir, dir, files);
  const vueCount = files.filter((f) => f.path.endsWith('.vue')).length;

  console.log(`\n=== 符号表 .vue 规范化 A/B 探针 ===`);
  console.log(`目录: ${dir}`);
  console.log(`候选文件: ${files.length}（其中 .vue ${vueCount}）\n`);

  console.log('--- A：喂 .vue 原文（旧行为）---');
  const a = runOne(files, false);
  console.log(`  provider ${a.providers} 个 / 跨过程落点 ${a.indirect} 个`);
  if (a.crashed.length > 0) console.log(`  ⚠️ 崩溃: ${a.crashed.join(' | ')}`);

  console.log('\n--- B：喂「只留 script 块，其余空行」（新行为）---');
  const b = runOne(files, true);
  console.log(`  provider ${b.providers} 个 / 跨过程落点 ${b.indirect} 个`);
  if (b.crashed.length > 0) console.log(`  ⚠️ 崩溃: ${b.crashed.join(' | ')}`);

  console.log('\n--- 差异 ---');
  const sameP = diffSets(a.providerKeys, b.providerKeys, 'provider 明细');
  const sameI = diffSets(a.indirectKeys, b.indirectKeys, '跨过程落点明细');

  console.log('');
  if (a.crashed.length > 0 && b.crashed.length === 0) {
    console.log('结论: ✅ 新行为修掉了崩溃（旧行为下整仓符号表建不起来）。');
  } else if (sameP && sameI) {
    console.log('结论: ✅ 本语料上行为中性 —— **不需要**为这次改动重建该仓库的索引。');
  } else {
    console.log('结论: ⚠️ 本语料上产出有变化 ⇒ 需要重建该仓库的索引（先人工确认差异是「变干净」）。');
  }
  console.log('');
}

main().catch((err) => {
  console.error('探针失败:', err);
  process.exit(1);
});
