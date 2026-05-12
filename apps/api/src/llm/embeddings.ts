/**
 * 向量嵌入生成模块 - 将文本转换为高维向量表示
 *
 * 功能说明：
 * - 使用 OpenAI 兼容的嵌入模型将文本转换为向量
 * - 支持单个文本和批量文本的嵌入生成
 * - 内置缓存机制，避免重复计算相同文本的嵌入
 * - 自动处理文本截断，确保不超过模型的 token 限制
 *
 * 使用场景：
 * - 代码语义搜索：将代码片段转换为向量，用于相似度匹配
 * - 问答系统：将用户查询和代码文档转换为向量，找到最相关的内容
 * - 代码聚类：通过向量相似度对代码进行分组
 */

import OpenAI from 'openai';
import { embeddingCache, cacheStatsTracker } from '../cache.js';

// OpenAI 客户端单例，避免重复创建连接
let openai: OpenAI | null = null;

/**
 * 获取 OpenAI 客户端实例（懒加载单例模式）
 *
 * 环境变量配置：
 * - EMBED_API_KEY 或 OPENAI_API_KEY: API 密钥
 * - EMBED_BASE_URL: 自定义 API 端点（可选，用于兼容其他服务商）
 *
 * @returns OpenAI 客户端实例
 */
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
 * 生成单个文本的向量嵌入
 *
 * 工作流程：
 * 1. 检查缓存：如果文本已经生成过嵌入，直接返回缓存结果
 * 2. 文本截断：限制在 8000 字符以内（约 8192 tokens）
 * 3. 调用 API：使用配置的模型生成嵌入向量
 * 4. 缓存结果：将生成的向量存入缓存，加速后续查询
 *
 * 性能优化：
 * - 使用 LRU 缓存避免重复计算
 * - 自动截断超长文本，防止 API 调用失败
 * - 记录缓存命中率，便于监控优化效果
 *
 * @param text - 要生成嵌入的文本内容
 * @returns 嵌入向量（数字数组，维度由模型决定，通常为 1024 或 1536）
 *
 * @example
 * const embedding = await generateEmbedding("function getUserById(id) { ... }");
 * // 返回: [0.123, -0.456, 0.789, ...] (1024维向量)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // 优先检查缓存，避免重复计算
  const cached = embeddingCache.get(text);
  if (cached) {
    cacheStatsTracker.recordHit('embedding'); // 记录缓存命中
    console.log('Embedding cache hit');
    return cached;
  }

  cacheStatsTracker.recordMiss('embedding'); // 记录缓存未命中

  // 从环境变量读取模型配置
  const model = process.env.EMBED_MODEL || 'text-embedding-v4';
  const dimensions = process.env.EMBED_DIMENSIONS ? parseInt(process.env.EMBED_DIMENSIONS) : undefined;

  // 截断文本到最大 8000 字符（约 8192 tokens，适用于中英文混合）
  // 这是为了防止超过模型的 token 限制导致 API 调用失败
  const truncatedText = text.length > 8000 ? text.substring(0, 8000) : text;

  // 调用 OpenAI API 生成嵌入向量
  const response = await getOpenAI().embeddings.create({
    model,
    input: truncatedText,
    ...(dimensions && { dimensions }), // 可选：指定向量维度
  });

  const embedding = response.data[0].embedding;

  // 将结果存入缓存（使用原始文本作为 key）
  embeddingCache.set(text, embedding);

  return embedding;
}

/**
 * 批量生成多个文本的向量嵌入
 *
 * 批量处理优势：
 * - 减少 API 调用次数，提高吞吐量
 * - 智能缓存检查，只为未缓存的文本生成嵌入
 * - 自动分批处理，避免超过 API 的批量限制
 *
 * 工作流程：
 * 1. 缓存检查：遍历所有文本，将已缓存的直接填充到结果中
 * 2. 批量生成：将未缓存的文本分批（每批 10 个）调用 API
 * 3. 结果合并：将新生成的嵌入和缓存的嵌入合并为完整结果
 * 4. 更新缓存：将新生成的嵌入存入缓存
 *
 * 性能优化：
 * - 批量大小设为 10（阿里云等服务商的 API 限制）
 * - 保持结果顺序与输入顺序一致
 * - 最大化利用缓存，减少不必要的 API 调用
 *
 * @param texts - 要生成嵌入的文本数组
 * @returns 嵌入向量数组，顺序与输入文本对应
 *
 * @example
 * const texts = [
 *   "function getUserById(id) { ... }",
 *   "class UserService { ... }",
 *   "const API_URL = '/api/users';"
 * ];
 * const embeddings = await batchGenerateEmbeddings(texts);
 * // 返回: [[0.1, 0.2, ...], [0.3, 0.4, ...], [0.5, 0.6, ...]]
 */
export async function batchGenerateEmbeddings(texts: string[]): Promise<number[][]> {
  const uncachedTexts: string[] = []; // 未缓存的文本
  const uncachedIndices: number[] = []; // 未缓存文本在原数组中的索引
  const results: number[][] = new Array(texts.length); // 最终结果数组

  // 第一步：检查缓存，将已缓存的嵌入直接填充到结果中
  texts.forEach((text, index) => {
    const cached = embeddingCache.get(text);
    if (cached) {
      results[index] = cached; // 使用缓存的嵌入
    } else {
      uncachedTexts.push(text); // 记录需要生成的文本
      uncachedIndices.push(index); // 记录原始索引，用于后续填充结果
    }
  });

  // 如果全部命中缓存，直接返回
  if (uncachedTexts.length === 0) {
    console.log('All embeddings from cache');
    return results;
  }

  console.log(`Generating ${uncachedTexts.length}/${texts.length} embeddings`);

  // 从环境变量读取模型配置
  const model = process.env.EMBED_MODEL || 'text-embedding-v4';
  const dimensions = process.env.EMBED_DIMENSIONS ? parseInt(process.env.EMBED_DIMENSIONS) : undefined;

  // 第二步：分批处理未缓存的文本
  // 批量大小设为 10（阿里云等服务商的 API 限制）
  const BATCH_SIZE = 10;
  for (let i = 0; i < uncachedTexts.length; i += BATCH_SIZE) {
    const batchTexts = uncachedTexts.slice(i, i + BATCH_SIZE);
    const batchIndices = uncachedIndices.slice(i, i + BATCH_SIZE);

    // 截断每个文本到最大 8000 字符（约 8192 tokens）
    const truncatedBatchTexts = batchTexts.map(text =>
      text.length > 8000 ? text.substring(0, 8000) : text
    );

    // 批量调用 API 生成嵌入
    const response = await getOpenAI().embeddings.create({
      model,
      input: truncatedBatchTexts,
      ...(dimensions && { dimensions }),
    });

    // 第三步：将生成的嵌入填充到结果数组，并更新缓存
    response.data.forEach((item, j) => {
      const originalIndex = batchIndices[j]; // 获取原始索引
      const originalText = batchTexts[j]; // 获取原始文本（未截断）
      results[originalIndex] = item.embedding; // 填充结果
      embeddingCache.set(originalText, item.embedding); // 更新缓存（使用原始文本作为 key）
    });
  }

  return results;
}
