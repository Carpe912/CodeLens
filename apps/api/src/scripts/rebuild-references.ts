#!/usr/bin/env node

/**
 * Rebuild References Script - Rebuild constant references without re-indexing
 *
 * This script only rebuilds the constant_references table without touching
 * embeddings or other indexed data. Useful when the reference-building logic
 * has been updated but the indexed data is still valid.
 *
 * Usage:
 *   npm run rebuild-references <repoId>
 *
 * Example:
 *   npm run rebuild-references 1
 */

import { Pool } from 'pg';
import { RelationshipBuilder } from '../indexer/relationship-builder.js';

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: npm run rebuild-references <repoId>');
    console.error('Example: npm run rebuild-references 1');
    process.exit(1);
  }

  const repoId = parseInt(args[0]);

  if (isNaN(repoId)) {
    console.error('Error: repoId must be a number');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Rebuild Constant References Script');
  console.log('='.repeat(60));
  console.log(`Repository ID: ${repoId}`);
  console.log('='.repeat(60));
  console.log('');

  try {
    // Check if repository exists
    const repoResult = await pool.query('SELECT * FROM repos WHERE id = $1', [repoId]);
    if (repoResult.rows.length === 0) {
      console.error(`Error: Repository with ID ${repoId} not found`);
      process.exit(1);
    }

    const repo = repoResult.rows[0];
    console.log(`Repository: ${repo.name}`);
    console.log(`Source: ${repo.source}`);
    console.log('');

    // Step 1: Clear existing constant references
    console.log('Step 1: Clearing existing constant references...');
    const deleteResult = await pool.query(
      'DELETE FROM constant_references WHERE repo_id = $1',
      [repoId]
    );
    console.log(`  Deleted ${deleteResult.rowCount} existing references`);
    console.log('');

    // Step 2: Get all files and their constants
    console.log('Step 2: Fetching files and constants...');
    const filesResult = await pool.query(
      `SELECT id, path FROM files WHERE repo_id = $1 ORDER BY id`,
      [repoId]
    );
    console.log(`  Found ${filesResult.rows.length} files`);
    console.log('');

    // Step 3: Rebuild references for each file
    console.log('Step 3: Rebuilding constant references...');
    const relationshipBuilder = new RelationshipBuilder(pool);
    let totalReferences = 0;
    let processedFiles = 0;

    for (const file of filesResult.rows) {
      // Get constants for this file
      const constantsResult = await pool.query(
        `SELECT
          id,
          symbol_name,
          string_value,
          constant_type,
          export_type,
          line_start,
          line_end,
          code
        FROM string_constants
        WHERE repo_id = $1 AND file_id = $2`,
        [repoId, file.id]
      );

      if (constantsResult.rows.length > 0) {
        // Build a minimal AST result with just the constants
        const astResult = {
          stringConstants: constantsResult.rows.map((row: any) => ({
            symbolName: row.symbol_name,
            stringValue: row.string_value,
            constantType: row.constant_type,
            exportType: row.export_type,
            lineStart: row.line_start,
            lineEnd: row.line_end,
            code: row.code,
          })),
          imports: [],
          urlPatterns: [],
          functions: [],
          classes: [],
        };

        // Build references for this file
        const result = await relationshipBuilder.buildRelationships(
          repoId,
          file.id,
          file.path,
          astResult
        );

        totalReferences += result.constantReferencesCreated;
      }

      processedFiles++;
      if (processedFiles % 10 === 0) {
        console.log(`  Progress: ${processedFiles}/${filesResult.rows.length} files, ${totalReferences} references created`);
      }
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('Rebuild Complete!');
    console.log('='.repeat(60));
    console.log(`Files Processed: ${processedFiles}`);
    console.log(`Total References Created: ${totalReferences}`);
    console.log('');

    // Get statistics
    const statsResult = await pool.query(
      `SELECT
        COUNT(*) as total_constants,
        COUNT(DISTINCT CASE WHEN export_type = 'none' THEN id END) as unexported_constants,
        (SELECT COUNT(*) FROM constant_references WHERE repo_id = $1) as total_references
      FROM string_constants
      WHERE repo_id = $1`,
      [repoId]
    );

    const stats = statsResult.rows[0];
    console.log('Statistics:');
    console.log(`  Total Constants: ${stats.total_constants}`);
    console.log(`  Unexported Constants: ${stats.unexported_constants}`);
    console.log(`  Total References: ${stats.total_references}`);
    console.log(`  Coverage: ${((parseInt(stats.total_references) / parseInt(stats.total_constants)) * 100).toFixed(1)}%`);
    console.log('');

  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('Rebuild Failed!');
    console.error('='.repeat(60));
    console.error(error);
    console.error('');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
