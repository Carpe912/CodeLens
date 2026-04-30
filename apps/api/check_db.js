import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function checkEmbeddingDimension() {
  try {
    // 检查 embedding 列的维度
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_chunks,
        COUNT(embedding) as chunks_with_embedding
      FROM code_chunks
    `);
    
    console.log('数据库统计:');
    console.log('- 总 chunks 数:', result.rows[0].total_chunks);
    console.log('- 有 embedding 的 chunks:', result.rows[0].chunks_with_embedding);
    
    // 尝试获取一个 embedding 的维度
    const embResult = await pool.query(`
      SELECT vector_dims(embedding) as dims
      FROM code_chunks 
      WHERE embedding IS NOT NULL 
      LIMIT 1
    `);
    
    if (embResult.rows.length > 0) {
      console.log('- Embedding 维度:', embResult.rows[0].dims);
    } else {
      console.log('- 没有找到 embedding 数据（需要重新索引）');
    }
    
  } catch (error) {
    console.error('检查失败:', error.message);
  } finally {
    await pool.end();
  }
}

checkEmbeddingDimension();
