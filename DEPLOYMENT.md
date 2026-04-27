# CodeLens 生产部署指南

本文档详细说明如何将 CodeLens 部署到生产服务器。

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

### 1. 配置部署脚本

在 `package.json` 中添加部署命令：

```json
{
  "scripts": {
    "deploy": "node scripts/deploy.js"
  }
}
```

### 2. 执行部署

```bash
# 确保使用 Node.js 18+
nvm use 18

# 执行部署
npm run deploy
```

部署脚本会自动完成：
1. 本地构建前端和后端
2. 通过 SSH 上传到服务器
3. 安装依赖
4. 重启 PM2 服务

**注意事项**：
- 前端构建时 Vite base 配置为 `/`，由 Nginx 处理路径映射
- 上传 dist 目录时使用 `dist/*` 避免嵌套目录问题
- PM2 使用 `serve` 命令提供静态文件服务

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
        EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        EMBED_MODEL: 'text-embedding-v3',
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

### 后端环境变量

配置在 `ecosystem.config.js` 中：

```javascript
env: {
  NODE_ENV: 'production',
  PORT: 8787,
  DB_HOST: 'localhost',
  DB_PORT: 5432,
  DB_NAME: 'codelens',
  DB_USER: 'postgres',
  DB_PASSWORD: 'your_password',
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  ANTHROPIC_API_KEY: 'your_anthropic_key',
  OPENAI_API_KEY: 'your_openai_key'
}
```

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

### 2. 访问测试

- 前端：https://sunlingyue.cn/code/
- API：https://sunlingyue.cn/code-api/repos

### 3. 查看日志

```bash
# API 日志
pm2 logs codelens-api

# Nginx 访问日志
tail -f /www/wwwlogs/47.116.6.132.log

# Nginx 错误日志
tail -f /www/wwwlogs/47.116.6.132.error.log
```

## 常见问题

### 1. 前端资源 404 错误

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

### 2. PM2 前端服务启动失败 (ENOTFOUND -p)

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

### 3. 嵌套 dist 目录问题

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

### 4. SSH 密码认证失败

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

### 5. API 502 错误

**原因**: API 服务未启动或端口不匹配

**检查**:
```bash
pm2 status
netstat -tlnp | grep 8787
pm2 logs codelens-api --lines 50
```

### 6. Mixed Content 错误

**原因**: HTTPS 页面请求 HTTP API

**解决**: 确保 `.env.production` 中使用 HTTPS URL
```env
VITE_API_BASE_URL=https://sunlingyue.cn/code-api
```

### 7. 静态资源 MIME 类型错误

**原因**: Nginx 未正确识别文件类型

**解决**: 确保 nginx.conf 包含 `mime.types`
```nginx
include mime.types;
default_type application/octet-stream;
```

### 8. 数据库连接失败

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
- [LEARNING_GUIDE.md](./LEARNING_GUIDE.md) - 完整学习指南
- [package.json](./package.json) - 依赖和脚本配置
- [ecosystem.config.js](./ecosystem.config.js) - PM2 配置
