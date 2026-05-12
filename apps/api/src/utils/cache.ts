/**
 * LRU 缓存实现（支持 TTL 过期时间）
 * 用于缓存搜索结果和向量嵌入
 *
 * LRU (Least Recently Used) 算法说明：
 * - 当缓存满时，优先淘汰最久未使用的条目
 * - 每次访问会将条目移到队列末尾（最近使用）
 * - 结合 TTL 机制，过期条目会被自动清理
 *
 * 使用场景：
 * - 搜索结果缓存：避免重复的相似搜索查询
 * - 向量嵌入缓存：减少重复的向量计算开销
 * - API 响应缓存：提升接口响应速度
 */

/**
 * 缓存条目接口
 * @template T 缓存值的类型
 */
interface CacheEntry<T> {
  value: T;           // 缓存的实际值
  timestamp: number;  // 创建时间戳（毫秒）
  accessCount: number; // 访问次数统计
}

/**
 * LRU 缓存类
 * @template T 缓存值的类型
 */
export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>; // 使用 Map 保持插入顺序
  private maxSize: number;  // 最大缓存条目数
  private ttl: number;      // 过期时间（毫秒）

  /**
   * 构造函数
   * @param maxSize 最大缓存条目数，默认 100
   * @param ttlMinutes 过期时间（分钟），默认 5 分钟
   */
  constructor(maxSize: number = 100, ttlMinutes: number = 5) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttlMinutes * 60 * 1000; // 转换为毫秒
  }

  /**
   * 从缓存中获取值
   * @param key 缓存键
   * @returns 缓存的值，如果不存在或已过期则返回 null
   *
   * 实现细节：
   * 1. 检查键是否存在
   * 2. 验证是否过期（当前时间 - 创建时间 > TTL）
   * 3. 更新访问计数
   * 4. 将条目移到 Map 末尾（LRU 策略）
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key); // 删除过期条目
      return null;
    }

    // 更新访问计数并移到末尾（最近使用）
    entry.accessCount++;
    this.cache.delete(key);   // 先删除
    this.cache.set(key, entry); // 再添加到末尾

    return entry.value;
  }

  /**
   * 设置缓存值
   * @param key 缓存键
   * @param value 要缓存的值
   *
   * 实现细节：
   * 1. 如果键已存在，先删除旧值
   * 2. 如果缓存已满，淘汰最久未使用的条目（Map 的第一个元素）
   * 3. 添加新条目到末尾
   */
  set(key: string, value: T): void {
    // 如果已存在则先删除
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // 如果达到容量上限，淘汰最久未使用的条目（第一个）
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    // 添加新条目
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 1, // 初始访问次数为 1
    });
  }

  /**
   * 检查键是否存在且未过期
   * @param key 缓存键
   * @returns 如果存在且未过期返回 true
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * 清空所有缓存条目
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计信息
   * @returns 包含缓存大小、最大容量和命中率的对象
   *
   * 命中率计算：
   * - 总命中次数 = 所有条目的（访问次数 - 1）之和
   * - 命中率 = 总命中次数 / 总访问次数
   */
  getStats(): { size: number; maxSize: number; hitRate: number } {
    let totalAccess = 0;  // 总访问次数
    let totalHits = 0;    // 总命中次数

    for (const entry of this.cache.values()) {
      totalAccess += entry.accessCount;
      if (entry.accessCount > 1) {
        // 访问次数 > 1 说明有缓存命中
        totalHits += entry.accessCount - 1;
      }
    }

    return {
      size: this.cache.size,      // 当前缓存条目数
      maxSize: this.maxSize,      // 最大容量
      hitRate: totalAccess > 0 ? totalHits / totalAccess : 0, // 命中率
    };
  }

  /**
   * 清理过期条目
   *
   * 使用场景：
   * - 定期调用以释放内存
   * - 在缓存容量接近上限时主动清理
   */
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    // 收集所有过期的键
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        keysToDelete.push(key);
      }
    }

    // 批量删除过期条目
    keysToDelete.forEach(key => this.cache.delete(key));
  }
}

/**
 * 从查询参数生成缓存键
 * @param prefix 键前缀，用于区分不同类型的缓存
 * @param params 查询参数列表
 * @returns 格式化的缓存键字符串
 *
 * 示例：
 * generateCacheKey('search', 'react', { limit: 10 })
 * => 'search:react:{"limit":10}'
 *
 * 实现细节：
 * - 对象参数会被 JSON 序列化
 * - 其他类型转换为字符串
 * - 使用冒号分隔各部分
 */
export function generateCacheKey(prefix: string, ...params: any[]): string {
  return `${prefix}:${params.map(p =>
    typeof p === 'object' ? JSON.stringify(p) : String(p)
  ).join(':')}`;
}
