/**
 * LRU（Least Recently Used）缓存实现
 * 最近最少使用缓存算法，当缓存满时自动淘汰最久未使用的条目
 *
 * 算法原理：
 * - 使用 Map 数据结构，利用其插入顺序特性
 * - 每次访问时将元素移到末尾（标记为最近使用）
 * - 当超过容量时，删除 Map 的第一个元素（最久未使用）
 *
 * 时间复杂度：
 * - get: O(1)
 * - set: O(1)
 *
 * 使用场景：
 * - 搜索结果缓存
 * - 向量嵌入缓存
 * - 频繁访问的热点数据
 *
 * @template K - 键的类型
 * @template V - 值的类型
 */
class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;

  /**
   * 构造函数
   * @param maxSize - 缓存最大容量，默认 100 个条目
   */
  constructor(maxSize: number = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * 获取缓存值
   * @param key - 缓存键
   * @returns 缓存值，如果不存在则返回 undefined
   *
   * 实现细节：
   * 1. 检查键是否存在
   * 2. 如果存在，先删除再重新插入（移到末尾，标记为最近使用）
   * 3. 返回对应的值
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // 移到末尾（标记为最近使用）
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * 设置缓存值
   * @param key - 缓存键
   * @param value - 缓存值
   *
   * 实现细节：
   * 1. 如果键已存在，先删除（更新位置）
   * 2. 将新键值对添加到末尾
   * 3. 如果超过容量，删除最旧的条目（Map 的第一个元素）
   */
  set(key: K, value: V): void {
    // 如果已存在则删除（用于更新位置）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // 添加到末尾
    this.cache.set(key, value);

    // 如果超过容量，淘汰最旧的条目
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value as K;
      this.cache.delete(firstKey);
    }
  }

  /**
   * 检查键是否存在
   * @param key - 缓存键
   * @returns 是否存在
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取当前缓存大小
   * @returns 缓存中的条目数量
   */
  size(): number {
    return this.cache.size;
  }
}

/**
 * 缓存实例：搜索结果缓存
 * 缓存 200 个搜索结果，使用 LRU 策略
 */
export const searchCache = new LRUCache<string, any>(200);

/**
 * 缓存实例：向量嵌入缓存
 * 缓存 500 个文本的向量嵌入结果
 * 向量嵌入计算成本高，缓存可显著提升性能
 */
export const embeddingCache = new LRUCache<string, number[]>(500);

/**
 * 生成缓存键的辅助函数
 * 将多个参数组合成唯一的缓存键
 *
 * @param parts - 键的组成部分（字符串或数字）
 * @returns 用冒号连接的缓存键字符串
 *
 * 示例：
 * generateCacheKey('search', '123', 'login') => 'search:123:login'
 */
export function generateCacheKey(...parts: (string | number)[]): string {
  return parts.join(':');
}

/**
 * 缓存条目接口
 * 包含值和过期时间的缓存条目
 *
 * @template T - 缓存值的类型
 */
interface CacheEntry<T> {
  value: T;
  expiry: number; // 过期时间戳（毫秒）
}

/**
 * TTL（Time To Live）缓存实现
 * 带有过期时间的缓存，自动清理过期条目
 *
 * 算法原理：
 * - 每个缓存条目包含值和过期时间戳
 * - 读取时检查是否过期，过期则自动删除
 * - 写入时计算过期时间 = 当前时间 + TTL
 *
 * 与 LRU 的区别：
 * - LRU 基于访问频率淘汰，TTL 基于时间淘汰
 * - TTL 适合有时效性的数据（如查询结果）
 * - LRU 适合热点数据缓存
 *
 * 使用场景：
 * - 查询结果缓存（15分钟有效期）
 * - 查询改写缓存（2小时有效期）
 * - 临时计算结果
 *
 * @template K - 键的类型
 * @template V - 值的类型
 */
export class TTLCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private ttl: number; // 生存时间（毫秒）
  private maxSize: number;

  /**
   * 构造函数
   * @param ttl - 生存时间（毫秒），默认 5 分钟
   * @param maxSize - 最大容量，默认 100 个条目
   */
  constructor(ttl: number = 300000, maxSize: number = 100) {
    this.cache = new Map();
    this.ttl = ttl; // 默认 5 分钟
    this.maxSize = maxSize;
  }

  /**
   * 获取缓存值
   * @param key - 缓存键
   * @returns 缓存值，如果不存在或已过期则返回 undefined
   *
   * 实现细节：
   * 1. 检查键是否存在
   * 2. 检查是否过期（当前时间 > 过期时间）
   * 3. 如果过期，删除条目并返回 undefined
   * 4. 否则返回缓存值
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // 检查是否过期
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * 设置缓存值
   * @param key - 缓存键
   * @param value - 缓存值
   *
   * 实现细节：
   * 1. 如果超过容量，删除最旧的条目（FIFO 策略）
   * 2. 存储值和过期时间戳
   */
  set(key: K, value: V): void {
    // 如果超过容量，淘汰最旧的条目
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value as K;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + this.ttl, // 计算过期时间
    });
  }

  /**
   * 检查键是否存在且未过期
   * @param key - 缓存键
   * @returns 是否存在且有效
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // 检查是否过期
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取当前缓存大小
   * @returns 缓存中的条目数量
   */
  size(): number {
    return this.cache.size;
  }
}

/**
 * 搜索结果 TTL 缓存实例
 * TTL: 15 分钟，容量: 200 个查询
 *
 * 优化说明：延长缓存时间从 5 分钟到 15 分钟，减少重复计算
 */
export const searchTTLCache = new TTLCache<string, any>(900000, 200);

/**
 * 查询结果缓存
 * 用于缓存 enhancedSearch 和 multiStageSearch 的结果
 *
 * 特点：
 * - TTL: 15 分钟（优化：从 5 分钟延长到 15 分钟，减少重复计算）
 * - 最大容量: 500 个查询
 * - 自动清理过期条目
 *
 * 使用场景：
 * - 代码搜索结果缓存
 * - 多策略搜索结果缓存
 * - 减少向量检索和语义分析的重复计算
 */
export const queryResultCache = new TTLCache<string, any>(900000, 500);

/**
 * 查询改写缓存
 * 用于缓存 generateQueryVariants 的结果
 *
 * 特点：
 * - TTL: 2 小时（优化：查询改写结果非常稳定，延长缓存时间）
 * - 最大容量: 1000 个查询
 *
 * 使用场景：
 * - 查询扩展和同义词替换
 * - 自然语言查询改写
 * - 减少 LLM 调用次数
 *
 * 为什么缓存时间长：
 * - 查询改写结果相对稳定，不随代码库变化
 * - LLM 调用成本高，长时间缓存可显著降低成本
 */
export const queryRewriteCache = new TTLCache<string, string[]>(7200000, 1000);

/**
 * HyDE（Hypothetical Document Embeddings）缓存
 * 用于缓存 generateHypotheticalCode 的结果
 *
 * HyDE 算法说明：
 * - 根据查询生成假设性的代码片段
 * - 对假设代码进行向量化
 * - 使用假设代码的向量进行相似度搜索
 * - 提高语义搜索的准确性
 *
 * 特点：
 * - TTL: 2 小时（优化：延长缓存时间）
 * - 最大容量: 500 个查询
 *
 * 使用场景：
 * - 自然语言到代码的语义搜索
 * - 提高搜索召回率
 * - 减少 LLM 生成假设代码的调用
 */
export const hydeCache = new TTLCache<string, string>(7200000, 500);

/**
 * 生成查询缓存键
 * 包含 repoId 和查询参数，确保不同仓库和配置的查询不会冲突
 *
 * @param repoId - 仓库 ID
 * @param query - 查询字符串
 * @param options - 可选的查询配置参数
 * @returns 唯一的缓存键
 *
 * 缓存键格式：query:{repoId}:{query}:{optionsJson}
 *
 * 示例：
 * generateQueryCacheKey(1, 'login', {enhanced: true})
 * => 'query:1:login:{"enhanced":true}'
 */
export function generateQueryCacheKey(
  repoId: number,
  query: string,
  options?: Record<string, any>
): string {
  const optionsStr = options ? JSON.stringify(options) : '';
  return `query:${repoId}:${query}:${optionsStr}`;
}

/**
 * 缓存统计信息接口
 * 用于监控缓存性能和命中率
 *
 * @property hits - 缓存命中次数
 * @property misses - 缓存未命中次数
 * @property hitRate - 命中率（0-1 之间）
 * @property size - 当前缓存大小
 * @property maxSize - 最大缓存容量
 */
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
}

/**
 * 缓存统计追踪器
 * 记录每个缓存的命中和未命中情况，用于性能分析
 *
 * 使用场景：
 * - 监控缓存效果
 * - 优化缓存策略
 * - 性能调优
 */
class CacheStatsTracker {
  private stats: Map<string, { hits: number; misses: number }> = new Map();

  /**
   * 记录缓存命中
   * @param cacheName - 缓存名称
   */
  recordHit(cacheName: string): void {
    const stat = this.stats.get(cacheName) || { hits: 0, misses: 0 };
    stat.hits++;
    this.stats.set(cacheName, stat);
  }

  /**
   * 记录缓存未命中
   * @param cacheName - 缓存名称
   */
  recordMiss(cacheName: string): void {
    const stat = this.stats.get(cacheName) || { hits: 0, misses: 0 };
    stat.misses++;
    this.stats.set(cacheName, stat);
  }

  /**
   * 获取指定缓存的统计信息
   * @param cacheName - 缓存名称
   * @returns 包含命中、未命中和命中率的统计对象
   */
  getStats(cacheName: string): { hits: number; misses: number; hitRate: number } {
    const stat = this.stats.get(cacheName) || { hits: 0, misses: 0 };
    const total = stat.hits + stat.misses;
    const hitRate = total > 0 ? stat.hits / total : 0;
    return { ...stat, hitRate };
  }

  /**
   * 获取所有缓存的统计信息
   * @returns 所有缓存的统计信息映射
   */
  getAllStats(): Record<string, { hits: number; misses: number; hitRate: number }> {
    const result: Record<string, any> = {};
    for (const [name, stat] of this.stats.entries()) {
      const total = stat.hits + stat.misses;
      const hitRate = total > 0 ? stat.hits / total : 0;
      result[name] = { ...stat, hitRate };
    }
    return result;
  }

  /**
   * 重置所有统计信息
   */
  reset(): void {
    this.stats.clear();
  }
}

/**
 * 全局缓存统计追踪器实例
 */
export const cacheStatsTracker = new CacheStatsTracker();

/**
 * 获取所有缓存的统计信息
 * 包含命中率、大小等性能指标
 *
 * @returns 所有缓存的详细统计信息
 *
 * 使用场景：
 * - 管理后台展示缓存状态
 * - 性能监控和告警
 * - 缓存策略优化决策
 */
export function getAllCacheStats(): Record<string, CacheStats> {
  const stats = cacheStatsTracker.getAllStats();

  return {
    queryResult: {
      ...stats.queryResult,
      size: queryResultCache.size(),
      maxSize: 500,
    },
    queryRewrite: {
      ...stats.queryRewrite,
      size: queryRewriteCache.size(),
      maxSize: 1000,
    },
    hyde: {
      ...stats.hyde,
      size: hydeCache.size(),
      maxSize: 500,
    },
    embedding: {
      ...stats.embedding,
      size: embeddingCache.size(),
      maxSize: 500,
    },
  };
}

/**
 * 清空所有缓存
 * 用于手动刷新缓存或故障恢复
 *
 * 使用场景：
 * - 代码库更新后清除旧缓存
 * - 缓存数据异常时重置
 * - 管理员手动清理
 *
 * 注意：清空缓存会导致短期性能下降，直到缓存重新预热
 */
export function clearAllCaches(): void {
  queryResultCache.clear();
  queryRewriteCache.clear();
  hydeCache.clear();
  embeddingCache.clear();
  searchCache.clear();
  searchTTLCache.clear();
  cacheStatsTracker.reset();
  console.log('All caches cleared');
}
