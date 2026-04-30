#!/usr/bin/env node

/**
 * Re-indexing Script - Run enhanced indexing on an existing repository
 *
 * Usage:
 *   npm run reindex <repoId> <repoPath>
 *
 * Example:
 *   npm run reindex 1 /path/to/repo
 */

import { Pool } from 'pg';
import { EnhancedIndexer } from '../indexer/enhanced-indexer.js';

// dotenv.config(); // Removed - environment variables should be set externally

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

  if (args.length < 2) {
    console.error('Usage: npm run reindex <repoId> <repoPath>');
    console.error('Example: npm run reindex 1 /tmp/codelens-repos/1');
    process.exit(1);
  }

  const repoId = parseInt(args[0]);
  const repoPath = args[1];

  if (isNaN(repoId)) {
    console.error('Error: repoId must be a number');
    process.exit(1);
  }

  // Validate environment variables
  const anthropicApiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    console.error('Error: ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Enhanced Re-indexing Script');
  console.log('='.repeat(60));
  console.log(`Repository ID: ${repoId}`);
  console.log(`Repository Path: ${repoPath}`);
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
    console.log(`Current Status: ${repo.status}`);
    console.log('');

    // Initialize enhanced indexer
    console.log('Initializing enhanced indexer...');
    const indexer = new EnhancedIndexer(pool, anthropicApiKey);

    // Reset progress and update status to indexing
    await pool.query(
      'UPDATE repos SET status = $1, index_progress = $2 WHERE id = $3',
      ['indexing', JSON.stringify({ total: 0, processed: 0, startTime: new Date() }), repoId]
    );

    // Start re-indexing with progress tracking
    console.log('Starting re-indexing...');
    console.log('');

    const startTime = Date.now();
    let lastProgress = 0;

    const progress = await indexer.reindexRepository(repoId, repoPath, {
      batchSize: 5, // Process 5 files in parallel
      onProgress: (p: any) => {
        const percent = Math.floor((p.processedFiles / p.totalFiles) * 100);
        if (percent !== lastProgress && percent % 10 === 0) {
          console.log(`Progress: ${percent}% (${p.processedFiles}/${p.totalFiles} files)`);
          lastProgress = percent;
        }
      },
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('');
    console.log('='.repeat(60));
    console.log('Re-indexing Complete!');
    console.log('='.repeat(60));
    console.log(`Total Files: ${progress.totalFiles}`);
    console.log(`Processed: ${progress.processedFiles}`);
    console.log(`Errors: ${progress.errors}`);
    console.log(`Duration: ${duration}s`);
    console.log('');

    // Get indexing statistics
    console.log('Fetching indexing statistics...');
    const stats = await indexer.getIndexingStats(repoId);

    console.log('');
    console.log('Indexing Statistics:');
    console.log(`  Files: ${stats.files}`);
    console.log(`  String Constants: ${stats.constants}`);
    console.log(`  Functions: ${stats.functions}`);
    console.log(`  Classes: ${stats.classes}`);
    console.log(`  URL Patterns: ${stats.urlPatterns}`);
    console.log(`  Import Relations: ${stats.imports}`);
    console.log(`  Call Graph Edges: ${stats.callEdges}`);
    console.log('');

    // Update status to ready
    await pool.query('UPDATE repos SET status = $1 WHERE id = $2', ['ready', repoId]);

    console.log('✓ Repository is now ready for enhanced search!');
    console.log('');
    console.log('You can now use the following search strategies:');
    console.log('  - strategy=multi: Multi-strategy search (vector + exact + fuzzy + dependency)');
    console.log('  - enhanced=true: Enhanced search with query rewriting');
    console.log('  - Default: Original keyword + vector search');
    console.log('');

  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('Re-indexing Failed!');
    console.error('='.repeat(60));
    console.error(error);
    console.error('');

    // Update status to failed
    await pool.query('UPDATE repos SET status = $1 WHERE id = $2', ['failed', repoId]);

    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
