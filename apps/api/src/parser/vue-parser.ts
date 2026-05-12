/**
 * Vue 单文件组件解析器
 * 负责解析 .vue 文件，提取其中的 script 部分并进行代码分析
 *
 * 解析策略：
 * 1. 使用 @vue/compiler-sfc 解析 Vue SFC 结构
 * 2. 提取 <script> 或 <script setup> 中的代码
 * 3. 根据 script 的 lang 属性选择对应的解析器
 * 4. 将解析结果标记为 'vue' 语言类型
 */

import { parse as parseVue } from '@vue/compiler-sfc';
import { parseTsFile } from './ts-parser.js';
import type { ParseResult } from './types.js';

/**
 * 解析 Vue 单文件组件
 *
 * 功能说明：
 * - 解析 Vue SFC 文件结构（template、script、style）
 * - 提取 script 部分的代码内容
 * - 支持 <script setup> 和普通 <script> 标签
 * - 支持 TypeScript 和 JavaScript
 *
 * 算法流程：
 * 1. 使用 Vue 编译器解析 SFC 结构，获取 descriptor
 * 2. 检查是否存在 script 或 scriptSetup 块
 * 3. 如果没有 script 块，返回空的解析结果
 * 4. 提取 script 内容和语言类型（ts/js）
 * 5. 如果是 TypeScript，调用 TS 解析器进行深度解析
 * 6. 将语言类型标记为 'vue' 并返回结果
 *
 * @param filePath - Vue 文件的绝对路径
 * @param code - Vue 文件的完整源代码内容
 * @returns 解析结果，包含从 script 块中提取的代码结构信息
 *
 * @example
 * ```typescript
 * const vueCode = `
 *   <template><div>Hello</div></template>
 *   <script setup lang="ts">
 *   const count = ref(0)
 *   </script>
 * `;
 * const result = parseVueFile('/path/to/Component.vue', vueCode);
 * ```
 */
export function parseVueFile(filePath: string, code: string): ParseResult {
  // 使用 Vue 编译器解析 SFC，获取各个块的描述信息
  const { descriptor } = parseVue(code, { filename: filePath });

  // 如果文件中没有 script 或 script setup 块，返回空结果
  if (!descriptor.script && !descriptor.scriptSetup) {
    return {
      filePath,
      language: 'vue',
      chunks: [],
      imports: [],
      exports: [],
    };
  }

  // 优先使用 script setup 的内容，否则使用普通 script 的内容
  const scriptContent = descriptor.scriptSetup?.content || descriptor.script?.content || '';
  // 获取 script 的语言类型（ts/js），默认为 js
  const scriptLang = descriptor.scriptSetup?.lang || descriptor.script?.lang || 'js';

  // 如果 script 使用 TypeScript，调用 TS 解析器进行详细解析
  if (scriptLang === 'ts' || scriptLang === 'typescript') {
    const result = parseTsFile(filePath, scriptContent);
    // 将语言类型标记为 vue，以便区分来源
    result.language = 'vue';
    return result;
  }

  // 对于纯 JavaScript 的 script，目前返回空结果
  // TODO: 可以考虑添加 JS 解析器支持
  return {
    filePath,
    language: 'vue',
    chunks: [],
    imports: [],
    exports: [],
  };
}
