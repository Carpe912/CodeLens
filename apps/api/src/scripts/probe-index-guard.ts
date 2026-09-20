/**
 * 索引守卫自检探针。
 *
 * 用法：
 *   node apps/api/dist/scripts/probe-index-guard.js /tmp/codelens-repos/33
 *
 * 为什么要有它：
 * 「加了三层守卫」这件事本身的正确性没法靠读代码判断 —— 阈值定高了拦不住
 * 压缩产物（索引跑几小时），定低了会**误杀真实源码**（更糟，且事后发现不了）。
 * 所以每次调阈值都在**真实语料**上先跑这个探针，确认：
 *   1. 该拦的（`public/static/**` 压缩包、生成的 iconfont）确实被拦了；
 *   2. 不该拦的（带大字符串常量的手写模块）**没被**误杀；
 *   3. 剩下的文件规模（个数 / 总字节）是可索引的量级。
 *
 * 探针只读目录、不碰数据库、不写任何东西 —— 可以随便跑。
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  scanRepoFiles,
  SKIP_DIRS,
  MAX_FILE_BYTES,
  MAX_SOURCE_LINE,
  MINIFIED_AVG_LINE,
  formatMB,
  type SkipReason,
} from '../indexing/file-scanner.js';
import { languageRegistry } from '../indexing/languages/registry.js';

const REASON_LABEL: Record<SkipReason, string> = {
  'build-output': '构建产物路径',
  'too-large': `文件 > ${formatMB(MAX_FILE_BYTES)}`,
  minified: `压缩产物（最长行 > ${MAX_SOURCE_LINE} 且平均行 > ${MINIFIED_AVG_LINE}）`,
};

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法: node probe-index-guard.js <仓库目录>');
    process.exit(1);
  }

  console.log(`\n=== 索引守卫探针 ===`);
  console.log(`目录: ${dir}`);
  console.log(`跳过目录: ${SKIP_DIRS.join(' / ')}`);
  console.log(`支持扩展名: ${languageRegistry.supportedExtensions.join(', ')}\n`);

  const startedAt = Date.now();
  const { files, skipped } = await scanRepoFiles(dir);
  const elapsed = Date.now() - startedAt;

  // ---- 被拦下的文件：逐条打印，按 原因 分组 ----
  const grouped = new Map<SkipReason, typeof skipped>();
  for (const item of skipped) {
    const bucket = grouped.get(item.reason) ?? [];
    bucket.push(item);
    grouped.set(item.reason, bucket);
  }

  console.log(`--- 被守卫拦下: ${skipped.length} 个 ---`);
  for (const [reason, items] of grouped) {
    console.log(`\n[${REASON_LABEL[reason]}] ${items.length} 个`);
    // 每类最多打 8 条，避免刷屏（全量清单看仓库自己）
    for (const item of items.slice(0, 8)) {
      console.log(`  ${item.path}  ——  ${item.detail}`);
    }
    if (items.length > 8) console.log(`  … 另有 ${items.length - 8} 个同类`);
  }

  // ---- 参与索引的文件：规模统计 ----
  let totalBytes = 0;
  const sizes: Array<{ path: string; size: number }> = [];
  for (const abs of files) {
    try {
      const s = await stat(abs);
      totalBytes += s.size;
      sizes.push({ path: abs.replace(dir, '').replace(/^\//, ''), size: s.size });
    } catch {
      /* 读不到就不统计 */
    }
  }
  sizes.sort((a, b) => b.size - a.size);

  console.log(`\n--- 参与索引: ${files.length} 个文件 / ${(totalBytes / 1048576).toFixed(2)} MB ---`);
  console.log('最大的 5 个（确认没有漏网的巨物）:');
  for (const item of sizes.slice(0, 5)) {
    console.log(`  ${(item.size / 1024).toFixed(0).padStart(6)} KB  ${item.path}`);
  }

  console.log(`\n扫描耗时: ${elapsed} ms`);
  console.log(
    `结论: ${files.length} 个文件进索引，${skipped.length} 个被拦（共发现 ${
      files.length + skipped.length
    } 个候选）\n`
  );
}

main().catch((err) => {
  console.error('探针失败:', err);
  process.exit(1);
});
