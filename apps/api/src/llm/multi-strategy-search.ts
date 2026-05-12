/**
 * 多策略搜索引擎 - 结合多种搜索策略以获得最佳结果
 *
 * 功能说明：
 * 这是一个智能搜索引擎，结合了 5 种不同的搜索策略，
 * 能够处理各种类型的代码搜索需求，从精确匹配到语义理解。
 *
 * 实现的 5 种搜索策略：
 * 1. 向量相似度搜索（语义搜索）
 *    - 使用向量嵌入进行语义匹配
 *    - 能找到意思相近但文本不同的代码
 *    - 适合：概念性搜索、模糊查询
 *
 * 2. 精确模式匹配（字面匹配）
 *    - 直接匹配代码文本
 *    - 支持 URL、常量、函数名的精确查找
 *    - 适合：已知名称的精确查找
 *
 * 3. 模糊文本搜索（容错搜索）
 *    - 使用 PostgreSQL 的 trigram 相似度
 *    - 容忍拼写错误和变体
 *    - 适合：不确定准确名称的搜索
 *
 * 4. 依赖感知搜索（关系搜索）
 *    - 追踪代码的导入和使用关系
 *    - 找到相关的代码位置
 *    - 适合：查找使用位置、影响分析
 *
 * 5. 图遍历搜索（调用图搜索）
 *    - 遍历函数调用图
 *    - 找到调用者和被调用者
 *    - 适合：理解代码流程、调用链分析
 *
 * 核心特性：
 * - 自动策略选择：根据查询意图自动选择最佳策略组合
 * - 智能排序：使用加权评分合并多个策略的结果
 * - 上下文增强：自动添加代码上下文和使用信息
 * - 缓存优化：使用 LRU 缓存加速重复查询
 * - 拼写纠错：自动纠正查询中的拼写错误
 * - 搜索建议：在结果不足时提供搜索建议
 *
 * 使用场景：
 * - 代码导航：快速定位函数、类、常量的定义
 * - API 查找：搜索 URL 端点和 API 定义
 * - 依赖分析：了解代码的使用关系
 * - 重构支持：找到所有需要修改的位置
 */

import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { generateEmbedding } from './embeddings.js';
import { DependencyTracker } from '../indexer/dependency-tracker.js';
import { searchURL } from './url-search.js';
import { LRUCache, generateCacheKey } from '../utils/cache.js';
import { generateSuggestions, correctTypos, SearchSuggestion } from '../utils/search-suggestions.js';
import { extractKeywords as extractMultilingualKeywords } from '../utils/multilingual-tokenizer.js';
import { deduplicateResults, DeduplicatableResult } from '../utils/deduplication.js';

// ============================================
// 类型定义
// ============================================

/**
 * 搜索结果接口
 */
export interface SearchResult {
  id: string;                                    // 结果唯一标识
  type: 'constant' | 'function' | 'class' | 'url' | 'chunk';  // 结果类型
  score: number;                                 // 匹配分数 (0-1)
  filePath: string;                              // 文件路径
  lineStart: number;                             // 起始行号
  lineEnd: number;                               // 结束行号
  content: string;                               // 代码内容
  context: SearchContext;                        // 上下文信息
  metadata: Record<string, any>;                 // 元数据
}

/**
 * 搜索响应接口（包含建议）
 */
export interface SearchResponse {
  results: SearchResult[];                       // 搜索结果
  suggestions?: SearchSuggestion[];              // 搜索建议（结果不足时）
  correctedQuery?: string;                       // 纠正后的查询（如果有拼写错误）
}

/**
 * 搜索上下文接口
 */
export interface SearchContext {
  fileName: string;                              // 文件名
  symbolName?: string;                           // 符号名称
  parentSymbol?: string;                         // 父符号（如类名）
  imports?: string[];                            // 导入列表
  usages?: Array<{ file: string; line: number }>;  // 使用位置
}

/**
 * 搜索选项接口
 */
export interface SearchOptions {
  limit?: number;                                // 结果数量限制（默认 20）
  threshold?: number;                            // 分数阈值（默认 0.5）
  strategies?: SearchStrategy[];                 // 使用的策略（默认 ['vector', 'exact', 'fuzzy']）
  includeContext?: boolean;                      // 是否包含上下文（默认 true）
  followDependencies?: boolean;                  // 是否追踪依赖（默认 false）
}

/**
 * 搜索策略类型
 */
export type SearchStrategy = 'vector' | 'exact' | 'fuzzy' | 'dependency' | 'graph';

/**
 * 查询意图接口
 */
export interface QueryIntent {
  type: 'url' | 'constant' | 'function' | 'class' | 'general';  // 查询类型
  confidence: number;                            // 置信度 (0-1)
  keywords: string[];                            // 提取的关键词
  filters: Record<string, any>;                  // 过滤条件
}

// ============================================
// 多策略搜索引擎类
// ============================================

export class MultiStrategySearch {
  private dependencyTracker: DependencyTracker;  // 依赖追踪器
  private anthropic: Anthropic;                  // Anthropic AI 客户端
  private searchCache: LRUCache<SearchResult[]>; // 搜索结果缓存

  constructor(private db: Pool, anthropicApiKey: string) {
    this.dependencyTracker = new DependencyTracker(db);
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
    // 初始化缓存：100 个条目，5 分钟 TTL
    this.searchCache = new LRUCache<SearchResult[]>(100, 5 * 60 * 1000);
  }

  /**
   * 主搜索入口 - 自动选择最佳策略
   *
   * 这是最简单的搜索接口，自动处理所有细节：
   * - 拼写纠错
   * - 意图识别
   * - 策略选择
   * - 结果排序
   *
   * @param repoId - 仓库 ID
   * @param query - 搜索查询
   * @param options - 搜索选项
   * @returns 搜索结果数组
   */
  async search(repoId: number, query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const response = await this.searchWithSuggestions(repoId, query, options);
    return response.results;
  }

  /**
   * 带建议的搜索 - 返回搜索结果和改进建议
   *
   * 完整的搜索流程：
   * 1. 拼写纠错：自动纠正查询中的拼写错误
   * 2. 缓存检查：检查是否有缓存的结果
   * 3. 意图分析：识别查询类型（URL、函数、类等）
   * 4. 策略选择：根据意图选择最佳策略组合
   * 5. 并行搜索：同时执行多个策略
   * 6. 结果合并：智能合并和排序结果
   * 7. 上下文增强：添加代码上下文和使用信息
   * 8. 去重过滤：移除重复结果
   * 9. 生成建议：结果不足时提供搜索建议
   *
   * @param repoId - 仓库 ID
   * @param query - 搜索查询
   * @param options - 搜索选项
   * @returns 搜索响应（包含结果和建议）
   */
  async searchWithSuggestions(
    repoId: number,
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const {
      limit = 20,
      threshold = 0.5,
      strategies = ['vector', 'exact', 'fuzzy'],
      includeContext = true,
      followDependencies = false,
    } = options;

    // 步骤 1: 拼写纠错
    const { corrected: correctedQuery, hasCorrected } = correctTypos(query);
    const searchQuery = hasCorrected ? correctedQuery : query;

    // 步骤 2: 生成缓存键（使用纠正后的查询）
    const cacheKey = generateCacheKey('search', { repoId, query: searchQuery, ...options });

    // 步骤 3: 检查缓存
    const cachedResults = this.searchCache.get(cacheKey);
    if (cachedResults) {
      console.log('✅ Cache hit for query:', searchQuery);
      return {
        results: cachedResults,
        correctedQuery: hasCorrected ? correctedQuery : undefined,
      };
    }

    // 步骤 4: 分析查询意图
    const intent = await this.analyzeQueryIntent(searchQuery);

    // 步骤 5: URL 查询特殊处理 - 使用简单模式（不进行推导）
    if (intent.type === 'url') {
      console.log('🔍 Detected URL query, using simple location search...');

      try {
        const urlResults = await searchURL(this.db, repoId, query, limit);

        // 将 URLSearchResult 转换为 SearchResult
        const convertedResults: SearchResult[] = urlResults.map(urlResult => ({
          id: urlResult.id,
          type: urlResult.type as any,
          score: urlResult.score,
          filePath: urlResult.filePath,
          lineStart: urlResult.lineStart,
          lineEnd: urlResult.lineEnd,
          content: urlResult.content,
          context: {
            fileName: urlResult.filePath.split('/').pop() || '',
            symbolName: urlResult.context.constantName,
          },
          metadata: {
            urlContext: urlResult.context,
            strategy: 'url_search',
          },
        }));

        console.log(`✅ Simple URL search found ${convertedResults.length} results`);

        // 缓存并返回
        this.searchCache.set(cacheKey, convertedResults);
        return {
          results: convertedResults,
          correctedQuery: hasCorrected ? correctedQuery : undefined,
        };
      } catch (error) {
        console.error('URL search failed, falling back to standard search:', error);
        // 失败时回退到标准搜索
      }
    }

    // 步骤 6: 根据意图选择最佳策略
    const selectedStrategies = this.selectStrategies(intent, strategies);

    // 步骤 7: 并行执行所有策略
    const searchResults = await Promise.all(
      selectedStrategies.map((strategy) => this.executeStrategy(repoId, query, intent, strategy, limit))
    );

    // 步骤 8: 合并和排序结果
    const mergedResults = this.mergeResults(searchResults, intent);

    // 步骤 9: 按阈值过滤
    const filteredResults = mergedResults.filter((r) => r.score >= threshold);

    // 步骤 10: 添加上下文信息（如果需要）
    if (includeContext) {
      await this.enrichWithContext(repoId, filteredResults);
    }

    // 步骤 11: 追踪依赖关系（如果需要）
    if (followDependencies) {
      await this.expandWithDependencies(repoId, filteredResults);
    }

    // 步骤 12: 去重
    const deduplicatedResults = this.deduplicateSearchResults(filteredResults);

    // 步骤 13: 限制结果数量
    const finalResults = deduplicatedResults.slice(0, limit);

    // 步骤 14: 存入缓存
    this.searchCache.set(cacheKey, finalResults);

    // 步骤 15: 构建可用术语字典（用于生成建议）
    const availableTerms = await this.getAvailableTerms(repoId);

    // 步骤 16: 生成搜索建议（结果不足时）
    let suggestions: SearchSuggestion[] | undefined;
    if (finalResults.length < 3) {
      suggestions = generateSuggestions(query, availableTerms);
    }

    return {
      results: finalResults,
      suggestions,
      correctedQuery: hasCorrected ? correctedQuery : undefined,
    };
  }

  /**
   * 分析查询意图 - 识别查询类型和提取关键词
   *
   * 意图识别策略（按优先级）：
   * 1. URL 模式：检测 URL 路径、参数、HTTP 方法
   * 2. 函数签名：检测函数调用、箭头函数
   * 3. 类/接口：检测类型定义
   * 4. 常量：检测全大写、错误码
   * 5. 通用搜索：使用多语言分词器
   *
   * 增强的 URL 识别能力：
   * - 标准 URL 路径: /api/users, /v1/repos
   * - 带参数的路径: /api/users/:id, /repos/{id}
   * - 完整 URL: http://example.com/api
   * - 查询字符串: ?page=1
   * - HTTP 方法: GET /api/users
   *
   * @param query - 搜索查询
   * @returns 查询意图对象
   */
  private async analyzeQueryIntent(query: string): Promise<QueryIntent> {
    // URL patterns - 增强识别
    // 1. 标准 URL 路径: /api/users, /v1/repos
    // 2. 带参数的路径: /api/users/:id, /repos/{id}
    // 3. 完整 URL: http://example.com/api
    // 4. 查询字符串: ?page=1
    if (
      query.match(/\/(api|rest|v\d+|graphql|endpoint)\/|:\w+|\/\{|\bhttps?:\/\//i) ||
      query.match(/^\/[a-z0-9_-]+\/[a-z0-9_-]+/i) || // /path/to/resource
      query.match(/\/(get|post|put|delete|patch)\b/i) // HTTP methods
    ) {
      return {
        type: 'url',
        confidence: 0.9,
        keywords: this.extractURLKeywords(query),
        filters: { type: 'url_segment' },
      };
    }

    // Function signatures
    if (query.match(/\w+\s*\(|function\s+\w+|=>\s*\{/)) {
      return {
        type: 'function',
        confidence: 0.85,
        keywords: this.extractFunctionKeywords(query),
        filters: {},
      };
    }

    // Class/interface patterns
    if (query.match(/class\s+\w+|interface\s+\w+|type\s+\w+/i)) {
      return {
        type: 'class',
        confidence: 0.85,
        keywords: this.extractClassKeywords(query),
        filters: {},
      };
    }

    // Constant patterns (all caps, error codes, etc.)
    if (query.match(/^[A-Z_]+$|^E\d+$/)) {
      return {
        type: 'constant',
        confidence: 0.8,
        keywords: [query],
        filters: { type: ['error_code', 'env_var'] },
      };
    }

    // General search - use multilingual tokenizer
    return {
      type: 'general',
      confidence: 0.5,
      keywords: await extractMultilingualKeywords(query),
      filters: {},
    };
  }

  /**
   * Extract keywords from URL query
   * 优化：更智能地提取有意义的关键词
   */
  private extractURLKeywords(query: string): string[] {
    const keywords: string[] = [];

    // Remove protocol and domain
    let path = query.replace(/^https?:\/\/[^\/]+/, '');

    // Remove query string and hash
    path = path.split('?')[0].split('#')[0];

    // Extract path segments (filter out IDs)
    const segments = path.split('/').filter((s) => {
      if (!s) return false;
      // Skip numeric IDs
      if (/^\d+$/.test(s)) return false;
      // Skip UUIDs
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return false;
      // Skip long hex strings
      if (/^[0-9a-f]{20,}$/i.test(s)) return false;
      // Skip parameter placeholders but extract the name
      if (s.startsWith(':') || s.startsWith('{')) {
        const paramName = s.replace(/^[:{}]/g, '').replace(/}$/, '');
        if (paramName) keywords.push(paramName);
        return false;
      }
      return true;
    });

    keywords.push(...segments);

    // Extract parameter names from :param or {param} format
    const params = query.match(/:(\w+)|\{(\w+)\}/g);
    if (params) {
      params.forEach(p => {
        const paramName = p.replace(/^[:{}]/g, '').replace(/}$/, '');
        if (paramName && !keywords.includes(paramName)) {
          keywords.push(paramName);
        }
      });
    }

    // Extract HTTP method if present
    const methodMatch = query.match(/\b(get|post|put|delete|patch)\b/i);
    if (methodMatch) {
      keywords.push(methodMatch[1].toLowerCase());
    }

    return keywords.filter(k => k.length > 1); // Filter out single chars
  }

  /**
   * Extract keywords from function query
   */
  private extractFunctionKeywords(query: string): string[] {
    const keywords: string[] = [];

    // Extract function name
    const nameMatch = query.match(/(?:function\s+)?(\w+)\s*\(/);
    if (nameMatch) {
      keywords.push(nameMatch[1]);
    }

    // Extract parameter types
    const paramTypes = query.match(/:\s*(\w+)/g);
    if (paramTypes) {
      keywords.push(...paramTypes.map((p) => p.replace(/:\s*/, '')));
    }

    return keywords;
  }

  /**
   * Extract keywords from class query
   */
  private extractClassKeywords(query: string): string[] {
    const keywords: string[] = [];

    // Extract class name
    const nameMatch = query.match(/(?:class|interface|type)\s+(\w+)/i);
    if (nameMatch) {
      keywords.push(nameMatch[1]);
    }

    // Extract extends/implements
    const extendsMatch = query.match(/extends\s+(\w+)/i);
    if (extendsMatch) {
      keywords.push(extendsMatch[1]);
    }

    return keywords;
  }

  /**
   * Select optimal search strategies based on intent
   */
  private selectStrategies(intent: QueryIntent, requestedStrategies: SearchStrategy[]): SearchStrategy[] {
    const strategies: SearchStrategy[] = [];

    // Always use vector search for semantic understanding
    if (requestedStrategies.includes('vector')) {
      strategies.push('vector');
    }

    // Use exact matching for high-confidence patterns
    if (intent.confidence > 0.8 && requestedStrategies.includes('exact')) {
      strategies.push('exact');
    }

    // Use fuzzy search for typo tolerance
    if (requestedStrategies.includes('fuzzy')) {
      strategies.push('fuzzy');
    }

    // Use dependency search for URL and function queries
    if ((intent.type === 'url' || intent.type === 'function') && requestedStrategies.includes('dependency')) {
      strategies.push('dependency');
    }

    // Use graph search for function queries
    if (intent.type === 'function' && requestedStrategies.includes('graph')) {
      strategies.push('graph');
    }

    return strategies;
  }

  /**
   * Execute a specific search strategy
   */
  private async executeStrategy(
    repoId: number,
    query: string,
    intent: QueryIntent,
    strategy: SearchStrategy,
    limit: number
  ): Promise<SearchResult[]> {
    switch (strategy) {
      case 'vector':
        return this.vectorSearch(repoId, query, intent, limit);
      case 'exact':
        return this.exactSearch(repoId, query, intent, limit);
      case 'fuzzy':
        return this.fuzzySearch(repoId, query, intent, limit);
      case 'dependency':
        return this.dependencySearch(repoId, query, intent, limit);
      case 'graph':
        return this.graphSearch(repoId, query, intent, limit);
      default:
        return [];
    }
  }

  /**
   * Strategy 1: Vector similarity search
   */
  private async vectorSearch(
    repoId: number,
    query: string,
    intent: QueryIntent,
    limit: number
  ): Promise<SearchResult[]> {
    // Generate query embedding
    const queryEmbedding = await this.generateQueryEmbedding(query);
    const embeddingVector = `[${queryEmbedding.join(',')}]`;

    const results: SearchResult[] = [];

    // Search in appropriate tables based on intent
    const tables = this.getSearchTables(intent.type);

    for (const table of tables) {
      const query = this.buildVectorQuery(table, repoId, embeddingVector, limit);
      const result = await this.db.query(query.sql, query.params);

      results.push(...this.mapToSearchResults(result.rows, table, 'vector'));
    }

    return results;
  }

  /**
   * Strategy 2: Exact pattern matching
   */
  private async exactSearch(
    repoId: number,
    query: string,
    intent: QueryIntent,
    limit: number
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    if (intent.type === 'url') {
      // Search URL patterns
      const urlResults = await this.db.query(
        `
        SELECT
          up.*,
          f.path as file_path
        FROM url_patterns up
        JOIN files f ON up.definition_file_id = f.id
        WHERE up.repo_id = $1
          AND (
            up.pattern ILIKE $2
            OR up.normalized_pattern ILIKE $2
          )
        ORDER BY
          CASE
            WHEN up.pattern = $3 THEN 1
            WHEN up.normalized_pattern = $3 THEN 2
            ELSE 3
          END
        LIMIT $4
      `,
        [repoId, `%${query}%`, query, limit]
      );

      results.push(...this.mapToSearchResults(urlResults.rows, 'url_patterns', 'exact'));
    } else if (intent.type === 'constant') {
      // Search string constants
      const constantResults = await this.db.query(
        `
        SELECT
          sc.*,
          f.path as file_path
        FROM string_constants sc
        JOIN files f ON sc.file_id = f.id
        WHERE sc.repo_id = $1
          AND (
            sc.symbol_name ILIKE $2
            OR sc.string_value ILIKE $2
          )
        ORDER BY
          CASE
            WHEN sc.symbol_name = $3 THEN 1
            WHEN sc.string_value = $3 THEN 2
            ELSE 3
          END
        LIMIT $4
      `,
        [repoId, `%${query}%`, query, limit]
      );

      results.push(...this.mapToSearchResults(constantResults.rows, 'string_constants', 'exact'));
    } else if (intent.type === 'function') {
      // Search functions
      const functionResults = await this.db.query(
        `
        SELECT
          fn.*,
          f.path as file_path
        FROM functions fn
        JOIN files f ON fn.file_id = f.id
        WHERE fn.repo_id = $1
          AND (
            fn.name ILIKE $2
            OR fn.full_name ILIKE $2
            OR fn.signature ILIKE $2
          )
        ORDER BY
          CASE
            WHEN fn.name = $3 THEN 1
            WHEN fn.full_name = $3 THEN 2
            ELSE 3
          END
        LIMIT $4
      `,
        [repoId, `%${query}%`, query, limit]
      );

      results.push(...this.mapToSearchResults(functionResults.rows, 'functions', 'exact'));
    }

    return results;
  }

  /**
   * Strategy 3: Fuzzy text search using trigrams
   */
  private async fuzzySearch(
    repoId: number,
    query: string,
    intent: QueryIntent,
    limit: number
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Search in code chunks with similarity scoring
    const chunkResults = await this.db.query(
      `
      SELECT
        cc.*,
        f.path as file_path,
        similarity(cc.code_text, $2) as sim_score
      FROM code_chunks cc
      JOIN files f ON cc.file_id = f.id
      WHERE cc.repo_id = $1
        AND cc.code_text % $2
      ORDER BY sim_score DESC
      LIMIT $3
    `,
      [repoId, query, limit]
    );

    results.push(...this.mapToSearchResults(chunkResults.rows, 'code_chunks', 'fuzzy'));

    return results;
  }

  /**
   * Strategy 4: Dependency-aware search
   */
  private async dependencySearch(
    repoId: number,
    query: string,
    intent: QueryIntent,
    limit: number
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // First, find direct matches
    const directMatches = await this.exactSearch(repoId, query, intent, 5);

    // For each match, find related code through dependencies
    for (const match of directMatches) {
      // Find files that import this symbol
      const fileId = await this.getFileIdFromPath(repoId, match.filePath);
      if (!fileId) continue;

      const importers = await this.dependencyTracker.findImporters(repoId, fileId, match.context.symbolName || '');

      // Add usage locations as results
      for (const importer of importers) {
        const importerFile = await this.db.query(
          `
          SELECT path FROM files WHERE id = $1
        `,
          [importer.fileId]
        );

        if (importerFile.rows.length > 0) {
          results.push({
            id: `dep:${importer.fileId}:${importer.symbol}`,
            type: 'chunk',
            score: 0.7 / (importer.depth + 1), // Decay score by depth
            filePath: importerFile.rows[0].path,
            lineStart: 0,
            lineEnd: 0,
            content: `Imports ${importer.symbol} from ${match.filePath}`,
            context: {
              fileName: importerFile.rows[0].path,
              symbolName: importer.symbol,
              imports: [match.filePath],
            },
            metadata: {
              importDepth: importer.depth,
              importType: importer.importType,
            },
          });
        }
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Strategy 5: Graph-based search (call graph traversal)
   */
  private async graphSearch(
    repoId: number,
    query: string,
    intent: QueryIntent,
    limit: number
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Find functions matching the query
    const functions = await this.db.query(
      `
      SELECT
        fn.*,
        f.path as file_path,
        cc.id as chunk_id
      FROM functions fn
      JOIN files f ON fn.file_id = f.id
      LEFT JOIN code_chunks cc ON fn.file_id = cc.file_id
        AND cc.line_start <= fn.line_start
        AND cc.line_end >= fn.line_end
      WHERE fn.repo_id = $1
        AND fn.name ILIKE $2
      LIMIT 5
    `,
      [repoId, `%${query}%`]
    );

    for (const func of functions.rows) {
      if (!func.chunk_id) continue;

      // Find callers
      const callers = await this.db.query(
        `
        SELECT
          cg.*,
          cc.code_text,
          cc.line_start,
          cc.line_end,
          f.path as file_path
        FROM call_graph cg
        JOIN code_chunks cc ON cg.from_chunk_id = cc.id
        JOIN files f ON cc.file_id = f.id
        WHERE cg.to_chunk_id = $1
        LIMIT 10
      `,
        [func.chunk_id]
      );

      results.push(...this.mapToSearchResults(callers.rows, 'call_graph', 'graph'));

      // Find callees
      const callees = await this.db.query(
        `
        SELECT
          cg.*,
          cc.code_text,
          cc.line_start,
          cc.line_end,
          f.path as file_path
        FROM call_graph cg
        JOIN code_chunks cc ON cg.to_chunk_id = cc.id
        JOIN files f ON cc.file_id = f.id
        WHERE cg.from_chunk_id = $1
        LIMIT 10
      `,
        [func.chunk_id]
      );

      results.push(...this.mapToSearchResults(callees.rows, 'call_graph', 'graph'));
    }

    return results.slice(0, limit);
  }

  /**
   * Get search tables based on intent type
   */
  private getSearchTables(intentType: string): string[] {
    switch (intentType) {
      case 'url':
        return ['url_patterns', 'string_constants'];
      case 'constant':
        return ['string_constants'];
      case 'function':
        return ['functions'];
      case 'class':
        return ['classes'];
      default:
        return ['code_chunks', 'functions', 'classes', 'string_constants'];
    }
  }

  /**
   * Build vector search query for a table
   */
  private buildVectorQuery(
    table: string,
    repoId: number,
    embeddingVector: string,
    limit: number
  ): { sql: string; params: any[] } {
    const baseQuery = `
      SELECT
        t.*,
        f.path as file_path,
        1 - (t.embedding <=> $2::vector) as similarity
      FROM ${table} t
      JOIN files f ON t.${table === 'url_patterns' ? 'definition_file_id' : 'file_id'} = f.id
      WHERE t.repo_id = $1
        AND t.embedding IS NOT NULL
      ORDER BY t.embedding <=> $2::vector
      LIMIT $3
    `;

    return {
      sql: baseQuery,
      params: [repoId, embeddingVector, limit],
    };
  }

  /**
   * Map database rows to SearchResult objects
   */
  private mapToSearchResults(rows: any[], table: string, strategy: string): SearchResult[] {
    return rows.map((row) => {
      let type: SearchResult['type'] = 'chunk';
      let content = '';
      let lineStart = 0;
      let lineEnd = 0;

      if (table === 'url_patterns') {
        type = 'url';
        content = `${row.method || 'HTTP'} ${row.pattern}`;
        lineStart = row.definition_line;
        lineEnd = row.definition_line;
      } else if (table === 'string_constants') {
        type = 'constant';
        content = row.string_value;
        lineStart = row.line_start;
        lineEnd = row.line_end;
      } else if (table === 'functions') {
        type = 'function';
        content = row.signature;
        lineStart = row.line_start;
        lineEnd = row.line_end;
      } else if (table === 'classes') {
        type = 'class';
        content = `${row.class_type} ${row.name}`;
        lineStart = row.line_start;
        lineEnd = row.line_end;
      } else if (table === 'code_chunks' || table === 'call_graph') {
        type = 'chunk';
        content = row.code_text || '';
        lineStart = row.line_start || 0;
        lineEnd = row.line_end || 0;
      } else {
        content = row.content || row.code_text || '';
        lineStart = row.line_start || 0;
        lineEnd = row.line_end || 0;
      }

      return {
        id: `${table}:${row.id}`,
        type,
        score: row.similarity || row.sim_score || 0.5,
        filePath: row.file_path,
        lineStart,
        lineEnd,
        content,
        context: {
          fileName: row.file_path.split('/').pop() || '',
          symbolName: row.symbol_name || row.name || row.full_name,
        },
        metadata: {
          strategy,
          table,
          ...row,
        },
      };
    });
  }

  /**
   * Merge results from multiple strategies
   */
  private mergeResults(resultSets: SearchResult[][], intent: QueryIntent): SearchResult[] {
    const merged = new Map<string, SearchResult>();

    // Strategy weights based on intent
    const weights: Record<string, number> = {
      vector: intent.type === 'general' ? 1.0 : 0.8,
      exact: intent.confidence > 0.8 ? 1.2 : 0.9,
      fuzzy: 0.7,
      dependency: intent.type === 'url' ? 1.1 : 0.8,
      graph: intent.type === 'function' ? 1.1 : 0.8,
    };

    resultSets.forEach((results) => {
      results.forEach((result) => {
        const key = `${result.filePath}:${result.lineStart}`;
        const strategy = result.metadata.strategy;
        const weight = weights[strategy] || 1.0;
        const weightedScore = result.score * weight;

        if (merged.has(key)) {
          // Boost score if found by multiple strategies
          const existing = merged.get(key)!;
          existing.score = Math.max(existing.score, weightedScore) + 0.1;
        } else {
          merged.set(key, { ...result, score: weightedScore });
        }
      });
    });

    // Sort by score
    return Array.from(merged.values()).sort((a, b) => b.score - a.score);
  }

  /**
   * Enrich results with additional context
   */
  private async enrichWithContext(repoId: number, results: SearchResult[]): Promise<void> {
    for (const result of results) {
      const fileId = await this.getFileIdFromPath(repoId, result.filePath);
      if (!fileId) continue;

      // Expand code context window (±5 lines)
      await this.expandCodeContext(fileId, result);

      // Get imports
      const imports = await this.db.query(
        `
        SELECT DISTINCT import_path
        FROM import_relations
        WHERE repo_id = $1 AND importer_file_id = $2
        LIMIT 10
      `,
        [repoId, fileId]
      );

      result.context.imports = imports.rows.map((r) => r.import_path);

      // Get usages if it's a constant or function
      if (result.type === 'constant' || result.type === 'function') {
        const usages = await this.db.query(
          `
          SELECT f.path, cr.referrer_line
          FROM constant_references cr
          JOIN files f ON cr.referrer_file_id = f.id
          WHERE cr.repo_id = $1
            AND cr.constant_id IN (
              SELECT id FROM string_constants
              WHERE repo_id = $1 AND symbol_name = $2
            )
          LIMIT 5
        `,
          [repoId, result.context.symbolName]
        );

        result.context.usages = usages.rows.map((r) => ({
          file: r.path,
          line: r.referrer_line,
        }));
      }
    }
  }

  /**
   * Expand code context window by ±5 lines
   */
  private async expandCodeContext(fileId: number, result: SearchResult): Promise<void> {
    const CONTEXT_LINES = 5;

    // Read file content from database
    const fileContent = await this.db.query(
      `
      SELECT content FROM files WHERE id = $1
    `,
      [fileId]
    );

    if (fileContent.rows.length === 0 || !fileContent.rows[0].content) {
      return;
    }

    const lines = fileContent.rows[0].content.split('\n');
    const totalLines = lines.length;

    // Calculate expanded range
    const expandedStart = Math.max(1, result.lineStart - CONTEXT_LINES);
    const expandedEnd = Math.min(totalLines, result.lineEnd + CONTEXT_LINES);

    // Extract expanded content
    const expandedContent = lines.slice(expandedStart - 1, expandedEnd).join('\n');

    // Update result with expanded content
    result.content = expandedContent;
    result.lineStart = expandedStart;
    result.lineEnd = expandedEnd;

    // Store original range in metadata
    result.metadata.originalLineStart = result.lineStart;
    result.metadata.originalLineEnd = result.lineEnd;
  }

  /**
   * Expand results with dependency information
   */
  private async expandWithDependencies(repoId: number, results: SearchResult[]): Promise<void> {
    // This would add related files through dependency chains
    // Implementation depends on specific requirements
  }

  /**
   * Get available terms from repository for suggestions
   */
  private async getAvailableTerms(repoId: number): Promise<string[]> {
    const terms: string[] = [];

    try {
      // Get function names
      const functions = await this.db.query(
        `
        SELECT DISTINCT symbol_name
        FROM functions
        WHERE repo_id = $1 AND symbol_name IS NOT NULL
        LIMIT 500
      `,
        [repoId]
      );
      terms.push(...functions.rows.map((r) => r.symbol_name));

      // Get class names
      const classes = await this.db.query(
        `
        SELECT DISTINCT symbol_name
        FROM classes
        WHERE repo_id = $1 AND symbol_name IS NOT NULL
        LIMIT 500
      `,
        [repoId]
      );
      terms.push(...classes.rows.map((r) => r.symbol_name));

      // Get constant names
      const constants = await this.db.query(
        `
        SELECT DISTINCT symbol_name
        FROM string_constants
        WHERE repo_id = $1 AND symbol_name IS NOT NULL
        LIMIT 500
      `,
        [repoId]
      );
      terms.push(...constants.rows.map((r) => r.symbol_name));
    } catch (error) {
      console.error('Failed to get available terms:', error);
    }

    return terms;
  }

  /**
   * Generate embedding for query using the configured embedding model
   */
  private async generateQueryEmbedding(text: string): Promise<number[]> {
    // Use the existing embedding implementation from embeddings.ts
    return await generateEmbedding(text.slice(0, 8000));
  }

  /**
   * Deduplicate search results using content similarity
   */
  private deduplicateSearchResults(results: SearchResult[]): SearchResult[] {
    // Convert SearchResult to DeduplicatableResult format
    const deduplicatable: DeduplicatableResult[] = results.map(r => ({
      id: r.id,
      filePath: r.filePath,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      content: r.content,
      score: r.score,
    }));

    // Deduplicate with 0.85 similarity threshold
    const deduplicated = deduplicateResults(deduplicatable, {
      contentThreshold: 0.85,
      checkLocation: true,
      keepHighestScore: true,
    });

    // Map back to SearchResult, preserving original data
    return deduplicated.map(d => {
      const original = results.find(r => r.id === d.id);
      return original!;
    });
  }

  /**
   * Get file ID from path
   */
  private async getFileIdFromPath(repoId: number, filePath: string): Promise<number | null> {
    const result = await this.db.query(
      `
      SELECT id FROM files WHERE repo_id = $1 AND path = $2
    `,
      [repoId, filePath]
    );

    return result.rows.length > 0 ? result.rows[0].id : null;
  }
}
