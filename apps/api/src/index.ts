import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initDatabase, createRepo, pool, searchByKeyword, searchByEmbedding } from './db/index.js';
import { enqueueIndexJob, startIndexWorker } from './indexer/queue.js';
import { generateEmbedding } from './llm/embeddings.js';
import { answerQuestion, analyzeRootCause } from './llm/qa.js';
import { searchTTLCache, generateCacheKey } from './cache.js';

// Validate required environment variables
function validateEnv() {
  const required = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please check your .env file');
    process.exit(1);
  }
}

validateEnv();

const fastify = Fastify({ logger: true });

await fastify.register(cors);
await fastify.register(multipart);
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
  return result.rows;
});

fastify.post<{
  Body: { name: string; source: 'gitlab' | 'zip'; url?: string };
}>('/repos', async (request, reply) => {
  const { name, source, url } = request.body;

  if (!name || !source) {
    return reply.code(400).send({ error: 'Missing name or source' });
  }

  const repoId = await createRepo(name, source, url);

  await enqueueIndexJob({
    repoId,
    repoName: name,
    source,
    url,
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

  const answer = await answerQuestion(query, evidence);

  await pool.query(
    'INSERT INTO questions (repo_id, query, answer, evidence_ids) VALUES ($1, $2, $3, $4)',
    [repoId, query, answer, evidence.map((e) => e.id)]
  );

  const result = {
    query,
    answer,
    evidence,
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
