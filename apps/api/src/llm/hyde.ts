import Anthropic from '@anthropic-ai/sdk';
import { generateEmbedding } from './embeddings.js';
import { hydeCache, cacheStatsTracker } from '../cache.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  timeout: 10000,
  maxRetries: 2,
});

/**
 * HyDE (Hypothetical Document Embeddings)
 * 生成假设性的代码片段来改进检索，特别适合"如何实现 X"类问题
 *
 * 原理：
 * 1. 用户问："如何实现用户登录？"
 * 2. Claude 生成假设代码：function login(username, password) { ... }
 * 3. 对假设代码生成 embedding
 * 4. 用假设代码的 embedding 检索（代码和代码更相似）
 *
 * 支持缓存以避免重复生成相同查询的假设代码
 */
export async function generateHypotheticalCode(query: string): Promise<string> {
  // 检查缓存
  const cached = hydeCache.get(query);
  if (cached) {
    cacheStatsTracker.recordHit('hyde');
    console.log(`HyDE cache hit: "${query}"`);
    return cached;
  }

  cacheStatsTracker.recordMiss('hyde');

  try {
    const prompt = `用户问题: ${query}

请生成一段假设性的代码片段，展示可能实现这个功能的代码。

要求:
1. 包含关键的函数名、类名、变量名
2. 体现核心逻辑和 API 调用
3. 包含典型的实现模式（如错误处理、参数验证等）
4. 50-100 行代码即可
5. 使用常见的编程语言（TypeScript/JavaScript/Python/Java）

示例代码:`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0];
    const code = content.type === 'text' ? content.text : '';

    if (code) {
      console.log('HyDE: Generated hypothetical code');
      // 缓存结果
      hydeCache.set(query, code);
    }

    return code;
  } catch (error) {
    console.log('HyDE generation unavailable, skipping');
    return '';
  }
}

/**
 * 使用 HyDE 改进向量检索
 * 返回多个 embedding：原始查询 + 假设代码
 */
export async function hydeEnhancedEmbedding(query: string): Promise<{
  queryEmbedding: number[];
  codeEmbedding?: number[];
  hypotheticalCode?: string;
}> {
  // 1. 原始查询的 embedding
  const queryEmbedding = await generateEmbedding(query);

  // 2. 生成假设代码
  const hypotheticalCode = await generateHypotheticalCode(query);

  if (hypotheticalCode) {
    // 3. 假设代码的 embedding
    const codeEmbedding = await generateEmbedding(hypotheticalCode);
    return { queryEmbedding, codeEmbedding, hypotheticalCode };
  }

  return { queryEmbedding };
}

/**
 * 判断查询是否适合使用 HyDE
 *
 * HyDE 适用场景：
 * 1. "如何实现"类问题（生成假设代码更容易匹配）
 * 2. 功能探索类问题（不知道具体函数名）
 *
 * HyDE 不适用场景：
 * 1. 代码定位（已知函数名/文件名）
 * 2. Bug 分析（需要看实际代码，不是假设代码）
 * 3. 具体代码查询（直接匹配更快）
 */
export function shouldUseHyDE(query: string): boolean {
  // 排除：明确的代码定位查询
  const excludePatterns = [
    /在哪/,
    /位置/,
    /文件/,
    /函数.*在/,
    /类.*在/,
    /\.ts|\.js|\.py|\.java/,  // 包含文件扩展名
    /^[a-zA-Z_][a-zA-Z0-9_]*$/,  // 单个标识符（如 "login"）
  ];

  if (excludePatterns.some(pattern => pattern.test(query))) {
    return false;
  }

  // 包含：功能实现类查询
  const includePatterns = [
    /如何/,
    /怎么/,
    /怎样/,
    /怎麼/,
    /如何实现/,
    /怎么做/,
    /实现.*方法/,
    /实现.*功能/,
    /怎么.*实现/,
    /如何.*处理/,
  ];

  return includePatterns.some(pattern => pattern.test(query));
}

