import OpenAI from 'openai';
import { embeddingCache } from '../cache.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateEmbedding(text: string): Promise<number[]> {
  // Check cache first
  const cached = embeddingCache.get(text);
  if (cached) {
    console.log('Embedding cache hit');
    return cached;
  }

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
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

  // Generate embeddings for uncached texts
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: uncachedTexts,
  });

  // Store results and cache
  response.data.forEach((item, i) => {
    const originalIndex = uncachedIndices[i];
    const text = uncachedTexts[i];
    results[originalIndex] = item.embedding;
    embeddingCache.set(text, item.embedding);
  });

  return results;
}
