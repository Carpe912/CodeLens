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
import type {
  EntityResult,
  StringConstant,
  URLPattern,
  ImportInfo,
  IndirectCallSite,
} from './languages/types.js';
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

/**
 * 「重建调用图」所需的最小函数信息
 *
 * `buildCallGraphEdges` 实际只读这 4 个字段（`extractFunctionCalls(code, name)` 之后，
 * 行号用来定位 chunk、`name` 用来排伪自环）。把它单独抽出来是为了让**整仓重建**
 * 能直接从 `functions` 表读这几列喂进来 —— 调用边本来就存在库里，
 * 重建它**不需要重新解析 AST、更不需要重新生成向量**。
 */
export interface CallGraphSourceFunction {
  name: string;
  lineStart: number;
  lineEnd: number;
  code: string;
}

/**
 * 增量索引的「引用传播」查询结果
 *
 * 一个文件被改动或删除后，**别的文件里**也可能有指向它的行被级联清掉
 * （import_relations 的 imported_file_id、url_usages 指向的 url_patterns…）。
 * 这些「受害文件」必须一起重建，否则增量之后库里会留下空洞。
 */
export interface ReferrersOfFiles {
  /** 通过 import 指向这些文件的文件（import_relations.importer_file_id） */
  importers: number[];
  /** 通过 url_usages 引用了「在这些文件中定义的接口」的文件 */
  urlUsageFiles: number[];
}

/** 仓库内的候选导入落点（供增量路径判断「新文件能否让旧 import 解析成功」） */
export interface UnresolvedImportRow {
  importerFileId: number;
  importerPath: string;
  importPath: string;
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
    astResult: EntityResult
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

      // 步骤 3b: 跨过程落点（间接调用 / 模板句柄）
      //
      // ⚠️ 这里**只往 url_usages 插行，不新建 url_patterns 行**。
      // url_patterns 的不变式是「一个接口一行」(repo, method, 规范化路径)，
      // 而一个接口在真实项目里会被几十处间接调用 —— 如果每处都建 pattern 行，
      // 这张表会退化成一个重复的调用点表，「接口」这个概念就没了。
      result.urlUsagesCreated += await this.buildIndirectUsages(repoId, fileId, astResult.indirectSites);

      // 步骤 4: 构建调用图边
      // 分析函数体中的函数调用，建立函数之间的调用关系
      result.callGraphEdgesCreated = await this.buildCallGraphEdges(repoId, fileId, astResult.functions);

      // 步骤 5: 文件级依赖（file_dependencies）
      //
      // 【历史坑】这里原本写着「由 import_relations 表的触发器自动完成」，
      // 但全仓库从来没有 CREATE TRIGGER —— 那张表一直是空的，
      // 依赖图分析也就永远拿不到数据。触发器从未被写出来，注释却在替它背书。
      //
      // 现在的做法：不再依赖任何触发器，改成在所有文件处理完后由应用层
      // 显式调用 rebuildFileDependencies(repoId) 一次性物化（见 EnhancedIndexer.indexFiles 末尾）。
      // 之所以不在这里逐文件做：一条依赖边需要导入方与被导入方都已入库，
      // 逐文件做会漏掉「被导入文件排在后面」的边。

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
        // 步骤 1: 把导入路径展开成**一组候选仓内路径**
        // 例如：'./types' → ['test-repo/src/api/types', '...types.ts', '...types.js', ...]
        //
        // 【为什么是一组而不是一个】原实现返回单个路径，且因为扩展名循环里
        // 第一轮 `ext === ''` 就直接 return，实际上永远返回**不带扩展名**的路径
        // （'../config/apiConfig'）。而 files.path 里存的是 '.../apiConfig.js'，
        // 于是 `WHERE path = $2` 必然查不到 → imported_file_id 恒为 NULL
        // → file_dependencies 恒为空。返回候选集、由数据库决定哪个真实存在，
        // 才能同时处理「显式写了扩展名」和「省略扩展名」两种写法。
        // 【不要用 imp.isExternal 提前短路】
        // ast-analyzer 判 isExternal 的规则是「不以 . 或 / 开头」——这对
        // `axios`、`vue` 正确，但会把工程别名 `@/stores/order`、`@comm/utils`
        // 一并误判成外部依赖，于是候选集恒为空、别名边全部丢失。
        // 真正「外部还是内部」的判据是**能否在 files 表里找到落点**：
        // resolveImportPathCandidates 对不认识的名字（纯包名）返回 []，
        // 对别名/相对路径返回候选集，再由下面的 ANY 查询裁决。
        const candidatePaths = this.resolveImportPathCandidates(importerFilePath, imp.importPath);
        let importedFileId: number | null = null;

        // 步骤 2: 内部导入 → 用一次 ANY 查询在候选里挑真实存在的那个
        if (candidatePaths.length > 0) {
          const fileResult = await this.db.query(
            `
            SELECT id, path FROM files
            WHERE repo_id = $1 AND path = ANY($2)
          `,
            [repoId, candidatePaths]
          );

          // 按候选的优先级顺序（而不是数据库返回顺序）取第一个命中的，
          // 保证「同一路径同时存在 .ts 与 .js」时结果稳定可预期。
          if (fileResult.rows.length > 0) {
            const idByPath = new Map<string, number>(
              fileResult.rows.map((r: { id: number; path: string }) => [r.path, r.id])
            );
            for (const candidate of candidatePaths) {
              const hit = idByPath.get(candidate);
              if (hit !== undefined) {
                importedFileId = hit;
                break;
              }
            }
          }
        }

        // 步骤 3: 插入导入关系到数据库
        // 即使是外部导入（如 'react'），也会记录，但 imported_file_id 为 null
        //
        // is_external 以**解析结果**为准：找到了仓内落点就是内部依赖。
        // 只在「原始判定为外部 且 确认没有落点」时才记 true —— 否则一个被成功
        // 解析到文件的别名导入会留下 is_external=true 的矛盾记录，把依赖图统计污染。
        const resolvedExternal = imp.isExternal && importedFileId === null;
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
            resolvedExternal,
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
      // 注意：code_chunks 的正文列是 code_text（不是 content）
      const chunks = await this.db.query(
        `
        SELECT id, code_text, line_start
        FROM code_chunks
        WHERE file_id = $1
      `,
        [importer.importer_file_id]
      );

      // 步骤 4: 在每个代码块中搜索符号的使用
      for (const chunk of chunks.rows) {
        const lines = chunk.code_text.split('\n');

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
        // 步骤 1: 取得（或创建）该「接口」的记录
        //
        // 唯一键 = (repo_id, method, normalized_pattern) —— **一个接口一行**，
        // 与库上的 idx_url_patterns_endpoint_unique 严格一致。调用方与路由定义共用同一行，
        // 「接口 → 调用点」这条跨边界关系才查得出来。
        //
        // ⚠️ 这里曾是「先 SELECT 再 INSERT」两段式，而唯一索引建在
        // (repo_id, 原始 pattern) 上 —— 原始路径不区分 HTTP 方法，同一个
        // `/api/users/:id` 下 GET/POST/PUT/DELETE 只有第一个能入库；后面的
        // INSERT 抛唯一冲突，被外层 catch 记一行日志就跳过了
        // （url_patterns 与 url_usages 双双缺行，功能静默降级）。
        // 改成 upsert 后，冲突不再是错误，而是「复用同一个接口行」。
        const patternResult = await this.db.query(
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
          ON CONFLICT (repo_id, COALESCE(method, ''), normalized_pattern)
          DO UPDATE SET pattern = url_patterns.pattern
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

        const patternId: number = patternResult.rows[0].id;

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
          -- 与 idx_url_usages_site_unique 一致，挡掉同一位置的重复插入
          ON CONFLICT (repo_id, url_pattern_id, COALESCE(usage_file_id, -1), COALESCE(usage_line, -1), COALESCE(usage_context, '')) DO NOTHING
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
   * 落库「跨过程落点」——间接调用与模板句柄。
   *
   * ============================================
   * 为什么与 buildURLUsages 分开
   * ============================================
   * `buildURLUsages` 是「一个 URL 模式 → 它自己的定义/使用处」，每处都会 upsert 一行
   * `url_patterns`。跨过程落点不同：它是**同一个接口被别处的封装方法间接用到**，
   * 接口本身早已有行。所以这里只查行、插 usage，不建新接口 —— 保住
   * 「一个接口一行」这条不变式（否则 url_patterns 会退化成调用点表）。
   *
   * 查不到已有接口行时才兜底建一行（method = NULL），宁可多一行也不丢落点。
   *
   * @param repoId - 仓库 ID
   * @param fileId - 落点所在文件的 ID
   * @param sites - 该文件的跨过程落点
   * @returns 成功创建的 usage 行数
   */
  private async buildIndirectUsages(
    repoId: number,
    fileId: number,
    sites: IndirectCallSite[]
  ): Promise<number> {
    if (sites.length === 0) return 0;
    let count = 0;

    for (const site of sites) {
      try {
        const normalized = this.normalizePathForMatch(site.url);

        // 步骤 1: 找这个接口已有的行（原始 pattern 或规范化 pattern 任一相等即可）
        const found = await this.db.query(
          `
          SELECT id FROM url_patterns
          WHERE repo_id = $1
            AND (
              lower(trim(both '/' from pattern)) = lower(trim(both '/' from $2))
              OR lower(trim(both '/' from coalesce(normalized_pattern, ''))) = lower(trim(both '/' from $2))
            )
          ORDER BY (method IS NOT NULL) DESC, id
          LIMIT 1
        `,
          [repoId, site.url]
        );

        let patternId: number;
        if (found.rows.length > 0) {
          patternId = found.rows[0].id;
        } else {
          // 兜底：接口行不存在（调用点的实参没解析出来过）时补一行，method = NULL
          const created = await this.db.query(
            `
            INSERT INTO url_patterns (
              repo_id, pattern, normalized_pattern, method, definition_file_id,
              definition_line, definition_code, components, path_params, query_params
            ) VALUES ($1, $2, $3, NULL, $4, $5, $6, '[]', '[]', '[]')
            ON CONFLICT (repo_id, COALESCE(method, ''), normalized_pattern)
            DO UPDATE SET pattern = url_patterns.pattern
            RETURNING id
          `,
            [repoId, site.url, normalized, fileId, site.line, site.code]
          );
          patternId = created.rows[0].id;
        }

        // 步骤 2: 落点所在的代码块
        const chunkResult = await this.db.query(
          `
          SELECT id FROM code_chunks
          WHERE file_id = $1 AND line_start <= $2 AND line_end >= $2
          ORDER BY line_start DESC
          LIMIT 1
        `,
          [fileId, site.line]
        );
        const chunkId = chunkResult.rows.length > 0 ? chunkResult.rows[0].id : null;

        // 步骤 3: 插 usage。usage_context 直接落 'indirect_call' / 'template_helper'，
        // 不再走 inferUsageContext —— 这两个语义靠代码文本推断不出来，
        // 只有扫描时才知道它是「跨过程」的。
        await this.db.query(
          `
          INSERT INTO url_usages (
            repo_id, url_pattern_id, usage_file_id, usage_chunk_id,
            usage_line, usage_code, usage_context, http_method
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
          ON CONFLICT (repo_id, url_pattern_id, COALESCE(usage_file_id, -1), COALESCE(usage_line, -1), COALESCE(usage_context, ''))
          DO NOTHING
        `,
          [repoId, patternId, fileId, chunkId, site.line, site.code, site.kind]
        );

        count++;
      } catch (error) {
        console.error(`Error creating indirect usage for ${site.callee} @${site.file}:${site.line}:`, error);
      }
    }

    return count;
  }

  /** 轻量规范化：只剥协议+域名，够用于「找已存在的接口行」的相等比较 */
  private normalizePathForMatch(value: string): string {
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)$/i.exec(value.trim());
    return m ? m[1] : value.trim();
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
   * 【两个调用者，同一个实现】
   * - 全量重建：`buildRelationships` 传 AST 抽出的 FunctionInfo
   * - 增量重建：`rebuildCallGraph` 从 `functions` 表读回 name/line/code 传进来
   * 两边的入参都满足 `CallGraphSourceFunction`，因此**判定逻辑天然一致** ——
   * 这是刻意的：调用图的正确性不该取决于它是怎么被触发重建的。
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param functions - 函数信息列表（AST 结果或从 functions 表重建的行都可）
   * @returns 成功创建的调用图边数量
   */
  private async buildCallGraphEdges(
    repoId: number,
    fileId: number,
    functions: CallGraphSourceFunction[]
  ): Promise<number> {
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
        //
        // 必须把 func.name 传进去：函数**自己那行声明**里出现的 `名字(` 是声明语法，
        // 不是调用。不排除的话，每个方法都会生成一条 from=to 的伪自环
        // （实测占仓库 29 全部调用边的 30%，见 extractFunctionCalls 的注释）。
        const calls = this.extractFunctionCalls(func.code, func.name);

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
   * =======================================================
   * 【必须排除的伪自环】selfName 参数就是为此存在的
   * =======================================================
   * `code` 是该函数自己的源码，第 0 行就是它的声明行：
   *     login(username, password) {      ← 方法简写
   *     function login(a, b) {           ← 函数声明
   * 正则 /(\w+)\s*\(/ 会把这行的 `login(` 也匹配成一次「对 login 的调用」，
   * 于是生成一条 `from_chunk_id = to_chunk_id` 且 `call_line = line_start`
   * 的边。这种边不是调用关系，是声明的语法假象。
   *
   * 实测影响（仓库 29）：333 条调用边里有 101 条是这类自环（30%）。
   * 后果不只是图难看 —— 它让「这个符号有几个调用点」这类计数被抬高，
   * 也让影响面分析在「唯一入边是伪自环」时过滤为空却报不出任何警告。
   *
   * 判定必须同时满足两个条件，缺一不可：
   *   1) 位于第 0 行（声明行）
   *   2) 名字等于函数自身名
   * 真正的递归调用一定出现在函数体里（index > 0），不会被误杀。
   *
   * @param code - 函数的源代码
   * @param selfName - 该函数自己的名字；传入后才会做伪自环排除
   * @returns 函数调用信息列表，包含函数名、调用类型、参数和行偏移
   */
  private extractFunctionCalls(
    code: string,
    selfName?: string
  ): Array<{ name: string; type: string; arguments: string[]; lineOffset: number }> {
    const calls: Array<{ name: string; type: string; arguments: string[]; lineOffset: number }> = [];
    const lines = code.split('\n');

    // 函数名可能带限定前缀（如 'AuthService.login'），比对末段即可
    const selfLeaf = selfName ? selfName.split('.').pop() : undefined;

    /**
     * 这个名字出现在**声明行**上时，是否属于「声明语法」而非「调用」
     *
     * - 与函数自身同名的：`login(a) {` / `function login(a) {`
     * - `constructor`：类构造函数声明 `constructor(baseURL) {`
     *   必须单独列出，因为 ts-morph 对 ConstructorDeclaration 的 getName() 返回
     *   undefined，FunctionInfo.name 退化成 'anonymous'，与 chunk 里的
     *   symbol_name='constructor' 对不上，靠 selfLeaf 匹配不到。
     *
     * 注意只在声明行（index === 0）判定：函数体里的 `this.constructor(...)`
     * 或真递归调用都出现在 index > 0，不会被误杀。
     */
    const isDeclarationName = (name: string): boolean =>
      name === 'constructor' || (selfLeaf !== undefined && name === selfLeaf);

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

        // 过滤掉函数自身声明行上的伪自环（见方法注释）
        if (index === 0 && isDeclarationName(funcName)) {
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
   * 把导入路径展开为一组候选仓内路径（按优先级排序）
   *
   * 与旧实现的区别：**不再猜一个路径**，而是把「省略扩展名 / 目录索引」这些
   * 可能性全部列出，交给数据库去判断哪个真实存在（见 buildImportRelationships）。
   *
   * 处理的路径类型：
   * 1. 相对路径：./types、../utils/helper
   * 2. 绝对路径：src/api/types（需要 tsconfig 的 paths 配置，暂不支持 → 返回空）
   * 3. 外部路径：react、lodash（返回空）
   *
   * 候选顺序（前者优先）：
   * - 原样（import 里显式写了扩展名，如 './types.js'）
   * - 补 .ts / .tsx / .js / .jsx / .mjs / .cjs / .vue / .json
   * - 目录索引 index.ts / index.tsx / index.js / index.jsx
   *
   * 【历史坑】旧实现在扩展名循环里写了 `if (ext === '' || ext.startsWith('.')) return testPath;`，
   * 而 extensions[0] 就是 ''，于是第一轮无条件返回**不带扩展名**的路径，
   * 后面那些候选永远走不到。注释写着「尝试各种扩展名」，代码实际只试了零个。
   *
   * @param importerPath - 导入者文件的路径（仓库内相对路径）
   * @param importPath - 导入语句里的原始路径
   * @returns 候选路径数组；非相对导入返回空数组
   */
  private resolveImportPathCandidates(importerPath: string, importPath: string): string[] {
    // 【必须在「相对路径空间」里拼接，不能用 path.resolve】
    // files.path 存的是仓库内相对路径（形如 'test-repo/src/api/x.js'），
    // 而 path.resolve 会把相对路径锚定到 process.cwd()，产出
    // '/root/CodeLens/test-repo/src/config/apiConfig' 这种绝对路径 ——
    // 与库里的值永远不相等，查找必然落空。
    // path.posix.join 只做拼接与 '..' 归一，结果保持相对。
    let resolvedBase: string | null = null;

    if (importPath.startsWith('.')) {
      resolvedBase = path.isAbsolute(importerPath)
        ? // 兜底：万一调用方给的是绝对路径，就沿用绝对语义
          path.resolve(path.dirname(importerPath), importPath)
        : path.posix.normalize(
            path.posix.join(path.posix.dirname(importerPath), importPath)
          );
    } else {
      // 非相对导入：可能是外部包（'vue'/'axios'），也可能是工程别名（'@/x'）。
      resolvedBase = this.resolveAliasImport(importerPath, importPath);
      if (resolvedBase === null) return []; // 判定为外部依赖，无仓内落点
    }

    // ⚠️ 注意：这份清单是「**导入路径候选探测**」，不是「哪些文件参与索引」。
    // 两者是不同概念，**不要**合并成 languageRegistry.supportedExtensions：
    // `.json` / `.mjs` / `.cjs` 可以被 import（因此必须探测），但它们不入库、没有 chunk。
    // 2026-09-19 审计时曾误判为「三份重复的扩展名清单之一」，核 code 后已更正。
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json'];
    const joiner = path.isAbsolute(resolvedBase) ? path.join : path.posix.join;

    const candidates: string[] = [resolvedBase];
    for (const ext of extensions) candidates.push(resolvedBase + ext);
    for (const ext of extensions) candidates.push(joiner(resolvedBase, `index${ext}`));

    return candidates;
  }

  /**
   * 把工程别名导入（`@/x`、`~/x`、`@comm/x`）映射成仓库内候选路径。
   *
   * 前端工程（Vue/React）大量使用别名，别名在构建配置里声明：
   *   vite:  resolve.alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) }
   *   vue-cli: chainWebpack -> config.resolve.alias.set('@comm', resolve('src/comm'))
   * 我们不解析构建配置（不同工具语法差异大、且属于静态分析之外的运行时能力），
   * 而是用一条**约定式**规则覆盖绝大多数工程：
   *
   *   <工程根>/src 就是别名根。
   *   `@/a/b`      -> <工程根>/src/a/b
   *   `@comm/a/b`  -> <工程根>/src/comm/a/b
   *   `~/a/b`      -> <工程根>/src/a/b
   *
   * 「工程根」由 importer 路径里最后一个 `/src/` 之前的部分推断
   * （`test-repo/web/src/views/X.vue` -> `test-repo/web`）。这能正确处理
   * monorepo 里多个子应用各有自己的 `src` 的情况。
   *
   * 推断不出工程根时**返回 null（当外部依赖）**，而不是猜一个根出来：
   * 猜错会产生一条静默错误的依赖边，比少一条边危害大得多。
   *
   * 注：产出的候选会交给 `path = ANY($2)` 去库里核对，不存在就自然落空，
   * 所以多产几个候选是无害的，不需要在这里做文件系统探测。
   */
  private resolveAliasImport(importerPath: string, importPath: string): string | null {
    const srcRoot = this.inferSrcRoot(importerPath);
    if (srcRoot === null) return null;

    if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
      return path.posix.normalize(path.posix.join(srcRoot, importPath.slice(2)));
    }

    // `@name/rest` / `~name/rest`：把 name 当作 src 下的一级目录
    const scoped = /^[@~]([A-Za-z0-9_-]+)(\/(.*))?$/.exec(importPath);
    if (scoped) {
      const [, ns, , rest = ''] = scoped;
      return path.posix.normalize(path.posix.join(srcRoot, ns, rest));
    }

    // 少数工程直接写 `src/foo/bar` 这种「从 src 起算」的路径
    if (importPath.startsWith('src/')) {
      return path.posix.normalize(path.posix.join(srcRoot, importPath.slice(4)));
    }

    return null; // 外部依赖
  }

  /**
   * 从某个仓内文件路径推断它所属工程的 `src` 目录。
   * 取**最后一个** `/src/`（monorepo 里子应用各有一份 src，最近的才是对的）。
   */
  private inferSrcRoot(importerPath: string): string | null {
    const marker = '/src/';
    const idx = importerPath.lastIndexOf(marker);
    if (idx > 0) return importerPath.slice(0, idx + marker.length - 1); // 保留末尾的 '/src'
    // importer 自身就在 src 根下且不带尾斜杠（形如 'x/src'）——罕见，不猜
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
    // ============================================================
    // 判定顺序很关键：**先判「路由定义」，再判「HTTP 客户端调用」**。
    // ============================================================
    // 初版是反过来的（先 `.get(` → route_definition），而客户端只认 axios/fetch，
    // 于是 `this.client.get(url)` / `api.get(url)` 这类调用**全部被误判成路由定义**。
    // 后果：跨边界关系里两侧都标着 route_definition，无法区分「谁调用了这个接口」，
    // 统计上表现为「只有路由定义」的接口异常多。
    //
    // 路由定义：router.get( / app.post( / route.use( ...
    if (/\b(router|app|route|server|express)\s*\.\s*(get|post|put|patch|delete|all|use|head|options)\s*\(/i.test(code)) {
      return 'route_definition';
    }

    // 客户端调用：知名 HTTP 客户端，或 `xxxClient.get(` / `http.post(` 这类对象方法
    if (
      /(axios|fetch|got|superagent|request|ky|needle|urllib)/i.test(code) ||
      /\b(this\.)?(client|http|httpclient|apiclient|api|request|instance|agent|ajax|rpc)\s*\.\s*(get|post|put|patch|delete|head|options|request)\s*\(/i.test(code)
    ) {
      return 'api_call';
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
   * 1. 导入关系（import_relations）—— 该文件作为导入者的行
   * 2. 常量引用（constant_references）—— **按常量归属**删（见下）
   * 3. URL 使用（url_usages）—— 该文件作为使用者的行
   * 4. 调用图边（call_graph）—— 该文件的 chunk 作为调用者的出边
   *
   * ⚠️ 本方法**不删** `url_patterns`。接口行是跨文件共享的
   * （`(repo, method, 规范化路径)` 唯一，谁先定义记谁），
   * 删它会级联打掉别的文件的调用点。回收交给 `gcOrphanURLPatterns`
   * （判据：0 使用点）。
   *
   * ⚠️ 本方法也**不删** `file_dependencies`：那条边要导入方与被导入方双方都在库，
   * 只能整仓重算（`rebuildFileDependencies`）。
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
      //
      // ⚠️ 这里曾经写的是 `WHERE referrer_file_id = $2`（「删掉我这个文件里的引用」），
      // 那是**错的**，而且错得很隐蔽：
      // `buildConstantReferences` 是「从常量的角度反查谁引用了它」——
      // 它插入的每一行的 constant_id 都属于**当前正在处理的文件**，
      // 而 referrer_file_id 可以是**任意别的文件**。
      // 所以「referrer_file_id = 我」的行里，混着「别人引用我」和「我引用别人」两种，
      // 按 referrer 删会把**别人创建的、指向第三个文件的行**一并删掉，
      // 而那个「别人」不在重建集合里，没人会把它们算回来 → 跨文件引用永久丢失。
      //
      // 正确的口径是**按常量归属删**：只删「我的常量被别人引用」的行。
      // 实际上 `cleanupFileEntities` 删 string_constants 时，外键 CASCADE 已经
      // 完成了同样的事，所以这条语句在正常流程里是 no-op —— 保留它是为了让
      // 「单独调用本方法」时行为也正确，而不是依赖调用方先删实体。
      await this.db.query(
        `
        DELETE FROM constant_references
        WHERE repo_id = $1
          AND constant_id IN (SELECT id FROM string_constants WHERE file_id = $2)
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

  /**
   * 清理**实体层**行（functions / classes / string_constants）
   *
   * 与 `cleanupFileRelationships` 是同一件事的两半：那个清理「关系」，这个清理「实体」。
   * 增量重建一个文件时必须两个都做，否则旧实体行会留下来 ——
   * `storeEntities` 的 ON CONFLICT 键里带 `line_start`，行号一变就插出**新行**，
   * 旧行不会被覆盖（表现为同一个函数在库里有两份，行号一旧一新）。
   *
   * 【级联副作用：constant_references 会被牵连，这是设计内的】
   * `constant_references.constant_id` 外键 ON DELETE CASCADE。删除本文件的
   * string_constants 会连带删掉**其他文件**里「引用该常量」的行。
   * 这是可接受的，因为调用方（增量路径）紧接着会重建本文件，
   * `buildConstantReferences` 会把这些跨文件引用重新查出来插回去。
   * ⚠️ 因此本方法**只能**用于「删完立刻重建同一个文件」的增量路径，
   * 不能拿来单独清空一个文件。
   *
   * 【functions / classes 为什么可以随便删】
   * 线上核对过：全库没有任何表用 id 引用 functions / classes
   * （`call_graph` 是通过 `code_chunks` 引用的，与这两张表无关），
   * 所以逐文件删除它们不会牵连到别的文件。
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @returns 删除的行数（三类实体之和）
   */
  async cleanupFileEntities(repoId: number, fileId: number): Promise<number> {
    let deleted = 0;

    await this.db.query('BEGIN');
    try {
      // 顺序无关（三张表互不引用），放在一个事务里只为原子性
      for (const table of ['functions', 'classes', 'string_constants'] as const) {
        const r = await this.db.query(
          `DELETE FROM ${table} WHERE repo_id = $1 AND file_id = $2`,
          [repoId, fileId]
        );
        deleted += r.rowCount ?? 0;
      }
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }

    return deleted;
  }

  /**
   * 整仓重建调用图（call_graph）
   *
   * ============================================
   * 为什么调用图**不能**逐文件增量
   * ============================================
   * `call_graph.from_chunk_id` / `to_chunk_id` 都外键指向 `code_chunks`
   * 且 ON DELETE CASCADE。而增量的第一步（重写变更文件的代码块）必然
   * `deleteFileChunks` → 老 chunk id 消失 → **别的文件里指向这些 chunk 的入边被级联删掉**。
   * 也就是说：「A 调用了 B」这条边，可能因为改了 B 而消失。
   * 逐文件重建补不回来 —— A 从来没有被改动过，没人会去重建 A 的边。
   *
   * 所以调用图必须整仓重建。但「整仓」不等于「全量重索引」：
   * 调用边的原料是**函数的源码文本 + 行号 + 名字**，这些在 `functions` 表里都有
   * （`code` 列就是当初 AST 抽出来的函数体）。于是可以直接从表里读回来，
   * 走**同一条** `buildCallGraphEdges` 逻辑重建 —— 不重新解析、不重新生成向量。
   *
   * 实测代价（仓库 29，277 文件）：几百毫秒级，相比 6 分钟的全量重建可以忽略。
   *
   * ⚠️ 调用时机：必须在「代码块已重写（phase A）」且「import_relations 已重建
   *    （phase B）」之后跑。`resolveCalledFunction` 的跨文件分支要查 import_relations，
   *    提前跑会把所有跨文件调用边解析成 NULL。
   *
   * @param repoId - 仓库 ID
   * @returns 重建出的调用边数量
   */
  async rebuildCallGraph(repoId: number): Promise<number> {
    const started = Date.now();

    // 先读函数、再清空 —— 顺序其实无所谓（两张表互不影响），
    // 但先读可以让「读失败」时不至于把好数据删掉。
    const rows = (
      await this.db.query(
        `
        SELECT file_id, name, line_start, line_end, code
        FROM functions
        WHERE repo_id = $1
          AND code IS NOT NULL
          AND code <> ''
        ORDER BY file_id, line_start
      `,
        [repoId]
      )
    ).rows as Array<{
      file_id: number;
      name: string | null;
      line_start: number;
      line_end: number;
      code: string;
    }>;

    await this.db.query('DELETE FROM call_graph WHERE repo_id = $1', [repoId]);

    // 按文件分组，复用逐文件版本（这样内存里也不会同时堆全仓函数体）
    const byFile = new Map<number, CallGraphSourceFunction[]>();
    for (const row of rows) {
      if (!byFile.has(row.file_id)) byFile.set(row.file_id, []);
      byFile.get(row.file_id)!.push({
        name: row.name ?? 'anonymous',
        lineStart: row.line_start,
        lineEnd: row.line_end,
        code: row.code,
      });
    }

    let count = 0;
    for (const [fileId, funcs] of byFile) {
      count += await this.buildCallGraphEdges(repoId, fileId, funcs);
    }

    console.log(
      `✓ Rebuilt call_graph for repo ${repoId}: ${count} edges from ${rows.length} functions ` +
        `(${Date.now() - started}ms)`
    );
    return count;
  }

  /**
   * 回收「没有任何使用点」的 URL 接口行（孤儿 url_patterns）
   *
   * ============================================
   * 为什么需要
   * ============================================
   * `buildURLUsages` 是**只增不删**的：它对 `url_patterns` 做 upsert、对 `url_usages`
   * 做 DO NOTHING。增量重建一个文件时，如果它原来定义的某个接口被删掉了，
   * 那行 `url_patterns` 不会有人去删 —— 它会以「定义在 X 文件」的姿态永远留在库里。
   *
   * ============================================
   * 为什么**不能**按文件直接删 url_patterns
   * ============================================
   * 这是本次设计里最反直觉的一条约束：`url_patterns` 是**跨文件共享**的。
   * 接口行只有一个（`(repo, method, 规范化路径)` 唯一），谁先定义就记谁的 file_id；
   * 而 `url_usages` 里躺着**所有调用方**的文件 id。
   * 于是「删掉 A 文件定义的 pattern 行」会级联删掉 B、C、D 文件里的调用点记录 ——
   * 而 B/C/D 根本没被改动，没人会去重建它们，调用点就永久丢了。
   *
   * ============================================
   * 判据：0 使用点 == 孤儿，这条不变式是站得住的
   * ============================================
   * `buildURLUsages` 每 upsert 一行接口，紧接着就为**同一个位置**插一行 usage。
   * 所以任何一个「真实存在」的接口行，至少有 1 行 usage。反过来说：
   * 一行 usage 都没有的接口，必然是残留（或曾经插入失败），删掉不会损失信息，
   * 而且它没有 usage → 级联删除波及不到任何别的文件。
   *
   * ⚠️ 范围限定：只清理 `definition_file_id` 落在本次重建集合里的行。
   * 不传 scope（null）时才做整仓清理 —— 那是「修历史脏数据」的用法，
   * 会影响检索结果，别在常规增量里用它。
   *
   * @param repoId - 仓库 ID
   * @param definitionFileIds - 本次重建的文件 id 集合；传 null 表示整仓
   * @returns 回收的行数
   */
  async gcOrphanURLPatterns(repoId: number, definitionFileIds: number[] | null): Promise<number> {
    const result =
      definitionFileIds === null
        ? await this.db.query(
            `
            DELETE FROM url_patterns p
            WHERE p.repo_id = $1
              AND NOT EXISTS (SELECT 1 FROM url_usages u WHERE u.url_pattern_id = p.id)
          `,
            [repoId]
          )
        : await this.db.query(
            `
            DELETE FROM url_patterns p
            WHERE p.repo_id = $1
              AND p.definition_file_id = ANY($2)
              AND NOT EXISTS (SELECT 1 FROM url_usages u WHERE u.url_pattern_id = p.id)
          `,
            [repoId, definitionFileIds]
          );

    return result.rowCount ?? 0;
  }

  /**
   * 找出「引用过这些文件」的**其他**文件（引用传播，1 跳）
   *
   * 增量索引最容易漏的一环：改动/删除一个文件，受伤的往往不只是它自己。
   * 线上外键全是 ON DELETE CASCADE，所以级联删除会**替我们**清掉别的文件里的行，
   * 但没有任何机制会把那些行重新算出来 —— 结果就是库里出现永久空洞。
   *
   * 具体两类（对应线上核对过的真实外键）：
   * 1. `import_relations.imported_file_id → files(id)` CASCADE
   *    → 删掉 A，B 里「B import A」的行被级联清掉。B 必须重建才能把这条边
   *      （以及它现在解析不到落点的状态）重新落库。
   * 2. `url_usages.url_pattern_id → url_patterns(id)` CASCADE，
   *    而 `url_patterns.definition_file_id → files(id)` CASCADE
   *    → 删掉（或改动后回收）A 定义的接口行，B/C/D 里的调用点被级联清掉。
   *      这些文件必须重建。
   *
   * 只做 1 跳：被牵连的文件重建后，理论上还能再牵连下一层，但那种情况需要
   * 「重建本身又删掉了别人的行」，而重建只删**自己的**行 + 自己定义的接口行，
   * 后者已被第 2 类覆盖。所以 1 跳足够收敛。
   *
   * @param repoId - 仓库 ID
   * @param fileIds - 变更/删除的文件 id 集合
   * @returns 需要一并重建的文件 id（已排除自己）
   */
  async findReferrersOf(repoId: number, fileIds: number[]): Promise<ReferrersOfFiles> {
    if (fileIds.length === 0) return { importers: [], urlUsageFiles: [] };

    const importers = await this.db.query(
      `
      SELECT DISTINCT ir.importer_file_id AS id
      FROM import_relations ir
      WHERE ir.repo_id = $1
        AND ir.imported_file_id = ANY($2)
        AND ir.importer_file_id <> ALL($2)
    `,
      [repoId, fileIds]
    );

    const urlUsageFiles = await this.db.query(
      `
      SELECT DISTINCT u.usage_file_id AS id
      FROM url_usages u
      JOIN url_patterns p ON u.url_pattern_id = p.id
      WHERE u.repo_id = $1
        AND p.definition_file_id = ANY($2)
        AND u.usage_file_id <> ALL($2)
    `,
      [repoId, fileIds]
    );

    return {
      importers: importers.rows.map((r: { id: number }) => r.id),
      urlUsageFiles: urlUsageFiles.rows.map((r: { id: number }) => r.id),
    };
  }

  /**
   * 列出「本该是仓内导入、但当时没能解析到落点」的导入行
   *
   * 用于处理**新增文件**这一路：新文件 A 入库前，别的文件里
   * `import ... from './A'` 只能记成 `imported_file_id = NULL`
   * （`buildImportRelationships` 是在 files 表里 `path = ANY(候选)` 核对的，查不到就留 NULL）。
   * A 一旦入库，这些行本该被重新解析。
   *
   * 【为什么用 `is_external = false` 做筛选条件】
   * `buildImportRelationships` 写库时以**解析结果**为准：
   * `resolvedExternal = imp.isExternal && importedFileId === null`。
   * 也就是「判定为外部」才记 true。而 `is_external = true` 的行意味着
   * 候选集本来就是空的（纯包名，或推断不出工程根的别名）——
   * 新增一个仓内文件**不可能**让候选集从空变成非空，所以它们不必重算。
   *
   * 实测（仓库 29）：全仓 551 条未解析导入里，549 条是外部依赖，
   * 只有 2 条是非外部的（两个 `.scss`）。也就是说这条传播路径的上限很小，
   * 但它兜住的是「新增文件 + 已有引用」这种最容易出错的场景。
   *
   * @param repoId - 仓库 ID
   * @returns 去重后的 (导入者文件, 导入路径) 列表
   */
  async findUnresolvedInRepoImports(repoId: number): Promise<UnresolvedImportRow[]> {
    const result = await this.db.query(
      `
      SELECT DISTINCT
        ir.importer_file_id AS importer_file_id,
        f.path              AS importer_path,
        ir.import_path      AS import_path
      FROM import_relations ir
      JOIN files f ON f.id = ir.importer_file_id
      WHERE ir.repo_id = $1
        AND ir.imported_file_id IS NULL
        AND ir.is_external = false
    `,
      [repoId]
    );

    return result.rows.map(
      (r: { importer_file_id: number; importer_path: string; import_path: string }) => ({
        importerFileId: r.importer_file_id,
        importerPath: r.importer_path,
        importPath: r.import_path,
      })
    );
  }

  /**
   * 对外暴露「导入路径 → 仓内候选路径」的展开逻辑。
   *
   * 增量路径要判断「某个原本解析失败的老 import，在新的文件集合下能否解析成功」，
   * 靠的就是把 import_path 展开成候选集、再看候选里有没有新文件的路径。
   * 这个展开规则必须与 `buildImportRelationships` 用的**完全一致**，
   * 否则会出现「我们以为能解析、实际写进去还是 NULL」的假阳性。
   */
  resolveImportCandidates(importerPath: string, importPath: string): string[] {
    return this.resolveImportPathCandidates(importerPath, importPath);
  }

  /**
   * 从 import_relations 物化「文件级依赖边」（file_dependencies）
   *
   * 【为什么需要这一步】
   * import_relations 是**符号级**的原始事实：一行 = 「文件 A 导入了符号 X（来自文件 B）」。
   * 同一个 A→B 可能有多行（导入多个符号）。做文件级影响分析时，
   * 每次都在 import_relations 上 GROUP BY 既慢又容易写错（漏 DISTINCT 就会重复计数）。
   * 因此把聚合结果物化成一张边表，让「反向依赖 / 传递闭包」这类查询变成
   * 对一张纯净边表的递归遍历。
   *
   * 【为什么不用触发器】
   * 这里原本的注释声称「触发器会自动聚合」，但仓库里从未存在任何 CREATE TRIGGER，
   * 表因此一直是空的。改成应用层显式调用：可测试、可追踪、不会出现「隐形依赖」。
   *
   * 【为什么整仓重建而不是增量】
   * 一条边依赖导入方与被导入方**双方**都已入库。逐文件增量维护必然漏边
   * （被导入的文件可能排在后面）。整仓重建是幂等的，且规模上只是一条
   * GROUP BY，成本远低于一次 embedding 调用。
   *
   * 【口径】
   * - 只统计仓内边（imported_file_id IS NOT NULL）：外部依赖（react、lodash）不是仓内节点
   * - 排除自环（文件 import 自己）
   * - dependency_count / dependency_types 保留「这条边有多重」的信息，
   *   供影响分析排序（导入 5 个符号的边比导入 1 个的更值得关注）
   *
   * @param repoId - 仓库 ID
   * @returns 物化出的边数量
   */
  async rebuildFileDependencies(repoId: number): Promise<number> {
    await this.db.query('BEGIN');

    try {
      // 整仓重建：先清空该仓库的旧边，再一次性聚合写入
      await this.db.query('DELETE FROM file_dependencies WHERE repo_id = $1', [repoId]);

      const result = await this.db.query(
        `
        INSERT INTO file_dependencies (
          repo_id,
          source_file_id,
          target_file_id,
          dependency_count,
          dependency_types
        )
        SELECT
          d.repo_id,
          d.importer_file_id,
          d.imported_file_id,
          COUNT(*),
          jsonb_agg(DISTINCT d.import_type)
        FROM (
          -- 先按「导入语句」去重再计数，避免 dependency_count 算重导致影响面排序失真。
          --
          -- ⚠️ 这条注释曾写「增量重索引路径没有调用 cleanupFileRelationships，该方法当前无调用点」。
          -- 前半句已过时：2026-09-19 的真增量实现了 EnhancedIndexer.rebuildFiles，
          -- 它会在重建前调 cleanupFileRelationships（见 enhanced-indexer.ts），
          -- 所以「改了内容的文件」现在不会残留旧 import 行。
          -- 但 DISTINCT 仍然保留：清理只覆盖「本次重建的文件集合」，
          -- 而 rebuildFiles 的两趟制（先全删、再全建）在异常中断后可能留下半成品；
          -- 另外全量路径本身也不保证同一 importer/imported 对不出现多行。
          -- 去重是廉价的，而 dependency_count 错了会一路传到影响面排序上。
          SELECT DISTINCT
            ir.repo_id,
            ir.importer_file_id,
            ir.imported_file_id,
            ir.import_path,
            ir.imported_symbol,
            ir.import_type,
            ir.importer_line
          FROM import_relations ir
          WHERE ir.repo_id = $1
            AND ir.imported_file_id IS NOT NULL
            AND ir.importer_file_id <> ir.imported_file_id
        ) d
        GROUP BY d.repo_id, d.importer_file_id, d.imported_file_id
        ON CONFLICT (source_file_id, target_file_id) DO UPDATE
        SET dependency_count = EXCLUDED.dependency_count,
            dependency_types = EXCLUDED.dependency_types,
            updated_at = NOW()
      `,
        [repoId]
      );

      await this.db.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }
}
