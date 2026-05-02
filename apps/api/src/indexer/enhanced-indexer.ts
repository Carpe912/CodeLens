/**
 * Enhanced Indexer - Main indexing pipeline with AST analysis and relationship building
 *
 * This module orchestrates the complete indexing process:
 * 1. Parse files with AST analyzer
 * 2. Extract entities (constants, functions, classes, URLs)
 * 3. Generate embeddings with text-embedding-v4
 * 4. Build relationships (imports, references, calls)
 * 5. Store everything in the database
 */

import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { ASTAnalyzer, ASTAnalysisResult } from './ast-analyzer.js';
import { RelationshipBuilder } from './relationship-builder.js';
import { generateEmbedding } from '../llm/embeddings.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================
// Type Definitions
// ============================================

export interface IndexingProgress {
  totalFiles: number;
  processedFiles: number;
  entitiesExtracted: number;
  relationshipsBuilt: number;
  errors: number;
}

export interface IndexingOptions {
  batchSize?: number;
  skipEmbeddings?: boolean;
  onProgress?: (progress: IndexingProgress) => void;
}

// ============================================
// Enhanced Indexer Class
// ============================================

export class EnhancedIndexer {
  private astAnalyzer: ASTAnalyzer;
  private relationshipBuilder: RelationshipBuilder;
  private anthropic: Anthropic;

  constructor(private db: Pool, anthropicApiKey: string) {
    this.astAnalyzer = new ASTAnalyzer();
    this.relationshipBuilder = new RelationshipBuilder(db);
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
  }

  /**
   * Index a single file with full AST analysis
   */
  async indexFile(repoId: number, fileId: number, filePath: string, content: string): Promise<void> {
    console.log(`Indexing file: ${filePath}`);

    try {
      // Step 1: Parse with AST analyzer
      const astResult = await this.astAnalyzer.analyzeFile(filePath, content);

      // Step 2: Store entities in database
      await this.storeEntities(repoId, fileId, filePath, astResult);

      // Step 3: Generate embeddings for entities
      await this.generateEmbeddings(repoId, fileId, astResult);

      // Step 4: Build relationships
      await this.relationshipBuilder.buildRelationships(repoId, fileId, filePath, astResult);

      console.log(`✓ Indexed ${filePath}`);
    } catch (error) {
      console.error(`✗ Error indexing ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Index multiple files in batch
   */
  async indexFiles(
    repoId: number,
    files: Array<{ id: number; path: string; content: string }>,
    options: IndexingOptions = {}
  ): Promise<IndexingProgress> {
    const { batchSize = 3, onProgress } = options;

    const progress: IndexingProgress = {
      totalFiles: files.length,
      processedFiles: 0,
      entitiesExtracted: 0,
      relationshipsBuilt: 0,
      errors: 0,
    };

    // Process files in batches
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (file) => {
          try {
            await this.indexFile(repoId, file.id, file.path, file.content);
            progress.processedFiles++;
          } catch (error) {
            progress.errors++;
            console.error(`Error indexing ${file.path}:`, error);
          }

          if (onProgress) {
            onProgress(progress);
          }
        })
      );
    }

    return progress;
  }

  /**
   * Store extracted entities in the database
   */
  private async storeEntities(
    repoId: number,
    fileId: number,
    filePath: string,
    astResult: ASTAnalysisResult
  ): Promise<void> {
    await this.db.query('BEGIN');

    try {
      // Store string constants
      for (const constant of astResult.stringConstants) {
        await this.db.query(
          `
          INSERT INTO string_constants (
            repo_id,
            file_id,
            symbol_name,
            string_value,
            constant_type,
            line_start,
            line_end,
            parent_object,
            export_type,
            code
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

      // Store functions
      for (const func of astResult.functions) {
        await this.db.query(
          `
          INSERT INTO functions (
            repo_id,
            file_id,
            name,
            full_name,
            signature,
            return_type,
            function_type,
            visibility,
            is_async,
            is_exported,
            parameters,
            cyclomatic_complexity,
            lines_of_code,
            line_start,
            line_end,
            code
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

      // Store classes
      for (const cls of astResult.classes) {
        await this.db.query(
          `
          INSERT INTO classes (
            repo_id,
            file_id,
            name,
            full_name,
            class_type,
            extends_class,
            implements_interfaces,
            properties,
            methods,
            decorators,
            line_start,
            line_end,
            code
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

      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  /**
   * Query existing embeddings to avoid regenerating them
   */
  private async getExistingEmbeddings(repoId: number, fileId: number): Promise<Set<string>> {
    const existing = new Set<string>();

    try {
      // Query string_constants with embeddings
      const constantsResult = await this.db.query(
        `SELECT symbol_name, line_start FROM string_constants
         WHERE repo_id = $1 AND file_id = $2 AND embedding IS NOT NULL`,
        [repoId, fileId]
      );
      for (const row of constantsResult.rows) {
        existing.add(`constant:${row.symbol_name}:${row.line_start}`);
      }

      // Query functions with embeddings
      const functionsResult = await this.db.query(
        `SELECT full_name, line_start FROM functions
         WHERE repo_id = $1 AND file_id = $2 AND embedding IS NOT NULL`,
        [repoId, fileId]
      );
      for (const row of functionsResult.rows) {
        existing.add(`function:${row.full_name}:${row.line_start}`);
      }

      // Query classes with embeddings
      const classesResult = await this.db.query(
        `SELECT full_name, line_start FROM classes
         WHERE repo_id = $1 AND file_id = $2 AND embedding IS NOT NULL`,
        [repoId, fileId]
      );
      for (const row of classesResult.rows) {
        existing.add(`class:${row.full_name}:${row.line_start}`);
      }

      // Query urls with embeddings
      const urlsResult = await this.db.query(
        `SELECT normalized_pattern, definition_line FROM urls
         WHERE repo_id = $1 AND file_id = $2 AND embedding IS NOT NULL`,
        [repoId, fileId]
      );
      for (const row of urlsResult.rows) {
        existing.add(`url:${row.normalized_pattern}:${row.definition_line}`);
      }

      console.log(`Found ${existing.size} existing embeddings for file ${fileId}`);
    } catch (error) {
      console.error('Error querying existing embeddings:', error);
    }

    return existing;
  }

  /**
   * Generate embeddings for all entities using text-embedding-v4
   */
  private async generateEmbeddings(repoId: number, fileId: number, astResult: ASTAnalysisResult): Promise<void> {
    const embeddingTasks: Array<{ type: string; id: string; text: string }> = [];

    // Query existing embeddings to skip already processed items
    const existingEmbeddings = await this.getExistingEmbeddings(repoId, fileId);

    // Prepare embedding tasks for constants
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

    // Prepare embedding tasks for functions
    for (const func of astResult.functions) {
      const key = `function:${func.fullName}:${func.lineStart}`;
      if (!existingEmbeddings.has(key)) {
        embeddingTasks.push({
          type: 'function',
          id: `${func.fullName}:${func.lineStart}`,
          text: `${func.signature}\n${func.code.slice(0, 500)}`, // Limit to 500 chars
        });
      }
    }

    // Prepare embedding tasks for classes
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

    // Prepare embedding tasks for URL patterns
    for (const url of astResult.urlPatterns) {
      const key = `url:${url.normalizedPattern}:${url.definitionLine}`;
      if (!existingEmbeddings.has(key)) {
        embeddingTasks.push({
          type: 'url',
          id: `${url.normalizedPattern}:${url.definitionLine}`,
          text: `${url.method || 'HTTP'} ${url.pattern}\n${url.definitionCode}`,
        });
      }
    }

    // Skip if all embeddings already exist
    if (embeddingTasks.length === 0) {
      console.log(`All embeddings already exist for file ${fileId}, skipping...`);
      return;
    }

    console.log(`Generating ${embeddingTasks.length} new embeddings for file ${fileId}...`);

    // Generate embeddings in batches and collect results
    const batchSize = 5;
    const embeddingResults: Array<{ type: string; id: string; embedding: number[] }> = [];

    for (let i = 0; i < embeddingTasks.length; i += batchSize) {
      const batch = embeddingTasks.slice(i, i + batchSize);

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

      embeddingResults.push(...results.filter((r): r is { type: string; id: string; embedding: number[] } => r !== null));
    }

    // Batch store embeddings by type
    await this.batchStoreEmbeddings(repoId, fileId, embeddingResults);
  }

  /**
   * Generate a single embedding using the configured embedding model
   * Uses the existing embeddings.ts implementation which supports OpenAI-compatible APIs
   */
  private async generateEmbeddingVector(text: string): Promise<number[]> {
    try {
      // Use the existing embedding implementation from embeddings.ts
      // This supports OpenAI-compatible APIs like DashScope (Alibaba Cloud)
      return await generateEmbedding(text.slice(0, 8000));
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * Batch store embeddings by type to reduce database round trips
   */
  private async batchStoreEmbeddings(
    repoId: number,
    fileId: number,
    results: Array<{ type: string; id: string; embedding: number[] }>
  ): Promise<void> {
    // Group by type
    const byType = new Map<string, Array<{ id: string; embedding: number[] }>>();
    for (const result of results) {
      if (!byType.has(result.type)) {
        byType.set(result.type, []);
      }
      byType.get(result.type)!.push({ id: result.id, embedding: result.embedding });
    }

    // Batch update each type
    for (const [type, items] of byType.entries()) {
      try {
        await this.batchUpdateEmbeddingsByType(repoId, fileId, type, items);
      } catch (error) {
        console.error(`Error batch updating ${type} embeddings:`, error);
      }
    }
  }

  /**
   * Batch update embeddings for a specific entity type
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
      await client.query('BEGIN');

      for (const item of items) {
        const embeddingVector = '[' + item.embedding.join(',') + ']';
        const [name, line] = item.id.split(':');
        const lineNum = parseInt(line, 10);

        if (isNaN(lineNum)) {
          console.error(`Invalid line number for ${entityType} ${name}: ${line}`);
          continue;
        }

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
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Store embedding in the appropriate table
   */
  private async storeEmbedding(
    repoId: number,
    fileId: number,
    entityType: string,
    entityId: string,
    embedding: number[]
  ): Promise<void> {
    const embeddingVector = '[' + embedding.join(',') + ']';

    try {
      switch (entityType) {
        case 'constant':
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
          const [urlPattern, urlLine] = entityId.split(':');
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
   * Re-index an entire repository
   */
  async reindexRepository(repoId: number, repoPath: string, options: IndexingOptions = {}): Promise<IndexingProgress> {
    console.log(`Starting re-index of repository ${repoId} at ${repoPath}`);

    // Get all files from the database
    const filesResult = await this.db.query(
      `
      SELECT id, path
      FROM files
      WHERE repo_id = $1
      ORDER BY path
    `,
      [repoId]
    );

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

    const validFiles = files.filter((f) => f !== null) as Array<{ id: number; path: string; content: string }>;

    // Clean up old data
    console.log('Cleaning up old relationships...');
    await this.cleanupRepository(repoId);

    // Index all files
    console.log(`Indexing ${validFiles.length} files...`);
    const progress = await this.indexFiles(repoId, validFiles, options);

    console.log('Re-indexing complete!');
    console.log(`  Processed: ${progress.processedFiles}/${progress.totalFiles}`);
    console.log(`  Errors: ${progress.errors}`);

    return progress;
  }

  /**
   * Clean up old data before re-indexing
   */
  private async cleanupRepository(repoId: number): Promise<void> {
    await this.db.query('BEGIN');

    try {
      // Delete in order to respect foreign key constraints
      await this.db.query('DELETE FROM search_logs WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM url_usages WHERE repo_id = $1', [repoId]);
      await this.db.query('DELETE FROM constant_references WHERE repo_id = $1', [repoId]);

      // call_graph doesn't have repo_id, delete via code_chunks -> files join
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
   * Get indexing statistics
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
