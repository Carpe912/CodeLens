/**
 * 增强索引器 - 带 AST 分析和关系构建的主索引流水线
 *
 * 本模块协调完整的索引流程，是知识图谱构建的核心：
 * 1. 使用 AST 分析器解析文件
 * 2. 提取实体（常量、函数、类、URL）
 * 3. 使用 text-embedding-v4 生成向量嵌入
 * 4. 构建关系（导入、引用、调用）
 * 5. 将所有数据存储到数据库
 *
 * 这是第二阶段索引（增强索引），在基础索引（Babel Parser）之后运行。
 * 提供更深层次的代码理解能力，包括：
 * - 字符串常量的智能分类
 * - URL 模式的提取和追踪
 * - 函数调用图的构建
 * - 跨文件符号解析
 */

import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { ASTAnalyzer, ASTAnalysisResult } from './ast-analyzer.js';
import { RelationshipBuilder } from './relationship-builder.js';
import { generateEmbedding } from '../llm/embeddings.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================
// 类型定义
// ============================================

/**
 * 索引进度信息
 * 用于跟踪索引过程的实时进度
 */
export interface IndexingProgress {
  totalFiles: number;        // 总文件数
  processedFiles: number;    // 已处理文件数
  entitiesExtracted: number; // 已提取实体数
  relationshipsBuilt: number;// 已构建关系数
  errors: number;            // 错误数量
}

/**
 * 索引选项
 * 配置索引行为的参数
 */
export interface IndexingOptions {
  batchSize?: number;                              // 批处理大小（默认 5）
  skipEmbeddings?: boolean;                        // 是否跳过向量生成（用于测试）
  onProgress?: (progress: IndexingProgress) => void; // 进度回调函数
}

// ============================================
// 增强索引器类
// ============================================

/**
 * 增强索引器
 *
 * 负责执行深度代码分析和知识图谱构建。
 * 与基础索引器（使用 Babel Parser）不同，增强索引器：
 * - 使用 ts-morph 进行更深入的 AST 分析
 * - 提取语义级别的信息（URL 模式、常量分类等）
 * - 构建完整的代码关系网络
 * - 为实体生成向量嵌入以支持语义搜索
 */
export class EnhancedIndexer {
  private astAnalyzer: ASTAnalyzer;              // AST 分析器实例
  private relationshipBuilder: RelationshipBuilder; // 关系构建器实例
  private anthropic: Anthropic;                  // Anthropic API 客户端（用于向量生成）

  /**
   * 构造函数
   *
   * @param db - PostgreSQL 数据库连接池
   * @param anthropicApiKey - Anthropic API 密钥（用于生成向量嵌入）
   */
  constructor(private db: Pool, anthropicApiKey: string) {
    this.astAnalyzer = new ASTAnalyzer();
    this.relationshipBuilder = new RelationshipBuilder(db);
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
  }

  /**
   * 索引单个文件（完整的 AST 分析）
   *
   * 这是增强索引的核心方法，执行四个关键步骤：
   * 1. AST 分析 - 提取代码实体和结构信息
   * 2. 存储实体 - 将提取的实体保存到数据库
   * 3. 构建关系 - 建立实体之间的关联关系
   * 4. 生成向量 - 为实体生成向量嵌入以支持语义搜索
   *
   * 注意：步骤 3 必须在步骤 4 之前执行，因为向量生成需要访问
   * 数据库中已存储的 URL 模式等信息。
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID（数据库主键）
   * @param filePath - 文件路径（相对于仓库根目录）
   * @param content - 文件内容（源代码）
   * @throws 如果索引过程中发生错误，会记录日志并重新抛出
   */
  async indexFile(repoId: number, fileId: number, filePath: string, content: string): Promise<void> {
    console.log(`Indexing file: ${filePath}`);

    try {
      // 步骤 1: 使用 AST 分析器解析文件
      // 提取函数、类、常量、URL 模式、导入关系等
      const astResult = await this.astAnalyzer.analyzeFile(filePath, content);

      // 步骤 2: 将提取的实体存储到数据库
      // 包括：字符串常量、函数、类、URL 模式
      await this.storeEntities(repoId, fileId, filePath, astResult);

      // 步骤 3: 构建实体之间的关系
      // 必须在生成向量之前执行，因为某些关系（如 URL 使用）需要先存储到数据库
      await this.relationshipBuilder.buildRelationships(repoId, fileId, filePath, astResult);

      // 步骤 4: 为实体生成向量嵌入
      // 支持语义搜索和相似度匹配
      await this.generateEmbeddings(repoId, fileId, astResult);

      console.log(`✓ Indexed ${filePath}`);
    } catch (error) {
      console.error(`✗ Error indexing ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * 批量索引多个文件
   *
   * 为了避免内存溢出和提高效率，文件会被分批处理。
   * 每批文件并行处理，批次之间串行执行。
   *
   * 批处理策略：
   * - 默认批大小为 5 个文件
   * - 批内文件并行处理（Promise.all）
   * - 批间串行处理（for 循环）
   * - 单个文件失败不影响其他文件
   *
   * @param repoId - 仓库 ID
   * @param files - 文件列表，包含文件 ID、路径和内容
   * @param options - 索引选项（批大小、进度回调等）
   * @returns 索引进度信息，包含成功和失败的统计
   */
  async indexFiles(
    repoId: number,
    files: Array<{ id: number; path: string; content: string }>,
    options: IndexingOptions = {}
  ): Promise<IndexingProgress> {
    const { batchSize = 5, onProgress } = options;

    // 初始化进度跟踪对象
    const progress: IndexingProgress = {
      totalFiles: files.length,
      processedFiles: 0,
      entitiesExtracted: 0,
      relationshipsBuilt: 0,
      errors: 0,
    };

    // 分批处理文件
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      // 批内文件并行处理
      await Promise.all(
        batch.map(async (file) => {
          try {
            // 索引单个文件
            await this.indexFile(repoId, file.id, file.path, file.content);
            progress.processedFiles++;
          } catch (error) {
            // 单个文件失败不影响其他文件
            progress.errors++;
            console.error(`Error indexing ${file.path}:`, error);
          }

          // 触发进度回调（如果提供）
          if (onProgress) {
            onProgress(progress);
          }
        })
      );
    }

    return progress;
  }

  /**
   * 将提取的实体存储到数据库
   *
   * 将 AST 分析提取的所有实体保存到对应的数据库表中。
   * 使用事务确保数据一致性：要么全部成功，要么全部回滚。
   *
   * 存储的实体类型：
   * 1. 字符串常量（string_constants）- 包含分类信息
   * 2. 函数（functions）- 包含签名、参数、复杂度等
   * 3. 类（classes）- 包含继承、接口、属性、方法等
   *
   * 冲突处理策略：
   * - 使用 ON CONFLICT DO UPDATE 处理重复记录
   * - 唯一键：(repo_id, file_id, 标识符, line_start)
   * - 更新策略：保留新数据，覆盖旧数据
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param filePath - 文件路径（用于日志）
   * @param astResult - AST 分析结果
   * @throws 如果存储过程中发生错误，会回滚事务并重新抛出
   */
  private async storeEntities(
    repoId: number,
    fileId: number,
    filePath: string,
    astResult: ASTAnalysisResult
  ): Promise<void> {
    // 开启数据库事务
    await this.db.query('BEGIN');

    try {
      // 步骤 1: 存储字符串常量
      // 包括 URL 片段、错误码、事件名、CSS 类名等
      for (const constant of astResult.stringConstants) {
        await this.db.query(
          `
          INSERT INTO string_constants (
            repo_id,
            file_id,
            symbol_name,        -- 常量名称（如 API_BASE）
            string_value,       -- 字符串值（如 '/api/v1'）
            constant_type,      -- 常量类型（url_segment/error_code/event_name 等）
            line_start,         -- 起始行号
            line_end,           -- 结束行号
            parent_object,      -- 父对象名称（如果是对象属性）
            export_type,        -- 导出类型（named/default/none）
            code                -- 完整代码
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (repo_id, file_id, string_value, line_start) DO UPDATE
          SET
            symbol_name = EXCLUDED.symbol_name,
            constant_type = EXCLUDED.constant_type,
            code = EXCLUDED.code
        `,
          [
            repoId,
            fileId,
            constant.symbolName || null,
            constant.stringValue,
            constant.constantType,
            constant.lineStart,
            constant.lineEnd,
            constant.parentObject || null,
            constant.exportType || 'none',
            constant.code,
          ]
        );
      }

      // 步骤 2: 存储函数
      // 包括函数声明、方法、箭头函数、构造函数
      for (const func of astResult.functions) {
        await this.db.query(
          `
          INSERT INTO functions (
            repo_id,
            file_id,
            name,                    -- 函数名称
            full_name,               -- 完整名称（包含类名，如 UserService.getUser）
            signature,               -- 函数签名
            return_type,             -- 返回值类型
            function_type,           -- 函数类型（function/method/arrow/constructor）
            visibility,              -- 可见性（public/private/protected）
            is_async,                -- 是否异步
            is_exported,             -- 是否导出
            parameters,              -- 参数列表（JSON）
            cyclomatic_complexity,   -- 圈复杂度
            lines_of_code,           -- 代码行数
            line_start,              -- 起始行号
            line_end,                -- 结束行号
            code                     -- 完整代码
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          ON CONFLICT (repo_id, file_id, full_name, line_start) DO UPDATE
          SET
            signature = EXCLUDED.signature,
            code = EXCLUDED.code
        `,
          [
            repoId,
            fileId,
            func.name,
            func.fullName,
            func.signature,
            func.returnType || null,
            func.functionType,
            func.visibility || 'public',
            func.isAsync,
            func.isExported,
            JSON.stringify(func.parameters),
            func.cyclomaticComplexity,
            func.linesOfCode,
            func.lineStart,
            func.lineEnd,
            func.code,
          ]
        );
      }

      // 步骤 3: 存储类
      // 包括类、接口、类型别名、枚举
      for (const cls of astResult.classes) {
        await this.db.query(
          `
          INSERT INTO classes (
            repo_id,
            file_id,
            name,                    -- 类名
            full_name,               -- 完整名称
            class_type,              -- 类型（class/interface/type/enum）
            extends_class,           -- 继承的类
            implements_interfaces,   -- 实现的接口（JSON 数组）
            properties,              -- 属性列表（JSON 数组）
            methods,                 -- 方法列表（JSON 数组）
            decorators,              -- 装饰器列表（JSON 数组）
            line_start,              -- 起始行号
            line_end,                -- 结束行号
            code                     -- 完整代码
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (repo_id, file_id, full_name, line_start) DO UPDATE
          SET
            code = EXCLUDED.code
        `,
          [
            repoId,
            fileId,
            cls.name,
            cls.fullName,
            cls.classType,
            cls.extendsClass || null,
            JSON.stringify(cls.implementsInterfaces),
            JSON.stringify(cls.properties),
            JSON.stringify(cls.methods),
            JSON.stringify(cls.decorators),
            cls.lineStart,
            cls.lineEnd,
            cls.code,
          ]
        );
      }

      // 提交事务
      await this.db.query('COMMIT');
    } catch (error) {
      // 发生错误时回滚事务
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  /**
   * 查询已存在的向量嵌入
   *
   * 为了避免重复生成向量（耗时且消耗 API 配额），在生成新向量前
   * 先查询数据库中已存在的向量嵌入。
   *
   * 查询策略：
   * - 检查 4 种实体类型：常量、函数、类、URL 模式
   * - 使用唯一键标识每个实体：类型:名称:行号
   * - 只查询有 embedding 字段的记录（非 NULL）
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @returns 已存在向量的实体键集合
   */
  private async getExistingEmbeddings(repoId: number, fileId: number): Promise<Set<string>> {
    const existing = new Set<string>();

    try {
      // 查询 1: 字符串常量的向量
      const constantsResult = await this.db.query(
        `SELECT symbol_name, line_start FROM string_constants
         WHERE repo_id = $1 AND file_id = $2 AND embedding IS NOT NULL`,
        [repoId, fileId]
      );
      for (const row of constantsResult.rows) {
        existing.add(`constant:${row.symbol_name}:${row.line_start}`);
      }

      // 查询 2: 函数的向量
      const functionsResult = await this.db.query(
        `SELECT full_name, line_start FROM functions
         WHERE repo_id = $1 AND file_id = $2 AND embedding IS NOT NULL`,
        [repoId, fileId]
      );
      for (const row of functionsResult.rows) {
        existing.add(`function:${row.full_name}:${row.line_start}`);
      }

      // 查询 3: 类的向量
      const classesResult = await this.db.query(
        `SELECT full_name, line_start FROM classes
         WHERE repo_id = $1 AND file_id = $2 AND embedding IS NOT NULL`,
        [repoId, fileId]
      );
      for (const row of classesResult.rows) {
        existing.add(`class:${row.full_name}:${row.line_start}`);
      }

      // 查询 4: URL 模式的向量
      const urlsResult = await this.db.query(
        `SELECT normalized_pattern, definition_line FROM url_patterns
         WHERE repo_id = $1 AND definition_file_id = $2 AND embedding IS NOT NULL`,
        [repoId, fileId]
      );
      for (const row of urlsResult.rows) {
        // URL 使用特殊分隔符 ||| 避免与路径中的 : 冲突
        existing.add(`url:${row.normalized_pattern}|||${row.definition_line}`);
      }

      console.log(`Found ${existing.size} existing embeddings for file ${fileId}`);
    } catch (error) {
      console.error('Error querying existing embeddings:', error);
    }

    return existing;
  }

  /**
   * 为所有实体生成向量嵌入
   *
   * 使用 text-embedding-v4 模型为代码实体生成向量嵌入，支持语义搜索。
   *
   * 处理流程：
   * 1. 查询已存在的向量，避免重复生成
   * 2. 为每种实体类型准备嵌入任务
   * 3. 批量生成向量（每批 10 个）
   * 4. 批量存储向量到数据库
   *
   * 向量生成策略：
   * - 常量：使用 "名称: 值 (类型)" 格式
   * - 函数：使用 "签名 + 代码前 500 字符"
   * - 类：使用 "类型 名称 + 代码前 500 字符"
   * - URL：使用 "HTTP方法 模式 + 定义代码"
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param astResult - AST 分析结果
   */
  private async generateEmbeddings(repoId: number, fileId: number, astResult: ASTAnalysisResult): Promise<void> {
    const embeddingTasks: Array<{ type: string; id: string; text: string }> = [];

    // 步骤 1: 查询已存在的向量，避免重复生成
    const existingEmbeddings = await this.getExistingEmbeddings(repoId, fileId);

    // 步骤 2: 为常量准备嵌入任务
    for (const constant of astResult.stringConstants) {
      if (constant.symbolName) {
        const key = `constant:${constant.symbolName}:${constant.lineStart}`;
        if (!existingEmbeddings.has(key)) {
          embeddingTasks.push({
            type: 'constant',
            id: `${constant.symbolName}:${constant.lineStart}`,
            text: `${constant.symbolName}: ${constant.stringValue} (${constant.constantType})`,
          });
        }
      }
    }

    // 步骤 3: 为函数准备嵌入任务
    for (const func of astResult.functions) {
      const key = `function:${func.fullName}:${func.lineStart}`;
      if (!existingEmbeddings.has(key)) {
        embeddingTasks.push({
          type: 'function',
          id: `${func.fullName}:${func.lineStart}`,
          text: `${func.signature}\n${func.code.slice(0, 500)}`, // 限制为 500 字符
        });
      }
    }

    // 步骤 4: 为类准备嵌入任务
    for (const cls of astResult.classes) {
      const key = `class:${cls.fullName}:${cls.lineStart}`;
      if (!existingEmbeddings.has(key)) {
        embeddingTasks.push({
          type: 'class',
          id: `${cls.fullName}:${cls.lineStart}`,
          text: `${cls.classType} ${cls.fullName}\n${cls.code.slice(0, 500)}`,
        });
      }
    }

    // 步骤 5: 为 URL 模式准备嵌入任务
    // 从数据库查询 URL 模式（因为可能已经被规范化）
    const urlPatternsResult = await this.db.query(
      `SELECT normalized_pattern, pattern, method, definition_line, definition_code
       FROM url_patterns
       WHERE repo_id = $1 AND definition_file_id = $2`,
      [repoId, fileId]
    );

    console.log(`Found ${urlPatternsResult.rows.length} URL patterns for file ${fileId}`);

    for (const url of urlPatternsResult.rows) {
      console.log(`Processing URL pattern: ${url.normalized_pattern} (line ${url.definition_line})`);

      // 跳过不完整的 URL 模式（如 :param、:param:param）
      // 只处理以 / 开头的完整路径
      if (!url.normalized_pattern || !url.normalized_pattern.startsWith('/')) {
        console.log(`  Skipping incomplete pattern: ${url.normalized_pattern}`);
        continue;
      }

      const key = `url:${url.normalized_pattern}|||${url.definition_line}`;
      if (!existingEmbeddings.has(key)) {
        console.log(`  Adding URL embedding task: ${key}`);
        embeddingTasks.push({
          type: 'url',
          id: `${url.normalized_pattern}|||${url.definition_line}`,
          text: `${url.method || 'HTTP'} ${url.pattern}\n${url.definition_code}`,
        });
      } else {
        console.log(`  URL embedding already exists: ${key}`);
      }
    }

    // 如果所有向量都已存在，跳过生成
    if (embeddingTasks.length === 0) {
      console.log(`All embeddings already exist for file ${fileId}, skipping...`);
      return;
    }

    console.log(`Generating ${embeddingTasks.length} new embeddings for file ${fileId}...`);

    // 步骤 6: 批量生成向量（每批 10 个）
    const batchSize = 10;
    const embeddingResults: Array<{ type: string; id: string; embedding: number[] }> = [];

    for (let i = 0; i < embeddingTasks.length; i += batchSize) {
      const batch = embeddingTasks.slice(i, i + batchSize);

      // 并行生成批内的所有向量
      const results = await Promise.all(
        batch.map(async (task) => {
          try {
            const embedding = await this.generateEmbeddingVector(task.text);
            return { type: task.type, id: task.id, embedding };
          } catch (error) {
            console.error(`Error generating embedding for ${task.type} ${task.id}:`, error);
            return null;
          }
        })
      );

      // 过滤掉失败的结果
      embeddingResults.push(...results.filter((r): r is { type: string; id: string; embedding: number[] } => r !== null));
    }

    // 步骤 7: 批量存储向量到数据库
    await this.batchStoreEmbeddings(repoId, fileId, embeddingResults);
  }

  /**
   * 生成单个向量嵌入
   *
   * 使用配置的嵌入模型生成文本的向量表示。
   * 使用 embeddings.ts 中的实现，支持 OpenAI 兼容的 API。
   *
   * @param text - 要生成向量的文本
   * @returns 向量数组（1536 维）
   */
  private async generateEmbeddingVector(text: string): Promise<number[]> {
    try {
      // 使用 embeddings.ts 中的现有实现
      // 支持 OpenAI 兼容的 API，如 DashScope（阿里云）
      return await generateEmbedding(text.slice(0, 8000)); // 限制文本长度为 8000 字符
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * 按类型批量存储向量嵌入
   *
   * 为了减少数据库往返次数，将向量按实体类型分组后批量更新。
   *
   * 优化策略：
   * - 按实体类型（constant、function、class、url）分组
   * - 每种类型使用专门的批量更新方法
   * - 减少数据库连接和事务开销
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param results - 向量生成结果数组
   */
  private async batchStoreEmbeddings(
    repoId: number,
    fileId: number,
    results: Array<{ type: string; id: string; embedding: number[] }>
  ): Promise<void> {
    // 步骤 1: 按类型分组
    const byType = new Map<string, Array<{ id: string; embedding: number[] }>>();
    for (const result of results) {
      if (!byType.has(result.type)) {
        byType.set(result.type, []);
      }
      byType.get(result.type)!.push({ id: result.id, embedding: result.embedding });
    }

    // 步骤 2: 批量更新每种类型
    for (const [type, items] of byType.entries()) {
      try {
        await this.batchUpdateEmbeddingsByType(repoId, fileId, type, items);
      } catch (error) {
        console.error(`Error batch updating ${type} embeddings:`, error);
      }
    }
  }

  /**
   * 批量更新特定实体类型的向量嵌入
   *
   * 使用事务批量更新向量，减少数据库锁定时间。
   *
   * 性能优化：
   * - 每个事务处理 50 个实体（txBatchSize）
   * - 使用数据库连接池避免频繁建立连接
   * - 发生错误时自动回滚事务
   *
   * ID 格式：
   * - 常量/函数/类：名称:行号
   * - URL：模式|||行号（使用 ||| 避免与路径中的 : 冲突）
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param entityType - 实体类型（constant、function、class、url）
   * @param items - 要更新的实体数组
   */
  private async batchUpdateEmbeddingsByType(
    repoId: number,
    fileId: number,
    entityType: string,
    items: Array<{ id: string; embedding: number[] }>
  ): Promise<void> {
    if (items.length === 0) return;

    const client = await this.db.connect();
    try {
      // 使用较小的事务批次减少锁定时间
      const txBatchSize = 50;
      for (let i = 0; i < items.length; i += txBatchSize) {
        const batch = items.slice(i, i + txBatchSize);

        await client.query('BEGIN');

        for (const item of batch) {
          // 将向量数组转换为 PostgreSQL vector 格式
          const embeddingVector = '[' + item.embedding.join(',') + ']';

          // 解析实体 ID
          // URL 模式使用 '|||' 分隔符，其他使用 ':'
          let name: string;
          let lineNum: number;
          let lineStr: string;

          if (entityType === 'url') {
            const [pattern, line] = item.id.split('|||');
            name = pattern;
            lineStr = line;
            lineNum = parseInt(line, 10);
          } else {
            const [n, line] = item.id.split(':');
            name = n;
            lineStr = line;
            lineNum = parseInt(line, 10);
          }

          // 验证行号有效性
          if (isNaN(lineNum)) {
            console.error(`Invalid line number for ${entityType} ${name}: ${lineStr}`);
            continue;
          }

          // 根据实体类型更新对应的表
          switch (entityType) {
            case 'constant':
              await client.query(
                `UPDATE string_constants SET embedding = $1::vector
                 WHERE repo_id = $2 AND file_id = $3 AND symbol_name = $4 AND line_start = $5`,
                [embeddingVector, repoId, fileId, name, lineNum]
              );
              break;

            case 'function':
              await client.query(
                `UPDATE functions SET embedding = $1::vector
                 WHERE repo_id = $2 AND file_id = $3 AND full_name = $4 AND line_start = $5`,
                [embeddingVector, repoId, fileId, name, lineNum]
              );
              break;

            case 'class':
              await client.query(
                `UPDATE classes SET embedding = $1::vector
                 WHERE repo_id = $2 AND file_id = $3 AND full_name = $4 AND line_start = $5`,
                [embeddingVector, repoId, fileId, name, lineNum]
              );
              break;

            case 'url':
              await client.query(
                `UPDATE url_patterns SET embedding = $1::vector
                 WHERE repo_id = $2 AND definition_file_id = $3 AND normalized_pattern = $4 AND definition_line = $5`,
                [embeddingVector, repoId, fileId, name, lineNum]
              );
              break;
          }
        }

        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 存储向量嵌入到对应的表
   *
   * 单个实体的向量存储方法（已被批量方法替代，保留用于兼容性）。
   *
   * 根据实体类型将向量更新到对应的数据库表：
   * - constant → string_constants 表
   * - function → functions 表
   * - class → classes 表
   * - url → url_patterns 表
   *
   * @param repoId - 仓库 ID
   * @param fileId - 文件 ID
   * @param entityType - 实体类型
   * @param entityId - 实体唯一标识（格式：名称:行号 或 模式|||行号）
   * @param embedding - 向量数组
   */
  private async storeEmbedding(
    repoId: number,
    fileId: number,
    entityType: string,
    entityId: string,
    embedding: number[]
  ): Promise<void> {
    // 将向量数组转换为 PostgreSQL vector 格式
    const embeddingVector = '[' + embedding.join(',') + ']';

    try {
      switch (entityType) {
        case 'constant':
          // 解析常量 ID：名称:行号
          const [constantName, constantLine] = entityId.split(':');
          const constantLineNum = parseInt(constantLine, 10);
          if (isNaN(constantLineNum)) {
            console.error(`Invalid line number for constant ${constantName}: ${constantLine}`);
            return;
          }
          await this.db.query(
            `
            UPDATE string_constants
            SET embedding = $1::vector
            WHERE repo_id = $2
              AND file_id = $3
              AND symbol_name = $4
              AND line_start = $5
          `,
            [embeddingVector, repoId, fileId, constantName, constantLineNum]
          );
          break;

        case 'function':
          // 解析函数 ID：名称:行号
          const [funcName, funcLine] = entityId.split(':');
          const funcLineNum = parseInt(funcLine, 10);
          if (isNaN(funcLineNum)) {
            console.error(`Invalid line number for function ${funcName}: ${funcLine}`);
            return;
          }
          await this.db.query(
            `
            UPDATE functions
            SET embedding = $1::vector
            WHERE repo_id = $2
              AND file_id = $3
              AND full_name = $4
              AND line_start = $5
          `,
            [embeddingVector, repoId, fileId, funcName, funcLineNum]
          );
          break;

        case 'class':
          // 解析类 ID：名称:行号
          const [className, classLine] = entityId.split(':');
          const classLineNum = parseInt(classLine, 10);
          if (isNaN(classLineNum)) {
            console.error(`Invalid line number for class ${className}: ${classLine}`);
            return;
          }
          await this.db.query(
            `
            UPDATE classes
            SET embedding = $1::vector
            WHERE repo_id = $2
              AND file_id = $3
              AND full_name = $4
              AND line_start = $5
          `,
            [embeddingVector, repoId, fileId, className, classLineNum]
          );
          break;

        case 'url':
          // 解析 URL ID：使用 '|||' 作为分隔符以处理包含冒号的模式（如 CSS 选择器）
          const separatorIndex = entityId.indexOf('|||');
          if (separatorIndex === -1) {
            console.error(`Invalid URL entity ID format (missing separator): ${entityId}`);
            return;
          }
          const urlPattern = entityId.substring(0, separatorIndex);
          const urlLine = entityId.substring(separatorIndex + 3);
          const urlLineNum = parseInt(urlLine, 10);
          if (isNaN(urlLineNum)) {
            console.error(`Invalid line number for URL ${urlPattern}: ${urlLine}`);
            return;
          }
          await this.db.query(
            `
            UPDATE url_patterns
            SET embedding = $1::vector
            WHERE repo_id = $2
              AND definition_file_id = $3
              AND normalized_pattern = $4
              AND definition_line = $5
          `,
            [embeddingVector, repoId, fileId, urlPattern, urlLineNum]
          );
          break;
      }
    } catch (error) {
      console.error(`Error storing embedding for ${entityType} ${entityId}:`, error);
    }
  }

  /**
   * 重新索引整个仓库
   *
   * 完整的仓库重建索引流程，包括清理旧数据和重新分析所有文件。
   *
   * 执行步骤：
   * 1. 从数据库查询所有文件路径
   * 2. 读取文件内容
   * 3. 清理旧的关系数据
   * 4. 重新索引所有文件
   * 5. 返回索引进度统计
   *
   * 使用场景：
   * - 数据库结构升级后需要重建索引
   * - 索引数据损坏需要修复
   * - 更新索引算法后需要重新处理
   *
   * @param repoId - 仓库 ID
   * @param repoPath - 仓库在文件系统中的路径
   * @param options - 索引选项（可选）
   * @returns 索引进度信息
   */
  async reindexRepository(repoId: number, repoPath: string, options: IndexingOptions = {}): Promise<IndexingProgress> {
    console.log(`Starting re-index of repository ${repoId} at ${repoPath}`);

    // 步骤 1: 从数据库获取所有文件
    const filesResult = await this.db.query(
      `
      SELECT id, path
      FROM files
      WHERE repo_id = $1
      ORDER BY path
    `,
      [repoId]
    );

    // 步骤 2: 读取文件内容
    const files = await Promise.all(
      filesResult.rows.map(async (row) => {
        const fullPath = path.join(repoPath, row.path);
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          return { id: row.id, path: row.path, content };
        } catch (error) {
          console.error(`Error reading file ${row.path}:`, error);
          return null;
        }
      })
    );

    // 过滤掉读取失败的文件
    const validFiles = files.filter((f) => f !== null) as Array<{ id: number; path: string; content: string }>;

    // 步骤 3: 清理旧数据
    console.log('Cleaning up old relationships...');
    await this.cleanupRepository(repoId);

    // 步骤 4: 索引所有文件
    console.log(`Indexing ${validFiles.length} files...`);
    const progress = await this.indexFiles(repoId, validFiles, options);

    // 步骤 5: 输出统计信息
    console.log('Re-indexing complete!');
    console.log(`  Processed: ${progress.processedFiles}/${progress.totalFiles}`);
    console.log(`  Errors: ${progress.errors}`);

    return progress;
  }

  /**
   * 清理仓库的旧数据
   *
   * 在重新索引前删除所有相关的旧数据，确保数据一致性。
   *
   * 删除顺序：
   * 1. 搜索日志（search_logs）
   * 2. URL 使用关系（url_usages）
   * 3. 常量引用关系（constant_references）
   * 4. 调用图（call_graph）- 通过 JOIN 删除
   * 5. 导入关系（import_relations）
   * 6. 文件依赖（file_dependencies）
   * 7. URL 模式（url_patterns）
   * 8. 函数（functions）
   * 9. 类（classes）
   * 10. 字符串常量（string_constants）
   *
   * 注意：删除顺序遵循外键约束，避免违反引用完整性。
   *
   * @param repoId - 仓库 ID
   */
  private async cleanupRepository(repoId: number): Promise<void> {
    await this.db.query('BEGIN');

    try {
      // 按照外键依赖顺序删除，避免约束冲突
      await this.db.query('DELETE FROM search_logs WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM url_usages WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM constant_references WHERE repo_id = $1', [repoId]);

      // call_graph 表没有 repo_id 字段，需要通过 code_chunks -> files 关联删除
      await this.db.query(`
        DELETE FROM call_graph
        WHERE from_chunk_id IN (
          SELECT cc.id FROM code_chunks cc
          JOIN files f ON cc.file_id = f.id
          WHERE f.repo_id = $1
        )
      `, [repoId]);

      await this.db.query('DELETE FROM import_relations WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM file_dependencies WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM url_patterns WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM functions WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM classes WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM string_constants WHERE repo_id = $1', [repoId]);

      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  /**
   * 获取索引统计信息
   *
   * 查询仓库的索引数据统计，用于监控和展示。
   *
   * 统计指标：
   * - files: 文件总数
   * - constants: 字符串常量总数
   * - functions: 函数总数
   * - classes: 类总数
   * - urlPatterns: URL 模式总数
   * - imports: 导入关系总数
   * - callEdges: 调用图边总数
   *
   * @param repoId - 仓库 ID
   * @returns 索引统计对象
   */
  async getIndexingStats(repoId: number): Promise<{
    files: number;
    constants: number;
    functions: number;
    classes: number;
    urlPatterns: number;
    imports: number;
    callEdges: number;
  }> {
    const stats = await this.db.query(
      `
      SELECT
        (SELECT COUNT(*) FROM files WHERE repo_id = $1) as files,
        (SELECT COUNT(*) FROM string_constants WHERE repo_id = $1) as constants,
        (SELECT COUNT(*) FROM functions WHERE repo_id = $1) as functions,
        (SELECT COUNT(*) FROM classes WHERE repo_id = $1) as classes,
        (SELECT COUNT(*) FROM url_patterns WHERE repo_id = $1) as url_patterns,
        (SELECT COUNT(*) FROM import_relations WHERE repo_id = $1) as imports,
        (SELECT COUNT(*) FROM call_graph WHERE repo_id = $1) as call_edges
    `,
      [repoId]
    );

    return {
      files: parseInt(stats.rows[0].files),
      constants: parseInt(stats.rows[0].constants),
      functions: parseInt(stats.rows[0].functions),
      classes: parseInt(stats.rows[0].classes),
      urlPatterns: parseInt(stats.rows[0].url_patterns),
      imports: parseInt(stats.rows[0].imports),
      callEdges: parseInt(stats.rows[0].call_edges),
    };
  }
}
