import Anthropic from '@anthropic-ai/sdk';
import { queryRewriteCache, cacheStatsTracker } from '../cache.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  timeout: 10000, // 10 seconds timeout
  maxRetries: 2, // Retry twice on 502/503 errors
});

/**
 * Generate query variants to improve retrieval recall
 * Uses Claude to create multiple reformulations of the user's query
 * 支持缓存以避免重复生成相同查询的变体
 */
export async function generateQueryVariants(query: string): Promise<string[]> {
  // 检查缓存
  const cached = queryRewriteCache.get(query);
  if (cached) {
    cacheStatsTracker.recordHit('queryRewrite');
    console.log(`Query rewrite cache hit: "${query}"`);
    return cached;
  }

  cacheStatsTracker.recordMiss('queryRewrite');
  const prompt = `你是一个查询改写专家。给定一个代码搜索查询，生成 3-5 个语义相似但表达不同的查询变体，以提高检索召回率。

原始查询: ${query}

要求:
1. 保持原始查询的核心意图
2. 使用不同的技术术语和表达方式
3. 包含相关的同义词和缩写
4. 考虑不同的抽象层次（具体实现 vs 概念描述）
5. 每行一个查询变体，不要编号

示例:
原始查询: "登录功能是怎么实现的？"
变体:
用户认证的实现方式
登录逻辑和鉴权流程
用户身份验证代码
login authentication implementation
登录接口和 token 处理

现在请为上面的查询生成变体:`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', // 优化：使用 Sonnet 提升速度（保持质量）
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      return [query];
    }

    // Parse variants from response
    const variants = content.text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.match(/^(变体|示例|原始查询)[:：]/))
      .filter(line => line.length > 3);

    // Always include original query
    const result = [query, ...variants];

    // 缓存结果
    queryRewriteCache.set(query, result);
    console.log(`Query rewrite cached: "${query}" -> ${result.length} variants`);

    return result;
  } catch (error) {
    console.error('Query rewrite failed:', error);
    // Fallback to original query
    return [query];
  }
}

/**
 * Classify query type for routing
 */
export async function classifyQueryType(query: string): Promise<'simple_lookup' | 'semantic_search' | 'complex_reasoning' | 'root_cause'> {
  const prompt = `分类以下代码查询的类型，只返回类型名称：

查询: ${query}

类型定义:
- simple_lookup: 简单的关键词查找（如"找到 login 函数"）
- semantic_search: 语义搜索（如"如何实现用户认证"）
- complex_reasoning: 复杂推理（如"为什么这个功能会导致性能问题"）
- root_cause: 根因分析（如"登录一天要登录好几次，什么原因"）

只返回类型名称，不要其他内容:`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      return 'semantic_search';
    }

    const type = content.text.trim().toLowerCase();
    if (type.includes('simple_lookup')) return 'simple_lookup';
    if (type.includes('root_cause')) return 'root_cause';
    if (type.includes('complex_reasoning')) return 'complex_reasoning';
    return 'semantic_search';
  } catch (error) {
    console.error('Query classification failed:', error);
    return 'semantic_search';
  }
}
