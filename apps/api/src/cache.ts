// Simple LRU cache implementation
class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    // Delete if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Add to end
    this.cache.set(key, value);

    // Evict oldest if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value as K;
      this.cache.delete(firstKey);
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// Cache instances
export const searchCache = new LRUCache<string, any>(200); // Cache 200 search results
export const embeddingCache = new LRUCache<string, number[]>(500); // Cache 500 embeddings

// Helper to generate cache key
export function generateCacheKey(...parts: (string | number)[]): string {
  return parts.join(':');
}

// Cache TTL wrapper
interface CacheEntry<T> {
  value: T;
  expiry: number;
}

export class TTLCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private ttl: number;
  private maxSize: number;

  constructor(ttl: number = 300000, maxSize: number = 100) {
    this.cache = new Map();
    this.ttl = ttl; // Default 5 minutes
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: K, value: V): void {
    // Evict oldest if over capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value as K;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + this.ttl,
    });
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// TTL cache for search results (5 minutes)
export const searchTTLCache = new TTLCache<string, any>(300000, 200);

/**
 * 查询结果缓存
 * 用于缓存 enhancedSearch 和 multiStageSearch 的结果
 *
 * 特点：
 * - TTL: 5 分钟（避免返回过时结果）
 * - 最大容量: 500 个查询
 * - 自动清理过期条目
 */
export const queryResultCache = new TTLCache<string, any>(300000, 500);

/**
 * 查询改写缓存
 * 用于缓存 generateQueryVariants 的结果
 *
 * 特点：
 * - TTL: 1 小时（查询改写结果相对稳定）
 * - 最大容量: 1000 个查询
 */
export const queryRewriteCache = new TTLCache<string, string[]>(3600000, 1000);

/**
 * HyDE 缓存
 * 用于缓存 generateHypotheticalCode 的结果
 *
 * 特点：
 * - TTL: 1 小时
 * - 最大容量: 500 个查询
 */
export const hydeCache = new TTLCache<string, string>(3600000, 500);

/**
 * 生成查询缓存键
 * 包含 repoId 和查询参数，确保不同仓库和配置的查询不会冲突
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
 * 缓存统计信息
 */
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
}

class CacheStatsTracker {
  private stats: Map<string, { hits: number; misses: number }> = new Map();

  recordHit(cacheName: string): void {
    const stat = this.stats.get(cacheName) || { hits: 0, misses: 0 };
    stat.hits++;
    this.stats.set(cacheName, stat);
  }

  recordMiss(cacheName: string): void {
    const stat = this.stats.get(cacheName) || { hits: 0, misses: 0 };
    stat.misses++;
    this.stats.set(cacheName, stat);
  }

  getStats(cacheName: string): { hits: number; misses: number; hitRate: number } {
    const stat = this.stats.get(cacheName) || { hits: 0, misses: 0 };
    const total = stat.hits + stat.misses;
    const hitRate = total > 0 ? stat.hits / total : 0;
    return { ...stat, hitRate };
  }

  getAllStats(): Record<string, { hits: number; misses: number; hitRate: number }> {
    const result: Record<string, any> = {};
    for (const [name, stat] of this.stats.entries()) {
      const total = stat.hits + stat.misses;
      const hitRate = total > 0 ? stat.hits / total : 0;
      result[name] = { ...stat, hitRate };
    }
    return result;
  }

  reset(): void {
    this.stats.clear();
  }
}

export const cacheStatsTracker = new CacheStatsTracker();

/**
 * 获取所有缓存的统计信息
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
