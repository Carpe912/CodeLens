# 🚀 部署指南

## 当前状态

- ✅ 所有 Agent 代码已创建
- ✅ API 集成完成
- ✅ 数据库迁移脚本就绪
- ✅ 环境变量已更新（阿里百炼）
- ⚠️ 本地 Node.js 版本过低（v14，需要 v18+）

## 推荐部署方式：服务器端构建

由于本地 Node.js 版本不兼容，建议直接在服务器上构建和部署。

### 方式 1: 使用自动化脚本（推荐）

```bash
# SSH 到服务器
ssh root@47.116.6.132

# 进入项目目录
cd /opt/codelens

# 拉取最新代码
git pull origin main

# 执行部署脚本
bash deploy-server.sh
```

脚本会自动完成：
1. ✅ 拉取最新代码
2. ✅ 安装依赖
3. ✅ 构建 API 和前端
4. ✅ 运行数据库迁移
5. ✅ 重启 PM2 服务

### 方式 2: 手动部署

```bash
# SSH 到服务器
ssh root@47.116.6.132

# 进入项目目录
cd /opt/codelens

# 拉取最新代码
git pull origin main

# 安装依赖
pnpm install

# 构建
pnpm build:api
pnpm build:web

# 运行迁移
cd apps/api
bash migrate-to-dashscope.sh

# 重启服务
pm2 restart codelens-api
pm2 restart codelens-web

# 查看状态
pm2 status
pm2 logs codelens-api --lines 50
```

## 部署后验证

### 1. 检查服务状态
```bash
pm2 status
pm2 logs codelens-api --lines 20
```

### 2. 测试 Agent API
```bash
curl -X POST http://localhost:8787/agent/query \
  -H "Content-Type: application/json" \
  -d '{"query": "登录功能是如何实现的？", "repoId": 1}'
```

### 3. 检查数据库表
```bash
psql $DATABASE_URL -c "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'agent_%';"
```

### 4. 访问前端
- 前端: https://sunlingyue.cn/code/
- API: https://sunlingyue.cn/code-api/

## 重要提醒

### 1. 向量维度变化
由于向量维度从 1024 升级到 1536，**必须重新索引所有仓库**：

```bash
# 通过 API 重新索引
curl -X POST https://sunlingyue.cn/code-api/repos/1/reindex
curl -X POST https://sunlingyue.cn/code-api/repos/2/reindex
```

### 2. 环境变量
确保服务器上的 `.env` 文件已更新为阿里百炼配置：

```bash
cd /opt/codelens/apps/api
cat .env | grep EMBED
```

应该看到：
```
EMBED_API_KEY=sk-4002f08ebad741ea98a6978679f98328
EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBED_DIMENSIONS=1536
```

## 故障排查

### 问题 1: 构建失败
```bash
# 检查 Node.js 版本
node --version  # 应该是 v18+

# 检查 pnpm 版本
pnpm --version

# 清理并重新安装
rm -rf node_modules
pnpm install
```

### 问题 2: 服务无法启动
```bash
# 查看详细错误
pm2 logs codelens-api --err --lines 50

# 检查端口占用
netstat -tlnp | grep 8787

# 手动启动查看错误
cd /opt/codelens/apps/api
node dist/index.js
```

### 问题 3: 数据库连接失败
```bash
# 测试数据库连接
psql $DATABASE_URL -c "SELECT 1;"

# 检查 PostgreSQL 状态
systemctl status postgresql
```

## 文档索引

- **[deploy-server.sh](deploy-server.sh)** - 服务器端自动化部署脚本
- **[QUICKSTART.md](QUICKSTART.md)** - 快速开始指南
- **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** - 详细部署指南
- **[UPGRADE_COMPLETE.md](UPGRADE_COMPLETE.md)** - 升级完成总结

## 预计时间

- 代码拉取: 1 分钟
- 依赖安装: 2-3 分钟
- 项目构建: 3-5 分钟
- 数据库迁移: 1 分钟
- 服务重启: 30 秒

**总计**: 约 10-15 分钟

---

**下一步**: SSH 到服务器并执行 `bash deploy-server.sh`
