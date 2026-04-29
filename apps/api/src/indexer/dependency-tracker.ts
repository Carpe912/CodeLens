/**
 * Dependency Tracker - Track constant usage and dependencies across files
 *
 * This module traces how constants, functions, and classes are used across
 * the codebase by following import chains and usage patterns.
 */

import { Pool } from 'pg';
import * as path from 'path';

// ============================================
// Type Definitions
// ============================================

export interface ConstantUsage {
  constantId: number;
  usageFileId: number;
  usageFilePath: string;
  usageChunkId?: number;
  usageLine: number;
  usageContext: string;
  referenceType: string;
}

export interface ImportChain {
  fileId: number;
  filePath: string;
  symbol: string;
  importType: string;
  depth: number;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface DependencyNode {
  id: string;
  type: 'file' | 'constant' | 'function' | 'class';
  label: string;
  filePath?: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'imports' | 'uses' | 'calls' | 'extends';
  weight: number;
}

// ============================================
// Dependency Tracker Class
// ============================================

export class DependencyTracker {
  constructor(private db: Pool) {}

  /**
   * Trace all usages of a constant across the codebase
   */
  async traceConstantUsage(repoId: number, constantId: number): Promise<ConstantUsage[]> {
    const usages: ConstantUsage[] = [];

    // Get the constant information
    const constantResult = await this.db.query(
      `
      SELECT sc.*, f.path as file_path
      FROM string_constants sc
      JOIN files f ON sc.file_id = f.id
      WHERE sc.id = $1
    `,
      [constantId]
    );

    if (constantResult.rows.length === 0) {
      return usages;
    }

    const constant = constantResult.rows[0];

    // Find direct references
    const directRefs = await this.db.query(
      `
      SELECT
        cr.*,
        f.path as usage_file_path
      FROM constant_references cr
      JOIN files f ON cr.referrer_file_id = f.id
      WHERE cr.constant_id = $1
    `,
      [constantId]
    );

    directRefs.rows.forEach((ref) => {
      usages.push({
        constantId,
        usageFileId: ref.referrer_file_id,
        usageFilePath: ref.usage_file_path,
        usageChunkId: ref.referrer_chunk_id,
        usageLine: ref.referrer_line,
        usageContext: ref.referrer_context,
        referenceType: 'direct',
      });
    });

    // Find indirect references through imports
    if (constant.symbol_name) {
      const importers = await this.findImporters(repoId, constant.file_id, constant.symbol_name);

      for (const importer of importers) {
        // Search for usage in the importing file
        const importerUsages = await this.findUsagesInFile(
          repoId,
          importer.fileId,
          constant.symbol_name,
          importer.alias
        );

        usages.push(...importerUsages);
      }
    }

    return usages;
  }

  /**
   * Find all files that import a specific symbol from a file
   */
  async findImporters(
    repoId: number,
    sourceFileId: number,
    symbolName: string,
    maxDepth: number = 5
  ): Promise<ImportChain[]> {
    const chains: ImportChain[] = [];
    const visited = new Set<number>();

    const queue: Array<{ fileId: number; symbol: string; depth: number }> = [
      { fileId: sourceFileId, symbol: symbolName, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= maxDepth || visited.has(current.fileId)) {
        continue;
      }

      visited.add(current.fileId);

      // Find files that import this symbol from the current file
      const importers = await this.db.query(
        `
        SELECT
          ir.importer_file_id,
          ir.imported_symbol,
          ir.alias,
          ir.import_type,
          f.path as file_path
        FROM import_relations ir
        JOIN files f ON ir.importer_file_id = f.id
        WHERE ir.repo_id = $1
          AND ir.imported_file_id = $2
          AND (ir.imported_symbol = $3 OR ir.import_type = 'namespace')
      `,
        [repoId, current.fileId, current.symbol]
      );

      for (const importer of importers.rows) {
        const effectiveSymbol = importer.alias || importer.imported_symbol || current.symbol;

        chains.push({
          fileId: importer.importer_file_id,
          filePath: importer.file_path,
          symbol: effectiveSymbol,
          importType: importer.import_type,
          depth: current.depth + 1,
        });

        // Continue tracing through re-exports
        queue.push({
          fileId: importer.importer_file_id,
          symbol: effectiveSymbol,
          depth: current.depth + 1,
        });
      }
    }

    return chains;
  }

  /**
   * Find usages of a symbol within a specific file
   */
  async findUsagesInFile(
    repoId: number,
    fileId: number,
    symbolName: string,
    alias?: string
  ): Promise<ConstantUsage[]> {
    const usages: ConstantUsage[] = [];
    const searchSymbol = alias || symbolName;

    // Search in code chunks
    const chunks = await this.db.query(
      `
      SELECT id, content, line_start, line_end
      FROM code_chunks
      WHERE file_id = $1
    `,
      [fileId]
    );

    for (const chunk of chunks.rows) {
      const lines = chunk.content.split('\n');

      lines.forEach((line: string, index: number) => {
        // Simple regex search for the symbol
        // This is a basic implementation; a full AST-based search would be more accurate
        const regex = new RegExp(`\\b${this.escapeRegex(searchSymbol)}\\b`, 'g');
        const matches = line.match(regex);

        if (matches) {
          const lineNumber = chunk.line_start + index;

          usages.push({
            constantId: -1, // Will be filled by caller
            usageFileId: fileId,
            usageFilePath: '', // Will be filled by caller
            usageChunkId: chunk.id,
            usageLine: lineNumber,
            usageContext: line.trim(),
            referenceType: 'indirect',
          });
        }
      });
    }

    return usages;
  }

  /**
   * Build a dependency graph for a file
   */
  async buildFileDependencyGraph(repoId: number, fileId: number, depth: number = 2): Promise<DependencyGraph> {
    const nodes: DependencyNode[] = [];
    const edges: DependencyEdge[] = [];
    const visited = new Set<number>();

    await this.buildGraphRecursive(repoId, fileId, depth, nodes, edges, visited);

    return { nodes, edges };
  }

  /**
   * Recursively build dependency graph
   */
  private async buildGraphRecursive(
    repoId: number,
    fileId: number,
    depth: number,
    nodes: DependencyNode[],
    edges: DependencyEdge[],
    visited: Set<number>
  ): Promise<void> {
    if (depth <= 0 || visited.has(fileId)) {
      return;
    }

    visited.add(fileId);

    // Get file information
    const fileResult = await this.db.query(
      `
      SELECT id, path
      FROM files
      WHERE id = $1
    `,
      [fileId]
    );

    if (fileResult.rows.length === 0) {
      return;
    }

    const file = fileResult.rows[0];

    // Add file node
    nodes.push({
      id: `file:${fileId}`,
      type: 'file',
      label: path.basename(file.path),
      filePath: file.path,
    });

    // Get imports from this file
    const imports = await this.db.query(
      `
      SELECT
        ir.*,
        f.path as imported_file_path
      FROM import_relations ir
      LEFT JOIN files f ON ir.imported_file_id = f.id
      WHERE ir.repo_id = $1 AND ir.importer_file_id = $2
    `,
      [repoId, fileId]
    );

    for (const imp of imports.rows) {
      if (imp.imported_file_id) {
        // Add edge
        edges.push({
          from: `file:${fileId}`,
          to: `file:${imp.imported_file_id}`,
          type: 'imports',
          weight: 1,
        });

        // Recursively process imported file
        await this.buildGraphRecursive(repoId, imp.imported_file_id, depth - 1, nodes, edges, visited);
      }
    }

    // Get function calls from this file
    const calls = await this.db.query(
      `
      SELECT
        cg.*,
        cc1.file_id as from_file_id,
        cc2.file_id as to_file_id
      FROM call_graph cg
      JOIN code_chunks cc1 ON cg.from_chunk_id = cc1.id
      LEFT JOIN code_chunks cc2 ON cg.to_chunk_id = cc2.id
      WHERE cc1.file_id = $1
    `,
      [fileId]
    );

    for (const call of calls.rows) {
      if (call.to_file_id && call.to_file_id !== fileId) {
        edges.push({
          from: `file:${fileId}`,
          to: `file:${call.to_file_id}`,
          type: 'calls',
          weight: 1,
        });
      }
    }
  }

  /**
   * Find all files that depend on a given file
   */
  async findDependents(repoId: number, fileId: number): Promise<number[]> {
    const result = await this.db.query(
      `
      SELECT DISTINCT importer_file_id
      FROM import_relations
      WHERE repo_id = $1 AND imported_file_id = $2
    `,
      [repoId, fileId]
    );

    return result.rows.map((row) => row.importer_file_id);
  }

  /**
   * Find all files that a given file depends on
   */
  async findDependencies(repoId: number, fileId: number): Promise<number[]> {
    const result = await this.db.query(
      `
      SELECT DISTINCT imported_file_id
      FROM import_relations
      WHERE repo_id = $1 AND importer_file_id = $2 AND imported_file_id IS NOT NULL
    `,
      [repoId, fileId]
    );

    return result.rows.map((row) => row.imported_file_id);
  }

  /**
   * Calculate dependency strength between two files
   */
  async calculateDependencyStrength(repoId: number, sourceFileId: number, targetFileId: number): Promise<number> {
    // Count import relations
    const importCount = await this.db.query(
      `
      SELECT COUNT(*) as count
      FROM import_relations
      WHERE repo_id = $1
        AND importer_file_id = $2
        AND imported_file_id = $3
    `,
      [repoId, sourceFileId, targetFileId]
    );

    // Count function calls
    const callCount = await this.db.query(
      `
      SELECT COUNT(*) as count
      FROM call_graph cg
      JOIN code_chunks cc1 ON cg.from_chunk_id = cc1.id
      JOIN code_chunks cc2 ON cg.to_chunk_id = cc2.id
      WHERE cc1.file_id = $1 AND cc2.file_id = $2
    `,
      [sourceFileId, targetFileId]
    );

    const imports = parseInt(importCount.rows[0].count);
    const calls = parseInt(callCount.rows[0].count);

    // Weight: imports count more than calls
    return imports * 2 + calls;
  }

  /**
   * Find circular dependencies
   */
  async findCircularDependencies(repoId: number): Promise<number[][]> {
    const cycles: number[][] = [];
    const visited = new Set<number>();
    const recursionStack = new Set<number>();

    // Get all files in the repo
    const filesResult = await this.db.query(
      `
      SELECT id FROM files WHERE repo_id = $1
    `,
      [repoId]
    );

    const fileIds = filesResult.rows.map((row) => row.id);

    for (const fileId of fileIds) {
      if (!visited.has(fileId)) {
        await this.detectCyclesDFS(repoId, fileId, visited, recursionStack, [], cycles);
      }
    }

    return cycles;
  }

  /**
   * DFS to detect cycles
   */
  private async detectCyclesDFS(
    repoId: number,
    fileId: number,
    visited: Set<number>,
    recursionStack: Set<number>,
    path: number[],
    cycles: number[][]
  ): Promise<void> {
    visited.add(fileId);
    recursionStack.add(fileId);
    path.push(fileId);

    // Get dependencies
    const dependencies = await this.findDependencies(repoId, fileId);

    for (const depId of dependencies) {
      if (!visited.has(depId)) {
        await this.detectCyclesDFS(repoId, depId, visited, recursionStack, path, cycles);
      } else if (recursionStack.has(depId)) {
        // Found a cycle
        const cycleStart = path.indexOf(depId);
        const cycle = path.slice(cycleStart);
        cycles.push(cycle);
      }
    }

    recursionStack.delete(fileId);
    path.pop();
  }

  /**
   * Get the shortest path between two files
   */
  async findShortestPath(repoId: number, sourceFileId: number, targetFileId: number): Promise<number[] | null> {
    const queue: Array<{ fileId: number; path: number[] }> = [{ fileId: sourceFileId, path: [sourceFileId] }];
    const visited = new Set<number>();

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.fileId === targetFileId) {
        return current.path;
      }

      if (visited.has(current.fileId)) {
        continue;
      }

      visited.add(current.fileId);

      const dependencies = await this.findDependencies(repoId, current.fileId);

      for (const depId of dependencies) {
        if (!visited.has(depId)) {
          queue.push({
            fileId: depId,
            path: [...current.path, depId],
          });
        }
      }
    }

    return null;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get statistics about dependencies
   */
  async getDependencyStats(repoId: number): Promise<{
    totalFiles: number;
    totalImports: number;
    avgImportsPerFile: number;
    maxImportsPerFile: number;
    filesWithCircularDeps: number;
  }> {
    const stats = await this.db.query(
      `
      WITH file_import_counts AS (
        SELECT
          importer_file_id,
          COUNT(*) as import_count
        FROM import_relations
        WHERE repo_id = $1
        GROUP BY importer_file_id
      )
      SELECT
        COUNT(DISTINCT f.id) as total_files,
        COUNT(ir.id) as total_imports,
        COALESCE(AVG(fic.import_count), 0) as avg_imports_per_file,
        COALESCE(MAX(fic.import_count), 0) as max_imports_per_file
      FROM files f
      LEFT JOIN import_relations ir ON f.id = ir.importer_file_id AND ir.repo_id = $1
      LEFT JOIN file_import_counts fic ON f.id = fic.importer_file_id
      WHERE f.repo_id = $1
    `,
      [repoId]
    );

    const cycles = await this.findCircularDependencies(repoId);
    const filesInCycles = new Set(cycles.flat());

    return {
      totalFiles: parseInt(stats.rows[0].total_files),
      totalImports: parseInt(stats.rows[0].total_imports),
      avgImportsPerFile: parseFloat(stats.rows[0].avg_imports_per_file),
      maxImportsPerFile: parseInt(stats.rows[0].max_imports_per_file),
      filesWithCircularDeps: filesInCycles.size,
    };
  }
}
