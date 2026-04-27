# CodeLens 生产部署指南

本文档详细说明如何将 CodeLens 部署到生产服务器。

## 部署架构

```
用户浏览器
    ↓ HTTPS
阿里云 CDN/WAF (sunlingyue.cn)
    ↓
Nginx (47.116.6.132)
    ├─→ /code/          → 静态文件 (React SPA)
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
npm run deploy
```

部署脚本会自动完成：
1. 本地构建前端和后端
2. 通过 SSH 上传到服务器
3. 安装依赖
4. 重启 PM2 服务

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
# 上传代码
scp -r apps/ package.json pnpm-workspace.yaml ecosystem.config.js \
  root@47.116.6.132:/opt/codelens/

# 上传环境配置
scp apps/web/.env.production root@47.116.6.132:/opt/codelens/apps/web/
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
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 8787,
        DB_HOST: 'localhost',
        DB_PORT: 5432,
        DB_NAME: 'codelens',
        DB_USER: 'postgres',
        DB_PASSWORD: '666666',
        REDIS_HOST: 'localhost',
        REDIS_PORT: 6379,
        ANTHROPIC_API_KEY: 'your_key',
        OPENAI_API_KEY: 'your_key'
      }
    }
  ]
};
```

## Nginx 配置

文件：`/www/server/panel/vhost/nginx/47.116.6.132.conf`

### 前端静态文件服务

```nginx
location /code/ {
    alias /opt/codelens/apps/web/dist/;
    try_files $uri $uri/ /code/index.html;
    
    # 静态资源缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### API 反向代理

```nginx
location /code-api/ {
    proxy_pass http://localhost:8787/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}
```

### HTTPS 配置

```nginx
listen 443 ssl http2;
ssl_certificate /www/server/panel/vhost/cert/47.116.6.132/fullchain.pem;
ssl_certificate_key /www/server/panel/vhost/cert/47.116.6.132/privkey.pem;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:HIGH:!aNULL:!MD5:!RC4:!DHE;
ssl_prefer_server_ciphers on;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 10m;
```

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

### 1. 前端 404 错误

**原因**: Nginx 配置中 `try_files` 未正确配置

**解决**:
```nginx
location /code/ {
    alias /opt/codelens/apps/web/dist/;
    try_files $uri $uri/ /code/index.html;
}
```

### 2. API 502 错误

**原因**: API 服务未启动或端口不匹配

**检查**:
```bash
pm2 status
netstat -tlnp | grep 8787
```

### 3. Mixed Content 错误

**原因**: HTTPS 页面请求 HTTP API

**解决**: 确保 `.env.production` 中使用 HTTPS URL
```env
VITE_API_BASE_URL=https://sunlingyue.cn/code-api
```

### 4. 静态资源 MIME 类型错误

**原因**: Nginx 未正确识别文件类型

**解决**: 确保 nginx.conf 包含 `mime.types`
```nginx
include mime.types;
default_type application/octet-stream;
```

### 5. 数据库连接失败

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
