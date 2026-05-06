import OpenAI from 'openai';
import { embeddingCache, cacheStatsTracker } from '../cache.js';

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: process.env.EMBED_BASE_URL,
    });
  }
  return openai;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  initialDelay = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if it's a rate limit error (429)
      if (error?.status === 429) {
        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          const delay = initialDelay * Math.pow(2, attempt);
          console.log(`Rate limit hit, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
          await sleep(delay);
          continue;
        }
      }

      // For other errors, throw immediately
      throw error;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

export async function generateEmbedding(text: string): Promise<number[]> {
  // Check cache first
  const cached = embeddingCache.get(text);
  if (cached) {
    cacheStatsTracker.recordHit('embedding');
    console.log('Embedding cache hit');
    return cached;
  }

  cacheStatsTracker.recordMiss('embedding');

  const model = process.env.EMBED_MODEL || 'text-embedding-v4';
  const dimensions = process.env.EMBED_DIMENSIONS ? parseInt(process.env.EMBED_DIMENSIONS) : undefined;

  // Truncate text to max 8000 characters (roughly 8192 tokens for Chinese/English mix)
  const truncatedText = text.length > 8000 ? text.substring(0, 8000) : text;

  // Use retry with exponential backoff for rate limit handling
  const response = await retryWithBackoff(async () => {
    return await getOpenAI().embeddings.create({
      model,
      input: truncatedText,
      ...(dimensions && { dimensions }),
    });
  });

  const embedding = response.data[0].embedding;

  // Cache the result (use original text as key)
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

  const model = process.env.EMBED_MODEL || 'text-embedding-v4';
  const dimensions = process.env.EMBED_DIMENSIONS ? parseInt(process.env.EMBED_DIMENSIONS) : undefined;

  // Split into batches of 10 (API limit for Alibaba Cloud)
  const BATCH_SIZE = 10;
  for (let i = 0; i < uncachedTexts.length; i += BATCH_SIZE) {
    const batchTexts = uncachedTexts.slice(i, i + BATCH_SIZE);
    const batchIndices = uncachedIndices.slice(i, i + BATCH_SIZE);

    // Truncate each text to max 8000 characters (roughly 8192 tokens)
    const truncatedBatchTexts = batchTexts.map(text =>
      text.length > 8000 ? text.substring(0, 8000) : text
    );

    // Generate embeddings for this batch with retry logic
    const response = await retryWithBackoff(async () => {
      return await getOpenAI().embeddings.create({
        model,
        input: truncatedBatchTexts,
        ...(dimensions && { dimensions }),
      });
    });

    // Store results and cache (use original text as key)
    response.data.forEach((item, j) => {
      const originalIndex = batchIndices[j];
      const originalText = batchTexts[j];
      results[originalIndex] = item.embedding;
      embeddingCache.set(originalText, item.embedding);
    });

    // Add a small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < uncachedTexts.length) {
      await sleep(200); // 200ms delay between batches
    }
  }

  return results;
}
