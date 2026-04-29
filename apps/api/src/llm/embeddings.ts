import OpenAI from 'openai';
import { embeddingCache, cacheStatsTracker } from '../cache.js';

const openai = new OpenAI({
  apiKey: process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.EMBED_BASE_URL,
});

export async function generateEmbedding(text: string): Promise<number[]> {
  // Check cache first
  const cached = embeddingCache.get(text);
  if (cached) {
    cacheStatsTracker.recordHit('embedding');
    console.log('Embedding cache hit');
    return cached;
  }

  cacheStatsTracker.recordMiss('embedding');

  const model = process.env.EMBED_MODEL || 'text-embedding-3-small';
  const dimensions = process.env.EMBED_DIMENSIONS ? parseInt(process.env.EMBED_DIMENSIONS) : undefined;

  const response = await openai.embeddings.create({
    model,
    input: text,
    ...(dimensions && { dimensions }),
  });

  const embedding = response.data[0].embedding;

  // Cache the result
  embeddingCache.set(text, embedding);

  return embedding;
}

export async function batchGenerateEmbeddings(texts: string[]): Promise<number[][]> {
  const uncachedTexts: string[] = [];
  const uncachedIndices: number[] = [];
  const results: number[][] = new Array(texts.length);

  // Check cache for each text
  texts.forEach((text, index) => {
    const cached = embeddingCache.get(text);
    if (cached) {
      results[index] = cached;
    } else {
      uncachedTexts.push(text);
      uncachedIndices.push(index);
    }
  });

  // If all cached, return immediately
  if (uncachedTexts.length === 0) {
    console.log('All embeddings from cache');
    return results;
  }

  console.log(`Generating ${uncachedTexts.length}/${texts.length} embeddings`);

  const model = process.env.EMBED_MODEL || 'text-embedding-3-small';
  const dimensions = process.env.EMBED_DIMENSIONS ? parseInt(process.env.EMBED_DIMENSIONS) : undefined;

  // Split into batches of 10 (API limit for Alibaba Cloud)
  const BATCH_SIZE = 10;
  for (let i = 0; i < uncachedTexts.length; i += BATCH_SIZE) {
    const batchTexts = uncachedTexts.slice(i, i + BATCH_SIZE);
    const batchIndices = uncachedIndices.slice(i, i + BATCH_SIZE);

    // Generate embeddings for this batch
    const response = await openai.embeddings.create({
      model,
      input: batchTexts,
      ...(dimensions && { dimensions }),
    });

    // Store results and cache
    response.data.forEach((item, j) => {
      const originalIndex = batchIndices[j];
      const text = batchTexts[j];
      results[originalIndex] = item.embedding;
      embeddingCache.set(text, item.embedding);
    });
  }

  return results;
}
