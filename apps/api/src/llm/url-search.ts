/**
 * URL 搜索模块 - 专门用于搜索 URL 和 API 端点
 *
 * 功能说明：
 * 处理动态构造的 URL 搜索，支持从常量、模板字符串和函数调用中查找 URL
 *
 * 核心特性：
 * 1. 意图识别：自动识别用户是要查找定义还是使用位置
 * 2. 多策略搜索：结合 5 种搜索策略，确保找到所有相关结果
 * 3. 模板匹配：支持动态参数的 URL 模板匹配
 * 4. 推导分析：追踪 URL 的构造链，理解复杂的 URL 生成逻辑
 * 5. HTTP 方法匹配：支持按 HTTP 方法（GET/POST/PUT/DELETE）过滤
 *
 * 搜索策略：
 * 1. 字符串常量搜索：查找直接定义的 URL 字符串
 * 2. URL 模式搜索：查找索引时提取的 URL 模式
 * 3. 推导搜索：分析函数和常量的依赖关系，推导 URL 构造过程
 * 4. 向量搜索：使用语义相似度查找相关 URL
 * 5. 使用位置搜索：查找 URL 在代码中的调用位置
 *
 * 使用场景：
 * - API 端点查找：快速定位某个 API 的定义和使用位置
 * - URL 重构：查找所有使用某个 URL 的地方
 * - 接口文档：了解 API 的定义方式和调用方式
 */

import { Pool } from 'pg';
import { generateEmbedding } from './embeddings.js';
import { matchURLTemplate, isTemplate, calculateURLSimilarity } from './url-template-matcher.js';
import { parseQueryIntent, ParsedIntent } from './query-intent-parser.js';
import { deriveURLConstruction } from './url-derivation.js';

/**
 * URL 搜索结果接口
 */
export interface URLSearchResult {
  id: string;                                    // 结果唯一标识
  type: 'constant' | 'pattern' | 'usage' | 'chunk' | 'template' | 'derivation';  // 结果类型
  score: number;                                 // 匹配分数 (0-1)
  filePath: string;                              // 文件路径
  lineStart: number;                             // 起始行号
  lineEnd: number;                               // 结束行号
  content: string;                               // 代码内容
  context: {                                     // 上下文信息
    constantName?: string;                       // 常量名
    constantValue?: string;                      // 常量值
    method?: string | null;                      // HTTP 方法（GET/POST/PUT/DELETE）
    templateMatch?: {                            // 模板匹配信息
      template: string;                          // 模板字符串
      extractedParams: Record<string, string>;   // 提取的参数
    };
    usageChain?: Array<{ file: string; line: number; code: string }>;  // 使用链
  };
}

/**
 * URL 搜索主函数 - 智能搜索 URL 和 API 端点
 *
 * 搜索流程：
 * 1. 意图解析：识别用户是要查找定义还是使用位置
 * 2. 路径提取：从 URL 中提取有意义的路径段
 * 3. 策略选择：根据意图选择最合适的搜索策略
 * 4. 并行搜索：执行多个搜索策略，收集所有结果
 * 5. 去重排序：合并结果，按分数排序
 * 6. 上下文增强：为高分结果添加使用信息
 *
 * 支持的查询格式：
 * - 简单路径: "/api/users"
 * - 带参数: "/api/users/:id"
 * - 完整 URL: "https://api.example.com/users"
 * - 带意图: "/api/users 位置" (查找调用位置)
 * - 带意图: "/api/users 定义" (查找定义位置)
 * - 带方法: "GET /api/users" (按 HTTP 方法过滤)
 *
 * 搜索策略（根据意图自动选择）：
 * - find_usages 意图：优先搜索 URL patterns 和使用位置
 * - find_definition 意图：优先搜索字符串常量
 * - 通用搜索：使用所有策略（常量、模式、推导、向量）
 *
 * @param db - 数据库连接池
 * @param repoId - 仓库 ID
 * @param urlQuery - URL 查询字符串（可包含自然语言意图）
 * @param limit - 返回结果数量限制（默认 20）
 * @returns URL 搜索结果数组，按匹配分数降序排列
 *
 * @example
 * // 示例 1: 简单 URL 搜索
 * const results = await searchURL(db, 1, "/api/users");
 *
 * @example
 * // 示例 2: 带意图的搜索
 * const results = await searchURL(db, 1, "/api/users 位置");
 * // 优先返回调用位置
 *
 * @example
 * // 示例 3: 带 HTTP 方法的搜索
 * const results = await searchURL(db, 1, "GET /api/users/:id");
 * // 只返回 GET 方法的匹配结果
 */
export async function searchURL(
  db: Pool,
  repoId: number,
  urlQuery: string,
  limit = 20
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // 步骤 1: 解析用户意图（提取目标 URL 和操作意图）
  const intent = parseQueryIntent(urlQuery);
  console.log(`🔍 Parsed intent:`, {
    target: intent.target,
    action: intent.action,
    original: intent.originalQuery
  });

  // 步骤 2: 提取 URL 的路径段（使用解析后的 target，而不是原始 query）
  // 路径段用于后续的模糊匹配和关键词搜索
  const pathSegments = extractPathSegments(intent.target);
  console.log(`URL search: extracted segments: ${pathSegments.join(', ')}`);

  // 步骤 3: 根据用户意图选择搜索策略
  if (intent.action === 'find_usages') {
    // 场景 1: 用户想找调用位置 - 优先搜索 URL patterns 和使用位置
    console.log('🎯 User wants to find usages, prioritizing URL patterns...');

    // 策略 1: 搜索 URL 模式表（最高优先级）
    const patternResults = await searchURLPatterns(db, repoId, pathSegments, intent.target);
    results.push(...patternResults);

    // 策略 2: 搜索代码块中的使用位置
    const usageResults = await searchURLUsages(db, repoId, pathSegments, intent.target);
    results.push(...usageResults);

    // 策略 3: 搜索字符串常量（较低优先级）
    const constantResults = await searchURLConstants(db, repoId, pathSegments, intent.target);
    results.push(...constantResults);

  } else if (intent.action === 'find_definition') {
    // 场景 2: 用户想找定义位置 - 优先搜索 string constants
    console.log('🎯 User wants to find definitions, prioritizing constants...');

    // 策略 1: 搜索字符串常量（最高优先级）
    const constantResults = await searchURLConstants(db, repoId, pathSegments, intent.target);
    results.push(...constantResults);

    // 策略 2: 搜索 URL 模式表
    const patternResults = await searchURLPatterns(db, repoId, pathSegments, intent.target);
    results.push(...patternResults);

  } else {
    // 场景 3: 通用搜索 - 使用所有策略
    console.log('🎯 General search, using all strategies...');

    // 策略 1: 搜索字符串常量
    const constantResults = await searchURLConstants(db, repoId, pathSegments, intent.target);
    results.push(...constantResults);

    // 策略 2: 搜索 URL 模式表
    const patternResults = await searchURLPatterns(db, repoId, pathSegments, intent.target);
    results.push(...patternResults);

    // 策略 3: 推导 URL 构造链（分析函数和常量的依赖关系）
    const derivationResults = await searchURLDerivation(db, repoId, intent.target);
    results.push(...derivationResults);

    // 策略 4: 向量语义搜索
    const vectorResults = await searchURLVector(db, repoId, intent.target);
    results.push(...vectorResults);
  }

  // 步骤 4: 去重和排序
  const deduped = deduplicateResults(results);
  const sorted = deduped.sort((a, b) => b.score - a.score);

  // 步骤 5: 为高分结果添加使用信息
  const topResults = sorted.slice(0, limit);
  await enrichWithUsages(db, repoId, topResults);

  return topResults;
}

/**
 * 从 URL 中提取有意义的路径段
 *
 * 提取策略：
 * 1. 移除协议和域名
 * 2. 移除查询字符串和哈希
 * 3. 将动态 ID 替换为占位符（保留结构）
 * 4. 过滤掉无意义的短字符串
 *
 * ID 识别规则：
 * - 纯数字 → :id
 * - UUID → :uuid
 * - MongoDB ObjectId (24位十六进制) → :id
 * - 长十六进制字符串 (20+位) → :token
 *
 * 保留规则：
 * - 常见 API 路径段：api, v1, v2, v3, v4, v5, app, web, p
 * - 有意义的路径段（长度 > 2）
 *
 * @param url - 原始 URL（已由 parseQueryIntent 清理）
 * @returns 路径段数组
 *
 * @example
 * extractPathSegments('/api/users/123/posts/abc')
 * // 返回: ['api', 'users', ':id', 'posts', 'abc']
 *
 * @example
 * extractPathSegments('/api/v1/products/5f8d0d55b54764421b7156c9')
 * // 返回: ['api', 'v1', 'products', ':id']
 */
function extractPathSegments(url: string): string[] {
  // 步骤 1: 移除协议和域名
  let path = url.replace(/^https?:\/\/[^\/]+/, '');

  // 步骤 2: 移除查询字符串和哈希
  path = path.split('?')[0].split('#')[0];

  // 步骤 3: 分割路径并处理每个段
  const segments = path.split('/').map(seg => {
    if (!seg) return null;

    // 识别并替换各种 ID 格式
    if (/^\d+$/.test(seg)) return ':id';                    // 纯数字 ID
    if (/^[0-9a-f]{20,}$/i.test(seg)) return ':token';      // 长十六进制字符串
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';  // UUID
    if (/^[0-9a-f]{24}$/i.test(seg)) return ':id';          // MongoDB ObjectId

    // 保留常见 API 路径段（即使很短）
    const commonSegments = ['api', 'v1', 'v2', 'v3', 'v4', 'v5', 'app', 'web', 'p'];
    if (commonSegments.includes(seg.toLowerCase())) return seg;

    // 过滤掉短随机字符串（可能是 ID）
    if (seg.length <= 2 && /^[a-z0-9]+$/i.test(seg)) return null;

    return seg;
  }).filter(seg => seg !== null) as string[];

  return segments;
}

/**
 * 搜索字符串常量中的 URL 模式
 *
 * 搜索策略（按优先级）：
 * 1. 精确段匹配：查找包含特定路径段的常量
 * 2. 模板匹配：匹配动态参数的 URL 模板（${id}, :id, {id}）
 * 3. 模糊相似度匹配：计算 URL 相似度，找到相近的 URL
 *
 * 评分规则：
 * - 完全匹配：1.0
 * - 包含完整目标 URL：0.95
 * - 目标 URL 包含此常量：0.85
 * - 部分段匹配：0.7 * (匹配段数 / 总段数)
 * - 模板匹配：0.95 * 模板分数
 * - 模糊匹配：0.7 * 相似度
 *
 * @param db - 数据库连接池
 * @param repoId - 仓库 ID
 * @param pathSegments - URL 路径段数组
 * @param fullURL - 完整 URL 字符串
 * @returns 搜索结果数组
 */
async function searchURLConstants(
  db: Pool,
  repoId: number,
  pathSegments: string[],
  fullURL: string
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // 策略 1: 精确段匹配 - 遍历每个路径段，查找包含该段的常量
  for (const segment of pathSegments) {
    const query = `
      SELECT
        sc.id,
        sc.symbol_name,
        sc.string_value,
        sc.line_start,
        sc.line_end,
        sc.code,
        f.path as file_path
      FROM string_constants sc
      JOIN files f ON sc.file_id = f.id
      WHERE sc.repo_id = $1
        AND sc.constant_type = 'url_segment'
        AND sc.string_value ILIKE $2
      ORDER BY LENGTH(sc.string_value) DESC
      LIMIT 10
    `;

    const result = await db.query(query, [repoId, `%${segment}%`]);

    for (const row of result.rows) {
      const stringValue = row.string_value.toLowerCase();
      const targetUrl = fullURL.toLowerCase();

      // 计算匹配精确度
      let score = 0;

      // 评分规则 1: 完全匹配（最高优先级）
      if (stringValue === targetUrl) {
        score = 1.0;
      }
      // 评分规则 2: 包含完整目标 URL（高优先级）
      else if (stringValue.includes(targetUrl)) {
        score = 0.95;
      }
      // 评分规则 3: 目标 URL 包含此常量（中等优先级）
      else if (targetUrl.includes(stringValue)) {
        score = 0.85;
      }
      // 评分规则 4: 部分段匹配（较低优先级）
      else {
        const matchCount = pathSegments.filter(seg =>
          stringValue.includes(seg.toLowerCase())
        ).length;
        score = 0.7 * (matchCount / pathSegments.length);
      }

      results.push({
        id: `constant:${row.id}`,
        type: 'constant',
        score,
        filePath: row.file_path,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        content: row.code || row.string_value,
        context: {
          constantName: row.symbol_name,
          constantValue: row.string_value,
        },
      });
    }
  }

  // 策略 2: 模板匹配 - 查找包含动态参数的 URL 模板
  // 支持的模板格式: ${id}, :id, {id}
  const templateQuery = `
    SELECT
      sc.id,
      sc.symbol_name,
      sc.string_value,
      sc.line_start,
      sc.line_end,
      sc.code,
      f.path as file_path
    FROM string_constants sc
    JOIN files f ON sc.file_id = f.id
    WHERE sc.repo_id = $1
      AND sc.constant_type = 'url_segment'
      AND (
        sc.string_value LIKE '%\${%'
        OR sc.string_value LIKE '%:%'
        OR sc.string_value LIKE '%{%'
      )
    LIMIT 50
  `;

  const templateResult = await db.query(templateQuery, [repoId]);

  for (const row of templateResult.rows) {
    // 检查是否为模板
    if (isTemplate(row.string_value)) {
      // 尝试将模板与查询 URL 匹配
      const match = matchURLTemplate(fullURL, row.string_value);

      if (match && match.score > 0.5) {
        results.push({
          id: `template:${row.id}`,
          type: 'template',
          score: 0.95 * match.score, // 模板匹配给予高分
          filePath: row.file_path,
          lineStart: row.line_start,
          lineEnd: row.line_end,
          content: row.code || row.string_value,
          context: {
            constantName: row.symbol_name,
            constantValue: row.string_value,
            templateMatch: {
              template: row.string_value,
              extractedParams: match.extractedParams,
            },
          },
        });
      }
    }
  }

  // 策略 3: 模糊相似度匹配 - 用于模板匹配失败但 URL 相似的情况
  const fuzzyQuery = `
    SELECT
      sc.id,
      sc.symbol_name,
      sc.string_value,
      sc.line_start,
      sc.line_end,
      sc.code,
      f.path as file_path
    FROM string_constants sc
    JOIN files f ON sc.file_id = f.id
    WHERE sc.repo_id = $1
      AND sc.constant_type = 'url_segment'
    LIMIT 100
  `;

  const fuzzyResult = await db.query(fuzzyQuery, [repoId]);

  for (const row of fuzzyResult.rows) {
    const similarity = calculateURLSimilarity(fullURL, row.string_value);

    if (similarity > 0.6) {
      // 检查是否已经有这个结果（避免重复）
      const existingId = `constant:${row.id}`;
      if (!results.find(r => r.id === existingId)) {
        results.push({
          id: existingId,
          type: 'constant',
          score: 0.7 * similarity,
          filePath: row.file_path,
          lineStart: row.line_start,
          lineEnd: row.line_end,
          content: row.code || row.string_value,
          context: {
            constantName: row.symbol_name,
            constantValue: row.string_value,
          },
        });
      }
    }
  }

  return results;
}

/**
 * 搜索 URL 模式表
 *
 * URL 模式表存储了索引时提取的所有 URL 模式，包括：
 * - 路由定义（Express, Koa, Fastify 等）
 * - API 端点声明
 * - HTTP 方法信息（GET/POST/PUT/DELETE）
 *
 * 搜索策略：
 * 1. 按路径段查找匹配的模式
 * 2. 支持 HTTP 方法过滤（如 "GET /api/users"）
 * 3. 方法匹配时提升分数，不匹配时降低分数
 *
 * 评分规则：
 * - 完全匹配：1.0
 * - 包含完整目标 URL：0.95
 * - 目标 URL 包含此模式：0.85
 * - 部分段匹配：0.7 * (匹配段数 / 总段数)
 * - HTTP 方法匹配：分数 * 1.2（提升 20%）
 * - HTTP 方法不匹配：分数 * 0.5（降低 50%）
 *
 * @param db - 数据库连接池
 * @param repoId - 仓库 ID
 * @param pathSegments - URL 路径段数组
 * @param fullURL - 完整 URL 字符串
 * @returns 搜索结果数组
 */
async function searchURLPatterns(
  db: Pool,
  repoId: number,
  pathSegments: string[],
  fullURL: string
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // 从查询中提取 HTTP 方法（如果存在）
  // 支持格式: "GET /api/users/:id"
  const methodMatch = fullURL.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
  const queryMethod = methodMatch ? methodMatch[1].toUpperCase() : null;
  const urlWithoutMethod = methodMatch ? fullURL.substring(methodMatch[0].length) : fullURL;

  // 按路径段搜索匹配的模式
  for (const segment of pathSegments) {
    const query = `
      SELECT
        up.id,
        up.pattern,
        up.normalized_pattern,
        up.method,
        up.definition_line,
        up.definition_code,
        f.path as file_path
      FROM url_patterns up
      JOIN files f ON up.definition_file_id = f.id
      WHERE up.repo_id = $1
        AND (
          up.pattern ILIKE $2
          OR up.normalized_pattern ILIKE $2
        )
      LIMIT 10
    `;

    const result = await db.query(query, [repoId, `%${segment}%`]);

    for (const row of result.rows) {
      const pattern = row.pattern.toLowerCase();
      const normalizedPattern = row.normalized_pattern?.toLowerCase() || '';
      const targetUrl = urlWithoutMethod.toLowerCase();
      const patternMethod = row.method?.toUpperCase();

      // 计算匹配精确度
      let score = 0;
      let matchType = 'partial';

      // 评分规则 1: 完全匹配（最高优先级）
      if (pattern === targetUrl || normalizedPattern === targetUrl) {
        score = 1.0;
        matchType = 'exact';
      }
      // 评分规则 2: 包含完整目标 URL（高优先级）
      else if (pattern.includes(targetUrl) || normalizedPattern.includes(targetUrl)) {
        score = 0.95;
        matchType = 'contains_full';
      }
      // 评分规则 3: 目标 URL 包含此模式（中等优先级）
      else if (targetUrl.includes(pattern) || (normalizedPattern && targetUrl.includes(normalizedPattern))) {
        score = 0.85;
        matchType = 'contained_in';
      }
      // 评分规则 4: 部分段匹配（较低优先级）
      else {
        const matchCount = pathSegments.filter(seg =>
          pattern.includes(seg.toLowerCase()) || normalizedPattern.includes(seg.toLowerCase())
        ).length;
        score = 0.7 * (matchCount / pathSegments.length);
        matchType = 'segment';
      }

      // HTTP 方法匹配调整分数
      if (queryMethod && patternMethod === queryMethod) {
        // 方法匹配：提升 20%
        score = Math.min(1.0, score * 1.2);
        console.log(`[URL Search] Method match boost: ${patternMethod} ${pattern} -> score ${score}`);
      }
      else if (queryMethod && patternMethod && patternMethod !== queryMethod) {
        // 方法不匹配：降低 50%
        score = score * 0.5;
        console.log(`[URL Search] Method mismatch penalty: expected ${queryMethod}, got ${patternMethod} for ${pattern} -> score ${score}`);
      }

      results.push({
        id: `pattern:${row.id}`,
        type: 'pattern',
        score,
        filePath: row.file_path,
        lineStart: row.definition_line,
        lineEnd: row.definition_line,
        content: row.definition_code || row.pattern,
        context: {
          constantValue: row.pattern,
          method: patternMethod,
        },
      });
    }
  }

  return results;
}

/**
 * 搜索 URL 的使用位置
 *
 * 专门用于查找 URL 在代码中的调用位置，支持常见的 HTTP 客户端模式：
 * - fetch('/api/users')
 * - axios.get('/api/users')
 * - http.post('/api/users')
 * - client.request('/api/users')
 *
 * 搜索策略：
 * 在 code_chunks 表中搜索包含 URL 路径段的代码块
 *
 * 评分规则：
 * - 包含完整目标 URL：0.95
 * - 部分段匹配：0.75 * (匹配段数 / 总段数)
 *
 * @param db - 数据库连接池
 * @param repoId - 仓库 ID
 * @param pathSegments - URL 路径段数组
 * @param fullURL - 完整 URL 字符串
 * @returns 搜索结果数组
 */
async function searchURLUsages(
  db: Pool,
  repoId: number,
  pathSegments: string[],
  fullURL: string
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // 策略: 在代码块中搜索 URL 使用模式
  // 查找常见的 HTTP 客户端调用模式
  for (const segment of pathSegments) {
    const query = `
      SELECT
        c.id,
        c.code_text,
        c.line_start,
        c.line_end,
        f.path as file_path
      FROM code_chunks c
      JOIN files f ON c.file_id = f.id
      WHERE f.repo_id = $1
        AND c.code_text ILIKE $2
      ORDER BY c.line_start
      LIMIT 20
    `;

    const result = await db.query(query, [repoId, `%${segment}%`]);

    for (const row of result.rows) {
      const codeText = row.code_text.toLowerCase();
      const targetUrl = fullURL.toLowerCase();

      // 计算匹配精确度
      let score = 0;

      // 评分规则 1: 包含完整目标 URL（最高优先级）
      if (codeText.includes(targetUrl)) {
        score = 0.95;
      }
      // 评分规则 2: 部分段匹配（较低优先级）
      else {
        const matchCount = pathSegments.filter(seg =>
          codeText.includes(seg.toLowerCase())
        ).length;
        score = 0.75 * (matchCount / pathSegments.length);
      }

      results.push({
        id: `usage:${row.id}`,
        type: 'usage',
        score,
        filePath: row.file_path,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        content: row.code_text,
        context: {},
      });
    }
  }

  return results;
}

/**
 * 向量语义搜索
 *
 * 使用向量嵌入进行语义相似度搜索，能够找到：
 * - 语义相似的 URL（即使文本不完全匹配）
 * - 相关的 API 端点
 * - 功能相似的接口
 *
 * 工作流程：
 * 1. 为查询 URL 生成向量嵌入
 * 2. 在 string_constants 表中搜索最相似的向量
 * 3. 使用余弦相似度排序
 *
 * 评分规则：
 * - 向量相似度 * 0.8（略低于精确匹配，因为可能不够精确）
 *
 * @param db - 数据库连接池
 * @param repoId - 仓库 ID
 * @param urlQuery - URL 查询字符串
 * @returns 搜索结果数组
 */
async function searchURLVector(
  db: Pool,
  repoId: number,
  urlQuery: string
): Promise<URLSearchResult[]> {
  try {
    // 步骤 1: 为 URL 生成向量嵌入
    const embedding = await generateEmbedding(urlQuery);
    const embeddingVector = `[${embedding.join(',')}]`;

    // 步骤 2: 在 string_constants 表中搜索相似向量
    // 使用 <=> 运算符计算余弦距离（1 - 余弦相似度）
    const query = `
      SELECT
        sc.id,
        sc.symbol_name,
        sc.string_value,
        sc.line_start,
        sc.line_end,
        sc.code,
        f.path as file_path,
        1 - (sc.embedding <=> $2::vector) as similarity
      FROM string_constants sc
      JOIN files f ON sc.file_id = f.id
      WHERE sc.repo_id = $1
        AND sc.embedding IS NOT NULL
        AND sc.constant_type = 'url_segment'
      ORDER BY sc.embedding <=> $2::vector
      LIMIT 10
    `;

    const result = await db.query(query, [repoId, embeddingVector]);

    return result.rows.map(row => ({
      id: `vector:${row.id}`,
      type: 'constant' as const,
      score: row.similarity * 0.8, // 向量搜索权重略低
      filePath: row.file_path,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      content: row.code || row.string_value,
      context: {
        constantName: row.symbol_name,
        constantValue: row.string_value,
      },
    }));
  } catch (error) {
    console.error('Vector search failed:', error);
    return [];
  }
}

/**
 * 去重搜索结果
 *
 * 去重策略：
 * 使用 "文件路径:起始行号" 作为唯一键
 * 如果同一位置有多个结果，保留分数最高的
 *
 * @param results - 原始搜索结果数组
 * @returns 去重后的结果数组
 */
function deduplicateResults(results: URLSearchResult[]): URLSearchResult[] {
  const seen = new Map<string, URLSearchResult>();

  for (const result of results) {
    const key = `${result.filePath}:${result.lineStart}`;
    const existing = seen.get(key);

    // 如果该位置没有结果，或新结果分数更高，则更新
    if (!existing || result.score > existing.score) {
      seen.set(key, result);
    }
  }

  return Array.from(seen.values());
}

/**
 * 为结果添加使用信息
 *
 * 为常量类型的结果查找其使用位置，帮助用户了解：
 * - 这个常量在哪些地方被使用
 * - 如何使用这个常量
 * - 使用的上下文代码
 *
 * 增强策略：
 * 在 code_chunks 表中搜索包含常量名的代码块（最多 5 个）
 *
 * @param db - 数据库连接池
 * @param repoId - 仓库 ID
 * @param results - 搜索结果数组（会被原地修改）
 */
async function enrichWithUsages(
  db: Pool,
  repoId: number,
  results: URLSearchResult[]
): Promise<void> {
  for (const result of results) {
    // 只为常量类型的结果添加使用信息
    if (result.type !== 'constant' || !result.context.constantName) {
      continue;
    }

    // 查找使用该常量的代码块
    const usageQuery = `
      SELECT
        f.path as file_path,
        c.line_start,
        c.code_text
      FROM code_chunks c
      JOIN files f ON c.file_id = f.id
      WHERE f.repo_id = $1
        AND c.code_text ILIKE $2
      LIMIT 5
    `;

    try {
      const usages = await db.query(usageQuery, [
        repoId,
        `%${result.context.constantName}%`,
      ]);

      if (usages.rows.length > 0) {
        result.context.usageChain = usages.rows.map(row => ({
          file: row.file_path,
          line: row.line_start,
          code: row.code_text.slice(0, 200), // 截取前 200 字符
        }));
      }
    } catch (error) {
      console.error('Failed to fetch usages:', error);
    }
  }
}

/**
 * 使用推导分析搜索 URL 构造链
 *
 * 推导分析能够：
 * - 追踪 URL 的构造过程（从常量到函数到最终 URL）
 * - 理解复杂的 URL 生成逻辑
 * - 展示完整的依赖链
 *
 * 工作流程：
 * 1. 调用 deriveURLConstruction 分析 URL 构造链
 * 2. 从 url_patterns 表中获取 HTTP 方法信息
 * 3. 根据 HTTP 方法匹配调整分数
 *
 * 评分规则：
 * - 基础分数：推导置信度（0-100）
 * - HTTP 方法匹配：分数 * 1.2（提升 20%）
 * - HTTP 方法不匹配：分数 * 0.5（降低 50%）
 *
 * @param db - 数据库连接池
 * @param repoId - 仓库 ID
 * @param targetUrl - 目标 URL
 * @returns 推导结果数组
 */
async function searchURLDerivation(
  db: Pool,
  repoId: number,
  targetUrl: string
): Promise<URLSearchResult[]> {
  try {
    // 步骤 1: 从查询中提取 HTTP 方法（如果存在）
    const methodMatch = targetUrl.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
    const queryMethod = methodMatch ? methodMatch[1].toUpperCase() : null;
    const urlWithoutMethod = methodMatch ? targetUrl.substring(methodMatch[0].length) : targetUrl;

    // 步骤 2: 执行 URL 推导分析
    const derivations = await deriveURLConstruction(db, repoId, urlWithoutMethod);

    // 步骤 3: 为每个推导结果添加 HTTP 方法信息并调整分数
    const results: URLSearchResult[] = [];

    for (const [index, derivation] of derivations.entries()) {
      const filePath = derivation.symbolChain[0]?.file || '';
      const lineStart = derivation.symbolChain[0]?.line || 0;

      // 尝试从 url_patterns 表中获取 HTTP 方法
      let patternMethod: string | null = null;
      try {
        const methodQuery = `
          SELECT method
          FROM url_patterns up
          JOIN files f ON up.definition_file_id = f.id
          WHERE up.repo_id = $1
            AND f.path = $2
            AND up.definition_line = $3
          LIMIT 1
        `;
        const methodResult = await db.query(methodQuery, [repoId, filePath, lineStart]);
        if (methodResult.rows.length > 0) {
          patternMethod = methodResult.rows[0].method?.toUpperCase();
        }
      } catch (error) {
        console.error('Failed to fetch method for derivation:', error);
      }

      // 计算分数（考虑 HTTP 方法匹配）
      let score = derivation.confidence;

      // HTTP 方法匹配调整分数
      if (queryMethod && patternMethod === queryMethod) {
        // 方法匹配：提升 20%
        score = Math.min(100, score * 1.2);
        console.log(`[URL Derivation] Method match boost: ${patternMethod} ${derivation.pattern} -> score ${score}`);
      }
      else if (queryMethod && patternMethod && patternMethod !== queryMethod) {
        // 方法不匹配：降低 50%
        score = score * 0.5;
        console.log(`[URL Derivation] Method mismatch penalty: expected ${queryMethod}, got ${patternMethod} for ${derivation.pattern} -> score ${score}`);
      }

      results.push({
        id: `derivation:${index}`,
        type: 'derivation' as const,
        score,
        filePath,
        lineStart,
        lineEnd: lineStart,
        content: derivation.symbolChain.map(s => `${s.symbol} = ${s.value}`).join('\n'),
        context: {
          constantName: derivation.symbolChain[0]?.symbol,
          constantValue: derivation.pattern,
          method: patternMethod,
          usageChain: derivation.symbolChain.map(s => ({
            file: s.file,
            line: s.line,
            code: `${s.symbol} = ${s.value}`,
          })),
        },
      });
    }

    return results;
  } catch (error) {
    console.error('URL derivation failed:', error);
    return [];
  }
}
