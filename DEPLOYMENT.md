# 🚀 CodeLens Agent 升级部署指南

本文档详细说明如何将 CodeLens（包含 Agent 升级）部署到生产服务器。

---

### 📚 文档导航

**[← 返回首页](./README.md)** · **[🎓 学习指南](./LEARNING_GUIDE.md)** · **[🚀 升级说明](./AGENTRAG_UPGRADE.md)** · **[📐 项目架构](./PROJECT_OVERVIEW.md)**

---

## 📋 本次升级内容

- ✅ Agent 核心代码（多轮推理引擎）
- ✅ 阿里百炼 API 集成（text-embedding-v4, qwen3-rerank）
- ✅ 向量维度升级（1024 → 1536）
- ✅ 数据库迁移（5个新表：agent_executions, agent_lessons, agent_reflections, tool_calls, conversation_memory）
- ✅ 7个新 API 端点（/agent/ask, /agent/ask/stream, /agent/sessions, /agent/history, /agent/stats, /agent/feedback）

## 部署架构

```
用户浏览器
    ↓ HTTPS
阿里云 CDN/WAF (sunlingyue.cn)
    ↓
Nginx (47.116.6.132)
    ├─→ /code/          → PM2 Serve (React SPA on :5173)
    └─→ /code-api/      → API 服务 (Fastify on :8787)
                              ↓
                         PostgreSQL (:5432)
                         Redis (:6379)
```

## 服务器环境

- **服务器**: 阿里云 ECS (47.116.6.132)
- **域名**: sunlingyue.cn
- **操作系统**: Linux
- **Node.js**: v22
- **进程管理**: PM2
- **Web 服务器**: Nginx (宝塔面板管理)
- **数据库**: PostgreSQL 14 + pgvector
- **缓存**: Redis 6

## 部署目录结构

```
/opt/codelens/
├── apps/
│   ├── api/
│   │   └── dist/          # API 编译产物
│   └── web/
│       └── dist/          # 前端构建产物
├── node_modules/
├── package.json
├── ecosystem.config.js    # PM2 配置
└── pnpm-workspace.yaml
```

## 一键部署脚本

### 前置条件

1. **配置 SSH 密钥认证**（推荐，避免每次输入密码）

```bash
# 生成 SSH 密钥（如果还没有）
ssh-keygen -t rsa -b 4096

# 复制公钥到服务器
ssh-copy-id root@47.116.6.132

# 测试连接
ssh root@47.116.6.132
```

2. **确保本地 Node.js 版本 >= 18.12**

```bash
node --version

# 如果版本过低，切换到 Node 18 或 22
nvm use 22
```

### 1. 配置部署脚本

在 `package.json` 中添加部署命令：

```json
{
  "scripts": {
    "deploy": "node scripts/deploy.js"
  }
}
```

### 2. 执行部署（推荐）

```bash
# 执行一键部署
npm run deploy
```

**部署脚本会自动完成：**
1. ✅ 检查环境（Node.js、pnpm、SSH）
2. ✅ 本地构建（API + 前端）
3. ✅ 上传到服务器（包含数据库迁移文件）
4. ✅ 安装依赖
5. ✅ **运行数据库迁移（新增 Agent 表）**
6. ✅ 重启 PM2 服务
7. ✅ 验证部署

### 3. 服务器端构建（备选方案）

如果本地 Node.js 版本不兼容，可以直接在服务器上构建：

```bash
# SSH 到服务器
ssh root@47.116.6.132

# 进入项目目录
cd /root/CodeLens

# 拉取最新代码
git pull origin main

# 执行服务器端部署脚本
bash deploy-server.sh
```

## 手动部署步骤

如果需要手动部署，按以下步骤操作：

### 1. 本地构建

```bash
# 安装依赖
pnpm install

# 构建 API
pnpm build:api

# 构建前端
pnpm build:web
```

### 2. 上传到服务器

```bash
# 上传 API 构建产物
scp -r apps/api/dist root@47.116.6.132:/opt/codelens/apps/api/

# 上传前端构建产物（注意使用 dist/* 避免嵌套）
ssh root@47.116.6.132 "rm -rf /opt/codelens/apps/web/dist && mkdir -p /opt/codelens/apps/web/dist"
scp -r apps/web/dist/* root@47.116.6.132:/opt/codelens/apps/web/dist/

# 上传配置文件
scp package.json pnpm-workspace.yaml ecosystem.config.js root@47.116.6.132:/opt/codelens/
```

### 3. 服务器端操作

```bash
# SSH 登录服务器
ssh root@47.116.6.132

# 进入项目目录
cd /opt/codelens

# 安装依赖（仅生产依赖）
pnpm install --prod

# 重启服务
pm2 restart ecosystem.config.js
```

## PM2 配置

文件：`ecosystem.config.js`

```javascript
module.exports = {
  apps: [
    {
      name: 'codelens-api',
      script: './apps/api/dist/index.js',
      cwd: '/opt/codelens',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        PORT: 8787,
        ANTHROPIC_BASE_URL: 'http://118.89.81.103:8081',
        ANTHROPIC_AUTH_TOKEN: 'your_token',
        EMBED_API_KEY: 'your_key',
        EMBED_BASE_URL: 'https://api.xiaocaseai.cn',
        EMBED_MODEL: 'text-embedding-v4',
        EMBED_DIMENSIONS: '1024',
        DB_HOST: 'localhost',
        DB_PORT: '5432',
        DB_NAME: 'codelens',
        DB_USER: 'postgres',
        DB_PASSWORD: 'your_password',
        REDIS_HOST: 'localhost',
        REDIS_PORT: '6379',
      },
      error_file: '/var/log/codelens-api-error.log',
      out_file: '/var/log/codelens-api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '1G',
    },
    {
      name: 'codelens-web',
      script: 'serve',
      args: '-s dist -p 5173',
      cwd: '/opt/codelens/apps/web',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/codelens-web-error.log',
      out_file: '/var/log/codelens-web-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
    },
  ],
};
```

**注意**：
- 前端使用 `serve` 命令（需要全局安装：`npm install -g serve`）
- `serve -s dist -p 5173` 提供单页应用支持（SPA）
- 确保 `args` 参数格式正确，避免 `ENOTFOUND -p` 错误

## Nginx 配置

文件：`/www/server/nginx/conf/vhost/codelens.conf`

```nginx
server {
    listen 80;
    server_name sunlingyue.cn www.sunlingyue.cn;

    # CodeLens API 代理
    location /code-api/ {
        rewrite ^/code-api/(.*)$ /$1 break;
        proxy_pass http://localhost:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    # CodeLens Web 前端（代理到 PM2 serve）
    location /code/ {
        proxy_pass http://localhost:5173/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # CodeLens Web 前端 (无尾部斜杠重定向)
    location = /code {
        return 301 /code/;
    }

    access_log /var/log/nginx/codelens-access.log;
    error_log /var/log/nginx/codelens-error.log;
}
```

**配置说明**：
- `/code/` 代理到 `http://localhost:5173/`（PM2 serve 服务）
- `/code-api/` 代理到 `http://localhost:8787`（Fastify API）
- Vite 构建时 `base: '/'`，由 Nginx 处理 `/code/` 路径映射
- `serve -s` 参数确保 SPA 路由正常工作

## 环境变量配置

### 前端环境变量

文件：`apps/web/.env.production`

```env
VITE_API_BASE_URL=https://sunlingyue.cn/code-api
```

### 后端环境变量（已更新为阿里百炼）

文件：`.env.production`（根目录）

```env
NODE_ENV=production
PORT=8787

# 数据库配置
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/codelens
DB_HOST=localhost
DB_PORT=5432
DB_NAME=codelens
DB_USER=postgres
DB_PASSWORD=your_password

# Redis 配置
REDIS_HOST=localhost
REDIS_PORT=6379

# Claude API 配置
ANTHROPIC_BASE_URL=http://118.89.81.103:8081
ANTHROPIC_AUTH_TOKEN=your_token

# 阿里百炼 Embedding API（已升级）
EMBED_API_KEY=sk-4002f08ebad741ea98a6978679f98328
EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBED_MODEL=text-embedding-v4
EMBED_DIMENSIONS=1536

# 阿里百炼 Rerank 模型
DASHSCOPE_RERANK_MODEL=qwen3-rerank
```

**重要提醒**：
- 向量维度已从 1024 升级到 1536
- 必须重新索引所有仓库才能使用新的向量维度

## 数据库初始化

### 1. 创建数据库

```bash
# 登录 PostgreSQL
psql -U postgres

# 创建数据库
CREATE DATABASE codelens;

# 连接到数据库
\c codelens

# 安装 pgvector 扩展
CREATE EXTENSION vector;
```

### 2. 初始化表结构

表结构会在 API 首次启动时自动创建，包括：

- `repos` - 仓库信息
- `code_blocks` - 代码块
- `embeddings` - 向量数据
- `questions` - 问答历史

## PM2 常用命令

```bash
# 查看服务状态
pm2 status

# 查看日志
pm2 logs codelens-api

# 重启服务
pm2 restart codelens-api

# 停止服务
pm2 stop codelens-api

# 删除服务
pm2 delete codelens-api

# 保存 PM2 配置（开机自启）
pm2 save
pm2 startup
```

## 验证部署

### 1. 检查服务状态

```bash
# PM2 进程状态
pm2 status

# API 服务健康检查
curl http://localhost:8787/repos

# Nginx 配置测试
nginx -t

# 重载 Nginx
nginx -s reload
```

### 2. 检查数据库表（新增）

```bash
# 检查 Agent 表是否创建成功
ssh root@47.116.6.132 "psql \$DATABASE_URL -c \"SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'agent_%' ORDER BY table_name;\""
```

应该看到 5 个新表：
- agent_conversations
- agent_executions  
- agent_lessons
- agent_reflections
- tool_calls

### 3. 测试 Agent API（新增）

```bash
# 测试标准查询
curl -X POST https://sunlingyue.cn/code-api/agent/ask \
  -H "Content-Type: application/json" \
  -d '{
    "query": "登录功能是如何实现的？",
    "repoId": 1
  }'

# 测试流式查询
curl -X POST https://sunlingyue.cn/code-api/agent/ask/stream \
  -H "Content-Type: application/json" \
  -d '{
    "query": "用户认证流程是什么？",
    "repoId": 1
  }'

# 查看执行历史
curl https://sunlingyue.cn/code-api/agent/history?repoId=1&limit=10

# 查看统计信息
curl https://sunlingyue.cn/code-api/agent/stats?repoId=1
```

### 4. 访问测试

- 前端：https://sunlingyue.cn/code/
- API：https://sunlingyue.cn/code-api/repos

### 5. 查看日志

```bash
# API 日志
pm2 logs codelens-api

# Nginx 访问日志
tail -f /www/wwwlogs/47.116.6.132.log

# Nginx 错误日志
tail -f /www/wwwlogs/47.116.6.132.error.log
```

## 常见问题

### 1. 本地 Node.js 版本过低（新增）

**症状**: 
```
ERROR: This version of pnpm requires at least Node.js v18.12
The current version of Node.js is v14.21.3
```

**解决方案**:
```bash
# 方式 1：切换 Node 版本
nvm use 22  # 或 nvm use 18

# 方式 2：使用服务器端构建
ssh root@47.116.6.132
cd /root/CodeLens
git pull origin main
bash deploy-server.sh
```

### 2. 数据库迁移失败（新增）

**症状**: 
```
ERROR: relation "agent_executions" already exists
```

**解决方案**:
这是正常的，表已存在。部署脚本会自动忽略此错误。

如果需要重新创建表：
```bash
ssh root@47.116.6.132
cd /root/CodeLens/apps/api
psql $DATABASE_URL -c "DROP TABLE IF EXISTS agent_conversations, agent_executions, agent_lessons, agent_reflections, tool_calls, conversation_memory CASCADE;"
psql $DATABASE_URL -f src/db/migrations/add_agent_tables.sql
```

### 3. 向量维度不匹配（新增）

**症状**: Agent 查询返回错误或结果不准确

**原因**: 向量维度从 1024 升级到 1536，旧的向量数据不兼容

**解决方案**: 重新索引所有仓库
```bash
# 方式 1：通过 API
curl -X POST https://sunlingyue.cn/code-api/repos/1/reindex
curl -X POST https://sunlingyue.cn/code-api/repos/2/reindex

# 方式 2：通过前端界面
# 访问 https://sunlingyue.cn/code/
# 进入每个仓库 → 点击"重新索引"按钮
```

### 4. Agent API 返回 500 错误（新增）

**可能原因**:
1. 数据库表未创建
2. 环境变量配置错误
3. 阿里百炼 API Key 无效

**检查步骤**:
```bash
# 1. 检查数据库表
ssh root@47.116.6.132 "psql \$DATABASE_URL -c \"SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'agent_%';\""

# 2. 检查环境变量
ssh root@47.116.6.132 "cat /root/CodeLens/.env.production | grep -E '(EMBED|DASHSCOPE)'"

# 3. 测试阿里百炼 API
curl -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings \
  -H "Authorization: Bearer sk-4002f08ebad741ea98a6978679f98328" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-v4","input":"test"}'

# 4. 查看 API 日志
ssh root@47.116.6.132 "pm2 logs codelens-api --err --lines 50"
```

### 5. 前端资源 404 错误

**症状**: 访问前端页面时，CSS/JS 文件返回 404

**原因**: Vite 配置的 `base` 路径与 Nginx 配置不匹配

**解决方案**:
```typescript
// vite.config.ts - 使用根路径，由 Nginx 处理 /code/ 映射
export default defineConfig({
  base: '/',  // 不要设置为 '/code/' 或 '/code-lens/'
  // ...
})
```

重新构建并部署：
```bash
npm run build
ssh root@47.116.6.132 "rm -rf /opt/codelens/apps/web/dist && mkdir -p /opt/codelens/apps/web/dist"
scp -r apps/web/dist/* root@47.116.6.132:/opt/codelens/apps/web/dist/
pm2 restart codelens-web
```

**验证**:
```bash
# 检查 index.html 中的资源路径
ssh root@47.116.6.132 "grep -o 'src=\"[^\"]*\"' /opt/codelens/apps/web/dist/index.html"
# 应该看到 src="/assets/..." 而不是 src="/code/assets/..."
```

### 6. PM2 前端服务启动失败 (ENOTFOUND -p)

**症状**: `pm2 logs codelens-web` 显示 `getaddrinfo ENOTFOUND -p`

**原因**: 
- PM2 配置中 `args` 参数格式错误
- 或者 `cwd` 路径指向了错误的目录（如嵌套的 dist/dist/）

**解决方案**:
```javascript
// ecosystem.config.js
{
  name: 'codelens-web',
  script: 'serve',
  args: '-s dist -p 5173',  // 正确格式：参数之间用空格分隔
  cwd: '/opt/codelens/apps/web',  // 确保路径正确，不是 dist/dist
}
```

确保 `serve` 已全局安装：
```bash
ssh root@47.116.6.132 "npm install -g serve"
```

### 7. 嵌套 dist 目录问题

**症状**: 部署后发现 `/opt/codelens/apps/web/dist/dist/` 嵌套目录

**原因**: 使用 `scp -r dist` 会将整个 dist 目录复制到目标目录下，造成嵌套

**解决方案**:
```bash
# 清理旧文件
ssh root@47.116.6.132 "rm -rf /opt/codelens/apps/web/dist && mkdir -p /opt/codelens/apps/web/dist"

# 上传文件内容（使用 dist/* 而不是 dist）
scp -r apps/web/dist/* root@47.116.6.132:/opt/codelens/apps/web/dist/

# 验证目录结构
ssh root@47.116.6.132 "ls -la /opt/codelens/apps/web/dist/"
# 应该直接看到 index.html 和 assets/ 目录
```

### 8. SSH 密码认证失败

**症状**: 部署脚本执行时频繁要求输入密码

**解决方案**: 配置 SSH 密钥认证
```bash
# 生成密钥（如果没有）
ssh-keygen -t rsa -b 4096

# 复制公钥到服务器
ssh-copy-id root@47.116.6.132

# 测试免密登录
ssh root@47.116.6.132 "echo 'SSH key authentication works!'"
```

### 9. API 502 错误

**原因**: API 服务未启动或端口不匹配

**检查**:
```bash
pm2 status
netstat -tlnp | grep 8787
pm2 logs codelens-api --lines 50
```

### 10. Mixed Content 错误

**原因**: HTTPS 页面请求 HTTP API

**解决**: 确保 `.env.production` 中使用 HTTPS URL
```env
VITE_API_BASE_URL=https://sunlingyue.cn/code-api
```

### 11. 静态资源 MIME 类型错误

**原因**: Nginx 未正确识别文件类型

**解决**: 确保 nginx.conf 包含 `mime.types`
```nginx
include mime.types;
default_type application/octet-stream;
```

### 12. 数据库连接失败

**原因**: 数据库密码错误或数据库不存在

**检查**:
```bash
psql -U postgres -d codelens -c "SELECT 1"
```

## 性能优化

### 1. Nginx 缓存

```nginx
# 静态资源缓存
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

### 2. Gzip 压缩

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css text/xml text/javascript 
           application/x-javascript application/xml+rss 
           application/javascript application/json;
```

### 3. PM2 集群模式

```javascript
{
  name: 'codelens-api',
  script: './apps/api/dist/index.js',
  instances: 2,  // 多实例
  exec_mode: 'cluster'
}
```

### 4. 数据库连接池

在 API 代码中配置：
```javascript
const pool = new Pool({
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

## 监控与告警

### 1. PM2 监控

```bash
# 安装 PM2 Plus
pm2 install pm2-server-monit

# 查看监控面板
pm2 monit
```

### 2. 日志轮转

```bash
# 安装 PM2 日志轮转
pm2 install pm2-logrotate

# 配置日志保留
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## 回滚策略

### 1. 保留旧版本

```bash
# 部署前备份
cp -r /opt/codelens /opt/codelens.backup.$(date +%Y%m%d_%H%M%S)
```

### 2. 快速回滚

```bash
# 停止当前服务
pm2 stop codelens-api

# 恢复备份
rm -rf /opt/codelens
mv /opt/codelens.backup.20240315_120000 /opt/codelens

# 重启服务
pm2 restart codelens-api
```

## 安全建议

1. **环境变量**: 不要将敏感信息提交到 Git
2. **数据库密码**: 使用强密码
3. **API Keys**: 定期轮换
4. **HTTPS**: 强制使用 HTTPS
5. **防火墙**: 只开放必要端口 (80, 443)
6. **定期更新**: 及时更新依赖包

## 相关文档

- [README.md](./README.md) - 项目介绍和快速开始
- [DEPLOY_NOW.md](./DEPLOY_NOW.md) - 快速部署指南（服务器端构建）
- [deploy-server.sh](./deploy-server.sh) - 服务器端部署脚本
- [scripts/deploy.js](./scripts/deploy.js) - 本地一键部署脚本
- [FINAL_STATUS.md](./FINAL_STATUS.md) - Agent 升级完成状态
- [apps/api/src/db/migrations/add_agent_tables.sql](./apps/api/src/db/migrations/add_agent_tables.sql) - Agent 数据库迁移脚本
- [LEARNING_GUIDE.md](./LEARNING_GUIDE.md) - 完整学习指南
- [package.json](./package.json) - 依赖和脚本配置
- [ecosystem.config.js](./ecosystem.config.js) - PM2 配置

---

**准备好了吗？执行 `npm run deploy` 开始部署！** 🚀
