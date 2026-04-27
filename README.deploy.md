# CodeLens 部署文档

## 服务器信息
- **IP**: 47.116.6.132
- **用户**: root
- **部署目录**: /opt/codelens
- **Node.js**: v20.20.2
- **域名**: https://sunlingyue.cn/code/

## 快速部署

### 一键部署命令

本地代码修改后，执行以下命令一键部署：

```bash
npm run deploy
```

部署脚本会自动：
1. ✅ 本地构建前端和后端
2. ✅ 通过 SSH 上传到服务器
3. ✅ 安装生产依赖
4. ✅ 重启 PM2 服务
5. ✅ 验证部署结果

### 前置要求

1. **本地环境**：
   - Node.js >= 18
   - pnpm >= 9
   - SSH 访问权限

2. **服务器环境**（已配置 ✅）：
   - Node.js 20.20.2
   - PostgreSQL 13 + pgvector
   - Redis 6
   - PM2
   - Nginx (宝塔面板管理)

## 访问地址

- **前端**: https://sunlingyue.cn/code/
- **API**: https://sunlingyue.cn/code-api/

## 服务管理

### SSH 登录服务器
```bash
ssh root@47.116.6.132
# 密码: Sunlingyao0912
```

### PM2 命令
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
```

### 数据库管理
```bash
# 连接数据库
PGPASSWORD=666666 psql -U postgres -d codelens

# 查看表
\dt

# 查看数据
SELECT * FROM repos;
```

### Redis 管理
```bash
# 连接 Redis
redis-cli

# 查看所有 keys
KEYS *

# 清空缓存
FLUSHALL
```

## 部署架构

```
用户浏览器
    ↓ HTTPS
阿里云 CDN/WAF (sunlingyue.cn)
    ↓
Nginx (47.116.6.132)
    ├─→ /code/          → 静态文件 (/opt/codelens/apps/web/dist/)
    └─→ /code-api/      → API 服务 (localhost:8787)
                              ↓
                         PostgreSQL (:5432)
                         Redis (:6379)
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
env_production: {
  NODE_ENV: 'production',
  PORT: 8787,
  DB_HOST: 'localhost',
  DB_PORT: 5432,
  DB_NAME: 'codelens',
  DB_USER: 'postgres',
  DB_PASSWORD: '666666',
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  ANTHROPIC_BASE_URL: 'http://118.89.81.103:8081',
  ANTHROPIC_AUTH_TOKEN: 'sk-f2582742d1626781374d8476763c987b32e85fd8e8911c0ed2f7eff7e9413058',
  EMBED_API_KEY: 'sk-4002f08ebad741ea98a6978679f98328',
  EMBED_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  EMBED_MODEL: 'text-embedding-v3',
  EMBED_DIMENSIONS: '1024'
}
```

## Nginx 配置

文件：`/www/server/panel/vhost/nginx/47.116.6.132.conf`

### 前端静态文件

```nginx
location /code/ {
    alias /opt/codelens/apps/web/dist/;
    try_files $uri $uri/ /code/index.html;
    add_header Cache-Control "no-cache";
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

## 故障排查

### 1. API 服务无法启动

```bash
# 查看详细日志
pm2 logs codelens-api --lines 50

# 检查端口占用
netstat -tlnp | grep 8787

# 检查数据库连接
PGPASSWORD=666666 psql -U postgres -d codelens -c "SELECT 1"
```

### 2. 前端 404 错误

```bash
# 检查静态文件是否存在
ls -la /opt/codelens/apps/web/dist/

# 检查 Nginx 配置
nginx -t

# 重载 Nginx
nginx -s reload
```

### 3. Mixed Content 错误

确保 `.env.production` 使用 HTTPS：
```env
VITE_API_BASE_URL=https://sunlingyue.cn/code-api
```

### 4. 数据库连接失败

```bash
# 检查 PostgreSQL 状态
systemctl status postgresql

# 检查数据库是否存在
PGPASSWORD=666666 psql -U postgres -l | grep codelens

# 创建数据库（如果不存在）
PGPASSWORD=666666 psql -U postgres -c "CREATE DATABASE codelens;"
```

### 5. Redis 连接失败

```bash
# 检查 Redis 状态
systemctl status redis

# 测试连接
redis-cli ping
```

## 手动部署步骤

如果自动部署失败，可以手动执行：

```bash
# 1. 本地构建
pnpm install
pnpm build:api
pnpm build:web

# 2. 上传到服务器
scp -r apps/api/dist root@47.116.6.132:/opt/codelens/apps/api/
scp -r apps/web/dist root@47.116.6.132:/opt/codelens/apps/web/
scp apps/web/.env.production root@47.116.6.132:/opt/codelens/apps/web/
scp ecosystem.config.js root@47.116.6.132:/opt/codelens/

# 3. SSH 登录服务器
ssh root@47.116.6.132

# 4. 安装依赖并重启
cd /opt/codelens
pnpm install --prod
pm2 restart ecosystem.config.js
```

## 性能优化

### 1. Nginx 缓存

```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
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
  instances: 2,  // 多实例
  exec_mode: 'cluster'
}
```

## 监控与日志

### PM2 监控

```bash
# 实时监控
pm2 monit

# 查看日志
pm2 logs codelens-api --lines 100

# 日志文件位置
/var/log/codelens-api-out.log
/var/log/codelens-api-error.log
```

### Nginx 日志

```bash
# 访问日志
tail -f /www/wwwlogs/47.116.6.132.log

# 错误日志
tail -f /www/wwwlogs/47.116.6.132.error.log
```

## 备份策略

### 数据库备份

```bash
# 备份数据库
PGPASSWORD=666666 pg_dump -U postgres codelens > codelens_backup_$(date +%Y%m%d).sql

# 恢复数据库
PGPASSWORD=666666 psql -U postgres codelens < codelens_backup_20240315.sql
```

### 代码备份

```bash
# 备份部署目录
tar -czf codelens_backup_$(date +%Y%m%d).tar.gz /opt/codelens
```

## 安全建议

1. ✅ 使用 HTTPS（已配置）
2. ✅ 配置防火墙（只开放 80, 443）
3. ✅ 使用 Nginx 反向代理
4. ⚠️ 定期更新依赖包
5. ⚠️ 定期备份数据库
6. ⚠️ 监控服务器资源使用

## 相关文档

- [README.md](./README.md) - 项目介绍
- [DEPLOYMENT.md](./DEPLOYMENT.md) - 详细部署指南
- [LEARNING_GUIDE.md](./LEARNING_GUIDE.md) - 学习指南

