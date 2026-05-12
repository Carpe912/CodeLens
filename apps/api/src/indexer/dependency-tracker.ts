/**
 * 依赖追踪器 - 跨文件追踪常量使用和依赖关系
 *
 * 本模块通过跟踪导入链和使用模式，追踪常量、函数和类在整个代码库中的使用情况。
 *
 * 核心功能：
 * 1. 追踪常量在代码库中的所有使用位置（直接引用和间接引用）
 * 2. 构建文件间的依赖关系图
 * 3. 检测循环依赖
 * 4. 计算依赖强度
 * 5. 查找最短依赖路径
 *
 * 使用场景：
 * - 代码重构时评估影响范围
 * - 分析模块耦合度
 * - 优化代码结构
 * - 检测潜在的架构问题
 */

import { Pool } from 'pg';
import * as path from 'path';

// ============================================
// 类型定义
// ============================================

/**
 * 常量使用信息接口
 * 描述常量在某个文件中的具体使用情况
 */
export interface ConstantUsage {
  constantId: number;          // 常量的唯一标识符
  usageFileId: number;         // 使用该常量的文件ID
  usageFilePath: string;       // 使用该常量的文件路径
  usageChunkId?: number;       // 使用该常量的代码块ID（可选）
  usageLine: number;           // 使用该常量的行号
  usageContext: string;        // 使用该常量的上下文代码
  referenceType: string;       // 引用类型：'direct'（直接引用）或 'indirect'（间接引用）
}

/**
 * 导入链接口
 * 表示符号通过导入关系传播的路径
 */
export interface ImportChain {
  fileId: number;              // 导入文件的ID
  filePath: string;            // 导入文件的路径
  symbol: string;              // 导入的符号名称
  alias?: string;              // 符号的别名（如果有重命名）
  importType: string;          // 导入类型：'named'（命名导入）、'default'（默认导入）、'namespace'（命名空间导入）
  depth: number;               // 导入链的深度（从源文件开始计数）
}

/**
 * 依赖关系图接口
 * 使用图结构表示文件、常量、函数、类之间的依赖关系
 */
export interface DependencyGraph {
  nodes: DependencyNode[];     // 图中的所有节点
  edges: DependencyEdge[];     // 图中的所有边（依赖关系）
}

/**
 * 依赖关系图节点接口
 * 表示依赖图中的一个实体（文件、常量、函数或类）
 */
export interface DependencyNode {
  id: string;                  // 节点的唯一标识符
  type: 'file' | 'constant' | 'function' | 'class';  // 节点类型
  label: string;               // 节点的显示标签
  filePath?: string;           // 如果是文件节点，存储文件路径
}

/**
 * 依赖关系图边接口
 * 表示两个节点之间的依赖关系
 */
export interface DependencyEdge {
  from: string;                // 起始节点ID
  to: string;                  // 目标节点ID
  type: 'imports' | 'uses' | 'calls' | 'extends';  // 依赖类型
  weight: number;              // 依赖强度权重
}

// ============================================
// 依赖追踪器类
// ============================================

export class DependencyTracker {
  constructor(private db: Pool) {}

  /**
   * 追踪常量在整个代码库中的所有使用情况
   *
   * 算法说明：
   * 1. 首先查询常量的基本信息（所在文件、符号名等）
   * 2. 查找直接引用：在 constant_references 表中查找所有直接使用该常量的位置
   * 3. 查找间接引用：通过导入链追踪，找到所有导入该常量的文件，然后在这些文件中搜索使用位置
   *
   * @param repoId - 仓库ID
   * @param constantId - 常量ID
   * @returns 返回常量使用信息数组，包含直接引用和间接引用
   *
   * 使用场景：
   * - 重构时评估常量修改的影响范围
   * - 查找未使用的常量
   * - 分析常量的使用模式
   */
  async traceConstantUsage(repoId: number, constantId: number): Promise<ConstantUsage[]> {
    const usages: ConstantUsage[] = [];

    // 获取常量的基本信息（包括所在文件路径和符号名）
    const constantResult = await this.db.query(
      `
      SELECT sc.*, f.path as file_path
      FROM string_constants sc
      JOIN files f ON sc.file_id = f.id
      WHERE sc.id = $1
    `,
      [constantId]
    );

    // 如果常量不存在，返回空数组
    if (constantResult.rows.length === 0) {
      return usages;
    }

    const constant = constantResult.rows[0];

    // 查找直接引用：在同一文件或通过直接访问使用该常量的位置
    const directRefs = await this.db.query(
      `
      SELECT
        cr.*,
        f.path as usage_file_path
      FROM constant_references cr
      JOIN files f ON cr.referrer_file_id = f.id
      WHERE cr.constant_id = $1
    `,
      [constantId]
    );

    // 将所有直接引用添加到结果数组
    directRefs.rows.forEach((ref) => {
      usages.push({
        constantId,
        usageFileId: ref.referrer_file_id,
        usageFilePath: ref.usage_file_path,
        usageChunkId: ref.referrer_chunk_id,
        usageLine: ref.referrer_line,
        usageContext: ref.referrer_context,
        referenceType: 'direct',  // 标记为直接引用
      });
    });

    // 查找间接引用：通过导入链追踪使用情况
    // 只有当常量有导出符号名时才进行间接引用追踪
    if (constant.symbol_name) {
      // 找到所有导入该符号的文件（包括多层导入）
      const importers = await this.findImporters(repoId, constant.file_id, constant.symbol_name);

      // 在每个导入文件中搜索符号的使用位置
      for (const importer of importers) {
        // 在导入文件中搜索符号的使用（考虑别名的情况）
        const importerUsages = await this.findUsagesInFile(
          repoId,
          importer.fileId,
          constant.symbol_name,
          importer.alias  // 如果导入时使用了别名，传入别名进行搜索
        );

        // 将间接引用添加到结果数组
        usages.push(...importerUsages);
      }
    }

    return usages;
  }

  /**
   * 查找所有从指定文件导入特定符号的文件
   *
   * 算法说明：
   * 使用广度优先搜索（BFS）追踪导入链，支持多层导入和重导出
   * 例如：A 导出 symbol -> B 导入并重导出 -> C 导入使用
   *
   * @param repoId - 仓库ID
   * @param sourceFileId - 源文件ID（定义符号的文件）
   * @param symbolName - 符号名称
   * @param maxDepth - 最大追踪深度，默认为5层，防止无限递归
   * @returns 返回导入链数组，包含每一层的导入信息
   *
   * 使用场景：
   * - 追踪符号的传播路径
   * - 分析重导出模式
   * - 评估模块的影响范围
   */
  async findImporters(
    repoId: number,
    sourceFileId: number,
    symbolName: string,
    maxDepth: number = 5
  ): Promise<ImportChain[]> {
    const chains: ImportChain[] = [];
    const visited = new Set<number>();  // 记录已访问的文件，避免重复处理

    // 初始化BFS队列，从源文件开始
    const queue: Array<{ fileId: number; symbol: string; depth: number }> = [
      { fileId: sourceFileId, symbol: symbolName, depth: 0 },
    ];

    // 广度优先搜索遍历导入链
    while (queue.length > 0) {
      const current = queue.shift()!;

      // 如果达到最大深度或已访问过该文件，跳过
      if (current.depth >= maxDepth || visited.has(current.fileId)) {
        continue;
      }

      visited.add(current.fileId);

      // 查找从当前文件导入该符号的所有文件
      // 包括命名导入和命名空间导入（import * as）
      const importers = await this.db.query(
        `
        SELECT
          ir.importer_file_id,
          ir.imported_symbol,
          ir.alias,
          ir.import_type,
          f.path as file_path
        FROM import_relations ir
        JOIN files f ON ir.importer_file_id = f.id
        WHERE ir.repo_id = $1
          AND ir.imported_file_id = $2
          AND (ir.imported_symbol = $3 OR ir.import_type = 'namespace')
      `,
        [repoId, current.fileId, current.symbol]
      );

      // 处理每个导入该符号的文件
      for (const importer of importers.rows) {
        // 确定有效的符号名：优先使用别名，否则使用导入的符号名或当前符号名
        const effectiveSymbol = importer.alias || importer.imported_symbol || current.symbol;

        // 记录导入链信息
        chains.push({
          fileId: importer.importer_file_id,
          filePath: importer.file_path,
          symbol: effectiveSymbol,
          importType: importer.import_type,
          depth: current.depth + 1,
        });

        // 继续追踪重导出：如果该文件又导出了这个符号，继续追踪下一层
        queue.push({
          fileId: importer.importer_file_id,
          symbol: effectiveSymbol,
          depth: current.depth + 1,
        });
      }
    }

    return chains;
  }

  /**
   * 在指定文件中查找符号的使用位置
   *
   * 算法说明：
   * 1. 从数据库中获取文件的所有代码块
   * 2. 使用正则表达式在每一行中搜索符号（考虑别名）
   * 3. 记录匹配的行号和上下文
   *
   * 注意：这是一个基于正则表达式的简单实现，完整的AST分析会更准确
   * 当前实现使用词边界匹配，避免匹配到符号的子串
   *
   * @param repoId - 仓库ID
   * @param fileId - 文件ID
   * @param symbolName - 符号名称
   * @param alias - 符号的别名（如果导入时重命名）
   * @returns 返回符号使用信息数组
   *
   * 局限性：
   * - 无法区分注释中的符号
   * - 无法处理字符串中的符号
   * - 可能产生误报（例如同名的局部变量）
   */
  async findUsagesInFile(
    repoId: number,
    fileId: number,
    symbolName: string,
    alias?: string
  ): Promise<ConstantUsage[]> {
    const usages: ConstantUsage[] = [];
    const searchSymbol = alias || symbolName;  // 优先使用别名进行搜索

    // 获取文件的所有代码块
    const chunks = await this.db.query(
      `
      SELECT id, content, line_start, line_end
      FROM code_chunks
      WHERE file_id = $1
    `,
      [fileId]
    );

    // 遍历每个代码块
    for (const chunk of chunks.rows) {
      const lines = chunk.content.split('\n');

      // 逐行搜索符号
      lines.forEach((line: string, index: number) => {
        // 使用正则表达式搜索符号
        // \b 表示词边界，确保只匹配完整的符号名，不匹配子串
        // 例如：搜索 "user" 不会匹配到 "username"
        const regex = new RegExp(`\\b${this.escapeRegex(searchSymbol)}\\b`, 'g');
        const matches = line.match(regex);

        if (matches) {
          // 计算实际行号（代码块起始行 + 块内偏移）
          const lineNumber = chunk.line_start + index;

          usages.push({
            constantId: -1,  // 由调用者填充实际的常量ID
            usageFileId: fileId,
            usageFilePath: '',  // 由调用者填充实际的文件路径
            usageChunkId: chunk.id,
            usageLine: lineNumber,
            usageContext: line.trim(),  // 去除首尾空白，保存上下文代码
            referenceType: 'indirect',  // 标记为间接引用（通过导入）
          });
        }
      });
    }

    return usages;
  }

  /**
   * 为指定文件构建依赖关系图
   *
   * 算法说明：
   * 使用深度优先搜索（DFS）递归构建依赖图，包括：
   * - 文件节点：代表代码文件
   * - 导入边：表示文件间的导入关系
   * - 调用边：表示函数调用关系
   *
   * @param repoId - 仓库ID
   * @param fileId - 起始文件ID
   * @param depth - 递归深度，默认为2层，控制图的复杂度
   * @returns 返回包含节点和边的依赖关系图
   *
   * 使用场景：
   * - 可视化文件依赖关系
   * - 分析模块耦合度
   * - 识别关键依赖路径
   */
  async buildFileDependencyGraph(repoId: number, fileId: number, depth: number = 2): Promise<DependencyGraph> {
    const nodes: DependencyNode[] = [];
    const edges: DependencyEdge[] = [];
    const visited = new Set<number>();  // 防止重复访问同一文件

    // 递归构建依赖图
    await this.buildGraphRecursive(repoId, fileId, depth, nodes, edges, visited);

    return { nodes, edges };
  }

  /**
   * 递归构建依赖关系图
   *
   * 算法说明：
   * 深度优先搜索（DFS）递归遍历文件依赖树
   * 1. 添加当前文件节点
   * 2. 查找该文件的所有导入关系，添加导入边
   * 3. 查找该文件的所有函数调用关系，添加调用边
   * 4. 递归处理每个依赖文件
   *
   * @param repoId - 仓库ID
   * @param fileId - 当前文件ID
   * @param depth - 剩余递归深度
   * @param nodes - 节点数组（引用传递，累积结果）
   * @param edges - 边数组（引用传递，累积结果）
   * @param visited - 已访问文件集合，防止循环依赖导致无限递归
   */
  private async buildGraphRecursive(
    repoId: number,
    fileId: number,
    depth: number,
    nodes: DependencyNode[],
    edges: DependencyEdge[],
    visited: Set<number>
  ): Promise<void> {
    // 终止条件：深度耗尽或文件已访问过
    if (depth <= 0 || visited.has(fileId)) {
      return;
    }

    visited.add(fileId);

    // 获取文件信息
    const fileResult = await this.db.query(
      `
      SELECT id, path
      FROM files
      WHERE id = $1
    `,
      [fileId]
    );

    if (fileResult.rows.length === 0) {
      return;
    }

    const file = fileResult.rows[0];

    // 添加文件节点到图中
    nodes.push({
      id: `file:${fileId}`,
      type: 'file',
      label: path.basename(file.path),  // 使用文件名作为标签
      filePath: file.path,
    });

    // 获取该文件的所有导入关系
    const imports = await this.db.query(
      `
      SELECT
        ir.*,
        f.path as imported_file_path
      FROM import_relations ir
      LEFT JOIN files f ON ir.imported_file_id = f.id
      WHERE ir.repo_id = $1 AND ir.importer_file_id = $2
    `,
      [repoId, fileId]
    );

    // 处理每个导入关系
    for (const imp of imports.rows) {
      if (imp.imported_file_id) {
        // 添加导入边：从当前文件指向被导入的文件
        edges.push({
          from: `file:${fileId}`,
          to: `file:${imp.imported_file_id}`,
          type: 'imports',
          weight: 1,
        });

        // 递归处理被导入的文件（深度减1）
        await this.buildGraphRecursive(repoId, imp.imported_file_id, depth - 1, nodes, edges, visited);
      }
    }

    // 获取该文件中的函数调用关系
    const calls = await this.db.query(
      `
      SELECT
        cg.*,
        cc1.file_id as from_file_id,
        cc2.file_id as to_file_id
      FROM call_graph cg
      JOIN code_chunks cc1 ON cg.from_chunk_id = cc1.id
      LEFT JOIN code_chunks cc2 ON cg.to_chunk_id = cc2.id
      WHERE cc1.file_id = $1
    `,
      [fileId]
    );

    // 处理每个函数调用关系
    for (const call of calls.rows) {
      // 只添加跨文件的调用边（排除文件内部调用）
      if (call.to_file_id && call.to_file_id !== fileId) {
        edges.push({
          from: `file:${fileId}`,
          to: `file:${call.to_file_id}`,
          type: 'calls',
          weight: 1,
        });
      }
    }
  }

  /**
   * 查找所有依赖于指定文件的文件（反向依赖）
   *
   * 用途：找出哪些文件导入了当前文件
   * 这对于评估文件修改的影响范围非常有用
   *
   * @param repoId - 仓库ID
   * @param fileId - 目标文件ID
   * @returns 返回依赖该文件的所有文件ID数组
   *
   * 使用场景：
   * - 重构前评估影响范围
   * - 查找文件的使用者
   * - 分析模块的重要性（被依赖越多越重要）
   */
  async findDependents(repoId: number, fileId: number): Promise<number[]> {
    const result = await this.db.query(
      `
      SELECT DISTINCT importer_file_id
      FROM import_relations
      WHERE repo_id = $1 AND imported_file_id = $2
    `,
      [repoId, fileId]
    );

    return result.rows.map((row) => row.importer_file_id);
  }

  /**
   * 查找指定文件依赖的所有文件（正向依赖）
   *
   * 用途：找出当前文件导入了哪些文件
   * 这对于理解文件的依赖关系和模块结构非常有用
   *
   * @param repoId - 仓库ID
   * @param fileId - 源文件ID
   * @returns 返回该文件依赖的所有文件ID数组
   *
   * 使用场景：
   * - 分析文件的依赖复杂度
   * - 识别过度依赖的文件
   * - 优化导入结构
   */
  async findDependencies(repoId: number, fileId: number): Promise<number[]> {
    const result = await this.db.query(
      `
      SELECT DISTINCT imported_file_id
      FROM import_relations
      WHERE repo_id = $1 AND importer_file_id = $2 AND imported_file_id IS NOT NULL
    `,
      [repoId, fileId]
    );

    return result.rows.map((row) => row.imported_file_id);
  }

  /**
   * 计算两个文件之间的依赖强度
   *
   * 算法说明：
   * 依赖强度 = 导入关系数量 × 2 + 函数调用数量 × 1
   * 导入关系的权重更高，因为它表示更强的耦合
   *
   * @param repoId - 仓库ID
   * @param sourceFileId - 源文件ID
   * @param targetFileId - 目标文件ID
   * @returns 返回依赖强度值（数值越大表示依赖越强）
   *
   * 使用场景：
   * - 识别紧密耦合的文件对
   * - 优先重构高耦合模块
   * - 可视化依赖关系时调整边的粗细
   *
   * 权重说明：
   * - 导入关系权重 = 2：表示结构性依赖，更难解耦
   * - 函数调用权重 = 1：表示行为性依赖，相对容易重构
   */
  async calculateDependencyStrength(repoId: number, sourceFileId: number, targetFileId: number): Promise<number> {
    // 统计导入关系数量
    const importCount = await this.db.query(
      `
      SELECT COUNT(*) as count
      FROM import_relations
      WHERE repo_id = $1
        AND importer_file_id = $2
        AND imported_file_id = $3
    `,
      [repoId, sourceFileId, targetFileId]
    );

    // 统计函数调用数量
    const callCount = await this.db.query(
      `
      SELECT COUNT(*) as count
      FROM call_graph cg
      JOIN code_chunks cc1 ON cg.from_chunk_id = cc1.id
      JOIN code_chunks cc2 ON cg.to_chunk_id = cc2.id
      WHERE cc1.file_id = $1 AND cc2.file_id = $2
    `,
      [sourceFileId, targetFileId]
    );

    const imports = parseInt(importCount.rows[0].count);
    const calls = parseInt(callCount.rows[0].count);

    // 计算加权依赖强度：导入的权重是调用的2倍
    return imports * 2 + calls;
  }

  /**
   * 查找仓库中的循环依赖
   *
   * 算法说明：
   * 使用深度优先搜索（DFS）和递归栈检测有向图中的环
   * 1. 遍历所有文件作为起点
   * 2. 对每个未访问的文件执行DFS
   * 3. 使用递归栈标记当前路径上的节点
   * 4. 如果遇到递归栈中的节点，说明找到了环
   *
   * @param repoId - 仓库ID
   * @returns 返回循环依赖数组，每个元素是一个文件ID数组，表示一个循环
   *
   * 使用场景：
   * - 识别架构问题
   * - 重构前的代码质量检查
   * - 防止模块加载死锁
   *
   * 循环依赖的危害：
   * - 增加代码理解难度
   * - 可能导致模块加载失败
   * - 降低代码可测试性
   * - 增加重构难度
   */
  async findCircularDependencies(repoId: number): Promise<number[][]> {
    const cycles: number[][] = [];
    const visited = new Set<number>();        // 全局已访问集合
    const recursionStack = new Set<number>(); // 当前递归路径栈

    // 获取仓库中的所有文件
    const filesResult = await this.db.query(
      `
      SELECT id FROM files WHERE repo_id = $1
    `,
      [repoId]
    );

    const fileIds = filesResult.rows.map((row) => row.id);

    // 对每个未访问的文件执行DFS
    for (const fileId of fileIds) {
      if (!visited.has(fileId)) {
        await this.detectCyclesDFS(repoId, fileId, visited, recursionStack, [], cycles);
      }
    }

    return cycles;
  }

  /**
   * 使用深度优先搜索检测循环依赖
   *
   * 算法说明：
   * 经典的DFS环检测算法，使用三色标记法的变体
   * - 白色（未访问）：不在visited集合中
   * - 灰色（访问中）：在recursionStack中
   * - 黑色（已完成）：在visited中但不在recursionStack中
   *
   * 当遇到灰色节点时，说明找到了环
   *
   * @param repoId - 仓库ID
   * @param fileId - 当前访问的文件ID
   * @param visited - 全局已访问集合（黑色节点）
   * @param recursionStack - 当前递归路径栈（灰色节点）
   * @param path - 当前路径上的文件ID数组
   * @param cycles - 累积的循环依赖结果数组
   *
   * 时间复杂度：O(V + E)，其中V是文件数，E是依赖关系数
   */
  private async detectCyclesDFS(
    repoId: number,
    fileId: number,
    visited: Set<number>,
    recursionStack: Set<number>,
    path: number[],
    cycles: number[][]
  ): Promise<void> {
    visited.add(fileId);           // 标记为已访问
    recursionStack.add(fileId);    // 加入递归栈（标记为灰色）
    path.push(fileId);             // 加入当前路径

    // 获取当前文件的所有依赖
    const dependencies = await this.findDependencies(repoId, fileId);

    for (const depId of dependencies) {
      if (!visited.has(depId)) {
        // 白色节点：继续DFS
        await this.detectCyclesDFS(repoId, depId, visited, recursionStack, path, cycles);
      } else if (recursionStack.has(depId)) {
        // 灰色节点：找到环！
        // 从路径中提取环的部分（从环的起点到当前节点）
        const cycleStart = path.indexOf(depId);
        const cycle = path.slice(cycleStart);
        cycles.push(cycle);
      }
      // 黑色节点：跳过（已经完全处理过）
    }

    // 回溯：从递归栈中移除（标记为黑色）
    recursionStack.delete(fileId);
    path.pop();
  }

  /**
   * 查找两个文件之间的最短依赖路径
   *
   * 算法说明：
   * 使用广度优先搜索（BFS）查找最短路径
   * BFS保证找到的第一条路径就是最短路径
   *
   * @param repoId - 仓库ID
   * @param sourceFileId - 源文件ID
   * @param targetFileId - 目标文件ID
   * @returns 返回文件ID数组表示路径，如果不存在路径则返回null
   *
   * 使用场景：
   * - 理解两个模块之间的依赖关系
   * - 分析依赖传播路径
   * - 优化导入结构
   *
   * 时间复杂度：O(V + E)，其中V是文件数，E是依赖关系数
   * 空间复杂度：O(V)
   */
  async findShortestPath(repoId: number, sourceFileId: number, targetFileId: number): Promise<number[] | null> {
    // 初始化BFS队列，包含起始文件和路径
    const queue: Array<{ fileId: number; path: number[] }> = [{ fileId: sourceFileId, path: [sourceFileId] }];
    const visited = new Set<number>();  // 记录已访问的文件

    while (queue.length > 0) {
      const current = queue.shift()!;

      // 找到目标文件，返回路径
      if (current.fileId === targetFileId) {
        return current.path;
      }

      // 跳过已访问的文件
      if (visited.has(current.fileId)) {
        continue;
      }

      visited.add(current.fileId);

      // 获取当前文件的所有依赖
      const dependencies = await this.findDependencies(repoId, current.fileId);

      // 将所有未访问的依赖加入队列
      for (const depId of dependencies) {
        if (!visited.has(depId)) {
          queue.push({
            fileId: depId,
            path: [...current.path, depId],  // 扩展路径
          });
        }
      }
    }

    // 未找到路径
    return null;
  }

  /**
   * 转义正则表达式中的特殊字符
   *
   * 将字符串中的正则表达式元字符转义，使其可以安全地用于正则表达式字面量匹配
   *
   * @param str - 需要转义的字符串
   * @returns 转义后的字符串
   *
   * 转义的字符：. * + ? ^ $ { } ( ) | [ ] \
   *
   * 示例：
   * escapeRegex("user.name") => "user\\.name"
   * escapeRegex("$variable") => "\\$variable"
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 获取仓库的依赖关系统计信息
   *
   * 提供仓库级别的依赖关系概览，帮助评估代码库的整体健康度
   *
   * @param repoId - 仓库ID
   * @returns 返回包含以下统计信息的对象：
   *   - totalFiles: 文件总数
   *   - totalImports: 导入关系总数
   *   - avgImportsPerFile: 每个文件的平均导入数
   *   - maxImportsPerFile: 单个文件的最大导入数
   *   - filesWithCircularDeps: 涉及循环依赖的文件数量
   *
   * 使用场景：
   * - 代码质量评估
   * - 识别过度依赖的文件
   * - 追踪重构进度
   * - 生成依赖关系报告
   *
   * 健康指标参考：
   * - avgImportsPerFile < 10: 良好
   * - avgImportsPerFile 10-20: 中等
   * - avgImportsPerFile > 20: 需要优化
   * - filesWithCircularDeps = 0: 理想状态
   */
  async getDependencyStats(repoId: number): Promise<{
    totalFiles: number;
    totalImports: number;
    avgImportsPerFile: number;
    maxImportsPerFile: number;
    filesWithCircularDeps: number;
  }> {
    // 使用CTE（公共表表达式）计算每个文件的导入数量
    const stats = await this.db.query(
      `
      WITH file_import_counts AS (
        SELECT
          importer_file_id,
          COUNT(*) as import_count
        FROM import_relations
        WHERE repo_id = $1
        GROUP BY importer_file_id
      )
      SELECT
        COUNT(DISTINCT f.id) as total_files,
        COUNT(ir.id) as total_imports,
        COALESCE(AVG(fic.import_count), 0) as avg_imports_per_file,
        COALESCE(MAX(fic.import_count), 0) as max_imports_per_file
      FROM files f
      LEFT JOIN import_relations ir ON f.id = ir.importer_file_id AND ir.repo_id = $1
      LEFT JOIN file_import_counts fic ON f.id = fic.importer_file_id
      WHERE f.repo_id = $1
    `,
      [repoId]
    );

    // 检测循环依赖并统计涉及的文件数
    const cycles = await this.findCircularDependencies(repoId);
    const filesInCycles = new Set(cycles.flat());  // 使用Set去重，因为一个文件可能在多个环中

    return {
      totalFiles: parseInt(stats.rows[0].total_files),
      totalImports: parseInt(stats.rows[0].total_imports),
      avgImportsPerFile: parseFloat(stats.rows[0].avg_imports_per_file),
      maxImportsPerFile: parseInt(stats.rows[0].max_imports_per_file),
      filesWithCircularDeps: filesInCycles.size,
    };
  }
}
