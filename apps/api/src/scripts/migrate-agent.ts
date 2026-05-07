/**
 * 运行 Agent 数据库迁移
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log('🚀 Starting Agent database migration...');

    // 读取迁移 SQL 文件
    const migrationSQL = readFileSync(
      join(__dirname, '../db/migrations/add_agent_tables.sql'),
      'utf-8'
    );

    // 执行迁移
    await pool.query(migrationSQL);

    console.log('✅ Agent tables created successfully!');

    // 验证表是否创建成功
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name LIKE 'agent_%'
      ORDER BY table_name
    `);

    console.log('\n📊 Created tables:');
    tables.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

    // 检查视图
    const views = await pool.query(`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
      AND table_name LIKE 'agent_%'
    `);

    if (views.rows.length > 0) {
      console.log('\n📈 Created views:');
      views.rows.forEach(row => {
        console.log(`  - ${row.table_name}`);
      });
    }

    console.log('\n✨ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
