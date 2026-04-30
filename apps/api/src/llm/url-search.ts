/**
 * URL Search - Specialized search for URLs and API endpoints
 *
 * This module handles searching for URLs that are dynamically constructed
 * from constants, template strings, and function calls.
 */

import { Pool } from 'pg';
import { generateEmbedding } from './embeddings.js';
import { matchURLTemplate, isTemplate, calculateURLSimilarity } from './url-template-matcher.js';

export interface URLSearchResult {
  id: string;
  type: 'constant' | 'pattern' | 'usage' | 'chunk' | 'template';
  score: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  context: {
    constantName?: string;
    constantValue?: string;
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
 */
export async function searchURL(
  db: Pool,
  repoId: number,
  urlQuery: string,
  limit = 20
): Promise<URLSearchResult[]> {
  const results: URLSearchResult[] = [];

  // Extract path segments from the URL
  const pathSegments = extractPathSegments(urlQuery);
  console.log(`URL search: extracted segments: ${pathSegments.join(', ')}`);

  // Strategy 1: Search string constants for URL patterns
  const constantResults = await searchURLConstants(db, repoId, pathSegments, urlQuery);
  results.push(...constantResults);

  // Strategy 2: Search URL patterns table
  const patternResults = await searchURLPatterns(db, repoId, pathSegments, urlQuery);
  results.push(...patternResults);

  // Strategy 3: Vector search for semantic matching
  const vectorResults = await searchURLVector(db, repoId, urlQuery);
  results.push(...vectorResults);

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
 */
function extractPathSegments(url: string): string[] {
  // Remove protocol and domain
  let path = url.replace(/^https?:\/\/[^\/]+/, '');

  // Split by / and filter out empty segments and IDs
  const segments = path.split('/').filter(seg => {
    if (!seg) return false;
    // Skip segments that look like IDs (long hex strings, UUIDs, etc.)
    if (/^[0-9a-f]{20,}$/i.test(seg)) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return false;
    return true;
  });

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
      // Calculate score based on how many segments match
      const matchCount = pathSegments.filter(seg =>
        row.string_value.toLowerCase().includes(seg.toLowerCase())
      ).length;
      const score = 0.9 * (matchCount / pathSegments.length);

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

  // Search for patterns matching the segments
  for (const segment of pathSegments) {
    const query = `
      SELECT
        up.id,
        up.pattern,
        up.normalized_pattern,
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
      const matchCount = pathSegments.filter(seg =>
        row.pattern.toLowerCase().includes(seg.toLowerCase()) ||
        row.normalized_pattern?.toLowerCase().includes(seg.toLowerCase())
      ).length;
      const score = 0.95 * (matchCount / pathSegments.length);

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
        },
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
