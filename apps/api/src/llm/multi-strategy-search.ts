/**
 * Multi-Strategy Search Engine - Combines multiple search strategies for optimal results
 *
 * This module implements 5 search strategies:
 * 1. Vector similarity search (semantic)
 * 2. Exact pattern matching (literal)
 * 3. Fuzzy text search (typo-tolerant)
 * 4. Dependency-aware search (follows imports)
 * 5. Graph-based search (call graph traversal)
 */

import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { DependencyTracker } from '../indexer/dependency-tracker.js';

// ============================================
// Type Definitions
// ============================================

export interface SearchResult {
  id: string;
  type: 'constant' | 'function' | 'class' | 'url' | 'chunk';
  score: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  context: SearchContext;
  metadata: Record<string, any>;
}

export interface SearchContext {
  fileName: string;
  symbolName?: string;
  parentSymbol?: string;
  imports?: string[];
  usages?: Array<{ file: string; line: number }>;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  strategies?: SearchStrategy[];
  includeContext?: boolean;
  followDependencies?: boolean;
}

export type SearchStrategy = 'vector' | 'exact' | 'fuzzy' | 'dependency' | 'graph';

export interface QueryIntent {
  type: 'url' | 'constant' | 'function' | 'class' | 'general';
  confidence: number;
  keywords: string[];
  filters: Record<string, any>;
}

// ============================================
// Multi-Strategy Search Engine
// ============================================

export class MultiStrategySearch {
  private dependencyTracker: DependencyTracker;
  private anthropic: Anthropic;

  constructor(private db: Pool, anthropicApiKey: string) {
    this.dependencyTracker = new DependencyTracker(db);
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
  }

  /**
   * Main search entry point - automatically selects best strategies
   */
  async search(repoId: number, query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      limit = 20,
      threshold = 0.5,
      strategies = ['vector', 'exact', 'fuzzy'],
      includeContext = true,
      followDependencies = false,
    } = options;

    // Analyze query intent
    const intent = await this.analyzeQueryIntent(query);

    // Select optimal strategies based on intent
    const selectedStrategies = this.selectStrategies(intent, strategies);

    // Execute searches in parallel
    const searchResults = await Promise.all(
      selectedStrategies.map((strategy) => this.executeStrategy(repoId, query, intent, strategy, limit))
    );

    // Merge and rank results
    const mergedResults = this.mergeResults(searchResults, intent);

    // Filter by threshold
    const filteredResults = mergedResults.filter((r) => r.score >= threshold);

    // Add context if requested
    if (includeContext) {
      await this.enrichWithContext(repoId, filteredResults);
    }

    // Follow dependencies if requested
    if (followDependencies) {
      await this.expandWithDependencies(repoId, filteredResults);
    }

    // Return top results
    return filteredResults.slice(0, limit);
  }

  /**
   * Analyze query to determine intent and extract keywords
   */
  private async analyzeQueryIntent(query: string): Promise<QueryIntent> {
    // URL patterns
    if (query.match(/\/(api|rest|v\d+)\/|:\w+|\/\{/i)) {
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

    // General search
    return {
      type: 'general',
      confidence: 0.5,
      keywords: query.split(/\s+/).filter((k) => k.length > 2),
      filters: {},
    };
  }

  /**
   * Extract keywords from URL query
   */
  private extractURLKeywords(query: string): string[] {
    const keywords: string[] = [];

    // Extract path segments
    const segments = query.split('/').filter((s) => s && !s.match(/^:\w+$/));
    keywords.push(...segments);

    // Extract parameter names
    const params = query.match(/:(\w+)/g);
    if (params) {
      keywords.push(...params.map((p) => p.slice(1)));
    }

    return keywords;
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
    const queryEmbedding = await this.generateEmbedding(query);
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
        similarity(cc.content, $2) as sim_score
      FROM code_chunks cc
      JOIN files f ON cc.file_id = f.id
      WHERE cc.repo_id = $1
        AND cc.content % $2
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
          cc.content,
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
          cc.content,
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
      } else {
        content = row.content || '';
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
   * Expand results with dependency information
   */
  private async expandWithDependencies(repoId: number, results: SearchResult[]): Promise<void> {
    // This would add related files through dependency chains
    // Implementation depends on specific requirements
  }

  /**
   * Generate embedding for query
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch('https://api.anthropic.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': (this.anthropic as any).apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'text-embedding-v4',
        input: text.slice(0, 8000),
      }),
    });

    const data = await response.json() as any;
    return data.embedding;
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
