/**
 * 代码块类型定义
 * 表示从源代码中解析出的一个独立的代码单元（函数、类、方法等）
 *
 * 使用场景：
 * - 代码分析和索引
 * - 代码搜索和导航
 * - 依赖关系分析
 * - 代码重构辅助
 */
export type CodeChunk = {
  /** 符号名称（函数名、类名、变量名等） */
  symbolName: string;

  /** 符号类型，用于区分不同的代码结构 */
  symbolType: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type' | 'component';

  /** 代码块起始行号（从 1 开始） */
  lineStart: number;

  /** 代码块结束行号（包含） */
  lineEnd: number;

  /** 代码块的完整源代码文本 */
  code: string;

  /** 代码块所在的文件路径（绝对路径） */
  filePath: string;

  /** 代码块所属的编程语言 */
  language: 'typescript' | 'javascript' | 'vue';

  /** 该代码块内部使用的导入符号列表 */
  imports: string[];

  /** 该代码块导出的符号列表 */
  exports: string[];

  /** 该代码块内部调用的函数/方法名称列表，用于构建调用图 */
  calls: string[];
};

/**
 * 文件解析结果类型定义
 * 包含整个文件的解析信息，包括所有代码块、导入和导出
 *
 * 使用场景：
 * - 文件级别的代码分析
 * - 模块依赖关系图构建
 * - 代码库索引和搜索
 */
export type ParseResult = {
  /** 被解析文件的路径（绝对路径） */
  filePath: string;

  /** 文件的编程语言类型 */
  language: 'typescript' | 'javascript' | 'vue';

  /** 从文件中解析出的所有代码块列表 */
  chunks: CodeChunk[];

  /** 文件中的所有导入语句，包含导入源和具体导入的符号 */
  imports: Array<{ source: string; specifiers: string[] }>;

  /** 文件导出的所有符号名称列表 */
  exports: string[];
};
