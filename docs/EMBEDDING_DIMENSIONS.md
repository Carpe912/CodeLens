# 向量维度配置说明

## 概述

CodeLens 使用向量嵌入（Vector Embeddings）来实现代码的语义搜索功能。本文档说明向量维度的配置和迁移方法。

## 当前配置

### 统一维度：1536

所有表的 `embedding` 列现在统一使用 **1536 维**向量：

- ✅ `code_chunks` - 代码块表
- ✅ `string_constants` - 字符串常量表
- ✅ `url_patterns` - URL 模式表
- ✅ `functions` - 函数表
- ✅ `classes` - 类表

### 环境变量配置

```bash
EMBED_MODEL=text-embedding-v4
EMBED_DIMENSIONS=1536
EMBED_API_KEY=your_api_key
EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

## 为什么是 1536 维？

1. **模型默认输出**：`text-embedding-v4` 模型的默认输出维度是 1536
2. **更高精度**：相比 1024 维，1536 维提供更精确的语义表示
3. **统一性**：所有增强表（string_constants, url_patterns 等）都使用 1536 维
4. **兼容性**：与阿里云百炼 API 的默认配置一致

## 历史演变

### 初始版本（1024 维）
- `code_chunks` 表最初使用 1024 维
- 这是某些早期 embedding 模型的默认维度

### 增强版本（混合维度）
- 添加增强表时使用了 1536 维
- 导致 `code_chunks` (1024) 和增强表 (1536) 维度不一致

### 当前版本（统一 1536 维）
- 所有表统一使用 1536 维
- 消除了维度不匹配的问题

## 如何检查当前维度

运行维度检查脚本：

```bash
cd apps/api
npm run check-dimensions
```

输出示例：
```
📊 各表的 embedding 列定义：
┌─────────┬────────────────────┬──────────────┬─────────┐
│ (index) │ table_name         │ column_name  │ udt_name│
├─────────┼────────────────────┼──────────────┼─────────┤
│    0    │ 'code_chunks'      │ 'embedding'  │ 'vector'│
│    1    │ 'string_constants' │ 'embedding'  │ 'vector'│
│    2    │ 'url_patterns'     │ 'embedding'  │ 'vector'│
│    3    │ 'functions'        │ 'embedding'  │ 'vector'│
│    4    │ 'classes'          │ 'embedding'  │ 'vector'│
└─────────┴────────────────────┴──────────────┴─────────┘

✅ code_chunks 中实际的向量维度： 1536
```

## 如何迁移维度

### 方法 1：使用 API 端点（推荐）

```bash
curl -X POST http://localhost:8787/admin/migrate-vector-dimension
```

这会：
1. 删除旧的 embedding 列
2. 创建新的 1536 维 embedding 列
3. 重建 HNSW 索引

### 方法 2：手动执行 SQL

```bash
psql -U postgres -d codelens -f apps/api/migrations/002_update_embedding_dimensions.sql
```

### 迁移后的步骤

⚠️ **重要**：迁移会清空所有现有的向量数据，需要重新索引：

```bash
# 重新索引指定仓库
npm run reindex <repo_id> <repo_path>

# 或通过 API
curl -X POST http://localhost:8787/repos/<repo_id>/reindex \
  -H "Content-Type: application/json" \
  -d '{"repoPath": "/path/to/repo"}'
```

## 性能考虑

### 存储空间
- **1024 维**：每个向量约 4KB (1024 × 4 bytes)
- **1536 维**：每个向量约 6KB (1536 × 4 bytes)
- **增加**：约 50% 的存储空间

### 查询性能
- 使用 HNSW 索引，查询性能差异很小（< 10%）
- 更高的维度提供更好的语义区分度

### 索引参数
```sql
CREATE INDEX idx_code_chunks_embedding_hnsw 
ON code_chunks 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

- `m = 16`：每个节点的连接数（平衡精度和速度）
- `ef_construction = 64`：构建时的搜索深度

## 常见问题

### Q: 为什么线上可以正常运行但维度不一致？

A: 可能的原因：
1. 线上数据库已经手动迁移过
2. 只使用了增强表，没有往 code_chunks 插入新数据
3. 线上环境变量配置不同

### Q: 可以使用其他维度吗？

A: 可以，但需要：
1. 修改 `EMBED_DIMENSIONS` 环境变量
2. 确保模型支持该维度（text-embedding-v4 支持可配置维度）
3. 修改所有表的 vector 列定义
4. 重新索引所有数据

### Q: 迁移会影响线上服务吗？

A: 会有短暂影响：
1. 迁移过程中会锁表（通常 < 1 秒）
2. 重建索引可能需要几秒到几分钟（取决于数据量）
3. 建议在低峰期执行

### Q: 如何回滚到 1024 维？

A: 修改迁移脚本中的维度值，然后重新执行：
```sql
ALTER TABLE code_chunks ADD COLUMN embedding vector(1024);
```
但不推荐，因为会失去精度。

## 相关文件

- [db/index.ts](../apps/api/src/db/index.ts) - 数据库表定义
- [llm/embeddings.ts](../apps/api/src/llm/embeddings.ts) - 向量生成逻辑
- [migrations/002_update_embedding_dimensions.sql](../apps/api/migrations/002_update_embedding_dimensions.sql) - 迁移脚本
- [scripts/check-embedding-dimensions.ts](../apps/api/src/scripts/check-embedding-dimensions.ts) - 维度检查工具

## 总结

- ✅ 统一使用 1536 维向量
- ✅ 与 text-embedding-v4 模型默认配置一致
- ✅ 提供更高的语义搜索精度
- ✅ 使用 HNSW 索引保证查询性能
- ⚠️ 迁移后需要重新索引所有仓库
