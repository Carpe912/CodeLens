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
    const { batchSize = 10, onProgress } = options;

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
   * Generate embeddings for all entities using text-embedding-v4
   */
  private async generateEmbeddings(repoId: number, fileId: number, astResult: ASTAnalysisResult): Promise<void> {
    const embeddingTasks: Array<{ type: string; id: string; text: string }> = [];

    // Prepare embedding tasks for constants
    for (const constant of astResult.stringConstants) {
      if (constant.symbolName) {
        embeddingTasks.push({
          type: 'constant',
          id: `${constant.symbolName}:${constant.lineStart}`,
          text: `${constant.symbolName}: ${constant.stringValue} (${constant.constantType})`,
        });
      }
    }

    // Prepare embedding tasks for functions
    for (const func of astResult.functions) {
      embeddingTasks.push({
        type: 'function',
        id: `${func.fullName}:${func.lineStart}`,
        text: `${func.signature}\n${func.code.slice(0, 500)}`, // Limit to 500 chars
      });
    }

    // Prepare embedding tasks for classes
    for (const cls of astResult.classes) {
      embeddingTasks.push({
        type: 'class',
        id: `${cls.fullName}:${cls.lineStart}`,
        text: `${cls.classType} ${cls.fullName}\n${cls.code.slice(0, 500)}`,
      });
    }

    // Prepare embedding tasks for URL patterns
    for (const url of astResult.urlPatterns) {
      embeddingTasks.push({
        type: 'url',
        id: `${url.normalizedPattern}:${url.definitionLine}`,
        text: `${url.method || 'HTTP'} ${url.pattern}\n${url.definitionCode}`,
      });
    }

    // Generate embeddings in batches
    const batchSize = 20;
    for (let i = 0; i < embeddingTasks.length; i += batchSize) {
      const batch = embeddingTasks.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (task) => {
          try {
            const embedding = await this.generateEmbedding(task.text);
            await this.storeEmbedding(repoId, fileId, task.type, task.id, embedding);
          } catch (error) {
            console.error(`Error generating embedding for ${task.type} ${task.id}:`, error);
          }
        })
      );
    }
  }

  /**
   * Generate a single embedding using text-embedding-v4
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Use Anthropic's text-embedding-v4 model (1536 dimensions)
      const response = await fetch('https://api.anthropic.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': (this.anthropic as any).apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'text-embedding-v4',
          input: text.slice(0, 8000), // Limit input length
        }),
      });

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.statusText}`);
      }

      const data = await response.json() as any;
      return data.embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
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
          await this.db.query(
            `
            UPDATE string_constants
            SET embedding = $1::vector
            WHERE repo_id = $2
              AND file_id = $3
              AND symbol_name = $4
              AND line_start = $5
          `,
            [embeddingVector, repoId, fileId, constantName, parseInt(constantLine)]
          );
          break;

        case 'function':
          const [funcName, funcLine] = entityId.split(':');
          await this.db.query(
            `
            UPDATE functions
            SET embedding = $1::vector
            WHERE repo_id = $2
              AND file_id = $3
              AND full_name = $4
              AND line_start = $5
          `,
            [embeddingVector, repoId, fileId, funcName, parseInt(funcLine)]
          );
          break;

        case 'class':
          const [className, classLine] = entityId.split(':');
          await this.db.query(
            `
            UPDATE classes
            SET embedding = $1::vector
            WHERE repo_id = $2
              AND file_id = $3
              AND full_name = $4
              AND line_start = $5
          `,
            [embeddingVector, repoId, fileId, className, parseInt(classLine)]
          );
          break;

        case 'url':
          const [urlPattern, urlLine] = entityId.split(':');
          await this.db.query(
            `
            UPDATE url_patterns
            SET embedding = $1::vector
            WHERE repo_id = $2
              AND definition_file_id = $3
              AND normalized_pattern = $4
              AND definition_line = $5
          `,
            [embeddingVector, repoId, fileId, urlPattern, parseInt(urlLine)]
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
      await this.db.query('DELETE FROM call_graph WHERE repo_id = $1', [repoId]);
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
