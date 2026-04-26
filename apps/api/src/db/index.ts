import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
  process.exit(1);
});

export async function initDatabase() {
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS repos (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        url TEXT,
        status TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        id SERIAL PRIMARY KEY,
        file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        symbol_name TEXT NOT NULL,
        symbol_type TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        code_text TEXT NOT NULL,
        embedding vector(1536),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_graph (
        id SERIAL PRIMARY KEY,
        from_chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE,
        to_symbol TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        answer TEXT,
        evidence_ids INTEGER[],
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding ON code_chunks USING ivfflat (embedding vector_cosine_ops);
    `);

    // Additional indexes for query optimization
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_files_repo_id ON files(repo_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_file_id ON code_chunks(file_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_symbol_name ON code_chunks(symbol_name);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_symbol_type ON code_chunks(symbol_type);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_call_graph_from_chunk_id ON call_graph(from_chunk_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_questions_repo_id ON questions(repo_id);
    `);

    console.log('Database initialized');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

export type Repo = {
  id: number;
  name: string;
  source: 'gitlab' | 'zip';
  url?: string;
  status: 'ready' | 'indexing' | 'failed';
  description?: string;
  created_at: Date;
};

export type CodeChunkRecord = {
  id: number;
  file_id: number;
  symbol_name: string;
  symbol_type: string;
  line_start: number;
  line_end: number;
  code_text: string;
  embedding?: number[];
};

export async function createRepo(name: string, source: 'gitlab' | 'zip', url?: string): Promise<number> {
  const result = await pool.query(
    'INSERT INTO repos (name, source, url, status) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, source, url, 'indexing']
  );
  return result.rows[0].id;
}

export async function updateRepoStatus(repoId: number, status: 'ready' | 'indexing' | 'failed') {
  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', [status, repoId]);
}

export async function insertFile(repoId: number, path: string, language: string, content: string): Promise<number> {
  const result = await pool.query(
    'INSERT INTO files (repo_id, path, language, content) VALUES ($1, $2, $3, $4) RETURNING id',
    [repoId, path, language, content]
  );
  return result.rows[0].id;
}

export async function insertCodeChunk(
  fileId: number,
  symbolName: string,
  symbolType: string,
  lineStart: number,
  lineEnd: number,
  codeText: string,
  embedding?: number[]
): Promise<number> {
  const result = await pool.query(
    'INSERT INTO code_chunks (file_id, symbol_name, symbol_type, line_start, line_end, code_text, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [fileId, symbolName, symbolType, lineStart, lineEnd, codeText, embedding ? `[${embedding.join(',')}]` : null]
  );
  return result.rows[0].id;
}

export async function searchByKeyword(repoId: number, keyword: string): Promise<CodeChunkRecord[]> {
  const result = await pool.query(
    `SELECT c.*, f.path as file_path
     FROM code_chunks c
     JOIN files f ON c.file_id = f.id
     WHERE f.repo_id = $1 AND (c.symbol_name ILIKE $2 OR c.code_text ILIKE $2)
     LIMIT 20`,
    [repoId, `%${keyword}%`]
  );
  return result.rows;
}

export async function searchByEmbedding(repoId: number, embedding: number[], limit = 10): Promise<CodeChunkRecord[]> {
  const result = await pool.query(
    `SELECT c.*, f.path as file_path, 1 - (c.embedding <=> $1::vector) as similarity
     FROM code_chunks c
     JOIN files f ON c.file_id = f.id
     WHERE f.repo_id = $2 AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    [`[${embedding.join(',')}]`, repoId, limit]
  );
  return result.rows;
}
