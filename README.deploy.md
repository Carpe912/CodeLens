# CodeLens 部署文档

## 服务器信息
- **IP**: 47.116.6.132
- **用户**: admin
- **部署目录**: /home/admin/codelens
- **Node.js**: v22 (通过 nvm 管理)

## 快速部署

### 前置要求

1. **安装 sshpass**（用于密码认证）：
```bash
# macOS
brew install hudochenkov/sshpass/sshpass

# Ubuntu/Debian
sudo apt-get install sshpass
```

2. **服务器环境**（admin 用户需要安装）：
- Node.js 22 (已通过 nvm 安装 ✅)
- PostgreSQL
- Redis
- PM2 (部署脚本会自动安装)

### 一键部署
```bash
pnpm deploy
# 或
npm run deploy
```

脚本会自动使用密码 `Sunlingyao0912` 进行认证。

部署脚本会自动：
1. 打包项目
2. 上传到服务器
3. 安装系统依赖 (Node.js, PostgreSQL, Redis, PM2)
4. 安装项目依赖
5. 构建项目
6. 初始化数据库
7. 启动服务

## 服务管理

### SSH 登录服务器
```bash
ssh admin@47.116.6.132
# 密码: Sunlingyao0912
```

### PM2 命令
```bash
# 查看服务状态
pm2 status

# 查看日志
pm2 logs codelens-api
pm2 logs codelens-web

# 重启服务
pm2 restart codelens-api
pm2 restart codelens-web

# 停止服务
pm2 stop codelens-api
pm2 stop codelens-web

# 删除服务
pm2 delete codelens-api
pm2 delete codelens-web
```

### 数据库管理
```bash
# 连接数据库
sudo -u postgres psql codelens

# 查看表
\dt

# 查看数据
SELECT * FROM repos;
SELECT * FROM files LIMIT 10;
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

## 访问地址
- **Web**: http://sunlingyue.cn/code (通过 Nginx 代理)
- **API**: http://sunlingyue.cn/code-api (通过 Nginx 代理)
- **直接访问 API**: http://47.116.6.132:8787
- **直接访问 Web**: http://47.116.6.132:5173

## 配置 HTTPS（可选但推荐）

```bash
# 登录服务器
ssh root@47.116.6.132

# 安装 Certbot
apt-get install -y certbot python3-certbot-nginx

# 自动配置 HTTPS
certbot --nginx -d sunlingyue.cn -d www.sunlingyue.cn

# 自动续期
certbot renew --dry-run
```

配置完成后访问 https://sunlingyue.cn

## 环境变量配置

配置文件位于 `/home/admin/codelens/.env`

```bash
# Anthropic API
ANTHROPIC_BASE_URL=http://118.89.81.103:8081
ANTHROPIC_AUTH_TOKEN=sk-f2582742d1626781374d8476763c987b32e85fd8e8911c0ed2f7eff7e9413058

# Embedding API (Aliyun DashScope)
EMBED_API_KEY=sk-4002f08ebad741ea98a6978679f98328
EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBED_MODEL=text-embedding-v3
EMBED_DIMENSIONS=1024

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=codelens
DB_USER=postgres
DB_PASSWORD=postgres

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Server
PORT=8787
NODE_ENV=production
```

## 故障排查

### 服务无法启动
```bash
# 查看详细日志
pm2 logs codelens-api --lines 100

# 检查端口占用
netstat -tlnp | grep 8787
netstat -tlnp | grep 5173
```

### 数据库连接失败
```bash
# 检查 PostgreSQL 状态
systemctl status postgresql

# 重启 PostgreSQL
systemctl restart postgresql

# 检查数据库是否存在
sudo -u postgres psql -l
```

### Redis 连接失败
```bash
# 检查 Redis 状态
systemctl status redis-server

# 重启 Redis
systemctl restart redis-server

# 测试连接
redis-cli ping
```

## 更新部署

修改代码后重新部署：
```bash
./deploy.sh
```

## 手动部署步骤

如果自动部署失败，可以手动执行：

```bash
# 1. 登录服务器
ssh admin@47.116.6.132

# 2. 切换到 Node.js 22
nvm use 22

# 3. 进入部署目录
cd /home/admin/codelens

# 4. 安装依赖
pnpm install

# 5. 构建
pnpm build

# 6. 重启服务
pm2 restart all
```

## 安全建议

1. 修改默认数据库密码
2. 配置防火墙规则
3. 使用 Nginx 反向代理
4. 启用 HTTPS
5. 定期备份数据库
