/**
 * 关系构建器 - 构建代码实体之间的关系
 *
 * 本模块接收 AST 分析的输出结果，在数据库中构建各种关系：
 * 1. 导入关系（import relations）- 文件之间的依赖关系
 * 2. 常量引用（constant references）- 常量在哪里被使用
 * 3. URL 使用关系（URL usages）- URL 模式的定义和使用位置
 * 4. 调用图（call graphs）- 函数之间的调用关系
 * 5. 文件依赖（file dependencies）- 由数据库触发器自动生成
 *
 * 这些关系构成了代码知识图谱的核心，支持：
 * - 跨文件符号追踪
 * - 函数调用链分析
 * - 常量影响范围分析
 * - API 端点使用追踪
 */

import { Pool } from 'pg';
import { ASTAnalysisResult, StringConstant, URLPattern, FunctionInfo, ImportInfo } from './ast-analyzer.js';
import * as path from 'path';

// ============================================
// 类型定义
// ============================================

/**
 * 关系构建结果
 * 记录本次构建过程中创建的各类关系数量
 */
export interface RelationshipBuildResult {
  importsCreated: number;              // 创建的导入关系数量
  constantReferencesCreated: number;   // 创建的常量引用数量
  urlUsagesCreated: number;            // 创建的 URL 使用关系数量
  callGraphEdgesCreated: number;       // 创建的调用图边数量
  fileDependenciesCreated: number;     // 创建的文件依赖数量（通常由触发器自动生成）
}

// ============================================
// 关系构建器类
// ============================================

/**
 * 关系构建器
 * 负责从 AST 分析结果中提取并构建代码实体之间的各种关系
 */
export class RelationshipBuilder {
  /**
   * 构造函数
   * @param db - PostgreSQL 数据库连接池，用于执行所有数据库操作
   */
  constructor(private db: Pool) {}

  /**
   * 为单个文件的 AST 分析结果构建所有关系
   *
   * 这是关系构建的主入口函数，按顺序执行以下步骤：
   * 1. 构建导入关系 - 记录该文件导入了哪些其他文件的符号
   * 2. 构建常量引用 - 记录该文件中的常量在哪里被使用
   * 3. 构建 URL 使用关系 - 记录该文件中定义或使用的 URL 模式
   * 4. 构建调用图边 - 记录该文件中的函数调用了哪些其他函数
   * 5. 文件依赖关系 - 由数据库触发器自动生成，无需手动处理
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID（数据库中的主键）
   * @param filePath - 文件路径（相对于仓库根目录）
   * @param astResult - AST 分析结果，包含提取的所有实体信息
   * @returns 关系构建结果，包含各类关系的创建数量
   * @throws 如果构建过程中发生错误，会记录日志并重新抛出异常
   */
  async buildRelationships(
    repoId: number,
    fileId: number,
    filePath: string,
    astResult: ASTAnalysisResult
  ): Promise<RelationshipBuildResult> {
    // 初始化结果对象，记录各类关系的创建数量
    const result: RelationshipBuildResult = {
      importsCreated: 0,
      constantReferencesCreated: 0,
      urlUsagesCreated: 0,
      callGraphEdgesCreated: 0,
      fileDependenciesCreated: 0,
    };

    try {
      // 步骤 1: 构建导入关系
      // 解析 import 语句，记录该文件导入了哪些符号，从哪个文件导入
      result.importsCreated = await this.buildImportRelationships(repoId, fileId, filePath, astResult.imports);

      // 步骤 2: 构建常量引用
      // 查找常量在代码中的使用位置，建立常量定义与使用之间的关系
      result.constantReferencesCreated = await this.buildConstantReferences(
        repoId,
        fileId,
        astResult.stringConstants
      );

      // 步骤 3: 构建 URL 使用关系
      // 记录 URL 模式的定义位置和使用上下文（API 调用、路由定义等）
      result.urlUsagesCreated = await this.buildURLUsages(repoId, fileId, astResult.urlPatterns);

      // 步骤 4: 构建调用图边
      // 分析函数体中的函数调用，建立函数之间的调用关系
      result.callGraphEdgesCreated = await this.buildCallGraphEdges(repoId, fileId, astResult.functions);

      // 步骤 5: 更新文件依赖关系（由 import_relations 表的触发器自动完成）
      // 数据库触发器会自动聚合 import_relations 表的数据，生成文件级别的依赖关系
      // 因此这里不需要手动处理

      return result;
    } catch (error) {
      // 记录错误日志，包含文件路径以便调试
      console.error(`Error building relationships for file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * 构建导入关系
   *
   * 解析文件中的所有 import 语句，建立导入者文件与被导入文件之间的关系。
   * 这些关系用于：
   * - 构建文件依赖图
   * - 跨文件符号解析（查找符号定义）
   * - 影响范围分析（修改一个文件会影响哪些文件）
   *
   * 处理的导入类型：
   * - named import: import { User } from './types'
   * - default import: import React from 'react'
   * - namespace import: import * as utils from './utils'
   * - side-effect import: import './styles.css'
   *
   * @param repoId - 仓库 ID
   * @param importerFileId - 导入者文件的 ID（当前文件）
   * @param importerFilePath - 导入者文件的路径
   * @param imports - AST 分析提取的导入信息列表
   * @returns 成功创建的导入关系数量
   */
  private async buildImportRelationships(
    repoId: number,
    importerFileId: number,
    importerFilePath: string,
    imports: ImportInfo[]
  ): Promise<number> {
    let count = 0;

    // 遍历所有导入语句
    for (const imp of imports) {
      try {
        // 步骤 1: 解析导入路径，将相对路径转换为绝对路径
        // 例如：'./types' → 'src/api/types.ts'
        const importedFilePath = this.resolveImportPath(importerFilePath, imp.importPath);
        let importedFileId: number | null = null;

        // 步骤 2: 如果是内部导入（非 node_modules），在数据库中查找被导入的文件
        if (!imp.isExternal && importedFilePath) {
          // 在数据库中查找被导入文件的 ID
          const fileResult = await this.db.query(
            `
            SELECT id FROM files
            WHERE repo_id = $1 AND path = $2
          `,
            [repoId, importedFilePath]
          );

          // 如果找到了被导入的文件，记录其 ID
          if (fileResult.rows.length > 0) {
            importedFileId = fileResult.rows[0].id;
          }
        }

        // 步骤 3: 插入导入关系到数据库
        // 即使是外部导入（如 'react'），也会记录，但 imported_file_id 为 null
        await this.db.query(
          `
          INSERT INTO import_relations (
            repo_id,
            importer_file_id,      -- 导入者文件 ID
            importer_line,         -- 导入语句所在行号
            imported_file_id,      -- 被导入文件 ID（外部导入时为 null）
            imported_symbol,       -- 导入的符号名称（如 'User'）
            import_type,           -- 导入类型：named/default/namespace/side-effect
            import_path,           -- 原始导入路径（如 './types' 或 'react'）
            is_external,           -- 是否为外部依赖
            alias                  -- 别名（如 import { User as U }）
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT DO NOTHING  -- 如果已存在相同的导入关系，忽略
        `,
          [
            repoId,
            importerFileId,
            imp.line,
            importedFileId,
            imp.importedSymbol || null,
            imp.importType,
            imp.importPath,
            imp.isExternal,
            imp.alias || null,
          ]
        );

        count++;
      } catch (error) {
        // 记录错误但不中断整个流程，继续处理其他导入
        console.error(`Error creating import relation for ${imp.importPath}:`, error);
      }
    }

    return count;
  }

  /**
   * 构建常量引用关系
   *
   * 查找字符串常量在代码中的使用位置，建立常量定义与引用之间的关系。
   * 这对于以下场景非常有用：
   * - 查找某个 API 路径常量在哪些地方被使用
   * - 分析修改某个常量会影响哪些代码
   * - 追踪配置项的使用范围
   *
   * 处理两种类型的常量：
   * 1. 导出常量：可以被其他文件导入使用，需要跨文件搜索引用
   * 2. 本地常量：只在当前文件内使用，只需在当前文件内搜索
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param constants - AST 分析提取的字符串常量列表
   * @returns 成功创建的常量引用关系数量
   */
  private async buildConstantReferences(
    repoId: number,
    fileId: number,
    constants: StringConstant[]
  ): Promise<number> {
    let count = 0;

    // 遍历所有字符串常量
    for (const constant of constants) {
      try {
        // 步骤 1: 在数据库中查找该常量的记录
        // 使用 string_value 和 line_start 作为唯一标识
        const constantResult = await this.db.query(
          `
          SELECT id FROM string_constants
          WHERE repo_id = $1
            AND file_id = $2
            AND string_value = $3
            AND line_start = $4
        `,
          [repoId, fileId, constant.stringValue, constant.lineStart]
        );

        // 如果常量不存在（可能是存储失败），跳过
        if (constantResult.rows.length === 0) {
          continue;
        }

        const constantId = constantResult.rows[0].id;

        // 步骤 2: 查找该常量的所有引用位置
        // 只有具名常量（有 symbolName）才能被引用
        if (constant.symbolName) {
          let references;

          // 根据常量的导出类型选择不同的搜索策略
          if (constant.exportType !== 'none') {
            // 导出常量：需要在导入该常量的文件中搜索引用
            // 例如：export const API_BASE = '/api'
            // 其他文件通过 import { API_BASE } from './constants' 使用
            references = await this.findConstantReferences(repoId, fileId, constant.symbolName);
          } else {
            // 非导出常量：只在当前文件内搜索引用
            // 例如：const LOCAL_CONFIG = { ... }
            references = await this.findLocalConstantReferences(repoId, fileId, constant.symbolName);
          }

          // 步骤 3: 将所有找到的引用关系插入数据库
          for (const ref of references) {
            await this.db.query(
              `
              INSERT INTO constant_references (
                repo_id,
                referrer_file_id,    -- 引用者文件 ID
                referrer_chunk_id,   -- 引用者代码块 ID
                referrer_line,       -- 引用所在行号
                referrer_context,    -- 引用的上下文代码（用于展示）
                constant_id,         -- 被引用的常量 ID
                reference_type       -- 引用类型：direct_reference/namespace_access/local_reference
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT DO NOTHING  -- 避免重复插入
            `,
              [repoId, ref.fileId, ref.chunkId, ref.line, ref.context, constantId, ref.type]
            );

            count++;
          }
        }
      } catch (error) {
        // 记录错误但继续处理其他常量
        console.error(`Error creating constant references for ${constant.symbolName}:`, error);
      }
    }

    return count;
  }

  /**
   * 查找导出常量的跨文件引用
   *
   * 对于导出的常量，需要在所有导入该常量的文件中搜索其使用位置。
   * 搜索策略：
   * 1. 查找所有导入该常量的文件（通过 import_relations 表）
   * 2. 在这些文件的代码块中搜索常量名称
   * 3. 处理别名情况（import { API_BASE as BASE }）
   * 4. 处理命名空间导入（import * as constants from './constants'）
   *
   * @param repoId - 仓库 ID
   * @param definitionFileId - 常量定义所在的文件 ID
   * @param symbolName - 常量的符号名称
   * @returns 引用信息列表，包含文件 ID、代码块 ID、行号、上下文和引用类型
   */
  private async findConstantReferences(
    repoId: number,
    definitionFileId: number,
    symbolName: string
  ): Promise<Array<{ fileId: number; chunkId: number; line: number; context: string; type: string }>> {
    const references: Array<{ fileId: number; chunkId: number; line: number; context: string; type: string }> = [];

    // 步骤 1: 查找所有导入该符号的文件
    // 包括直接导入（import { API_BASE }）和命名空间导入（import * as constants）
    const importers = await this.db.query(
      `
      SELECT
        ir.importer_file_id,
        ir.alias,              -- 别名（如果有）
        ir.import_type         -- 导入类型
      FROM import_relations ir
      WHERE ir.repo_id = $1
        AND ir.imported_file_id = $2
        AND (ir.imported_symbol = $3 OR ir.import_type = 'namespace')
    `,
      [repoId, definitionFileId, symbolName]
    );

    // 步骤 2: 在每个导入文件中搜索常量的使用
    for (const importer of importers.rows) {
      // 确定要搜索的符号名称（如果有别名，使用别名）
      const searchSymbol = importer.alias || symbolName;

      // 步骤 3: 获取该文件的所有代码块
      const chunks = await this.db.query(
        `
        SELECT id, content, line_start
        FROM code_chunks
        WHERE file_id = $1
      `,
        [importer.importer_file_id]
      );

      // 步骤 4: 在每个代码块中搜索符号的使用
      for (const chunk of chunks.rows) {
        const lines = chunk.content.split('\n');

        lines.forEach((line: string, index: number) => {
          // 使用正则表达式匹配完整的单词边界
          // \b 确保匹配完整的符号名，避免匹配到 API_BASE_URL 中的 API_BASE
          const regex = new RegExp(`\\b${this.escapeRegex(searchSymbol)}\\b`);
          if (regex.test(line)) {
            references.push({
              fileId: importer.importer_file_id,
              chunkId: chunk.id,
              line: chunk.line_start + index,  // 计算实际行号
              context: line.trim().slice(0, 200),  // 截取前 200 个字符作为上下文
              type: importer.import_type === 'namespace' ? 'namespace_access' : 'direct_reference',
            });
          }
        });
      }
    }

    return references;
  }

  /**
   * 查找本地常量的文件内引用
   *
   * 对于未导出的常量，只需要在定义它的文件内搜索引用。
   * 这些常量通常是文件内部使用的配置或临时变量。
   *
   * 注意事项：
   * - 需要排除常量定义行本身（避免将定义误认为引用）
   * - 使用单词边界匹配，避免误匹配（如 USER 不应匹配到 USER_ID）
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param symbolName - 常量的符号名称
   * @returns 引用信息列表
   */
  private async findLocalConstantReferences(
    repoId: number,
    fileId: number,
    symbolName: string
  ): Promise<Array<{ fileId: number; chunkId: number; line: number; context: string; type: string }>> {
    const references: Array<{ fileId: number; chunkId: number; line: number; context: string; type: string }> = [];

    // 步骤 1: 获取该文件的所有代码块
    const chunks = await this.db.query(
      `
      SELECT id, code_text, line_start
      FROM code_chunks
      WHERE file_id = $1
    `,
      [fileId]
    );

    // 步骤 2: 在每个代码块中搜索常量的使用
    for (const chunk of chunks.rows) {
      const lines = chunk.code_text.split('\n');

      lines.forEach((line: string, index: number) => {
        // 使用正则表达式匹配符号名称
        const regex = new RegExp(`\\b${this.escapeRegex(symbolName)}\\b`);

        // 排除常量定义行本身
        // 检查是否包含 const/let/var 声明语句
        const isDefinitionLine =
          line.includes(`const ${symbolName}`) ||
          line.includes(`let ${symbolName}`) ||
          line.includes(`var ${symbolName}`);

        // 如果匹配到符号且不是定义行，记录为引用
        if (regex.test(line) && !isDefinitionLine) {
          references.push({
            fileId: fileId,
            chunkId: chunk.id,
            line: chunk.line_start + index,  // 计算实际行号
            context: line.trim().slice(0, 200),  // 截取上下文
            type: 'local_reference',  // 标记为本地引用
          });
        }
      });
    }

    return references;
  }

  /**
   * 构建 URL 使用关系
   *
   * 记录 URL 模式的定义和使用位置，建立 URL 与代码的关联关系。
   * 这对于以下场景非常有用：
   * - 查找某个 API 端点在哪里被调用
   * - 分析 API 的使用频率和位置
   * - 追踪路由定义与实际调用的对应关系
   *
   * URL 模式的规范化：
   * - /api/users/${userId} → api/users/:userId
   * - 相同的规范化模式会被合并为同一个 URL 模式记录
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param urlPatterns - AST 分析提取的 URL 模式列表
   * @returns 成功创建的 URL 使用关系数量
   */
  private async buildURLUsages(repoId: number, fileId: number, urlPatterns: URLPattern[]): Promise<number> {
    let count = 0;

    // 遍历所有 URL 模式
    for (const pattern of urlPatterns) {
      try {
        // 步骤 1: 查找或创建 URL 模式记录
        // 使用规范化后的模式和 HTTP 方法作为唯一标识
        const patternResult = await this.db.query(
          `
          SELECT id FROM url_patterns
          WHERE repo_id = $1
            AND normalized_pattern = $2
            AND method = $3
        `,
          [repoId, pattern.normalizedPattern, pattern.method || null]
        );

        let patternId: number;

        if (patternResult.rows.length > 0) {
          // 如果 URL 模式已存在，使用现有的 ID
          patternId = patternResult.rows[0].id;
        } else {
          // 如果 URL 模式不存在，创建新记录
          const insertResult = await this.db.query(
            `
            INSERT INTO url_patterns (
              repo_id,
              pattern,                -- 原始模式（如 /api/users/\${userId}）
              normalized_pattern,     -- 规范化模式（如 api/users/:userId）
              method,                 -- HTTP 方法（GET/POST/PUT/DELETE/PATCH）
              definition_file_id,     -- 定义该 URL 的文件 ID
              definition_line,        -- 定义所在行号
              definition_code,        -- 定义的代码片段
              components,             -- URL 组成部分（JSON 数组）
              path_params,            -- 路径参数列表（JSON 数组）
              query_params            -- 查询参数列表（JSON 数组）
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
          `,
            [
              repoId,
              pattern.pattern,
              pattern.normalizedPattern,
              pattern.method || null,
              fileId,
              pattern.definitionLine,
              pattern.definitionCode,
              JSON.stringify(pattern.components),
              JSON.stringify(pattern.pathParams),
              JSON.stringify(pattern.queryParams),
            ]
          );

          patternId = insertResult.rows[0].id;
        }

        // 步骤 2: 查找包含该 URL 使用的代码块
        // 根据行号查找对应的代码块
        const chunkResult = await this.db.query(
          `
          SELECT id FROM code_chunks
          WHERE file_id = $1
            AND line_start <= $2
            AND line_end >= $2
          ORDER BY line_start DESC
          LIMIT 1
        `,
          [fileId, pattern.definitionLine]
        );

        const chunkId = chunkResult.rows.length > 0 ? chunkResult.rows[0].id : null;

        // 步骤 3: 创建 URL 使用记录
        await this.db.query(
          `
          INSERT INTO url_usages (
            repo_id,
            url_pattern_id,       -- 关联的 URL 模式 ID
            usage_file_id,        -- 使用该 URL 的文件 ID
            usage_chunk_id,       -- 使用该 URL 的代码块 ID
            usage_line,           -- 使用所在行号
            usage_code,           -- 使用的代码片段
            usage_context,        -- 使用上下文（api_call/route_definition/router）
            http_method           -- HTTP 方法
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING  -- 避免重复插入
        `,
          [
            repoId,
            patternId,
            fileId,
            chunkId,
            pattern.definitionLine,
            pattern.definitionCode,
            this.inferUsageContext(pattern.definitionCode),  // 推断使用上下文
            pattern.method || null,
          ]
        );

        count++;
      } catch (error) {
        // 记录错误但继续处理其他 URL 模式
        console.error(`Error creating URL usage for ${pattern.pattern}:`, error);
      }
    }

    return count;
  }

  /**
   * 构建调用图边
   *
   * 分析函数体中的函数调用，建立函数之间的调用关系（调用图）。
   * 调用图是代码理解的核心数据结构，支持：
   * - 查找某个函数被谁调用（反向追踪）
   * - 查找某个函数调用了哪些函数（正向追踪）
   * - 分析函数的影响范围
   * - 构建完整的调用链路
   *
   * 识别的调用类型：
   * - direct: 直接函数调用 funcName()
   * - async_await: 异步调用 await funcName()
   * - promise: Promise 链式调用 funcName().then()
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param functions - AST 分析提取的函数信息列表
   * @returns 成功创建的调用图边数量
   */
  private async buildCallGraphEdges(repoId: number, fileId: number, functions: FunctionInfo[]): Promise<number> {
    let count = 0;

    // 遍历所有函数
    for (const func of functions) {
      try {
        // 步骤 1: 查找该函数对应的代码块
        // 根据函数的起止行号查找包含该函数的代码块
        const chunkResult = await this.db.query(
          `
          SELECT id FROM code_chunks
          WHERE file_id = $1
            AND line_start <= $2
            AND line_end >= $3
          ORDER BY line_start DESC
          LIMIT 1
        `,
          [fileId, func.lineStart, func.lineEnd]
        );

        // 如果找不到对应的代码块，跳过该函数
        if (chunkResult.rows.length === 0) {
          continue;
        }

        const fromChunkId = chunkResult.rows[0].id;

        // 步骤 2: 从函数体中提取所有函数调用
        // 使用正则表达式匹配函数调用模式
        const calls = this.extractFunctionCalls(func.code);

        // 步骤 3: 为每个函数调用创建调用图边
        for (const call of calls) {
          // 尝试解析被调用的函数，找到其对应的代码块
          const toChunk = await this.resolveCalledFunction(repoId, fileId, call.name);

          // 插入调用图边
          await this.db.query(
            `
            INSERT INTO call_graph (
              repo_id,
              from_chunk_id,      -- 调用者代码块 ID
              to_chunk_id,        -- 被调用者代码块 ID（可能为 null，如果无法解析）
              to_symbol,          -- 被调用的函数名称
              call_type,          -- 调用类型（direct/async_await/promise）
              arguments,          -- 调用参数（JSON 数组）
              call_line           -- 调用所在行号
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT DO NOTHING  -- 避免重复插入
          `,
            [
              repoId,
              fromChunkId,
              toChunk?.id || null,  // 如果无法解析被调用函数，to_chunk_id 为 null
              call.name,
              call.type,
              JSON.stringify(call.arguments),
              func.lineStart + call.lineOffset,  // 计算调用的实际行号
            ]
          );

          count++;
        }
      } catch (error) {
        // 记录错误但继续处理其他函数
        console.error(`Error creating call graph edges for ${func.name}:`, error);
      }
    }

    return count;
  }

  /**
   * 从代码中提取函数调用
   *
   * 使用正则表达式从函数代码中识别所有函数调用。
   * 这是一个基础实现，使用文本匹配而非 AST 分析。
   *
   * 识别的调用模式：
   * 1. 直接调用：funcName(...)
   * 2. 异步调用：await funcName(...)
   * 3. Promise 链：funcName().then(...)
   *
   * 局限性：
   * - 无法识别复杂的调用模式（如高阶函数、动态调用）
   * - 可能产生误报（如注释中的函数名）
   * - 无法准确提取参数信息
   *
   * @param code - 函数的源代码
   * @returns 函数调用信息列表，包含函数名、调用类型、参数和行偏移
   */
  private extractFunctionCalls(
    code: string
  ): Array<{ name: string; type: string; arguments: string[]; lineOffset: number }> {
    const calls: Array<{ name: string; type: string; arguments: string[]; lineOffset: number }> = [];
    const lines = code.split('\n');

    // 遍历每一行代码
    lines.forEach((line, index) => {
      // 模式 1: 识别普通函数调用 funcName(
      // 使用全局匹配找出所有调用
      const callRegex = /(\w+)\s*\(/g;
      let match;

      while ((match = callRegex.exec(line)) !== null) {
        const funcName = match[1];

        // 过滤掉 JavaScript 关键字，避免误识别
        // 例如：if(、for(、while( 等不是函数调用
        const keywords = ['if', 'for', 'while', 'switch', 'catch', 'function', 'return'];
        if (keywords.includes(funcName)) {
          continue;
        }

        // 记录函数调用
        calls.push({
          name: funcName,
          type: 'direct',  // 直接调用
          arguments: [],   // 暂不解析参数（需要更复杂的解析器）
          lineOffset: index,  // 相对于函数起始行的偏移
        });
      }

      // 模式 2: 识别异步调用 await funcName
      // 异步调用通常表示重要的异步操作
      if (line.includes('await')) {
        const awaitRegex = /await\s+(\w+)/g;
        let awaitMatch;

        while ((awaitMatch = awaitRegex.exec(line)) !== null) {
          calls.push({
            name: awaitMatch[1],
            type: 'async_await',  // 异步等待调用
            arguments: [],
            lineOffset: index,
          });
        }
      }

      // 模式 3: 识别 Promise 链式调用 .then(
      // Promise 链表示异步流程控制
      if (line.includes('.then(')) {
        calls.push({
          name: 'then',
          type: 'promise',  // Promise 链式调用
          arguments: [],
          lineOffset: index,
        });
      }
    });

    return calls;
  }

  /**
   * 解析被调用的函数，找到其对应的代码块
   *
   * 函数解析策略（按优先级）：
   * 1. 首先在当前文件中查找（本地函数）
   * 2. 然后在导入的文件中查找（导入的函数）
   * 3. 如果都找不到，返回 null（可能是外部库函数或动态调用）
   *
   * 这个解析过程对于构建准确的调用图至关重要。
   *
   * @param repoId - 仓库 ID
   * @param callerFileId - 调用者所在文件的 ID
   * @param functionName - 被调用的函数名称
   * @returns 被调用函数的代码块信息，如果无法解析则返回 null
   */
  private async resolveCalledFunction(
    repoId: number,
    callerFileId: number,
    functionName: string
  ): Promise<{ id: number } | null> {
    // 策略 1: 在当前文件中查找函数定义
    // 大多数函数调用都是调用同一文件中的其他函数
    const sameFileResult = await this.db.query(
      `
      SELECT id FROM code_chunks
      WHERE file_id = $1
        AND symbol_name = $2
      LIMIT 1
    `,
      [callerFileId, functionName]
    );

    // 如果在当前文件中找到，直接返回
    if (sameFileResult.rows.length > 0) {
      return sameFileResult.rows[0];
    }

    // 策略 2: 在导入的文件中查找函数定义
    // 查找所有导入关系，然后在被导入的文件中搜索函数
    const importedResult = await this.db.query(
      `
      SELECT cc.id
      FROM import_relations ir
      JOIN code_chunks cc ON ir.imported_file_id = cc.file_id
      WHERE ir.repo_id = $1
        AND ir.importer_file_id = $2
        AND (ir.imported_symbol = $3 OR ir.import_type = 'namespace')
        AND cc.symbol_name = $3
      LIMIT 1
    `,
      [repoId, callerFileId, functionName]
    );

    // 如果在导入的文件中找到，返回
    if (importedResult.rows.length > 0) {
      return importedResult.rows[0];
    }

    // 策略 3: 无法解析
    // 可能的原因：
    // - 外部库函数（如 console.log、Math.max）
    // - 动态调用（如 this[funcName]()）
    // - 全局函数
    // - 解析错误
    return null;
  }

  /**
   * 解析导入路径为绝对文件路径
   *
   * 将相对导入路径转换为仓库内的绝对路径，以便在数据库中查找文件。
   *
   * 处理的路径类型：
   * 1. 相对路径：./types、../utils/helper
   * 2. 绝对路径：src/api/types（需要项目配置，暂不支持）
   * 3. 外部路径：react、lodash（返回 null）
   *
   * 文件扩展名尝试顺序：
   * - 无扩展名（可能是目录）
   * - .ts、.tsx（TypeScript）
   * - .js、.jsx（JavaScript）
   * - /index.ts、/index.tsx、/index.js、/index.jsx（目录索引文件）
   *
   * @param importerPath - 导入者文件的路径
   * @param importPath - 导入语句中的路径
   * @returns 解析后的绝对路径，如果是外部导入则返回 null
   */
  private resolveImportPath(importerPath: string, importPath: string): string | null {
    // 处理相对导入（以 . 开头）
    if (importPath.startsWith('.')) {
      // 获取导入者文件所在的目录
      const importerDir = path.dirname(importerPath);

      // 解析相对路径为绝对路径
      // 例如：importerPath = 'src/api/user.ts', importPath = './types'
      //      → resolvedPath = 'src/api/types'
      let resolvedPath = path.resolve(importerDir, importPath);

      // 尝试各种可能的文件扩展名
      // TypeScript/JavaScript 项目中，import 语句通常省略扩展名
      const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

      for (const ext of extensions) {
        const testPath = resolvedPath + ext;
        // 注意：这里无法检查文件是否真实存在（需要文件系统访问）
        // 所以返回最可能的路径
        if (ext === '' || ext.startsWith('.')) {
          return testPath;
        }
      }

      // 默认返回 .ts 扩展名（TypeScript 项目）
      return resolvedPath + '.ts';
    }

    // 处理绝对导入和外部导入
    // 绝对导入需要项目配置（如 tsconfig.json 的 paths）才能正确解析
    // 目前暂不支持，返回 null
    // 外部导入（如 'react'、'lodash'）也返回 null
    return null;
  }

  /**
   * 推断 URL 使用的上下文
   *
   * 根据代码片段的特征，推断 URL 的使用场景。
   * 这有助于区分不同类型的 URL 使用：
   * - API 调用：客户端发起的 HTTP 请求
   * - 路由定义：服务端定义的 API 端点
   * - 路由器配置：路由器的配置代码
   *
   * @param code - 包含 URL 的代码片段
   * @returns 使用上下文类型
   */
  private inferUsageContext(code: string): string {
    // 检查是否为 API 调用
    // 特征：包含 axios 或 fetch 关键字
    if (code.includes('axios') || code.includes('fetch')) {
      return 'api_call';
    }

    // 检查是否为路由定义
    // 特征：包含 .get(、.post( 等 HTTP 方法调用
    if (code.includes('.get(') || code.includes('.post(')) {
      return 'route_definition';
    }

    // 检查是否为路由器配置
    // 特征：包含 router 关键字
    if (code.includes('router')) {
      return 'router';
    }

    // 无法确定上下文
    return 'unknown';
  }

  /**
   * 转义正则表达式中的特殊字符
   *
   * 将字符串中的正则表达式特殊字符转义，使其可以安全地用于正则表达式匹配。
   * 例如：API_BASE.url → API_BASE\\.url
   *
   * 需要转义的字符：. * + ? ^ $ { } ( ) | [ ] \
   *
   * @param str - 需要转义的字符串
   * @returns 转义后的字符串
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 清理文件的旧关系数据
   *
   * 在重新构建关系之前，删除该文件的所有旧关系记录。
   * 这确保了关系数据的准确性，避免过时数据的累积。
   *
   * 清理的关系类型：
   * 1. 导入关系（import_relations）
   * 2. 常量引用（constant_references）
   * 3. URL 使用（url_usages）
   * 4. 调用图边（call_graph）
   *
   * 注意：使用事务确保原子性，要么全部删除成功，要么全部回滚。
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @throws 如果删除过程中发生错误，会回滚事务并抛出异常
   */
  async cleanupFileRelationships(repoId: number, fileId: number): Promise<void> {
    // 开启数据库事务
    await this.db.query('BEGIN');

    try {
      // 步骤 1: 删除导入关系
      // 删除该文件作为导入者的所有导入记录
      await this.db.query(
        `
        DELETE FROM import_relations
        WHERE repo_id = $1 AND importer_file_id = $2
      `,
        [repoId, fileId]
      );

      // 步骤 2: 删除常量引用
      // 删除该文件中代码引用其他常量的记录
      await this.db.query(
        `
        DELETE FROM constant_references
        WHERE repo_id = $1 AND referrer_file_id = $2
      `,
        [repoId, fileId]
      );

      // 步骤 3: 删除 URL 使用记录
      // 删除该文件中使用 URL 的记录
      await this.db.query(
        `
        DELETE FROM url_usages
        WHERE repo_id = $1 AND usage_file_id = $2
      `,
        [repoId, fileId]
      );

      // 步骤 4: 删除调用图边
      // 删除该文件中的函数调用其他函数的记录
      // 注意：需要先查询该文件的所有代码块，然后删除这些代码块的调用关系
      await this.db.query(
        `
        DELETE FROM call_graph
        WHERE repo_id = $1 AND from_chunk_id IN (
          SELECT id FROM code_chunks WHERE file_id = $2
        )
      `,
        [repoId, fileId]
      );

      // 提交事务
      await this.db.query('COMMIT');
    } catch (error) {
      // 发生错误时回滚事务
      await this.db.query('ROLLBACK');
      throw error;
    }
  }
}
