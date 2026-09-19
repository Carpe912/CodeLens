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
import { generateEmbedding } from '../llm/embeddings.js';
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
    usageContext?: string;                       // 使用上下文（api_call / route_definition / router / unknown / indirect_call / template_helper / version_family）
    relatedKind?: string;                        // 关联层来源（非空表示这条是「关联结果」而非直接命中）
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

    // 策略 3: 使用位置
    //
    // ⚠️ url_patterns **一个接口只有一行**（唯一键是 (repo, method, 规范化路径)，
    // 定义位置取「第一个写入者」）。所以「同一条路径被几处分别定义/调用」这件事
    // 只存在于 url_usages 里 —— 例如 `/api/users` 的定义行记在 userApi.js:13，
    // 而 userRoutes.js:9 的路由注册只是一个 usage。
    // 只在 find_usages 分支查 usage，会让「找定义」这类查询**永远看不到**另一半位置，
    // 表现为「这条路由明明在文件里，搜出来就是没有」。三类意图一律带上 usage。
    const usageResults = await searchURLUsages(db, repoId, pathSegments, intent.target);
    results.push(...usageResults);

  } else {
    // 场景 3: 通用搜索 - 使用所有策略
    console.log('🎯 General search, using all strategies...');

    // 策略 1: 搜索字符串常量
    const constantResults = await searchURLConstants(db, repoId, pathSegments, intent.target);
    results.push(...constantResults);

    // 策略 2: 搜索 URL 模式表
    const patternResults = await searchURLPatterns(db, repoId, pathSegments, intent.target);
    results.push(...patternResults);

    // 策略 3: 使用位置（理由同 find_definition 分支）
    const usageResults = await searchURLUsages(db, repoId, pathSegments, intent.target);
    results.push(...usageResults);

    // 策略 4: 推导 URL 构造链（分析函数和常量的依赖关系）
    const derivationResults = await searchURLDerivation(db, repoId, intent.target);
    results.push(...derivationResults);

    // 策略 5: 向量语义搜索
    const vectorResults = await searchURLVector(db, repoId, intent.target);
    results.push(...vectorResults);
  }

  // 步骤 4: 去重和排序
  //
  // 排序必须带确定性的并列规则：`deduplicateResults` 的 Map 会**保留首次插入的位置**
  // 而只更新分值，于是「同分」的行在数组里的先后由「哪条策略先把它塞进来」决定
  // （pattern 阶段先于 usage 阶段）。只用 score 排序时，这会稳定地把
  // 「只在 url_usages 里出现的行」（如常量拼出来的路由注册行）排到同分组末尾，
  // 然后被 slice 截掉。加上 file/line 作为并列键，结果既稳定又与人读代码的顺序一致。
  const deduped = deduplicateResults(results);
  const sorted = deduped.sort(
    (a, b) =>
      b.score - a.score ||
      a.filePath.localeCompare(b.filePath) ||
      a.lineStart - b.lineStart
  );

  // 步骤 5: 为高分结果添加使用信息
  const topResults = sorted.slice(0, limit);
  await enrichWithUsages(db, repoId, topResults);

  // 步骤 6: 关联层
  //
  // 前 5 步都是「字面命中」：查询的路径段出现在哪个 URL 里。但真实项目里
  // 「这个接口被谁用」常常一个字面路径都没有 —— 业务方法只调自己的封装
  // （`this.orderApi.getOrderItem(...)`），封装里才写字面路径；反过来
  // `fromTemplate` 这类模板处理器自己也不产出路径。
  //
  // 这一层补的正是这两种跨过程落点，外加「版本循环生成的同类路由」。
  // **刻意排在直接命中之后**并打上 `relatedKind` 标签：它们属于「关联信息」，
  // 不该挤掉前面的直接命中，使用者也能一眼看出这条为什么会出现。
  const related = await searchURLRelated(db, repoId, intent.target, pathSegments, topResults);

  return [...topResults, ...related];
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

// ============================================
// 候选集查询（取代「按段循环 + 无 ORDER BY」）
// ============================================

/**
 * 候选集大小。
 *
 * `deduplicateResults` 的去重键是「文件:行」，排序后还要 `slice(0, limit)`。
 * 候选集给太小，真正命中的行会在排序前就被截掉 —— 这正是「索引里有、搜不出来」的成因。
 *
 * 取 400 而不是几十：一条路径的 url_usages 行数 = 它在全仓出现的次数，
 * 而 /api/users 这种短路径会因为 `api`、`users` 两个泛段命中大半个仓库
 *（实测 test-repo 上 160 条 usage 里命中 120+）。截断在 120 时，
 * 排在段命中数后面的行（例如常量拼出来的 complexRoutes.js:17）会被整段丢掉。
 */
const URL_CANDIDATE_LIMIT = 400;

/** 去掉首尾斜杠。入库时 normalized_pattern 的首斜杠被剥掉，查询却带着斜杠，直接比会永远不等 */
function stripSlashes(s: string): string {
  return s.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 查询目标：去方法前缀、去查询串/哈希、统一小写、去首尾斜杠 */
function normalizeTarget(url: string): string {
  return stripSlashes(url.replace(/[?#].*$/, '').trim().toLowerCase());
}

/** 参与匹配的路径段（≥2 字符，避免 'v'、'a' 这类单字符把候选集炸开） */
function usableSegments(pathSegments: string[], target: string): string[] {
  const raw = pathSegments.length > 0 ? pathSegments : stripSlashes(target).split('/');
  return raw.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
}

/**
 * 段匹配得分 = 基础分 × 召回 × 精确度。
 *
 * 只算「查询里有几段被命中」是不够的：`/api/users` 会同时命中
 * `/api/v1/users`（多了 v1 一段）和 `/api/v1/users/:userId/orders/:orderId/items/:itemId`
 *（多了四段），两者召回率都是 100%，于是同分并列、顺序由内部实现决定 ——
 * 结果「最贴近查询的那条」可能排在几百名之后。乘上 `查询段数 / 模式段数`
 * 后，多余段越少分越高，正好是我们想要的次序。
 *
 * @param base - 该策略的基础分（usage 0.8 / pattern、constant 0.7）
 * @param querySegs - 查询的路径段
 * @param matched - 查询段中在候选里出现过的数量
 * @param patternValue - 候选自身的路径（用于算它有多少段）
 */
function segmentScore(base: number, querySegs: string[], matched: number, patternValue: string): number {
  if (querySegs.length === 0) return 0;
  const patternSegs = usableSegments([], patternValue);
  const precision = querySegs.length / Math.max(patternSegs.length, querySegs.length);
  return base * (matched / querySegs.length) * precision;
}

/** 排名片段：0 精确 / 1 互相包含 / 2 被查询包含 / 3 仅段命中；另附命中段数 */
function rankedColumns(patternCol: string, normalizedCol: string, cte = 'url_q'): string {
  const p = `lower(${patternCol})`;
  const n = `lower(coalesce(${normalizedCol}, ''))`;
  const t = `(SELECT t FROM ${cte}_target)`;
  return `
      CASE
        WHEN trim(both '/' from ${p}) = ${t} THEN 0
        WHEN trim(both '/' from ${n}) = ${t} THEN 0
        WHEN ${p} LIKE '%' || ${t} || '%' THEN 1
        WHEN ${n} LIKE '%' || ${t} || '%' THEN 1
        WHEN ${t} LIKE '%' || trim(both '/' from ${n}) || '%' THEN 2
        ELSE 3
      END AS match_rank,
      (SELECT count(*) FROM ${cte}_seg WHERE position(seg in ${p}) > 0 OR position(seg in ${n}) > 0) AS seg_hits`;
}

/** 候选谓词：命中任意一段；查询里没有可用段时退化为「全取」 */
function hitPredicate(patternCol: string, normalizedCol: string, cte = 'url_q'): string {
  const p = `lower(${patternCol})`;
  const n = `lower(coalesce(${normalizedCol}, ''))`;
  return `(
        (SELECT count(*) FROM ${cte}_seg) = 0
        OR EXISTS (
          SELECT 1 FROM ${cte}_seg WHERE position(seg in ${p}) > 0 OR position(seg in ${n}) > 0
        )
      )`;
}

/** 目标表 + 段表两个 CTE（`$2` 是查询目标） */
function rankedCte(cte = 'url_q'): string {
  return `
    WITH ${cte}_target AS (
      SELECT trim(both '/' from lower($2::text)) AS t
    ),
    ${cte}_seg AS (
      SELECT s AS seg
      FROM regexp_split_to_table(trim(both '/' from lower($2::text)), '/') AS s
      WHERE length(s) >= 2
    )`;
}

/** 方法一致优先（未指定方法时该键恒为 1，不产生任何影响） */
function methodOrder(methodCol: string): string {
  return `CASE WHEN $4::text <> '' AND upper(coalesce(${methodCol}, '')) = upper($4::text) THEN 0 ELSE 1 END`;
}

const RANKED_CTE = rankedCte('url_q');

/**
 * 候选集查询：**一条 SQL** 取回命中任意路径段的行，并按精确度排好序。
 *
 * 旧实现是「按段循环」：每段一条 `ILIKE '%seg%' LIMIT 10`，**且没有 ORDER BY**。
 * Postgres 于是在物理顺序里随便给 10 行。查询 `/api/v1/users/:userId/profile`
 * 时，`%api%` 的 10 个名额很可能被别的文件占满，真正命中 4 个段的那条记录
 * 根本没进候选集 —— 表现为「明明索引里就有，搜出来却是空的」。
 *
 * 现在：候选集 = 命中任意一段的**全部**行，排序键按「方法一致 → 精确度档位 →
 * 命中段数 → 路径长度」，只截断排在最前面的若干条。
 */
async function queryRankedCandidates(
  db: Pool,
  repoId: number,
  target: string,
  queryMethod: string | null,
  mode: 'pattern' | 'usage'
): Promise<any[]> {
  const sql =
    mode === 'pattern'
      ? `${RANKED_CTE}
    SELECT up.id, up.pattern, up.normalized_pattern, up.method, up.definition_line,
           up.definition_code, f.path AS file_path,${rankedColumns('up.pattern', 'up.normalized_pattern')}
    FROM url_patterns up
    JOIN files f ON f.id = up.definition_file_id
    WHERE up.repo_id = $1 AND ${hitPredicate('up.pattern', 'up.normalized_pattern')}
    ORDER BY ${methodOrder('up.method')}, match_rank, seg_hits DESC,
             length(coalesce(up.normalized_pattern, up.pattern)),
             f.path, up.definition_line
    LIMIT $3`
      : `${RANKED_CTE}
    SELECT u.id,
           u.usage_line,
           u.usage_code,
           u.usage_context,
           u.http_method,
           f.path AS file_path,
           up.pattern,
           up.normalized_pattern,${rankedColumns('up.pattern', 'up.normalized_pattern')}
    FROM url_usages u
    JOIN url_patterns up ON up.id = u.url_pattern_id
    LEFT JOIN files f ON f.id = u.usage_file_id
    WHERE u.repo_id = $1 AND ${hitPredicate('up.pattern', 'up.normalized_pattern')}
    ORDER BY ${methodOrder('u.http_method')}, match_rank, seg_hits DESC,
             length(coalesce(up.normalized_pattern, up.pattern)),
             f.path, u.usage_line
    LIMIT $3`;

  const { rows } = await db.query(sql, [repoId, target, URL_CANDIDATE_LIMIT, queryMethod]);
  return rows;
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

  const methodMatch = fullURL.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
  const target = normalizeTarget(methodMatch ? fullURL.substring(methodMatch[0].length) : fullURL);
  const targetUrl = stripSlashes(target);
  const segments = usableSegments(pathSegments, target);

  // 策略 1: 段匹配常量 —— 一次查询取回候选集并按精确度排序
  //（旧实现按段循环、每段 `ILIKE` + `LIMIT 10` + 只按长度排序，
  //  候选集同样是「任意的 10 行」，长常量会把真正贴近查询的那条挤出去）
  const constRows = await db.query(
    `${rankedCte('url_c')}
      SELECT sc.id, sc.symbol_name, sc.string_value, sc.line_start, sc.line_end, sc.code,
             f.path AS file_path,
             ${rankedColumns('sc.string_value', 'sc.string_value', 'url_c')}
      FROM string_constants sc
      JOIN files f ON f.id = sc.file_id
      WHERE sc.repo_id = $1
        AND sc.constant_type = 'url_segment'
        AND ${hitPredicate('sc.string_value', 'sc.string_value', 'url_c')}
      ORDER BY match_rank, seg_hits DESC, length(sc.string_value)
      LIMIT $3`,
    [repoId, target, URL_CANDIDATE_LIMIT]
  );

  {
    for (const row of constRows.rows) {
      const stringValue = stripSlashes(row.string_value.toLowerCase());

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
        const matchCount = segments.filter(seg =>
          stringValue.includes(seg)
        ).length;
        score = segmentScore(0.7, segments, matchCount, stringValue);
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
  const target = normalizeTarget(urlWithoutMethod);

  // 一次性取回候选集（已按精确度排序），不再按段循环 + 无 ORDER BY 的 LIMIT
  const rows = await queryRankedCandidates(db, repoId, target, queryMethod, 'pattern');

  // 比较口径：两侧都去首尾斜杠后再比。
  // 入库的 normalized_pattern 没有首斜杠，而查询通常带（`/api/v1/users/:id`），
  // 老代码用原样字符串比较，于是「完全匹配」这条分支实际上从未命中过。
  const targetUrl = stripSlashes(target);
  const segments = usableSegments(pathSegments, target);

  for (const row of rows) {
    {
      const pattern = stripSlashes(row.pattern.toLowerCase());
      const normalizedPattern = stripSlashes((row.normalized_pattern || '').toLowerCase());
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
        const matchCount = segments.filter(seg =>
          pattern.includes(seg) || normalizedPattern.includes(seg)
        ).length;
        score = segmentScore(0.7, segments, matchCount, normalizedPattern || pattern);
        matchType = 'segment';
      }

      // HTTP 方法匹配调整分数
      if (queryMethod && patternMethod === queryMethod) {
        // 方法匹配：提升 20%
        score = Math.min(1.0, score * 1.2);
      }
      else if (queryMethod && patternMethod && patternMethod !== queryMethod) {
        // 方法不匹配：降低 50%
        score = score * 0.5;
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

  const methodMatch = fullURL.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
  const queryMethod = methodMatch ? methodMatch[1].toUpperCase() : null;
  const target = normalizeTarget(methodMatch ? fullURL.substring(methodMatch[0].length) : fullURL);
  const targetUrl = stripSlashes(target);
  const segments = usableSegments(pathSegments, target);

  // 策略 1: url_usages —— 索引期就标好的「这条接口出现在哪个文件哪一行」
  //
  // 这是**唯一精确**的使用位置来源：调用点两侧（客户端调用 / 路由定义）都在库里，
  // 还带 usage_context 能区分「谁在调」还是「谁在提供」。
  //
  // 老实现完全没用它，转而去 code_chunks 里 `code_text ILIKE '%api%'`
  // 再 `ORDER BY line_start LIMIT 20` —— 拿到的是「含 api 二字的最早 20 个代码块」，
  // 真正的调用点几乎必然被挤掉。这就是「索引里有、搜不出来」的另一半原因。
  try {
    const usageRows = await queryRankedCandidates(db, repoId, target, queryMethod, 'usage');
    for (const row of usageRows) {
      const line: number | null = row.usage_line;
      if (!line || !row.file_path) continue;

      const codeText = String(row.usage_code || row.pattern || '').toLowerCase();
      // 用「这一行的源码 + 它所属接口的规范化路径」一起评分。
      //
      // 只用源码会漏掉一整类使用点：常量拼接出来的路由，源码里一个路径字面量都没有
      //（`router.get(`${USER_BASE}`)`），只有解析后的 normalized_pattern 才知道它是
      // `/api/v1/users`。这类行的段命中数会算成 0、分数掉到 0，被排到 40 名开外。
      const normalizedPattern = String(row.normalized_pattern || '').toLowerCase();
      const haystack = `${codeText}\n${normalizedPattern}`;
      let score: number;
      if (stripSlashes(normalizedPattern) === targetUrl || codeText.includes(targetUrl)) {
        // 使用位置比「模式定义」更贴合「这个接口在哪被用」这个问题，给到 0.98
        score = 0.98;
      } else {
        const matchCount = segments.filter(seg => haystack.includes(seg)).length;
        score = segmentScore(0.8, segments, matchCount, normalizedPattern);
      }

      results.push({
        id: `usage:${row.id}`,
        type: 'usage',
        score,
        filePath: row.file_path,
        lineStart: line,
        lineEnd: line,
        content: row.usage_code || row.pattern || '',
        context: {
          method: row.http_method ?? null,
          usageContext: row.usage_context ?? undefined,
        },
      });
    }
  } catch (error) {
    console.error('Failed to search url_usages:', error);
  }

  // 策略 2: code_chunks 兜底 —— 覆盖 url_usages 里没有的写法
  //（例如路径被拼进中间变量，索引期的使用点识别没覆盖到）
  // 同样改成「一次查询 + 按命中段数排序」，并且要求命中至少一半的段，
  // 否则 `%api%` 这类泛段会把整个仓库的代码块都拉进来。
  if (segments.length > 0) {
    try {
      const chunkQuery = `
        WITH url_q_seg AS (
          SELECT s AS seg
          FROM regexp_split_to_table($2::text, '/') AS s
          WHERE length(s) >= 2
        )
        SELECT c.id, c.code_text, c.line_start, c.line_end, f.path AS file_path,
               (SELECT count(*) FROM url_q_seg WHERE position(seg in lower(c.code_text)) > 0) AS seg_hits
        FROM code_chunks c
        JOIN files f ON f.id = c.file_id
        WHERE f.repo_id = $1
          AND (SELECT count(*) FROM url_q_seg WHERE position(seg in lower(c.code_text)) > 0)
              >= GREATEST(2, ceil((SELECT count(*) FROM url_q_seg)::numeric / 2))
        ORDER BY seg_hits DESC, length(c.code_text)
        LIMIT $3
      `;
      const chunkRows = await db.query(chunkQuery, [repoId, segments.join('/'), 10]);
      for (const row of chunkRows.rows) {
        const codeText = String(row.code_text || '').toLowerCase();
        const matchCount = segments.filter(seg => codeText.includes(seg)).length;
        results.push({
          id: `usage:chunk:${row.id}`,
          type: 'usage',
          // 兜底策略，分数刻意压在 url_usages（段匹配 0.53 起）之下：
          // 它是「这行源码里出现了同样的路径段」，定位精度天然不如
          // 「这一行就是某个已知接口的使用点」。给高了会把 40 个位置
          // 铺满同文件的邻近代码块，把真正的那几行挤出去。
          score: codeText.includes(targetUrl) ? 0.6 : 0.5 * (matchCount / Math.max(segments.length, 1)),
          filePath: row.file_path,
          lineStart: row.line_start,
          lineEnd: row.line_end,
          content: row.code_text,
          context: {},
        });
      }
    } catch (error) {
      console.error('Failed to search url usage chunks:', error);
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
// ============================================
// 关联层：跨过程落点 / 版本家族 / 模板句柄
// ============================================

/**
 * 关联层条数上限。
 *
 * 关联结果按构造就是「越多越全」，必须封顶：一个被几十个业务方法调用的接口，
 * `indirect_call` 能一次召回上百条，把响应撑爆、也把「直接命中」淹掉。
 * 30 是在「够用于追溯调用方」与「不喧宾夺主」之间取的阈值。
 */
const RELATED_LIMIT = 30;

/** 该段是不是占位符（`:id` / `${id}`） */
function isPlaceholderSeg(seg: string): boolean {
  const s = seg.trim();
  return s.startsWith(':') || s.includes('${');
}

/** 查询里的「实义字面段」——占位符段没有区分能力，不参与计数 */
function literalQuerySegments(querySegs: string[]): string[] {
  return querySegs
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2 && !isPlaceholderSeg(s));
}

/** 查询里出现了具体版本号段（v1 / v2 / …） */
function hasVersionSegment(querySegs: string[]): boolean {
  return querySegs.some((s) => /^v\d+$/.test(s.trim().toLowerCase()));
}

/** 查询本身是模板形式（带 `:param` / `${...}`） */
function isTemplateQuery(target: string): boolean {
  return /[:$]\{?[A-Za-z_][\w$]*/.test(target);
}

/** 候选模式的某一段是不是「版本占位」（版本循环里生成的 `/api/${version}/...`） */
function versionFamilyMatch(querySegs: string[], patternValue: string): boolean {
  if (!hasVersionSegment(querySegs)) return false;
  const cand = usableSegments([], patternValue);
  const n = Math.min(querySegs.length, cand.length);
  for (let i = 0; i < n; i++) {
    if (/^v\d+$/.test(querySegs[i].trim().toLowerCase()) && isPlaceholderSeg(cand[i])) return true;
  }
  return false;
}

/**
 * 关联层召回。
 *
 * 三类，全部**低分且带标签**，由 `searchURL` 追加在直接命中之后：
 *
 * 1. `indirect_call`｜间接调用
 *    业务方法调用了封装方法，因而会请求到这个接口。落点在**调用行**上。
 *    判定：与该接口的路径共享 >= 2 个实义字面段（`api` 这种通用段必须再搭一个
 *    区分性段才算数，否则 `/api/...` 会把全仓都召回）。
 *
 * 2. `template_helper`｜模板句柄
 *    路径模板处理器（如 `fromTemplate(template, params)`）——它自己不产出路径，
 *    返回的就是入参。查询本身是模板形式时就该把它带出来，因为「所有模板路径
 *    都靠它解析」。
 *
 * 3. `version_family`｜版本家族
 *    查询带具体版本段（`/api/v2/...`）而候选同位是 `${version}` 占位时，
 *    说明该版本路由不是手写的、而是版本循环生成的 —— 这正是「为什么搜不到
 *    `/api/v2/products/:id` 的字面路由」的答案。
 *
 * @param existing - 已经返回的直接命中，用于去重（同一 file+line 不重复出现）
 */
async function searchURLRelated(
  db: Pool,
  repoId: number,
  target: string,
  querySegs: string[],
  existing: URLSearchResult[]
): Promise<URLSearchResult[]> {
  const out: URLSearchResult[] = [];
  const seen = new Set(existing.map((r) => `${r.filePath}\u0000${r.lineStart}`));
  const lits = literalQuerySegments(querySegs);
  const push = (r: URLSearchResult) => {
    const key = `${r.filePath}\u0000${r.lineStart}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };

  // -------- ① / ② 跨过程落点（url_usages 里的 indirect_call / template_helper）
  try {
    const like = lits.map((s) => `%${s}%`);
    const rows = await db.query(
      `
      SELECT f.path AS file_path, u.usage_line, u.usage_code, u.usage_context,
             p.pattern, p.normalized_pattern, p.method
      FROM url_usages u
      JOIN url_patterns p ON p.id = u.url_pattern_id
      LEFT JOIN files f ON f.id = u.usage_file_id
      WHERE u.repo_id = $1
        AND u.usage_context IN ('indirect_call', 'template_helper')
        AND (
          $2::text[] IS NULL
          OR p.pattern ILIKE ANY($2::text[])
          OR coalesce(p.normalized_pattern, '') ILIKE ANY($2::text[])
        )
      ORDER BY f.path, u.usage_line
      LIMIT 400
      `,
      [repoId, like.length > 0 ? like : null]
    );

    for (const r of rows.rows) {
      const kind = String(r.usage_context);
      const pat = String(r.pattern ?? '');
      const norm = String(r.normalized_pattern ?? '');
      const hay = `${pat} ${norm}`.toLowerCase();
      const shared = lits.filter((s) => hay.includes(s)).length;

      let score: number | null = null;
      if (kind === 'indirect_call' && shared >= 2) score = 0.35;
      else if (kind === 'template_helper' && isTemplateQuery(target)) score = 0.3;
      if (score === null) continue;

      const filePath = String(r.file_path ?? '');
      const line = Number(r.usage_line ?? 0);
      if (!filePath || !line) continue;
      push({
        id: `related-${kind}-${filePath}-${line}`,
        type: 'usage',
        score,
        filePath,
        lineStart: line,
        lineEnd: line,
        content: String(r.usage_code ?? pat),
        context: {
          usageContext: kind,
          relatedKind: kind,
          method: r.method ?? null,
          constantValue: pat,
        },
      });
    }
  } catch (error) {
    console.error('URL related (cross-procedure) failed:', error);
  }

  // -------- ③ 版本家族
  if (hasVersionSegment(querySegs)) {
    try {
      const rows = await db.query(
        `
        SELECT p.id, p.pattern, p.normalized_pattern, p.method, p.definition_line,
               p.definition_code, f.path AS file_path
        FROM url_patterns p
        LEFT JOIN files f ON f.id = p.definition_file_id
        WHERE p.repo_id = $1
        `,
        [repoId]
      );
      for (const r of rows.rows) {
        const pat = String(r.pattern ?? '');
        if (!versionFamilyMatch(querySegs, pat)) continue;
        const filePath = String(r.file_path ?? '');
        const line = Number(r.definition_line ?? 0);
        if (!filePath || !line) continue;
        push({
          id: `related-version_family-${r.id}`,
          type: 'pattern',
          score: 0.28,
          filePath,
          lineStart: line,
          lineEnd: line,
          content: String(r.definition_code ?? pat),
          context: {
            usageContext: 'version_family',
            relatedKind: 'version_family',
            method: r.method ?? null,
            constantValue: pat,
          },
        });
      }
    } catch (error) {
      console.error('URL related (version family) failed:', error);
    }
  }

  return out
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath) || a.lineStart - b.lineStart)
    .slice(0, RELATED_LIMIT);
}

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
      //
      // ⚠️ `deriveURLConstruction` 返回的 confidence 是 **0-100**，而
      // pattern/usage/constant 三条策略都是 0-1。原样混在一起再按 score 排序，
      // 等于「所有 derivation 结果无条件压过所有精确命中」——
      // 于是 `/api/users` 这类查询里，真正对的路由定义行会被
      // confidence=100 的推导链挤出 top-20，表现为「索引里有、搜出来没有」。
      // 这里先归一到 0-1，让四条策略在同一把尺子上比较。
      let score = derivation.confidence / 100;

      // HTTP 方法匹配调整分数
      if (queryMethod && patternMethod === queryMethod) {
        // 方法匹配：提升 20%
        score = Math.min(1, score * 1.2);
      }
      else if (queryMethod && patternMethod && patternMethod !== queryMethod) {
        // 方法不匹配：降低 50%
        score = score * 0.5;
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
