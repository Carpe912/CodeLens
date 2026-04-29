#!/usr/bin/env node

/**
 * Database Migration Script - Apply enhanced schema migration
 *
 * Usage:
 *   npm run migrate
 */

import { Pool } from 'pg';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function main() {
  console.log('='.repeat(60));
  console.log('Enhanced Schema Migration');
  console.log('='.repeat(60));
  console.log('');

  try {
    // Read migration file
    const migrationPath = path.join(__dirname, '../../migrations/001_enhanced_schema.sql');
    console.log(`Reading migration file: ${migrationPath}`);

    const migrationSQL = await fs.readFile(migrationPath, 'utf-8');

    console.log('Applying migration...');
    console.log('');

    // Execute migration
    await pool.query(migrationSQL);

    console.log('');
    console.log('='.repeat(60));
    console.log('Migration Complete!');
    console.log('='.repeat(60));
    console.log('');
    console.log('New tables created:');
    console.log('  ✓ string_constants - String constants with semantic types');
    console.log('  ✓ url_patterns - URL patterns with components');
    console.log('  ✓ functions - Function signatures and metadata');
    console.log('  ✓ classes - Classes, interfaces, and types');
    console.log('  ✓ import_relations - Import/export relationships');
    console.log('  ✓ constant_references - Constant usage tracking');
    console.log('  ✓ url_usages - URL pattern usage locations');
    console.log('  ✓ file_dependencies - File-level dependency graph');
    console.log('  ✓ search_logs - Search analytics');
    console.log('');
    console.log('Extended tables:');
    console.log('  ✓ code_chunks - Added metadata, node_type, parent_chunk_id');
    console.log('  ✓ call_graph - Added call_type, arguments, call_line');
    console.log('');
    console.log('Views created:');
    console.log('  ✓ url_patterns_detailed');
    console.log('  ✓ constants_with_references');
    console.log('  ✓ functions_with_calls');
    console.log('');
    console.log('Helper functions:');
    console.log('  ✓ normalize_url_pattern()');
    console.log('  ✓ infer_constant_type()');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Run: npm run reindex <repoId> <repoPath>');
    console.log('  2. Use strategy=multi in search API for enhanced results');
    console.log('');

  } catch (error: any) {
    console.error('');
    console.error('='.repeat(60));
    console.error('Migration Failed!');
    console.error('='.repeat(60));
    console.error(error.message);
    console.error('');

    if (error.message.includes('already exists')) {
      console.log('Note: Some tables already exist. This is normal if you\'ve run the migration before.');
      console.log('The migration script uses IF NOT EXISTS to avoid conflicts.');
      console.log('');
    }

    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
