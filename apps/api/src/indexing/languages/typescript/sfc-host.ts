/**
 * Vue 单文件组件解析器
 *
 * 负责解析 .vue 文件，提取其中的 script 部分并交给 TS/JS 解析器做代码分析。
 *
 * ============================================================
 * 这个文件修过两个会让 .vue「被索引但抽不出东西」的缺陷
 * ============================================================
 *
 * 【缺陷 1：纯 JS 的 <script> 返回空结果】
 * 原实现判断 `if (scriptLang === 'ts' || scriptLang === 'typescript')` 才调用解析器，
 * 否则直接 return 空的 chunks/imports/exports，还挂着 TODO。
 * 而 Vue 项目的 <script lang="ts"> 与纯 <script> 都很常见 —— 后者会被索引成
 * **0 个 chunk**：文件在库里、行数统计里有它，但检索、影响面、调用图全都看不见它。
 * 这不是报错，是静默丢数据。现在 JS 与 TS 走同一条解析路径。
 *
 * 【缺陷 2：行号整体偏移】
 * 解析器拿到的是 **script 块的内部文本**，不是整个 .vue 文件。Babel 报的行号
 * 因此是「相对于 script 块」的。实测：`<script setup lang="ts">` 在第 5 行时，
 * 真实第 9 行的 `const count` 会被报成第 5 行 —— 恒定偏移 4
 * （= script 开始标签所在行号 - 1）。
 * 后果是所有「跳转到文件:行号」和证据行区间都对不上，而我们刚做的影响面/证据
 * 显示全部依赖行号。现在统一回填这个偏移。
 *
 * 【另外】同时存在 `<script>` 与 `<script setup>` 的文件，两个块都会被解析，
 * 各自按自己的起始行回填偏移后合并 —— 只取一个会漏掉另一个块里的符号。
 */

import { parse as parseVue } from '@vue/compiler-sfc';
import { parseTsFile } from './chunker.js';
import type { CodeChunk, ChunkResult } from '../types.js';

/**
 * 一个解包出来的 `<script>` 块。
 *
 * 关键是 `offset`：解析器拿到的是**块内部文本**，报出的行号是「相对块」的，
 * 必须加回该偏移才是 `.vue` 文件里的绝对行号。
 */
export interface VueScriptBlock {
  /** 块内部源码文本（不含 `<script>` 标签本身） */
  content: string;
  /** 行号偏移 = 开始标签所在行号 − 1 */
  offset: number;
  /** 块语言：`'ts'` / `'js'` / `'tsx'` 等（默认 `'js'`） */
  lang: string;
}

/**
 * 解包 SFC 的 `<script>` / `<script setup>` 块（含行号偏移）。
 *
 * ⚠️ **两遍索引都必须走这里**，理由不同但结论相同：
 * - 第一遍（`parseVueFile`）：Babel 需要的是纯 script 文本；
 * - 第二遍（实体层）：把 `.vue` **原文**交给 ts-morph 会让 `<template>` 被当 TS 解析，
 *   产出大量 `anonymous` 垃圾类；而且 ts-morph 在 `.vue` 扩展名下 `getReturnType()` 会抛异常
 *   （见 `entities.ts` 的 `extractFunctionInfo`），解包后配合中性文件名才能修掉。
 *
 * 没有 script 块时返回空数组 —— **纯模板组件是正常情况，不是缺陷**。
 *
 * @param filePath - 文件路径（仅用于让 `@vue/compiler-sfc` 报错时能定位，不参与解析）
 * @param code - `.vue` 文件完整源码
 */
export function parseVueScriptBlocks(filePath: string, code: string): VueScriptBlock[] {
  const { descriptor } = parseVue(code, { filename: filePath });

  return [descriptor.script, descriptor.scriptSetup]
    .filter((b): b is NonNullable<typeof b> => Boolean(b))
    .map((b) => ({
      content: b.content,
      offset: b.loc.start.line - 1,
      lang: b.lang ?? 'js',
    }));
}

/**
 * 解析 Vue 单文件组件
 *
 * 支持 `<script>` 与 `<script setup>`、TypeScript 与 JavaScript 的任意组合。
 * 没有 script 块的文件（纯模板组件）返回空结果 —— 这是正常情况，不是缺陷。
 *
 * @param filePath - Vue 文件的路径（索引器传的是仓库内相对路径）
 * @param code - Vue 文件的完整源代码内容
 * @returns 解析结果，chunks 的行号已对齐到 .vue 文件本身
 */
export function parseVueFile(filePath: string, code: string): ChunkResult {
  const blocks = parseVueScriptBlocks(filePath, code);

  // 没有 script 块：纯模板/纯样式组件，如实返回空
  if (blocks.length === 0) {
    return { filePath, chunks: [], imports: [], exports: [] };
  }

  const chunks: CodeChunk[] = [];
  const imports: ChunkResult['imports'] = [];
  const exports: string[] = [];
  const seenImports = new Set<string>();

  for (const block of blocks) {
    // TS 和 JS 都走 parseTsFile：它基于 Babel，两种语法都能解析。
    // 之前只给 TS 走这条路，JS 直接被丢掉。
    const result = parseTsFile(filePath, block.content);

    // 把「相对于 script 块」的行号换算成「相对于 .vue 文件」的行号。
    const offset = block.offset;

    for (const chunk of result.chunks) {
      if (offset > 0) {
        chunk.lineStart += offset;
        chunk.lineEnd += offset;
      }
      chunks.push(chunk);
    }

    // imports 在 ChunkResult 里不带行号，按 source+specifiers 去重即可
    for (const imp of result.imports) {
      const key = `${imp.source}|${imp.specifiers.join(',')}`;
      if (seenImports.has(key)) continue;
      seenImports.add(key);
      imports.push(imp);
    }

    for (const name of result.exports) {
      if (!exports.includes(name)) exports.push(name);
    }
  }

  return { filePath, chunks, imports, exports };
}
