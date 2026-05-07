# 阿里百炼 API 迁移 + Agent 数据库迁移指南

## ✅ 已完成的工作

### 1. 本地环境变量更新 ✅

已将本地配置从 XiaocaseAI 切换到阿里百炼：

**更新的文件**:
- ✅ `apps/api/.env`
- ✅ `apps/api/.env.example`

**新配置**:
```bash
# 阿里百炼 Embedding API
EMBED_API_KEY=sk-4002f08ebad741ea98a6978679f98328
EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBED_MODEL=text-embedding-v4
EMBED_DIMENSIONS=1536  # 从 1024 更新为 1536

# 阿里百炼 Rerank API
DASHSCOPE_API_KEY=sk-4002f08ebad741ea98a6978679f98328
DASHSCOPE_RERANK_MODEL=qwen3-rerank  # 从 bge-reranker-v2-m3 更新
```

### 2. Agent 数据库迁移文件 ✅

已创建完整的迁移脚本：
- ✅ `apps/api/src/db/migrations/add_agent_tables.sql`
- ✅ `apps/api/src/scripts/migrate-agent.cjs`

---

## 🚀 待执行步骤

### Step 1: 启动数据库

```bash
# macOS
brew services start postgresql

# 或手动启动
pg_ctl -D /usr/local/var/postgres start

# 验证数据库运行
psql -U postgres -d codelens -c "SELECT version();"
```

### Step 2: 运行 Agent 数据库迁移

```bash
cd /Users/coopwire-test/remote-project/CodeLens/apps/api
node src/scripts/migrate-agent.cjs
```

**预期输出**:
```
🚀 Starting Agent database migration...
✅ Agent tables created successfully!

📊 Created tables:
  - agent_executions
  - agent_lessons
  - agent_reflections
  - conversation_memory
  - tool_calls

📈 Created views:
  - agent_performance_stats

✨ Migration completed successfully!
```

### Step 3: 更新向量维度（重要！）

由于向量维度从 1024 变为 1536，需要重建向量列：

```bash
# 连接数据库
psql -U postgres -d codelens

# 执行以下 SQL
DROP INDEX IF EXISTS idx_code_chunks_embedding;
ALTER TABLE code_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE code_chunks ADD COLUMN embedding vector(1536);
CREATE INDEX idx_code_chunks_embedding ON code_chunks 
  USING ivfflat (embedding vector_cosine_ops);

# 退出
\q
```

**注意**: 这会清空所有现有的 embeddings，需要重新索引仓库。

### Step 4: 更新服务器环境变量

**服务器路径**: `/root/CodeLens/apps/api/.env`

SSH 到服务器并更新：

```bash
ssh your-server

cd /root/CodeLens/apps/api

# 备份现有配置
cp .env .env.backup

# 编辑 .env 文件
nano .env
```

**更新以下配置**:
```bash
# 阿里百炼 Embedding API
EMBED_API_KEY=sk-4002f08ebad741ea98a6978679f98328
EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBED_MODEL=text-embedding-v4
EMBED_DIMENSIONS=1536

# 阿里百炼 Rerank API
DASHSCOPE_API_KEY=sk-4002f08ebad741ea98a6978679f98328
DASHSCOPE_RERANK_MODEL=qwen3-rerank
```

### Step 5: 服务器数据库迁移

```bash
# 在服务器上执行
cd /root/CodeLens/apps/api

# 运行 Agent 迁移
node src/scripts/migrate-agent.cjs

# 更新向量维度
psql $DATABASE_URL << EOF
DROP INDEX IF EXISTS idx_code_chunks_embedding;
ALTER TABLE code_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE code_chunks ADD COLUMN embedding vector(1536);
CREATE INDEX idx_code_chunks_embedding ON code_chunks 
  USING ivfflat (embedding vector_cosine_ops);
EOF
```

### Step 6: 重启服务

```bash
# 服务器上重启 API 服务
pm2 restart codelens-api

# 查看日志
pm2 logs codelens-api
```

### Step 7: 重新索引仓库

由于向量维度变化，需要重新索引所有仓库：

```bash
# 方式 1: 通过 API
curl -X POST http://your-server:8787/repos/1/reindex

# 方式 2: 通过前端
# 访问前端 → 仓库管理 → 点击"重新索引"按钮
```

---

## 🧪 测试验证

### 测试 1: 验证 Agent 表创建

```bash
psql -U postgres -d codelens -c "
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name LIKE 'agent_%'
ORDER BY table_name;
"
```

**预期输出**:
```
       table_name        
------------------------
 agent_executions
 agent_lessons
 agent_performance_stats
 agent_reflections
```

### 测试 2: 验证向量维度

```bash
psql -U postgres -d codelens -c "
SELECT 
  column_name, 
  data_type,
  udt_name
FROM information_schema.columns 
WHERE table_name = 'code_chunks' 
AND column_name = 'embedding';
"
```

**预期输出**:
```
 column_name | data_type | udt_name 
-------------+-----------+----------
 embedding   | USER-DEFINED | vector
```

### 测试 3: 测试阿里百炼 Embedding API

```bash
curl -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings \
  -H "Authorization: Bearer sk-4002f08ebad741ea98a6978679f98328" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-v4",
    "input": "测试文本"
  }'
```

**预期**: 返回 1536 维向量

### 测试 4: 测试 Agent 功能

```bash
# 启动本地服务
cd /Users/coopwire-test/remote-project/CodeLens/apps/api
pnpm dev:api

# 测试 Agent 问答
curl -X POST http://localhost:8787/agent/ask \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": 1,
    "query": "登录功能是如何实现的？"
  }'
```

### 测试 5: 测试 Agent 流式响应

```bash
curl -X POST http://localhost:8787/agent/ask-stream \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": 1,
    "query": "查找 /api/users 接口"
  }'
```

---

## 📊 配置对比

| 配置项 | 旧值 (XiaocaseAI) | 新值 (阿里百炼) |
|--------|-------------------|-----------------|
| **API Key** | sk-Krq1GA0g... | sk-4002f08e... |
| **Base URL** | api.xiaocaseai.cn | dashscope.aliyuncs.com |
| **Embedding 模型** | text-embedding-v4 | text-embedding-v4 |
| **向量维度** | 1024 | **1536** ⚠️ |
| **Rerank 模型** | bge-reranker-v2-m3 | qwen3-rerank |

⚠️ **重要**: 向量维度变化需要重建数据库列并重新索引！

---

## 🔧 故障排查

### 问题 1: 数据库连接失败

**错误**: `ECONNREFUSED 127.0.0.1:5432`

**解决**:
```bash
# 检查 PostgreSQL 状态
brew services list | grep postgresql

# 启动 PostgreSQL
brew services start postgresql

# 或
pg_ctl -D /usr/local/var/postgres start
```

### 问题 2: 向量维度不匹配

**错误**: `dimension mismatch: expected 1024, got 1536`

**解决**: 执行 Step 3 的向量维度更新 SQL

### 问题 3: Agent 表已存在

**错误**: `relation "agent_executions" already exists`

**解决**: 迁移脚本使用 `CREATE TABLE IF NOT EXISTS`，可以安全重复执行

### 问题 4: API Key 无效

**错误**: `401 Unauthorized`

**解决**: 
1. 检查 API Key 是否正确
2. 验证 Base URL 是否正确
3. 测试 API Key: `curl -H "Authorization: Bearer YOUR_KEY" https://dashscope.aliyuncs.com/compatible-mode/v1/models`

---

## 📝 需要更新的代码文件

### 已自动适配（无需修改）

以下文件通过环境变量自动适配，无需修改代码：

✅ `apps/api/src/llm/embeddings.ts` - 读取 `EMBED_BASE_URL` 和 `EMBED_API_KEY`  
✅ `apps/api/src/llm/multi-strategy-search.ts` - 使用 embeddings.ts  
✅ `apps/api/src/agent/tool-registry.ts` - 使用 multiStrategySearch  

### 需要验证的文件

检查以下文件是否硬编码了向量维度：

```bash
cd /Users/coopwire-test/remote-project/CodeLens
grep -r "1024" apps/api/src --include="*.ts" | grep -i "dimension\|vector"
```

如果发现硬编码，替换为 `parseInt(process.env.EMBED_DIMENSIONS || '1536')`

---

## ✅ 完成检查清单

### 本地环境
- [x] 更新 `.env` 配置
- [x] 更新 `.env.example` 配置
- [ ] 启动 PostgreSQL
- [ ] 运行 Agent 数据库迁移
- [ ] 更新向量维度
- [ ] 重新索引仓库
- [ ] 测试 Agent 功能

### 服务器环境
- [ ] 备份服务器 `.env`
- [ ] 更新服务器 `.env` 配置
- [ ] 运行 Agent 数据库迁移
- [ ] 更新向量维度
- [ ] 重启 PM2 服务
- [ ] 重新索引仓库
- [ ] 测试 Agent 功能

---

## 🎯 预期效果

### 性能提升
- **向量维度**: 1024 → 1536（更精确的语义表示）
- **Rerank 模型**: bge-reranker-v2-m3 → qwen3-rerank（更好的中文支持）
- **Agent 能力**: 新增多轮推理、自我反思、对话记忆

### API 变化
- 新增 7 个 Agent 端点
- 保持向后兼容（原有 `/ask` 端点仍可用）
- 新增流式响应支持

---

## 📞 支持

如遇问题，请检查：
1. 数据库是否正常运行
2. API Key 是否有效
3. 向量维度是否正确更新
4. 日志输出（`pm2 logs` 或控制台）

**迁移完成时间**: 预计 10-15 分钟  
**重新索引时间**: 取决于仓库大小（约 5-30 分钟/仓库）
