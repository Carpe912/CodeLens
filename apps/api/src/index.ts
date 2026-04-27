import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initDatabase, createRepo, pool, searchByKeyword, searchByEmbedding, getRepo, addQuestionFeedback, getQuestionFeedback, getSimilarQuestionsWithFeedback } from './db/index.js';
import { enqueueIndexJob, enqueueIncrementalIndexJob, enqueueRefreshJob, startIndexWorker } from './indexer/queue.js';
import { generateEmbedding } from './llm/embeddings.js';
import { answerQuestion, analyzeRootCause } from './llm/qa.js';
import { searchTTLCache, generateCacheKey } from './cache.js';

// Validate required environment variables
function validateEnv() {
  const required = [
    process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN',
    process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY or EMBED_API_KEY'
  ].filter(Boolean);

  if (required.length > 0) {
    console.error(`Missing required environment variables: ${required.join(', ')}`);
    console.error('Please check your .env file');
    process.exit(1);
  }
}

validateEnv();

const fastify = Fastify({ logger: true });

await fastify.register(cors);
await fastify.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1,
  },
});
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

await initDatabase();
startIndexWorker();

fastify.get('/health', async () => {
  return { ok: true, service: 'codelens-api' };
});

fastify.get('/repos', async () => {
  const result = await pool.query('SELECT * FROM repos ORDER BY created_at DESC');
  // Mask gitlab_token for security
  const repos = result.rows.map((repo: any) => ({
    ...repo,
    gitlab_token: repo.gitlab_token ? '***' : null,
  }));
  return repos;
});

fastify.post<{
  Body: { name: string; source: 'gitlab' | 'zip'; url?: string; gitlabToken?: string };
}>('/repos', async (request, reply) => {
  const { name, source, url, gitlabToken } = request.body;

  if (!name || !source) {
    return reply.code(400).send({ error: 'Missing name or source' });
  }

  if (source === 'gitlab' && !url) {
    return reply.code(400).send({ error: 'GitLab source requires url' });
  }

  const repoId = await createRepo(name, source, url, gitlabToken);

  await enqueueIndexJob({
    repoId,
    repoName: name,
    source,
    url,
    gitlabToken,
  });

  return { repoId, status: 'indexing' };
});

fastify.post('/repos/upload', async (request, reply) => {
  const data = await request.file();

  if (!data) {
    return reply.code(400).send({ error: 'No file uploaded' });
  }

  const filename = data.filename;
  const buffer = await data.toBuffer();
  const zipPath = join('/tmp', `codelens-${Date.now()}-${filename}`);

  await writeFile(zipPath, buffer);

  const repoId = await createRepo(filename, 'zip');

  await enqueueIndexJob({
    repoId,
    repoName: filename,
    source: 'zip',
    zipPath,
  });

  return { repoId, status: 'indexing' };
});

fastify.post<{
  Params: { id: string };
  Body: { files: string[] };
}>('/repos/:id/incremental-index', async (request, reply) => {
  const repoId = parseInt(request.params.id);
  const { files } = request.body;

  if (!files || !Array.isArray(files) || files.length === 0) {
    return reply.code(400).send({ error: 'Missing or invalid files array' });
  }

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  // Determine repo path based on source
  const repoPath = `/tmp/codelens-repos/${repoId}`;

  const jobId = await enqueueIncrementalIndexJob({
    repoId,
    repoPath,
    files,
  });

  return { jobId, status: 'indexing', filesCount: files.length };
});

// Refresh GitLab repository
fastify.post<{
  Params: { id: string };
}>('/repos/:id/refresh', async (request, reply) => {
  const repoId = parseInt(request.params.id);

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  if (repo.source !== 'gitlab') {
    return reply.code(400).send({ error: 'Only GitLab repositories can be refreshed' });
  }

  if (!repo.url) {
    return reply.code(400).send({ error: 'Repository URL not found' });
  }

  if (repo.status === 'indexing') {
    return reply.code(400).send({ error: 'Repository is currently being indexed' });
  }

  // Allow refresh even if status is 'failed' - the refresh function will handle re-cloning if needed

  // Update status to indexing
  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', ['indexing', repoId]);

  const jobId = await enqueueRefreshJob({
    repoId,
    url: repo.url,
    gitlabToken: repo.gitlab_token,
  });

  return { jobId, status: 'refreshing' };
});

// Admin endpoint to reset repo status (temporary)
fastify.post<{
  Params: { id: string };
  Body: { status: string };
}>('/repos/:id/reset-status', async (request, reply) => {
  const repoId = parseInt(request.params.id);
  const { status } = request.body;

  if (!['ready', 'failed', 'indexing'].includes(status)) {
    return reply.code(400).send({ error: 'Invalid status' });
  }

  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', [status, repoId]);
  return { message: 'Status updated', repoId, status };
});

// Admin endpoint to migrate vector dimension
fastify.post('/admin/migrate-vector-dimension', async (request, reply) => {
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

    return {
      success: true,
      message: 'Vector dimension migrated from 1536 to 1024. All existing embeddings have been cleared. You need to re-index your repositories.'
    };
  } catch (error: any) {
    console.error('Migration failed:', error);
    return reply.code(500).send({ error: 'Migration failed', details: error.message });
  }
});

fastify.get<{
  Querystring: { repoId: string; q: string };
}>('/search', async (request, reply) => {
  const { repoId, q } = request.query;

  if (!repoId || !q) {
    return reply.code(400).send({ error: 'Missing repoId or q' });
  }

  // Check cache first
  const cacheKey = generateCacheKey('search', repoId, q);
  const cached = searchTTLCache.get(cacheKey);
  if (cached) {
    console.log('Search cache hit');
    return cached;
  }

  const keywordResults = await searchByKeyword(parseInt(repoId), q);

  const embedding = await generateEmbedding(q);
  const semanticResults = await searchByEmbedding(parseInt(repoId), embedding, 10);

  const combined = [...keywordResults, ...semanticResults];
  const unique = Array.from(new Map(combined.map((item) => [item.id, item])).values());

  const result = {
    query: q,
    hits: unique.slice(0, 20),
  };

  // Cache the result
  searchTTLCache.set(cacheKey, result);

  return result;
});

fastify.post<{
  Body: { repoId: number; query: string };
}>('/ask', async (request, reply) => {
  const { repoId, query } = request.body;

  if (!repoId || !query) {
    return reply.code(400).send({ error: 'Missing repoId or query' });
  }

  // Check cache first
  const cacheKey = generateCacheKey('ask', repoId.toString(), query);
  const cached = searchTTLCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const embedding = await generateEmbedding(query);
  const evidence = await searchByEmbedding(repoId, embedding, 10);

  // Get similar historical questions with feedback
  const historicalFeedback = await getSimilarQuestionsWithFeedback(repoId, query, 3);

  const answer = await answerQuestion(query, evidence, historicalFeedback);

  const questionResult = await pool.query(
    'INSERT INTO questions (repo_id, query, answer, evidence_ids) VALUES ($1, $2, $3, $4) RETURNING id',
    [repoId, query, answer, evidence.map((e) => e.id)]
  );

  const questionId = questionResult.rows[0].id;

  const result = {
    questionId,
    query,
    answer,
    evidence,
    historicalFeedback: historicalFeedback.length > 0 ? historicalFeedback : undefined,
  };

  // Cache the result
  searchTTLCache.set(cacheKey, result);

  return result;
});

fastify.post<{
  Body: { repoId: number; query: string };
}>('/root-cause', async (request, reply) => {
  const { repoId, query } = request.body;

  if (!repoId || !query) {
    return reply.code(400).send({ error: 'Missing repoId or query' });
  }

  const embedding = await generateEmbedding(query);
  const evidence = await searchByEmbedding(repoId, embedding, 15);

  const rootCause = await analyzeRootCause(query, evidence);

  return {
    query,
    rootCause,
    evidence,
  };
});

fastify.get('/questions', async () => {
  const result = await pool.query('SELECT * FROM questions ORDER BY created_at DESC LIMIT 50');
  return result.rows;
});

// Add feedback to a question
fastify.post<{
  Body: { questionId: number; feedbackText: string; isHelpful: boolean };
}>('/questions/feedback', async (request, reply) => {
  const { questionId, feedbackText, isHelpful } = request.body;

  if (!questionId || !feedbackText) {
    return reply.code(400).send({ error: 'Missing questionId or feedbackText' });
  }

  const feedbackId = await addQuestionFeedback(questionId, feedbackText, isHelpful);

  return { feedbackId, success: true };
});

// Get feedback for a question
fastify.get<{
  Querystring: { questionId: string };
}>('/questions/feedback', async (request, reply) => {
  const { questionId } = request.query;

  if (!questionId) {
    return reply.code(400).send({ error: 'Missing questionId' });
  }

  const feedback = await getQuestionFeedback(parseInt(questionId));

  return { feedback };
});

// Get call graph for a symbol
fastify.get<{
  Querystring: { repoId: string; symbolName: string };
}>('/call-graph', async (request, reply) => {
  const { repoId, symbolName } = request.query;

  if (!repoId || !symbolName) {
    return reply.code(400).send({ error: 'Missing repoId or symbolName' });
  }

  try {
    // Find the symbol
    const symbolResult = await pool.query(
      `SELECT c.id, c.symbol_name, c.symbol_type, f.path as file_path
       FROM code_chunks c
       JOIN files f ON c.file_id = f.id
       WHERE f.repo_id = $1 AND c.symbol_name = $2
       LIMIT 1`,
      [parseInt(repoId), symbolName]
    );

    if (symbolResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Symbol not found' });
    }

    const symbol = symbolResult.rows[0];

    // Get outgoing calls (what this symbol calls)
    const outgoingResult = await pool.query(
      `SELECT DISTINCT cg.to_symbol, c2.symbol_type, f2.path as file_path
       FROM call_graph cg
       LEFT JOIN code_chunks c2 ON c2.symbol_name = cg.to_symbol
       LEFT JOIN files f2 ON c2.file_id = f2.id
       WHERE cg.from_chunk_id = $1 AND f2.repo_id = $2`,
      [symbol.id, parseInt(repoId)]
    );

    // Get incoming calls (what calls this symbol)
    const incomingResult = await pool.query(
      `SELECT DISTINCT c.symbol_name, c.symbol_type, f.path as file_path
       FROM call_graph cg
       JOIN code_chunks c ON cg.from_chunk_id = c.id
       JOIN files f ON c.file_id = f.id
       WHERE cg.to_symbol = $1 AND f.repo_id = $2`,
      [symbolName, parseInt(repoId)]
    );

    return {
      symbol: {
        name: symbol.symbol_name,
        type: symbol.symbol_type,
        file: symbol.file_path,
      },
      calls: outgoingResult.rows.map((row: any) => ({
        name: row.to_symbol,
        type: row.symbol_type,
        file: row.file_path,
      })),
      calledBy: incomingResult.rows.map((row: any) => ({
        name: row.symbol_name,
        type: row.symbol_type,
        file: row.file_path,
      })),
    };
  } catch (error) {
    console.error('Call graph error:', error);
    return reply.code(500).send({ error: 'Failed to fetch call graph' });
  }
});

const port = parseInt(process.env.PORT || '8787');

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM'];
signals.forEach((signal) => {
  process.on(signal, async () => {
    console.log(`Received ${signal}, closing server gracefully...`);
    try {
      await fastify.close();
      await pool.end();
      console.log('Server closed successfully');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  });
});

try {
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`CodeLens API running at http://localhost:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
