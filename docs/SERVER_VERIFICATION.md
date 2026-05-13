# 服务器端验证指南

## 快速验证

在服务器上执行以下命令来验证向量维度配置：

### 方法 1：使用验证脚本（推荐）

```bash
# 1. 上传验证脚本到服务器
scp scripts/verify-dimensions.sh root@118.89.81.103:/root/CodeLens/

# 2. 在服务器上执行
ssh root@118.89.81.103
cd /root/CodeLens
chmod +x verify-dimensions.sh
./verify-dimensions.sh
```

### 方法 2：手动检查

```bash
# 连接到服务器
ssh root@118.89.81.103

# 进入项目目录
cd /root/CodeLens/apps/api

# 运行维度检查脚本
node dist/scripts/check-embedding-dimensions.js
```

## 预期输出

### 如果已经是 1536 维（无需迁移）

```
📊 各表的 embedding 列定义：
┌─────────┬────────────────────┬──────────────┐
│ (index) │ table_name         │ column_name  │
├─────────┼────────────────────┼──────────────┤
│    0    │ 'code_chunks'      │ 'embedding'  │
│    1    │ 'string_constants' │ 'embedding'  │
└─────────┴────────────────────┴──────────────┘

✅ code_chunks 中实际的向量维度： 1536

💡 建议：
  - 期望的向量维度：1536
  - ✅ 数据库维度与配置一致，无需迁移
```

### 如果是 1024 维（需要迁移）

```
✅ code_chunks 中实际的向量维度： 1024

💡 建议：
  - 期望的向量维度：1536
  - ⚠️  数据库维度与配置不一致，建议迁移
  - 迁移命令：
    POST http://localhost:8787/admin/migrate-vector-dimension
```

## 如果需要迁移

### 步骤 1：备份数据库（重要！）

```bash
# 在服务器上执行
pg_dump -U postgres -d codelens > /root/codelens_backup_$(date +%Y%m%d_%H%M%S).sql
```

### 步骤 2：执行迁移

```bash
# 方法 1：使用 API（推荐）
curl -X POST http://localhost:8787/admin/migrate-vector-dimension

# 方法 2：直接执行 SQL
psql -U postgres -d codelens -f /root/CodeLens/apps/api/migrations/002_update_embedding_dimensions.sql
```

### 步骤 3：重新索引

迁移会清空所有向量数据，需要重新索引所有仓库：

```bash
# 通过 API 重新索引
curl -X POST http://localhost:8787/repos/<repo_id>/reindex \
  -H "Content-Type: application/json" \
  -d '{"repoPath": "/path/to/repo"}'
```

## 部署更新的代码

如果验证后需要部署新代码：

```bash
# 在本地
git add .
git commit -m "fix: 统一向量维度为 1536"
git push

# 在服务器上
ssh root@118.89.81.103
cd /root/CodeLens
git pull
cd apps/api
npm run build
pm2 restart codelens-api
```

## 验证迁移结果

迁移完成后，再次运行检查脚本确认：

```bash
node dist/scripts/check-embedding-dimensions.js
```

应该看到所有表都是 1536 维。

## 监控

迁移后观察以下指标：

```bash
# 检查 API 日志
pm2 logs codelens-api

# 检查数据库连接
psql -U postgres -d codelens -c "SELECT COUNT(*) FROM code_chunks WHERE embedding IS NOT NULL;"

# 检查磁盘使用
df -h
```

## 回滚（如果出现问题）

```bash
# 停止服务
pm2 stop codelens-api

# 恢复数据库
psql -U postgres -d codelens < /root/codelens_backup_YYYYMMDD_HHMMSS.sql

# 启动服务
pm2 start codelens-api
```

## 联系信息

如果遇到问题，检查：
1. 数据库日志：`/var/log/postgresql/`
2. API 日志：`pm2 logs codelens-api`
3. 错误日志：`/var/log/codelens-api-error.log`
