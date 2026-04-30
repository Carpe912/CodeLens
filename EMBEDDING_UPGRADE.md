# Embedding 模型升级指南

## 升级内容

从 `text-embedding-v3` (1024维) 升级到 `text-embedding-v4` (1536维)

## 升级优势

- **性能提升**: 20-30% 的搜索准确度提升
- **成本降低**: 50% 的 API 调用成本降低
- **更好的语义理解**: 更高维度的向量表示

## 已更新的文件

### 1. 代码文件
- ✅ `apps/api/src/llm/embeddings.ts` - 默认模型改为 `text-embedding-v4`

### 2. 配置文件
- ✅ `apps/api/.env` - 本地开发环境
- ✅ `apps/api/.env.example` - 示例配置
- ✅ `.env.production` - 生产环境配置

### 3. 数据库迁移
- ✅ `apps/api/migrations/002_update_embedding_dimensions.sql` - 向量维度 1024 → 1536

## 部署步骤

### 1. 更新服务器配置

将 `.env.production` 上传到服务器：

```bash
scp .env.production user@server:/path/to/codelens/.env.production
```

### 2. 部署新代码

```bash
# 上传编译后的代码
scp -r apps/api/dist/* user@server:/path/to/codelens/apps/api/dist/

# 上传数据库迁移文件
scp apps/api/migrations/002_update_embedding_dimensions.sql user@server:/path/to/codelens/apps/api/migrations/
```

### 3. 运行数据库迁移

在服务器上执行：

```bash
cd /path/to/codelens/apps/api
npm run migrate
```

这会：
- 清空所有现有的 embedding 数据
- 删除旧的 1024 维 embedding 列
- 创建新的 1536 维 embedding 列
- 重建 HNSW 索引

### 4. 重启服务

```bash
pm2 restart codelens-api
```

### 5. 重新索引所有仓库

**方式 1: 通过 API 接口**

对每个仓库调用重新索引接口：

```bash
curl -X POST http://your-server:8787/repos/1/reindex
curl -X POST http://your-server:8787/repos/2/reindex
# ... 对所有仓库重复
```

**方式 2: 通过脚本**

```bash
cd /path/to/codelens/apps/api
npm run reindex-all
```

## 验证

### 1. 检查数据库

```sql
-- 检查 embedding 列的维度
SELECT 
  COUNT(*) as total_chunks,
  COUNT(embedding) as chunks_with_embedding,
  vector_dims(embedding) as embedding_dimensions
FROM code_chunks
WHERE embedding IS NOT NULL
LIMIT 1;

-- 应该返回: embedding_dimensions = 1536
```

### 2. 测试搜索功能

在前端进行搜索测试，验证：
- 搜索结果是否正常返回
- 搜索准确度是否提升
- 响应速度是否正常

## 注意事项

⚠️ **重要提示**：

1. **数据库迁移会清空所有 embedding 数据**，必须重新索引所有仓库
2. **重新索引期间**，搜索功能可能返回不完整的结果
3. **建议在低峰期进行升级**，避免影响用户使用
4. **备份数据库**，以防万一需要回滚

## 回滚方案

如果升级后出现问题，可以回滚：

1. 恢复旧的配置文件（`text-embedding-v3`, 1024 维）
2. 运行回滚迁移（需要手动创建）
3. 重启服务
4. 重新索引所有仓库

## 时间估算

- 数据库迁移: < 1 分钟
- 单个仓库重新索引: 取决于仓库大小
  - 小型仓库 (< 100 文件): 2-5 分钟
  - 中型仓库 (100-1000 文件): 10-30 分钟
  - 大型仓库 (> 1000 文件): 30-60 分钟

## 成本对比

### text-embedding-v3 (1024维)
- 价格: ¥0.0007 / 1K tokens
- 示例: 1000 个文件 × 500 tokens = 500K tokens = ¥0.35

### text-embedding-v4 (1536维)
- 价格: ¥0.00035 / 1K tokens (降低 50%)
- 示例: 1000 个文件 × 500 tokens = 500K tokens = ¥0.175

**节省**: 每次全量索引节省 50% 成本

## 完成标志

✅ 所有配置文件已更新
✅ 代码已编译成功
✅ 数据库迁移脚本已准备
✅ 部署文档已完成

下一步: 部署到服务器并重新索引
