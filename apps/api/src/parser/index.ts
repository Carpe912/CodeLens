/**
 * Parser 模块入口文件
 * 提供统一的文件解析接口，根据文件类型自动选择合适的解析器
 *
 * 支持的文件类型：
 * - TypeScript (.ts, .tsx)
 * - JavaScript (.js, .jsx)
 * - Vue 单文件组件 (.vue)
 */

import { parseTsFile } from './ts-parser.js';
import { parseVueFile } from './vue-parser.js';
import type { ParseResult } from './types.js';

// 导出所有类型定义
export * from './types.js';

/**
 * 解析代码文件，提取代码结构信息
 *
 * 功能说明：
 * - 根据文件扩展名自动选择对应的解析器
 * - 提取文件中的函数、类、变量、接口等代码块
 * - 分析导入导出关系和函数调用关系
 *
 * 算法流程：
 * 1. 检查文件扩展名
 * 2. 调用对应的专用解析器（Vue 或 TypeScript/JavaScript）
 * 3. 返回统一格式的解析结果
 *
 * @param filePath - 文件的绝对路径，用于确定文件类型和记录位置信息
 * @param code - 文件的源代码内容字符串
 * @returns 解析结果对象，包含代码块、导入、导出等信息；如果文件类型不支持则返回 null
 *
 * @example
 * ```typescript
 * const result = parseFile('/path/to/file.ts', 'export function hello() {}');
 * if (result) {
 *   console.log(result.chunks); // 输出解析出的代码块
 * }
 * ```
 */
export function parseFile(filePath: string, code: string): ParseResult | null {
  // 处理 Vue 单文件组件
  if (filePath.endsWith('.vue')) {
    return parseVueFile(filePath, code);
  }

  // 处理 TypeScript 和 JavaScript 文件（包括 JSX/TSX）
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
    return parseTsFile(filePath, code);
  }

  // 不支持的文件类型返回 null
  return null;
}
