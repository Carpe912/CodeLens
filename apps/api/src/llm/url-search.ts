/**
 * URL Search - Specialized search for URLs and API endpoints
 *
 * This module handles searching for URLs that are dynamically constructed
 * from constants, template strings, and function calls.
 */

import { Pool } from 'pg';
import { generateEmbedding } from './embeddings.js';
import { matchURLTemplate, isTemplate, calculateURLSimilarity } from './url-template-matcher.js';
import { parseQueryIntent, ParsedIntent } from './query-intent-parser.js';
import { deriveURLConstruction } from './url-derivation.js';

export interface URLSearchResult {
  id: string;
  type: 'constant' | 'pattern' | 'usage' | 'chunk' | 'template' | 'derivation';
  score: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  context: {
    constantName?: string;
    constantValue?: string;
    method?: string | null;
    templateMatch?: {
      template: string;
      extractedParams: Record<string, string>;
    };
    usageChain?: Array<{ file: string; line: number; code: string }>;
  };
}

/**
 * Search for URLs by extracting path segments and searching across:
 * 1. String constants (URL templates)
 * 2. URL patterns (extracted during indexing)
 * 3. Code chunks (vector search for semantic matching)
 *
 * 支持自然语言意图：
 * - "/api/users 位置" -> 查找调用位置
 * - "/api/users 定义" -> 查找定义位置
 */
export async function searchURL(
  db: Pool,
  repoId: number,
  urlQuery: string,
  limit = 20
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // 1. 解析用户意图
  const intent = parseQueryIntent(urlQuery);
  console.log(`🔍 Parsed intent:`, {
    target: intent.target,
    action: intent.action,
    original: intent.originalQuery
  });

  // 2. 提取 URL 的路径段（使用解析后的 target，而不是原始 query）
  const pathSegments = extractPathSegments(intent.target);
  console.log(`URL search: extracted segments: ${pathSegments.join(', ')}`);

  // 3. 根据用户意图选择搜索策略
  if (intent.action === 'find_usages') {
    // 用户想找调用位置 - 优先搜索 URL patterns 和使用位置
    console.log('🎯 User wants to find usages, prioritizing URL patterns...');

    // Strategy 1: Search URL patterns table (highest priority)
    const patternResults = await searchURLPatterns(db, repoId, pathSegments, intent.target);
    results.push(...patternResults);

    // Strategy 2: Search for usages in code chunks
    const usageResults = await searchURLUsages(db, repoId, pathSegments, intent.target);
    results.push(...usageResults);

    // Strategy 3: Search string constants (lower priority)
    const constantResults = await searchURLConstants(db, repoId, pathSegments, intent.target);
    results.push(...constantResults);

  } else if (intent.action === 'find_definition') {
    // 用户想找定义位置 - 优先搜索 string constants
    console.log('🎯 User wants to find definitions, prioritizing constants...');

    const constantResults = await searchURLConstants(db, repoId, pathSegments, intent.target);
    results.push(...constantResults);

    const patternResults = await searchURLPatterns(db, repoId, pathSegments, intent.target);
    results.push(...patternResults);

  } else {
    // 通用搜索 - 使用原有的策略
    console.log('🎯 General search, using all strategies...');

    // Strategy 1: Search string constants for URL patterns
    const constantResults = await searchURLConstants(db, repoId, pathSegments, intent.target);
    results.push(...constantResults);

    // Strategy 2: Search URL patterns table
    const patternResults = await searchURLPatterns(db, repoId, pathSegments, intent.target);
    results.push(...patternResults);

    // Strategy 3: Derive URL construction from functions and constants
    const derivationResults = await searchURLDerivation(db, repoId, intent.target);
    results.push(...derivationResults);

    // Strategy 4: Vector search for semantic matching
    const vectorResults = await searchURLVector(db, repoId, intent.target);
    results.push(...vectorResults);
  }

  // Deduplicate and sort by score
  const deduped = deduplicateResults(results);
  const sorted = deduped.sort((a, b) => b.score - a.score);

  // Enrich top results with usage information
  const topResults = sorted.slice(0, limit);
  await enrichWithUsages(db, repoId, topResults);

  return topResults;
}

/**
 * Extract meaningful path segments from a URL
 * 注意：此函数现在接收的是已经清理过的 URL（由 parseQueryIntent 处理）
 */
function extractPathSegments(url: string): string[] {
  // Remove protocol and domain
  let path = url.replace(/^https?:\/\/[^\/]+/, '');

  // Remove query string and hash
  path = path.split('?')[0].split('#')[0];

  // Split by / and map segments, replacing IDs with placeholders to preserve structure
  const segments = path.split('/').map(seg => {
    if (!seg) return null;

    // Replace pure numeric IDs with :id placeholder
    if (/^\d+$/.test(seg)) return ':id';

    // Replace long hex strings (SHA, tokens, etc.) with :token
    if (/^[0-9a-f]{20,}$/i.test(seg)) return ':token';

    // Replace UUIDs with :uuid
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';

    // Replace MongoDB ObjectIds (24 hex chars) with :id
    if (/^[0-9a-f]{24}$/i.test(seg)) return ':id';

    // Keep common API path segments even if short
    const commonSegments = ['api', 'v1', 'v2', 'v3', 'v4', 'v5', 'app', 'web', 'p'];
    if (commonSegments.includes(seg.toLowerCase())) return seg;

    // Skip short random strings (likely IDs) - but only if not a common segment
    if (seg.length <= 2 && /^[a-z0-9]+$/i.test(seg)) return null;

    return seg;
  }).filter(seg => seg !== null) as string[];

  return segments;
}

/**
 * Search string constants for URL patterns
 */
async function searchURLConstants(
  db: Pool,
  repoId: number,
  pathSegments: string[],
  fullURL: string
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // Strategy 1: Exact segment matching
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

      // 1. 完全匹配（最高优先级）
      if (stringValue === targetUrl) {
        score = 1.0;
      }
      // 2. 包含完整目标 URL（高优先级）
      else if (stringValue.includes(targetUrl)) {
        score = 0.95;
      }
      // 3. 目标 URL 包含此常量（中等优先级）
      else if (targetUrl.includes(stringValue)) {
        score = 0.85;
      }
      // 4. 部分段匹配（较低优先级）
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

  // Strategy 2: Template matching for dynamic URLs
  // Search for all URL constants and try template matching
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
    // Check if this is a template
    if (isTemplate(row.string_value)) {
      // Try to match the template against the query URL
      const match = matchURLTemplate(fullURL, row.string_value);

      if (match && match.score > 0.5) {
        results.push({
          id: `template:${row.id}`,
          type: 'template',
          score: 0.95 * match.score, // High score for template matches
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

  // Strategy 3: Fuzzy similarity matching
  // For cases where template matching fails but URLs are similar
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
      // Check if we already have this result
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
 * Search URL patterns table
 */
async function searchURLPatterns(
  db: Pool,
  repoId: number,
  pathSegments: string[],
  fullURL: string
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // Extract HTTP method from query if present (e.g., "GET /api/users/:id")
  const methodMatch = fullURL.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
  const queryMethod = methodMatch ? methodMatch[1].toUpperCase() : null;
  const urlWithoutMethod = methodMatch ? fullURL.substring(methodMatch[0].length) : fullURL;

  // Search for patterns matching the segments
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

      // 1. 完全匹配（最高优先级）
      if (pattern === targetUrl || normalizedPattern === targetUrl) {
        score = 1.0;
        matchType = 'exact';
      }
      // 2. 包含完整目标 URL（高优先级）
      else if (pattern.includes(targetUrl) || normalizedPattern.includes(targetUrl)) {
        score = 0.95;
        matchType = 'contains_full';
      }
      // 3. 目标 URL 包含此模式（中等优先级）
      else if (targetUrl.includes(pattern) || (normalizedPattern && targetUrl.includes(normalizedPattern))) {
        score = 0.85;
        matchType = 'contained_in';
      }
      // 4. 部分段匹配（较低优先级）
      else {
        const matchCount = pathSegments.filter(seg =>
          pattern.includes(seg.toLowerCase()) || normalizedPattern.includes(seg.toLowerCase())
        ).length;
        score = 0.7 * (matchCount / pathSegments.length);
        matchType = 'segment';
      }

      // Boost score if HTTP method matches
      if (queryMethod && patternMethod === queryMethod) {
        score = Math.min(1.0, score * 1.2); // 20% boost for method match
        console.log(`[URL Search] Method match boost: ${patternMethod} ${pattern} -> score ${score}`);
      }
      // Penalize if HTTP method doesn't match (when query specifies a method)
      else if (queryMethod && patternMethod && patternMethod !== queryMethod) {
        score = score * 0.5; // 50% penalty for method mismatch
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
 * Search for URL usages in code chunks
 * 专门用于查找 URL 的调用位置
 */
async function searchURLUsages(
  db: Pool,
  repoId: number,
  pathSegments: string[],
  fullURL: string
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // Strategy 1: Search in code_chunks for URL usage patterns
  // Look for common patterns like: fetch('/api/users'), axios.get('/api/users'), etc.
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

      // 1. 完全匹配（最高优先级）
      if (codeText.includes(targetUrl)) {
        score = 0.95;
      }
      // 2. 部分段匹配（较低优先级）
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
 * Vector search for semantic matching
 */
async function searchURLVector(
  db: Pool,
  repoId: number,
  urlQuery: string
): Promise<URLSearchResult[]> {
  try {
    // Generate embedding for the URL
    const embedding = await generateEmbedding(urlQuery);
    const embeddingVector = `[${embedding.join(',')}]`;

    // Search in string_constants with embeddings
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
      score: row.similarity * 0.8, // Slightly lower weight for vector search
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
 * Deduplicate results by file path and line number
 */
function deduplicateResults(results: URLSearchResult[]): URLSearchResult[] {
  const seen = new Map<string, URLSearchResult>();

  for (const result of results) {
    const key = `${result.filePath}:${result.lineStart}`;
    const existing = seen.get(key);

    if (!existing || result.score > existing.score) {
      seen.set(key, result);
    }
  }

  return Array.from(seen.values());
}

/**
 * Enrich results with usage information
 */
async function enrichWithUsages(
  db: Pool,
  repoId: number,
  results: URLSearchResult[]
): Promise<void> {
  for (const result of results) {
    if (result.type !== 'constant' || !result.context.constantName) {
      continue;
    }

    // Find where this constant is used
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
          code: row.code_text.slice(0, 200),
        }));
      }
    } catch (error) {
      console.error('Failed to fetch usages:', error);
    }
  }
}

/**
 * Search for URL construction chains using derivation analysis
 */
async function searchURLDerivation(
  db: Pool,
  repoId: number,
  targetUrl: string
): Promise<URLSearchResult[]> {
  try {
    // Extract HTTP method from query if present
    const methodMatch = targetUrl.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
    const queryMethod = methodMatch ? methodMatch[1].toUpperCase() : null;
    const urlWithoutMethod = methodMatch ? targetUrl.substring(methodMatch[0].length) : targetUrl;

    const derivations = await deriveURLConstruction(db, repoId, urlWithoutMethod);

    // Enrich derivations with HTTP method from url_patterns table
    const results: URLSearchResult[] = [];

    for (const [index, derivation] of derivations.entries()) {
      const filePath = derivation.symbolChain[0]?.file || '';
      const lineStart = derivation.symbolChain[0]?.line || 0;

      // Try to find HTTP method from url_patterns table
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

      // Calculate score with method matching
      let score = derivation.confidence;

      // Boost score if HTTP method matches
      if (queryMethod && patternMethod === queryMethod) {
        score = Math.min(100, score * 1.2); // 20% boost for method match
        console.log(`[URL Derivation] Method match boost: ${patternMethod} ${derivation.pattern} -> score ${score}`);
      }
      // Penalize if HTTP method doesn't match (when query specifies a method)
      else if (queryMethod && patternMethod && patternMethod !== queryMethod) {
        score = score * 0.5; // 50% penalty for method mismatch
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
