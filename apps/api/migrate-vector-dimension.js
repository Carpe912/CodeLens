import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function migrate() {
  try {
    console.log('Starting migration: changing embedding vector dimension from 1536 to 1024...');

    // Drop the index first
    console.log('Dropping index...');
    await pool.query('DROP INDEX IF EXISTS idx_code_chunks_embedding');

    // Drop the embedding column
    console.log('Dropping old embedding column...');
    await pool.query('ALTER TABLE code_chunks DROP COLUMN IF EXISTS embedding');

    // Add new embedding column with 1024 dimensions
    console.log('Adding new embedding column with 1024 dimensions...');
    await pool.query('ALTER TABLE code_chunks ADD COLUMN embedding vector(1024)');

    // Recreate the index
    console.log('Recreating index...');
    await pool.query('CREATE INDEX idx_code_chunks_embedding ON code_chunks USING ivfflat (embedding vector_cosine_ops)');

    console.log('Migration completed successfully!');
    console.log('Note: All existing embeddings have been cleared. You need to re-index your repositories.');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
