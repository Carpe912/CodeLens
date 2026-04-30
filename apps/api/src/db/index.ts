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
        gitlab_token TEXT,
        status TEXT NOT NULL,
        description TEXT,
        index_progress JSONB DEFAULT '{"total": 0, "processed": 0, "startTime": null}'::jsonb,
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
        embedding vector(1024),
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
      CREATE TABLE IF NOT EXISTS question_feedback (
        id SERIAL PRIMARY KEY,
        question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
        feedback_text TEXT NOT NULL,
        is_helpful BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Drop old IVFFlat index if exists
    await pool.query(`
      DROP INDEX IF EXISTS idx_code_chunks_embedding;
    `);

    // Create HNSW index for better performance (faster queries, higher recall)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding_hnsw
      ON code_chunks
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
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

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_question_feedback_question_id ON question_feedback(question_id);
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
  gitlab_token?: string;
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

export async function createRepo(name: string, source: 'gitlab' | 'zip', url?: string, gitlabToken?: string): Promise<number> {
  const result = await pool.query(
    'INSERT INTO repos (name, source, url, gitlab_token, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, source, url, gitlabToken, 'indexing']
  );
  return result.rows[0].id;
}

export async function getRepo(repoId: number): Promise<Repo | null> {
  const result = await pool.query('SELECT * FROM repos WHERE id = $1', [repoId]);
  return result.rows[0] || null;
}

export async function updateRepoStatus(repoId: number, status: 'ready' | 'indexing' | 'failed') {
  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', [status, repoId]);
}

export async function updateIndexProgress(repoId: number, total: number, processed: number, startTime?: Date) {
  const progress = {
    total,
    processed,
    startTime: startTime || new Date(),
  };
  await pool.query('UPDATE repos SET index_progress = $1 WHERE id = $2', [JSON.stringify(progress), repoId]);
}

export async function getIndexProgress(repoId: number): Promise<{ total: number; processed: number; startTime: Date | null; phase?: 'basic' | 'enhanced' } | null> {
  const result = await pool.query('SELECT index_progress FROM repos WHERE id = $1', [repoId]);
  if (!result.rows[0]) return null;
  const progress = result.rows[0].index_progress;
  return {
    total: progress.total || 0,
    processed: progress.processed || 0,
    startTime: progress.startTime ? new Date(progress.startTime) : null,
    phase: progress.phase,
  };
}

export async function clearRepoData(repoId: number): Promise<void> {
  // Delete all files and their chunks (cascade will handle chunks)
  await pool.query('DELETE FROM files WHERE repo_id = $1', [repoId]);
  // Reset progress
  await pool.query('UPDATE repos SET index_progress = $1 WHERE id = $2', [JSON.stringify({ total: 0, processed: 0, startTime: null }), repoId]);
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
  // Skip keyword search for very long queries (e.g., URLs) as ILIKE is too slow
  if (keyword.length > 100) {
    return [];
  }

  // Only search in symbol_name to avoid slow ILIKE on code_text
  const result = await pool.query(
    `SELECT c.*, f.path as file_path
     FROM code_chunks c
     JOIN files f ON c.file_id = f.id
     WHERE f.repo_id = $1 AND c.symbol_name ILIKE $2
     LIMIT 20`,
    [repoId, `%${keyword}%`]
  );
  return result.rows;
}

export async function searchByEmbedding(repoId: number, embedding: number[], limit = 10): Promise<CodeChunkRecord[]> {
  // Set HNSW search parameter for better recall
  await pool.query('SET hnsw.ef_search = 40');

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

// Search for string constants (URLs, API endpoints, etc.)
export async function searchStringConstants(repoId: number, pattern: string, limit = 20): Promise<any[]> {
  const result = await pool.query(
    `SELECT
       sc.id,
       sc.value,
       sc.symbol_name,
       sc.export_type,
       f.path as file_path,
       c.start_line,
       c.end_line,
       c.code_text
     FROM string_constants sc
     JOIN code_chunks c ON sc.chunk_id = c.id
     JOIN files f ON c.file_id = f.id
     WHERE f.repo_id = $1 AND sc.value ILIKE $2
     ORDER BY LENGTH(sc.value) DESC
     LIMIT $3`,
    [repoId, `%${pattern}%`, limit]
  );
  return result.rows;
}

// Find where a constant is used (by symbol name or value)
export async function findConstantUsages(repoId: number, constantId: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT
       c.id,
       c.code_text,
       c.start_line,
       c.end_line,
       f.path as file_path,
       sc.value as constant_value,
       sc.symbol_name
     FROM constant_references cr
     JOIN code_chunks c ON cr.chunk_id = c.id
     JOIN files f ON c.file_id = f.id
     JOIN string_constants sc ON cr.constant_id = sc.id
     WHERE f.repo_id = $1 AND cr.constant_id = $2
     ORDER BY f.path, c.start_line`,
    [repoId, constantId]
  );
  return result.rows;
}

// Find call chain for a function
export async function findCallChain(repoId: number, functionName: string, maxDepth = 3): Promise<any[]> {
  const result = await pool.query(
    `WITH RECURSIVE call_chain AS (
       -- Base case: find the target function
       SELECT
         cg.caller_chunk_id,
         cg.callee_chunk_id,
         cg.caller_name,
         cg.callee_name,
         1 as depth,
         ARRAY[cg.callee_name] as path
       FROM call_graph cg
       JOIN code_chunks c ON cg.callee_chunk_id = c.id
       JOIN files f ON c.file_id = f.id
       WHERE f.repo_id = $1 AND cg.callee_name ILIKE $2

       UNION ALL

       -- Recursive case: find callers
       SELECT
         cg.caller_chunk_id,
         cg.callee_chunk_id,
         cg.caller_name,
         cg.callee_name,
         cc.depth + 1,
         cc.path || cg.caller_name
       FROM call_graph cg
       JOIN call_chain cc ON cg.callee_chunk_id = cc.caller_chunk_id
       JOIN code_chunks c ON cg.caller_chunk_id = c.id
       JOIN files f ON c.file_id = f.id
       WHERE f.repo_id = $1 AND cc.depth < $3
         AND NOT (cg.caller_name = ANY(cc.path)) -- Prevent cycles
     )
     SELECT DISTINCT
       cc.*,
       c.code_text,
       c.start_line,
       c.end_line,
       f.path as file_path
     FROM call_chain cc
     JOIN code_chunks c ON cc.caller_chunk_id = c.id
     JOIN files f ON c.file_id = f.id
     ORDER BY cc.depth, f.path, c.start_line`,
    [repoId, `%${functionName}%`, maxDepth]
  );
  return result.rows;
}

// Incremental indexing functions
export async function getFileByPath(repoId: number, path: string): Promise<{ id: number; content: string } | null> {
  const result = await pool.query(
    'SELECT id, content FROM files WHERE repo_id = $1 AND path = $2',
    [repoId, path]
  );
  return result.rows[0] || null;
}

export async function updateFile(fileId: number, content: string, language: string): Promise<void> {
  await pool.query(
    'UPDATE files SET content = $1, language = $2 WHERE id = $3',
    [content, language, fileId]
  );
}

export async function deleteFileChunks(fileId: number): Promise<void> {
  await pool.query('DELETE FROM code_chunks WHERE file_id = $1', [fileId]);
}

export async function deleteFile(fileId: number): Promise<void> {
  await pool.query('DELETE FROM files WHERE id = $1', [fileId]);
}

// Feedback functions
export async function addQuestionFeedback(questionId: number, feedbackText: string, isHelpful: boolean): Promise<number> {
  const result = await pool.query(
    'INSERT INTO question_feedback (question_id, feedback_text, is_helpful) VALUES ($1, $2, $3) RETURNING id',
    [questionId, feedbackText, isHelpful]
  );
  return result.rows[0].id;
}

export async function getQuestionFeedback(questionId: number): Promise<Array<{ id: number; feedback_text: string; is_helpful: boolean; created_at: Date }>> {
  const result = await pool.query(
    'SELECT id, feedback_text, is_helpful, created_at FROM question_feedback WHERE question_id = $1 ORDER BY created_at DESC',
    [questionId]
  );
  return result.rows;
}

export async function getSimilarQuestionsWithFeedback(repoId: number, query: string, limit = 5): Promise<Array<{
  id: number;
  query: string;
  answer: string;
  feedback: Array<{ feedback_text: string; is_helpful: boolean }>;
}>> {
  const result = await pool.query(
    `SELECT q.id, q.query, q.answer,
      COALESCE(
        json_agg(
          json_build_object('feedback_text', qf.feedback_text, 'is_helpful', qf.is_helpful)
          ORDER BY qf.created_at DESC
        ) FILTER (WHERE qf.id IS NOT NULL),
        '[]'
      ) as feedback
     FROM questions q
     LEFT JOIN question_feedback qf ON q.id = qf.question_id
     WHERE q.repo_id = $1 AND q.query ILIKE $2
     GROUP BY q.id, q.query, q.answer
     ORDER BY q.created_at DESC
     LIMIT $3`,
    [repoId, `%${query}%`, limit]
  );
  return result.rows;
}

/**
 * 获取代码块的扩展上下文
 * 包含前后若干行代码，提供更完整的上下文
 *
 * @param chunkId 代码块 ID
 * @param linesBefore 前面包含的行数（默认 5 行）
 * @param linesAfter 后面包含的行数（默认 5 行）
 */
export async function getChunkWithContext(
  chunkId: number,
  linesBefore: number = 5,
  linesAfter: number = 5
): Promise<(CodeChunkRecord & { file_path?: string; extended_code?: string }) | null> {
  const result = await pool.query(
    `SELECT c.*, f.content, f.path as file_path
     FROM code_chunks c
     JOIN files f ON c.file_id = f.id
     WHERE c.id = $1`,
    [chunkId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const chunk = result.rows[0];
  const lines = chunk.content.split('\n');

  // 计算扩展范围（注意：line_start 和 line_end 是 1-based）
  const start = Math.max(0, chunk.line_start - linesBefore - 1);
  const end = Math.min(lines.length, chunk.line_end + linesAfter);

  const extendedCode = lines.slice(start, end).join('\n');

  return {
    ...chunk,
    extended_code: extendedCode,
  };
}

/**
 * 批量获取代码块的扩展上下文
 */
export async function getChunksWithContext(
  chunks: Array<CodeChunkRecord & { file_path?: string }>,
  linesBefore: number = 5,
  linesAfter: number = 5
): Promise<Array<CodeChunkRecord & { file_path?: string; extended_code?: string }>> {
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const withContext = await getChunkWithContext(chunk.id, linesBefore, linesAfter);
      return withContext || chunk;
    })
  );

  return results;
}

