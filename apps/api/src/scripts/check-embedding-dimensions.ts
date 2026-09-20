/**
 * 检查数据库中各表的 embedding 维度配置
 *
 * 用途：
 * - 验证所有表的向量维度是否一致
 * - 检查是否需要运行迁移脚本
 * - 诊断向量维度不匹配的问题
 */
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

async function checkEmbeddingDimensions() {
  try {
    console.log('🔍 检查数据库中的 embedding 维度配置...\n');

    // 1. 检查各表的 embedding 列类型
    console.log('📊 各表的 embedding 列定义：');
    const columnsQuery = `
      SELECT
        table_name,
        column_name,
        udt_name,
        character_maximum_length
      FROM information_schema.columns
      WHERE column_name = 'embedding'
      AND table_schema = 'public'
      ORDER BY table_name;
    `;
    const columnsResult = await pool.query(columnsQuery);
    console.table(columnsResult.rows);

    // 2. 检查 code_chunks 表的详细信息
    console.log('\n📋 code_chunks 表结构：');
    const codeChunksQuery = `
      SELECT
        column_name,
        data_type,
        udt_name
      FROM information_schema.columns
      WHERE table_name = 'code_chunks'
      AND table_schema = 'public'
      ORDER BY ordinal_position;
    `;
    const codeChunksResult = await pool.query(codeChunksQuery);
    console.table(codeChunksResult.rows);

    // 3. 检查 code_chunks 中有多少数据
    console.log('\n📈 code_chunks 数据统计：');
    const statsQuery = `
      SELECT
        COUNT(*) as total_chunks,
        COUNT(embedding) as chunks_with_embedding,
        COUNT(*) - COUNT(embedding) as chunks_without_embedding
      FROM code_chunks;
    `;
    const statsResult = await pool.query(statsQuery);
    console.table(statsResult.rows);

    // 4. 如果有 embedding，检查实际维度
    const sampleQuery = `
      SELECT array_length(embedding::real[], 1) as actual_dimension
      FROM code_chunks
      WHERE embedding IS NOT NULL
      LIMIT 1;
    `;
    const sampleResult = await pool.query(sampleQuery);
    if (sampleResult.rows.length > 0) {
      console.log('\n✅ code_chunks 中实际的向量维度：', sampleResult.rows[0].actual_dimension);
    } else {
      console.log('\n⚠️  code_chunks 表中没有 embedding 数据');
    }

    // 5. 检查增强表的维度
    console.log('\n📊 增强表的向量维度：');
    const enhancedTables = ['string_constants', 'url_patterns', 'functions', 'classes'];
    for (const table of enhancedTables) {
      const checkQuery = `
        SELECT
          '${table}' as table_name,
          COUNT(*) as total_rows,
          COUNT(embedding) as rows_with_embedding,
          (SELECT array_length(embedding::real[], 1) FROM ${table} WHERE embedding IS NOT NULL LIMIT 1) as actual_dimension
        FROM ${table};
      `;
      try {
        const result = await pool.query(checkQuery);
        console.log(`  ${table}:`, result.rows[0]);
      } catch (err) {
        console.log(`  ${table}: 表不存在或查询失败`);
      }
    }

    // 6. 检查环境变量配置
    console.log('\n⚙️  环境变量配置：');
    console.log('  EMBED_MODEL:', process.env.EMBED_MODEL || '未设置');
    console.log('  EMBED_DIMENSIONS:', process.env.EMBED_DIMENSIONS || '未设置');

    // 7. 给出建议
    console.log('\n💡 建议：');
    const expectedDimension = parseInt(process.env.EMBED_DIMENSIONS || '1536');
    console.log(`  - 期望的向量维度：${expectedDimension}`);
    console.log('  - 如果数据库中的维度与期望不一致，请运行迁移：');
    console.log('    POST http://localhost:8787/admin/migrate-vector-dimension');
    console.log('  - 迁移后需要重新索引所有仓库：');
    console.log('    npm run reindex <repo_id> <repo_path>');

  } catch (error) {
    console.error('❌ 检查失败:', error);
  } finally {
    await pool.end();
  }
}

checkEmbeddingDimensions();
