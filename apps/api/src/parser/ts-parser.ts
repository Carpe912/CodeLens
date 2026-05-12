/**
 * TypeScript/JavaScript 代码解析器
 * 使用 Babel 解析器和遍历器，提取代码中的各种语法结构
 *
 * 核心技术：
 * - @babel/parser: 将代码解析为抽象语法树（AST）
 * - @babel/traverse: 遍历 AST 节点，提取代码结构信息
 *
 * 支持的语法特性：
 * - TypeScript 类型系统（接口、类型别名、装饰器等）
 * - JSX/TSX 语法
 * - ES6+ 模块系统（import/export）
 * - 类和函数声明
 * - 箭头函数和变量声明
 */

import { parse } from '@babel/parser';
import traverseModule, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import type { CodeChunk, ParseResult } from './types.js';

// 处理 ESM 和 CJS 两种模块导入方式的兼容性
// 某些环境下 traverse 可能作为 default 导出
const traverse = typeof traverseModule === 'function' ? traverseModule : (traverseModule as any).default;

/**
 * 解析 TypeScript/JavaScript 文件
 *
 * 功能说明：
 * - 将源代码解析为 AST（抽象语法树）
 * - 遍历 AST 提取各种代码结构（函数、类、变量、接口等）
 * - 分析导入导出关系
 * - 提取函数调用关系，用于构建调用图
 * - 去重处理，避免重复记录相同的代码块
 *
 * 算法流程：
 * 1. 使用 Babel parser 将代码解析为 AST
 * 2. 使用 visitor 模式遍历 AST 的各种节点类型
 * 3. 对每种节点类型提取相应的信息（名称、位置、代码等）
 * 4. 对于函数和方法，额外提取内部的函数调用
 * 5. 去除重复的代码块（相同名称和位置）
 * 6. 返回完整的解析结果
 *
 * 支持的代码结构：
 * - 函数声明（FunctionDeclaration）
 * - 类声明（ClassDeclaration）
 * - 变量声明（VariableDeclaration），包括箭头函数
 * - 类方法（ClassMethod）
 * - 对象方法（ObjectMethod）
 * - TypeScript 接口（TSInterfaceDeclaration）
 * - TypeScript 类型别名（TSTypeAliasDeclaration）
 * - 导入语句（ImportDeclaration）
 * - 导出语句（ExportNamedDeclaration、ExportDefaultDeclaration）
 *
 * @param filePath - 文件的绝对路径
 * @param code - 文件的源代码内容
 * @returns 解析结果，包含所有提取的代码块和依赖关系；解析失败时返回空结果
 *
 * @example
 * ```typescript
 * const code = `
 *   import { foo } from './foo';
 *   export function bar() {
 *     return foo();
 *   }
 * `;
 * const result = parseTsFile('/path/to/file.ts', code);
 * // result.chunks 包含 bar 函数
 * // result.imports 包含 foo 的导入信息
 * // result.exports 包含 bar 的导出信息
 * ```
 */
export function parseTsFile(filePath: string, code: string): ParseResult {
  // 初始化结果容器
  const chunks: CodeChunk[] = [];
  const imports: Array<{ source: string; specifiers: string[] }> = [];
  const exports: string[] = [];

  try {
    // 使用 Babel 解析器将代码转换为 AST
    // 配置支持 TypeScript、JSX 和装饰器语法
    const ast = parse(code, {
      sourceType: 'module', // 使用 ES 模块语法
      plugins: [
        'typescript', // 支持 TypeScript 语法
        'jsx', // 支持 JSX 语法
        ['decorators', { decoratorsBeforeExport: true }], // 支持装饰器，装饰器在 export 之前
      ],
    });

  // 使用 visitor 模式遍历 AST，提取各种代码结构
  traverse(ast, {
    /**
     * 处理导入声明语句
     * 提取导入的模块路径和具体导入的符号
     *
     * 支持的导入形式：
     * - import defaultExport from 'module'
     * - import { named } from 'module'
     * - import * as namespace from 'module'
     */
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      const source = path.node.source.value; // 导入的模块路径
      // 提取导入的具体符号名称
      const specifiers = path.node.specifiers.map((spec: t.ImportDeclaration['specifiers'][0]) => {
        if (spec.type === 'ImportDefaultSpecifier') {
          // 默认导入：import Foo from 'module'
          return spec.local.name;
        }
        if (spec.type === 'ImportSpecifier') {
          // 命名导入：import { foo } from 'module'
          return spec.imported.type === 'Identifier' ? spec.imported.name : '';
        }
        return '';
      }).filter(Boolean); // 过滤掉空字符串
      imports.push({ source, specifiers });
    },

    /**
     * 处理函数声明
     * 提取函数的名称、位置、代码和内部调用的函数
     *
     * 示例：function foo() { bar(); }
     */
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      const node = path.node;
      // 跳过匿名函数或没有位置信息的函数
      if (!node.id || !node.loc) return;

      // 收集函数内部的所有函数调用
      const calls: string[] = [];
      path.traverse({
        CallExpression(callPath: NodePath<t.CallExpression>) {
          const callee = callPath.node.callee;
          if (callee.type === 'Identifier') {
            // 直接调用：foo()
            calls.push(callee.name);
          } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
            // 成员调用：obj.method()
            calls.push(callee.property.name);
          }
        },
      });

      // 提取函数的完整代码文本
      chunks.push({
        symbolName: node.id.name,
        symbolType: 'function',
        lineStart: node.loc.start.line,
        lineEnd: node.loc.end.line,
        code: code.split('\n').slice(node.loc.start.line - 1, node.loc.end.line).join('\n'),
        filePath,
        language: 'typescript',
        imports: [],
        exports: [],
        calls,
      });
    },

    /**
     * 处理类声明
     * 提取类的名称、位置和完整代码
     *
     * 示例：class MyClass { ... }
     */
    ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
      const node = path.node;
      // 跳过匿名类或没有位置信息的类
      if (!node.id || !node.loc) return;

      chunks.push({
        symbolName: node.id.name,
        symbolType: 'class',
        lineStart: node.loc.start.line,
        lineEnd: node.loc.end.line,
        code: code.split('\n').slice(node.loc.start.line - 1, node.loc.end.line).join('\n'),
        filePath,
        language: 'typescript',
        imports: [],
        exports: [],
        calls: [],
      });
    },

    /**
     * 处理变量声明
     * 区分普通变量和箭头函数变量
     *
     * 支持的形式：
     * - const foo = 'value' (普通变量)
     * - const bar = () => {} (箭头函数)
     * - const baz = function() {} (函数表达式)
     */
    VariableDeclaration(path: NodePath<t.VariableDeclaration>) {
      const node = path.node;
      if (!node.loc) return;

      // 遍历所有变量声明（const a = 1, b = 2）
      node.declarations.forEach((decl: t.VariableDeclarator) => {
        // 只处理简单标识符，跳过解构赋值
        if (decl.id.type !== 'Identifier' || !decl.init || !decl.loc) return;

        // 特殊处理箭头函数：const fn = () => {}
        if (decl.init.type === 'ArrowFunctionExpression') {
          // 收集箭头函数内部的函数调用
          const calls: string[] = [];
          path.traverse({
            CallExpression(callPath: NodePath<t.CallExpression>) {
              const callee = callPath.node.callee;
              if (callee.type === 'Identifier') {
                calls.push(callee.name);
              } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
                calls.push(callee.property.name);
              }
            },
          });

          // 将箭头函数作为 function 类型记录
          chunks.push({
            symbolName: decl.id.name,
            symbolType: 'function',
            lineStart: decl.loc.start.line,
            lineEnd: decl.loc.end.line,
            code: code.split('\n').slice(decl.loc.start.line - 1, decl.loc.end.line).join('\n'),
            filePath,
            language: 'typescript',
            imports: [],
            exports: [],
            calls,
          });
        }
        // 普通变量声明
        else {
          chunks.push({
            symbolName: decl.id.name,
            symbolType: 'variable',
            lineStart: decl.loc.start.line,
            lineEnd: decl.loc.end.line,
            code: code.split('\n').slice(decl.loc.start.line - 1, decl.loc.end.line).join('\n'),
            filePath,
            language: 'typescript',
            imports: [],
            exports: [],
            calls: [],
          });
        }
      });
    },

    /**
     * 处理命名导出声明
     * 提取导出的符号名称
     *
     * 支持的形式：
     * - export function foo() {}
     * - export class Bar {}
     * - export const baz = 1
     */
    ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
      const node = path.node;
      if (node.declaration) {
        if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
          exports.push(node.declaration.id.name);
        } else if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
          exports.push(node.declaration.id.name);
        } else if (node.declaration.type === 'VariableDeclaration') {
          // 处理变量导出，可能有多个：export const a = 1, b = 2
          node.declaration.declarations.forEach((decl: t.VariableDeclarator) => {
            if (decl.id.type === 'Identifier') {
              exports.push(decl.id.name);
            }
          });
        }
      }
    },

    /**
     * 处理默认导出声明
     * 提取默认导出的符号名称
     *
     * 支持的形式：
     * - export default function foo() {}
     * - export default class Bar {}
     * - export default identifier
     */
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      const node = path.node;
      if (node.declaration.type === 'Identifier') {
        // export default foo
        exports.push(node.declaration.name);
      } else if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
        // export default function foo() {}
        exports.push(node.declaration.id.name);
      } else if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
        // export default class Foo {}
        exports.push(node.declaration.id.name);
      }
    },

    /**
     * 处理 TypeScript 接口声明
     * 提取接口的名称、位置和完整定义
     *
     * 示例：interface User { name: string; }
     */
    TSInterfaceDeclaration(path: NodePath<t.TSInterfaceDeclaration>) {
      const node = path.node;
      if (!node.id || !node.loc) return;

      chunks.push({
        symbolName: node.id.name,
        symbolType: 'interface',
        lineStart: node.loc.start.line,
        lineEnd: node.loc.end.line,
        code: code.split('\n').slice(node.loc.start.line - 1, node.loc.end.line).join('\n'),
        filePath,
        language: 'typescript',
        imports: [],
        exports: [],
        calls: [],
      });
    },

    /**
     * 处理 TypeScript 类型别名声明
     * 提取类型别名的名称、位置和完整定义
     *
     * 示例：type Status = 'active' | 'inactive'
     */
    TSTypeAliasDeclaration(path: NodePath<t.TSTypeAliasDeclaration>) {
      const node = path.node;
      if (!node.id || !node.loc) return;

      chunks.push({
        symbolName: node.id.name,
        symbolType: 'type',
        lineStart: node.loc.start.line,
        lineEnd: node.loc.end.line,
        code: code.split('\n').slice(node.loc.start.line - 1, node.loc.end.line).join('\n'),
        filePath,
        language: 'typescript',
        imports: [],
        exports: [],
        calls: [],
      });
    },

    /**
     * 处理对象方法
     * 提取对象字面量中定义的方法
     *
     * 示例：const obj = { method() { ... } }
     */
    ObjectMethod(path: NodePath<t.ObjectMethod>) {
      const node = path.node;
      // 只处理标识符形式的方法名
      if (node.key.type !== 'Identifier' || !node.loc) return;

      // 收集方法内部的函数调用
      const calls: string[] = [];
      path.traverse({
        CallExpression(callPath: NodePath<t.CallExpression>) {
          const callee = callPath.node.callee;
          if (callee.type === 'Identifier') {
            calls.push(callee.name);
          } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
            calls.push(callee.property.name);
          }
        },
      });

      chunks.push({
        symbolName: node.key.name,
        symbolType: 'method',
        lineStart: node.loc.start.line,
        lineEnd: node.loc.end.line,
        code: code.split('\n').slice(node.loc.start.line - 1, node.loc.end.line).join('\n'),
        filePath,
        language: 'typescript',
        imports: [],
        exports: [],
        calls,
      });
    },

    /**
     * 处理类方法
     * 提取类中定义的方法（包括构造函数、普通方法、getter/setter）
     *
     * 示例：class Foo { method() { ... } }
     */
    ClassMethod(path: NodePath<t.ClassMethod>) {
      const node = path.node;
      // 只处理标识符形式的方法名
      if (node.key.type !== 'Identifier' || !node.loc) return;

      // 收集方法内部的函数调用
      const calls: string[] = [];
      path.traverse({
        CallExpression(callPath: NodePath<t.CallExpression>) {
          const callee = callPath.node.callee;
          if (callee.type === 'Identifier') {
            calls.push(callee.name);
          } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
            calls.push(callee.property.name);
          }
        },
      });

      chunks.push({
        symbolName: node.key.name,
        symbolType: 'method',
        lineStart: node.loc.start.line,
        lineEnd: node.loc.end.line,
        code: code.split('\n').slice(node.loc.start.line - 1, node.loc.end.line).join('\n'),
        filePath,
        language: 'typescript',
        imports: [],
        exports: [],
        calls,
      });
    },
  });

  // 去重处理：移除重复的代码块
  // 判断标准：相同的符号名称、起始行号和结束行号
  // 这种情况可能发生在某些复杂的 AST 遍历场景中
  const uniqueChunks = chunks.filter((chunk, index, self) =>
    index === self.findIndex((c) =>
      c.symbolName === chunk.symbolName &&
      c.lineStart === chunk.lineStart &&
      c.lineEnd === chunk.lineEnd
    )
  );

  // 返回完整的解析结果
  return {
    filePath,
    language: 'typescript',
    chunks: uniqueChunks,
    imports,
    exports,
  };
  } catch (error) {
    // 解析失败时记录错误并返回空结果
    // 可能的失败原因：语法错误、不支持的语法特性等
    console.error(`Failed to parse ${filePath}:`, error);
    return {
      filePath,
      language: 'typescript',
      chunks: [],
      imports: [],
      exports: [],
    };
  }
}
