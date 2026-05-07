# 服务器部署和迁移指南

## 🚀 快速部署（服务器端）

### 方式 1: 使用自动化脚本（推荐）

```bash
# SSH 到服务器
ssh your-server

# 进入项目目录
cd /root/CodeLens/apps/api

# 下载并执行迁移脚本
bash migrate-to-dashscope.sh
```

脚本会自动完成：
1. ✅ 备份现有配置
2. ✅ 更新环境变量到阿里百炼
3. ✅ 测试数据库连接
4. ✅ 创建 Agent 数据库表
5. ✅ 更新向量维度 (1024 → 1536)
6. ✅ 测试阿里百炼 API
7. ✅ 重启 PM2 服务

---

### 方式 2: 手动执行（逐步操作）

#### Step 1: 备份配置

```bash
cd /root/CodeLens/apps/api
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
```

#### Step 2: 更新环境变量

编辑 `.env` 文件：

```bash
nano .env
```

更新以下配置：

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

保存并退出 (Ctrl+X, Y, Enter)

#### Step 3: 拉取最新代码

```bash
cd /root/CodeLens
git pull origin main
```

#### Step 4: 安装依赖

```bash
cd apps/api
pnpm install
```

#### Step 5: 运行 Agent 数据库迁移

```bash
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

#### Step 6: 更新向量维度

⚠️ **警告**: 这会清空所有现有的 embeddings！

```bash
psql $DATABASE_URL << EOF
DROP INDEX IF EXISTS idx_code_chunks_embedding;
ALTER TABLE code_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE code_chunks ADD COLUMN embedding vector(1536);
CREATE INDEX idx_code_chunks_embedding ON code_chunks 
  USING ivfflat (embedding vector_cosine_ops);
EOF
```

#### Step 7: 重启服务

```bash
pm2 restart codelens-api
pm2 logs codelens-api --lines 50
```

#### Step 8: 重新索引仓库

通过 API 重新索引所有仓库：

```bash
# 获取所有仓库
curl http://localhost:8787/repos

# 重新索引每个仓库
curl -X POST http://localhost:8787/repos/1/reindex
curl -X POST http://localhost:8787/repos/2/reindex
# ... 依次执行
```

---

## 🧪 验证和测试

### 1. 验证 Agent 表创建

```bash
psql $DATABASE_URL -c "
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
 conversation_memory
 tool_calls
```

### 2. 验证向量维度

```bash
psql $DATABASE_URL -c "
SELECT 
  column_name, 
  data_type,
  udt_name
FROM information_schema.columns 
WHERE table_name = 'code_chunks' 
AND column_name = 'embedding';
"
```

**预期**: 显示 vector 类型

### 3. 测试阿里百炼 Embedding API

```bash
curl -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings \
  -H "Authorization: Bearer sk-4002f08ebad741ea98a6978679f98328" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-v4",
    "input": "测试文本"
  }'
```

**预期**: 返回包含 1536 维向量的 JSON

### 4. 测试 Agent 功能

```bash
# 测试标准问答
curl -X POST http://localhost:8787/agent/ask \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": 1,
    "query": "登录功能是如何实现的？"
  }'

# 测试流式响应
curl -X POST http://localhost:8787/agent/ask-stream \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": 1,
    "query": "查找 /api/users 接口"
  }'

# 查看执行历史
curl http://localhost:8787/agent/history?repoId=1&limit=10

# 查看性能统计
curl http://localhost:8787/agent/stats
```

### 5. 检查服务日志

```bash
# 实时查看日志
pm2 logs codelens-api

# 查看最近 100 行
pm2 logs codelens-api --lines 100

# 查看错误日志
pm2 logs codelens-api --err
```

---

## 🔧 故障排查

### 问题 1: 数据库连接失败

**错误**: `ECONNREFUSED` 或 `connection refused`

**解决**:
```bash
# 检查 PostgreSQL 状态
systemctl status postgresql

# 启动 PostgreSQL
systemctl start postgresql

# 检查端口
netstat -tlnp | grep 5432
```

### 问题 2: 迁移脚本执行失败

**错误**: `relation already exists`

**解决**: 迁移脚本使用 `IF NOT EXISTS`，可以安全重复执行
```bash
node src/scripts/migrate-agent.cjs
```

### 问题 3: 向量维度不匹配

**错误**: `dimension mismatch`

**解决**: 确保执行了 Step 6 的向量维度更新 SQL

### 问题 4: PM2 服务无法启动

**错误**: 服务启动失败

**解决**:
```bash
# 查看详细错误
pm2 logs codelens-api --err --lines 50

# 删除并重新启动
pm2 delete codelens-api
pm2 start ecosystem.config.js

# 或直接运行查看错误
cd /root/CodeLens/apps/api
node src/index.js
```

### 问题 5: API Key 无效

**错误**: `401 Unauthorized`

**解决**:
1. 检查 `.env` 中的 API Key 是否正确
2. 测试 API Key:
```bash
curl -H "Authorization: Bearer sk-4002f08ebad741ea98a6978679f98328" \
  https://dashscope.aliyuncs.com/compatible-mode/v1/models
```

---

## 📊 部署检查清单

### 部署前
- [ ] 备份数据库
- [ ] 备份 `.env` 配置
- [ ] 记录当前服务状态

### 部署中
- [ ] 更新环境变量
- [ ] 拉取最新代码
- [ ] 安装依赖
- [ ] 运行数据库迁移
- [ ] 更新向量维度
- [ ] 重启服务

### 部署后
- [ ] 验证 Agent 表创建
- [ ] 验证向量维度
- [ ] 测试阿里百炼 API
- [ ] 测试 Agent 功能
- [ ] 重新索引仓库
- [ ] 检查服务日志
- [ ] 监控服务状态

---

## 📈 性能监控

### 监控指标

```bash
# CPU 和内存使用
pm2 monit

# 详细状态
pm2 status

# 重启次数和运行时间
pm2 info codelens-api
```

### 数据库监控

```bash
# 查看 Agent 执行统计
psql $DATABASE_URL -c "SELECT * FROM agent_performance_stats;"

# 查看最近的执行记录
psql $DATABASE_URL -c "
SELECT 
  id, 
  query, 
  success, 
  confidence, 
  duration_ms,
  created_at 
FROM agent_executions 
ORDER BY created_at DESC 
LIMIT 10;
"

# 查看工具调用统计
psql $DATABASE_URL -c "
SELECT 
  tool_name, 
  COUNT(*) as call_count,
  AVG(duration_ms) as avg_duration,
  SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_count
FROM tool_calls 
GROUP BY tool_name;
"
```

---

## 🎯 预期效果

### 性能提升
- **向量维度**: 1024 → 1536（更精确的语义表示）
- **Rerank 模型**: bge-reranker-v2-m3 → qwen3-rerank（更好的中文支持）
- **Agent 能力**: 新增多轮推理、自我反思、对话记忆

### 新增功能
- ✅ 7 个新的 Agent API 端点
- ✅ 流式响应支持
- ✅ 执行历史记录
- ✅ 性能统计分析
- ✅ 对话记忆管理

### API 兼容性
- ✅ 保持向后兼容
- ✅ 原有 `/ask` 端点仍可用
- ✅ 新增 `/agent/*` 端点

---

## 📞 支持

如遇问题，请检查：
1. 服务日志: `pm2 logs codelens-api`
2. 数据库连接: `psql $DATABASE_URL -c "SELECT 1;"`
3. API Key 有效性
4. 向量维度是否正确更新

**部署时间**: 约 10-15 分钟  
**重新索引时间**: 5-30 分钟/仓库（取决于大小）

---

## 🔄 回滚方案

如果升级后出现问题，可以回滚：

```bash
# 1. 恢复配置
cp .env.backup.YYYYMMDD_HHMMSS .env

# 2. 回滚代码
git checkout <previous-commit>

# 3. 重启服务
pm2 restart codelens-api

# 4. 如需删除 Agent 表
psql $DATABASE_URL << EOF
DROP TABLE IF EXISTS agent_reflections CASCADE;
DROP TABLE IF EXISTS tool_calls CASCADE;
DROP TABLE IF EXISTS conversation_memory CASCADE;
DROP TABLE IF EXISTS agent_lessons CASCADE;
DROP TABLE IF EXISTS agent_executions CASCADE;
DROP VIEW IF EXISTS agent_performance_stats;
EOF
```

**注意**: 回滚后需要将向量维度改回 1024 并重新索引。
