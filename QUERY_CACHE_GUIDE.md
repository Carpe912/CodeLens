# 查询缓存功能说明

## 概述

查询缓存是一个高性价比的优化功能，能够显著提升搜索性能并降低 API 成本。

## 核心优势

| 指标 | 优化效果 |
|------|---------|
| **响应速度** | 2000ms → 50ms（提升 95%） |
| **成本节省** | 节省 50-70% 的重复查询成本 |
| **内存占用** | < 100MB（可配置） |
| **命中率** | 预期 40-60%（取决于查询重复度） |

## 缓存层级

### 1. 查询结果缓存（Query Result Cache）
- **用途**：缓存 `enhancedSearch()` 和 `multiStageSearch()` 的完整结果
- **TTL**：5 分钟
- **容量**：500 个查询
- **命中场景**：用户重复搜索相同问题

**示例**：
```typescript
// 第一次查询：2000ms（需要调用 Claude + 向量检索 + Rerank）
const results = await enhancedSearch(repoId, "如何实现登录");

// 第二次查询（5 分钟内）：50ms（直接返回缓存）
const results = await enhancedSearch(repoId, "如何实现登录");
```

### 2. 查询改写缓存（Query Rewrite Cache）
- **用途**：缓存 `generateQueryVariants()` 的结果
- **TTL**：1 小时
- **容量**：1000 个查询
- **节省成本**：每次命中节省 ~$0.002

**示例**：
```typescript
// 第一次：调用 Claude 生成查询变体（~500 tokens）
const variants = await generateQueryVariants("如何实现登录");
// 返回：["如何实现登录", "用户认证的实现方式", "登录逻辑和鉴权流程", ...]

// 第二次（1 小时内）：直接返回缓存，节省 $0.002
const variants = await generateQueryVariants("如何实现登录");
```

### 3. HyDE 缓存（Hypothetical Document Cache）
- **用途**：缓存 `generateHypotheticalCode()` 的结果
- **TTL**：1 小时
- **容量**：500 个查询
- **节省成本**：每次命中节省 ~$0.0015

**示例**：
```typescript
// 第一次：调用 Claude 生成假设代码
const code = await generateHypotheticalCode("如何实现 JWT 认证");
// 返回：function verifyJWT(token) { ... }

// 第二次（1 小时内）：直接返回缓存，节省 $0.0015
const code = await generateHypotheticalCode("如何实现 JWT 认证");
```

### 4. Embedding 缓存（已有）
- **用途**：缓存文本的 embedding 向量
- **容量**：500 个文本
- **节省成本**：每次命中节省 ~$0.0001

## 使用方式

### 默认启用（推荐）

所有缓存**默认启用**，无需修改代码：

```typescript
// 自动使用缓存
const results = await enhancedSearch(repoId, query);
```

### 禁用缓存（特殊场景）

如果需要强制获取最新结果：

```typescript
const results = await enhancedSearch(repoId, query, {
  useCache: false,  // 禁用查询结果缓存
});
```

## 缓存管理 API

### 查看缓存统计

```bash
curl http://localhost:8787/admin/cache/stats
```

**返回示例**：
```json
{
  "queryResult": {
    "hits": 120,
    "misses": 80,
    "hitRate": 0.6,
    "size": 150,
    "maxSize": 500
  },
  "queryRewrite": {
    "hits": 200,
    "misses": 100,
    "hitRate": 0.67,
    "size": 250,
    "maxSize": 1000
  },
  "hyde": {
    "hits": 50,
    "misses": 30,
    "hitRate": 0.625,
    "size": 60,
    "maxSize": 500
  },
  "embedding": {
    "hits": 300,
    "misses": 200,
    "hitRate": 0.6,
    "size": 400,
    "maxSize": 500
  }
}
```

### 清空所有缓存

```bash
curl -X POST http://localhost:8787/admin/cache/clear
```

**使用场景**：
- 代码库更新后，需要清空旧的查询结果
- 调试时需要强制重新计算
- 内存压力大时手动清理

## 性能分析

### 典型查询流程（无缓存）

```
用户查询 "如何实现登录"
  ↓
1. Query Rewrite (500ms, $0.002)
  ↓
2. Generate Embedding (200ms, $0.0001)
  ↓
3. HyDE (500ms, $0.0015)
  ↓
4. Vector Search (300ms)
  ↓
5. Rerank (500ms, $0.001)
  ↓
总计: 2000ms, $0.0046
```

### 典型查询流程（有缓存，命中）

```
用户查询 "如何实现登录"
  ↓
1. 检查查询结果缓存 → 命中！
  ↓
总计: 50ms, $0
```

### 成本节省计算

假设每天 1000 次查询，命中率 50%：

| 项目 | 无缓存 | 有缓存 | 节省 |
|------|--------|--------|------|
| **每次查询成本** | $0.0046 | $0.0023 | 50% |
| **每天成本** | $4.60 | $2.30 | $2.30 |
| **每月成本** | $138 | $69 | $69 |
| **每年成本** | $1,679 | $840 | **$839** |

## 缓存键设计

查询结果缓存的键包含：
- `repoId`：仓库 ID
- `query`：查询文本
- `options`：查询选项（useQueryRewrite, useReranking, useHyDE, topK）

**示例**：
```typescript
// 不同的查询选项会生成不同的缓存键
const key1 = generateQueryCacheKey(1, "login", { useHyDE: true });
// "query:1:login:{"useHyDE":true}"

const key2 = generateQueryCacheKey(1, "login", { useHyDE: false });
// "query:1:login:{"useHyDE":false}"
```

这确保了：
- 不同仓库的相同查询不会冲突
- 不同配置的相同查询不会冲突

## 缓存失效策略

### 自动失效（TTL）

| 缓存类型 | TTL | 原因 |
|---------|-----|------|
| 查询结果 | 5 分钟 | 代码可能更新，避免返回过时结果 |
| 查询改写 | 1 小时 | 查询改写结果相对稳定 |
| HyDE | 1 小时 | 假设代码生成结果稳定 |
| Embedding | 永久 | 相同文本的 embedding 不会变化 |

### 手动失效

1. **代码库更新后**：
   ```bash
   curl -X POST http://localhost:8787/admin/cache/clear
   ```

2. **重新索引后**：
   ```bash
   # 自动清空缓存（可选，在 reindex 逻辑中添加）
   ```

## 监控建议

### 关键指标

1. **命中率（Hit Rate）**
   - 目标：> 40%
   - 如果 < 30%：说明查询重复度低，缓存效果有限
   - 如果 > 60%：说明缓存效果很好

2. **缓存大小（Size）**
   - 监控是否接近 maxSize
   - 如果经常满：考虑增加容量

3. **成本节省**
   - 计算公式：`节省 = hits × 单次查询成本`
   - 示例：120 hits × $0.0046 = $0.55/天

### 日志示例

```
Query cache hit: "如何实现登录"
Query rewrite cache hit: "如何实现登录"
HyDE cache hit: "如何实现 JWT 认证"
Embedding cache hit
```

## 配置调优

### 增加缓存容量（如果内存充足）

编辑 [apps/api/src/cache.ts](apps/api/src/cache.ts)：

```typescript
// 查询结果缓存：500 → 1000
export const queryResultCache = new TTLCache<string, any>(300000, 1000);

// 查询改写缓存：1000 → 2000
export const queryRewriteCache = new TTLCache<string, string[]>(3600000, 2000);
```

### 调整 TTL（如果需要更长的缓存时间）

```typescript
// 查询结果缓存：5 分钟 → 10 分钟
export const queryResultCache = new TTLCache<string, any>(600000, 500);

// 查询改写缓存：1 小时 → 2 小时
export const queryRewriteCache = new TTLCache<string, string[]>(7200000, 1000);
```

## 注意事项

1. **代码更新后记得清空缓存**
   - 否则可能返回基于旧代码的搜索结果

2. **不要过度依赖缓存**
   - 缓存是优化，不是核心功能
   - 缓存失效时系统应该正常工作

3. **监控内存使用**
   - 每个缓存条目约 10-50KB
   - 总内存占用 < 100MB（默认配置）

4. **缓存命中率取决于用户行为**
   - 如果用户总是问新问题：命中率低
   - 如果用户重复搜索：命中率高

## 总结

查询缓存是一个**低成本、高收益**的优化：

✅ **优点**：
- 响应速度提升 95%（2s → 50ms）
- 成本节省 50-70%
- 实现简单，维护成本低
- 内存占用小（< 100MB）

⚠️ **限制**：
- 只对重复查询有效
- 需要定期清空（代码更新后）
- 命中率取决于用户行为

**推荐**：保持默认启用，定期监控命中率和成本节省。
