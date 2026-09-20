/**
 * 仓库文件扫描器 —— 决定「哪些文件参与索引」。
 *
 * ============================================================
 * 这是入库的**唯一闸门**，也是**唯一一份**受支持扩展名清单的来源。
 * ============================================================
 *
 * 历史包袱（为什么单独抽一个文件）：
 * 扩展名清单原本散在三处，而且三处互不相同 ——
 *
 * | 位置 | 清单 |
 * |---|---|
 * | `indexer.ts` 的 `collectFiles` | `.ts .tsx .js .jsx .vue`（**唯一闸门**） |
 * | `relationship-builder.ts` | 多 `.mjs .cjs .json` |
 * | `url-resolver.ts` 的 import 解析 | 又一份 |
 *
 * 更糟的是闸门失败**完全静默**：不支持的语言 → 0 个文件 →
 * 索引跑完、状态 `ready`、退出码 0、日志只有一行 `Processed: 0/0`。
 * 一个 Java 仓库上传后就是这样「成功」的。
 *
 * 现在：清单来自 `languageRegistry.supportedExtensions`（由适配器自己声明，不可能漂移），
 * 且 0 文件会在 `indexCodebase` 里**显式抛错**。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { languageRegistry } from './languages/registry.js';

/**
 * 扫描时跳过的目录。
 *
 * 分三类：依赖（node_modules / vendor）、构建产物（dist / build / out / target / .next …）、
 * 缓存与覆盖率（.cache / .turbo / coverage / __pycache__ / .pytest_cache）。
 *
 * ⚠️ 这一层只按**目录名**判断，抓不到「和源码混在一起」的产物 ——
 * `public/static/` 里的 vendored 压缩包、`src/assets/` 里生成的 iconfont
 * 都安然穿过这一层。它们由下面的 `checkIndexGuards` 三层守卫处理。
 */
export const SKIP_DIRS: readonly string[] = [
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', '.turbo', '.nuxt', '.output', 'out', '.vercel',
  'vendor', 'target', '__pycache__', '.pytest_cache',
];

// ============================================================================
// 三层守卫：把「压缩 / 构建产物」挡在索引之外
// ============================================================================
//
// 为什么需要它（真实事故，2026-09-19）：
//
// 把真实工程 testwire-frontend 接进来后，索引产出 45 个文件 / 1431 个代码块，
// 但代码块正文合计 **52.8 MB**。根因是 `public/static/monaco/` 下的
// `workerMain.js`（308 KB / 23 行 / 最长行 156,899 字符）：它是压缩产物，
// AST 分块在这类文件上会切出大量**跨越大段文本**的 span，
// 文本量相对原文件放大约 160 倍。逐个 embed 的话耗时数小时、费用高得离谱，
// 而结果全是噪声 —— 没有人会去检索 monaco 的压缩源码。
//
// 三层按**代价从低到高**排序，前一层拦住就不必进下一层：
//
// | 层 | 判据 | 代价 |
// |---|---|---|
// | ③ | 路径特征（`public/static/`、`*.min.js` …） | 纯字符串比对 |
// | ② | 单文件 > 1 MB | 用 `stat` 已拿到的 size，零成本 |
// | ① | 整体像压缩产物（长行 + 密排） | 需要读文件 |
//
// 与既有的 `SKIP_DIRS` 不重叠：那一层是「按目录名」，本层是「按路径/大小/内容」。

/** 层② 单文件大小上限：超过即视为构建/生成产物（十进制 1 MB） */
export const MAX_FILE_BYTES = 1_000_000;

/** 把字节数格式化成人类可读的十进制 MB —— 阈值用十进制定义，显示也得一致 */
export function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/** 层① 触发压缩嫌疑的**单行**长度下限 */
export const MAX_SOURCE_LINE = 5_000;

/**
 * 层① 触发压缩嫌疑的**平均**行长下限。
 *
 * ⚠️ 这两个条件是 **AND**，缺一不可 —— 只看最长行会误杀真实源码。
 *
 * 反例（本仓库语料实测）：`src/utils/Json.ts` 是个 61 行的手写模块，
 * 里面有 import、有 JSDoc、有导出函数，但第 39 行是一个 65,554 字符的
 * 位图字符串常量（`const txt = "000…333…"`）。
 * 只按「最长行 > 5000」判，这个**真源码文件会被整个丢掉**，
 * 连带里面几个正经函数一起消失 —— 而「该索引的没索引」比「多索引点噪声」
 * 危害大得多（挂错比漏掉更有害）。
 *
 * 加上平均行长后两者就分开了：
 *
 * | 文件 | 行数 | 最长行 | 平均行 | 判定 |
 * |---|---|---|---|---|
 * | `src/utils/Json.ts` | 61 | 65,554 | 1,099 | **真源码** → 索引 |
 * | `public/static/monaco/…/workerMain.js` | 23 | 156,899 | ≈13,700 | 压缩产物 → 跳过 |
 * | `src/assets/icon/iconfont.js` | 1 | 784,438 | 784,438 | 压缩产物 → 跳过 |
 *
 * 直观解释：压缩产物是「**行少而总体量巨大**」，所以平均行长会非常大；
 * 而带大字符串常量的真源码只是「某一行特别长」，整篇平均下来仍然正常。
 */
export const MINIFIED_AVG_LINE = 2_000;

/**
 * 层③ 路径闸门：构建产物 / 压缩产物的路径特征。
 * 最便宜的一层，先跑 —— 命中就不必读文件了。
 */
export const BUILD_OUTPUT_PATTERNS: readonly RegExp[] = [
  /(^|\/)public\/(static|assets|build|dist)\//i,
  /\.min\.[cm]?[jt]sx?$/i,
  /\.bundle\.[cm]?[jt]s$/i,
  /\.chunk\.[cm]?[jt]s$/i,
];

/** 文件被守卫拦下的原因 */
export type SkipReason = 'build-output' | 'too-large' | 'minified';

export interface SkippedFile {
  /** 相对仓库根的路径 */
  path: string;
  reason: SkipReason;
  /** 人类可读细节（大小 / 最长行 / 平均行），直接进日志 */
  detail: string;
}

export interface ScanReport {
  /** 真正参与索引的绝对路径 */
  files: string[];
  /** 被守卫拦下的文件 —— **必须逐条上报，不许静默丢弃** */
  skipped: SkippedFile[];
}

const REASON_LABEL: Record<SkipReason, string> = {
  'build-output': '构建产物路径',
  'too-large': '文件过大',
  minified: '压缩产物',
};

/**
 * 统计行数与最长行长度。
 *
 * 手写单趟扫描而不是 `text.split('\n')`：后者会为 1 MB 的文件分配
 * 一个上万元素的数组（外加每行的字符串对象），在批量扫描时纯属浪费。
 */
export function measureLines(text: string): { lineCount: number; longestLine: number } {
  let longestLine = 0;
  let lineCount = 1;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      const len = i - start;
      if (len > longestLine) longestLine = len;
      lineCount++;
      start = i + 1;
    }
  }
  const tail = text.length - start;
  if (tail > longestLine) longestLine = tail;
  return { lineCount, longestLine };
}

/**
 * 三层守卫的唯一实现。
 *
 * @param relPath - 相对仓库根的路径（**必须用相对路径**：层③ 的锚点在
 *   `public/static/` 这类位置，用绝对路径会因仓库根目录名不同而漂移）
 * @param absPath - 绝对路径，仅层① 需要读文件时用到
 * @param size - 文件字节数（调用方从 `stat` 拿到，避免这里再 stat 一次）
 * @param loadedContent - 调用方**已经读过**的文件正文。给了就直接用，
 *   不再读一次盘 —— 增量索引在判定「内容变没变」时本来就读过了。
 */
export async function checkIndexGuards(
  relPath: string,
  absPath: string,
  size: number,
  loadedContent?: string
): Promise<SkippedFile | null> {
  // ---- 层③ 路径特征 ----
  for (const pattern of BUILD_OUTPUT_PATTERNS) {
    if (pattern.test(relPath)) {
      return { path: relPath, reason: 'build-output', detail: `匹配 ${pattern}` };
    }
  }

  // ---- 层② 单文件大小 ----
  if (size > MAX_FILE_BYTES) {
    return {
      path: relPath,
      reason: 'too-large',
      detail: `${formatMB(size)} > ${formatMB(MAX_FILE_BYTES)}`,
    };
  }

  // ---- 层① 内容形态（读文件）----
  // 走到这里说明文件 ≤ 1 MB，读一整个是可接受的；真正的成本在解析与向量化。
  let text: string;
  if (loadedContent !== undefined) {
    text = loadedContent;
  } else {
    try {
      text = await readFile(absPath, 'utf-8');
    } catch {
      // 读不出来就别自作主张拦下它，交给后面的读取逻辑去报错（错误不该被这里吞掉）
      return null;
    }
  }
  const { lineCount, longestLine } = measureLines(text);
  const avgLine = text.length / Math.max(lineCount, 1);
  if (longestLine > MAX_SOURCE_LINE && avgLine > MINIFIED_AVG_LINE) {
    return {
      path: relPath,
      reason: 'minified',
      detail: `${lineCount} 行 / 最长行 ${longestLine} / 平均行 ${Math.round(avgLine)}`,
    };
  }

  return null;
}

/** 把守卫结果拼成一行日志（供调用方直接 console 用） */
export function formatSkippedSummary(skipped: SkippedFile[]): string {
  if (skipped.length === 0) return '';
  const byReason = new Map<SkipReason, number>();
  for (const item of skipped) {
    byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
  }
  const parts = [...byReason.entries()].map(([reason, count]) => `${REASON_LABEL[reason]} ${count}`);
  return `${skipped.length} 个文件被守卫跳过（${parts.join('，')}）`;
}

/** 该路径是否会被索引（按注册表里的扩展名判定） */
export function isIndexable(filePath: string): boolean {
  return languageRegistry.forFile(filePath) !== null;
}

/**
 * 递归收集目录下所有需要索引的代码文件，**并上报被守卫拦下的文件**。
 *
 * 这是入库的唯一闸门，全仓只有这一处决定「哪些文件进索引」。
 *
 * @param dir - 仓库在本地文件系统的根目录
 * @returns 待索引文件的**绝对路径**（顺序 = 目录遍历顺序）+ 跳过清单
 */
export async function scanRepoFiles(dir: string): Promise<ScanReport> {
  const files: string[] = [];
  const skipped: SkippedFile[] = [];

  async function walk(currentPath: string, relDir: string) {
    const entries = await readdir(currentPath);

    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry)) continue;

      const fullPath = join(currentPath, entry);
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const stats = await stat(fullPath);

      if (stats.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (stats.isFile()) {
        // ⚠️ 走注册表而不是本地正则：清单只此一份。
        // 扩展名匹配是**大小写不敏感**的（`FOO.TS` 也算），比旧的
        // `match(/\.(ts|tsx|js|jsx|vue)$/)` 更宽松 —— 旧写法在 Linux 上会
        // 静默漏掉大写扩展名。本仓库语料里没有大写扩展名，故行为等价。
        if (!isIndexable(fullPath)) continue;

        // 三层守卫（构建产物 / 过大 / 压缩）——命中就记账，绝不静默丢弃
        const hit = await checkIndexGuards(relPath, fullPath, stats.size);
        if (hit) {
          skipped.push(hit);
          continue;
        }

        files.push(fullPath);
      }
    }
  }

  await walk(dir, '');
  return { files, skipped };
}
