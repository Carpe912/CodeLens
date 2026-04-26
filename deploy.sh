#!/bin/bash

# CodeLens 自动部署脚本
# 服务器: 47.116.6.132

set -e

SERVER_IP="47.116.6.132"
SERVER_USER="root"
SERVER_PASSWORD="Sunlingyao0912"
DEPLOY_DIR="/opt/codelens"
PROJECT_NAME="CodeLens"

echo "🚀 开始部署 CodeLens 到服务器 ${SERVER_IP}..."

# 1. 打包项目
echo "📦 打包项目..."
tar -czf codelens-deploy.tar.gz \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=dist \
  --exclude=.turbo \
  --exclude=apps/web/dist \
  --exclude=apps/api/dist \
  .

# 2. 上传到服务器
echo "📤 上传文件到服务器..."
sshpass -p "${SERVER_PASSWORD}" scp -o StrictHostKeyChecking=no \
  codelens-deploy.tar.gz ${SERVER_USER}@${SERVER_IP}:/tmp/

# 3. 在服务器上执行部署
echo "🔧 在服务器上执行部署..."
sshpass -p "${SERVER_PASSWORD}" ssh -o StrictHostKeyChecking=no \
  ${SERVER_USER}@${SERVER_IP} << 'ENDSSH'

set -e

DEPLOY_DIR="/opt/codelens"
PROJECT_NAME="CodeLens"

echo "📁 创建部署目录..."
mkdir -p ${DEPLOY_DIR}
cd ${DEPLOY_DIR}

echo "📦 解压项目..."
tar -xzf /tmp/codelens-deploy.tar.gz -C ${DEPLOY_DIR}
rm /tmp/codelens-deploy.tar.gz

echo "🔧 安装系统依赖..."
# 检查并安装 Node.js
if ! command -v node &> /dev/null; then
    echo "安装 Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# 检查并安装 pnpm
if ! command -v pnpm &> /dev/null; then
    echo "安装 pnpm..."
    npm install -g pnpm
fi

# 检查并安装 PostgreSQL
if ! command -v psql &> /dev/null; then
    echo "安装 PostgreSQL..."
    apt-get update
    apt-get install -y postgresql postgresql-contrib
    systemctl start postgresql
    systemctl enable postgresql

    # 创建数据库和用户
    sudo -u postgres psql << EOF
CREATE DATABASE codelens;
CREATE USER postgres WITH PASSWORD 'postgres';
GRANT ALL PRIVILEGES ON DATABASE codelens TO postgres;
ALTER DATABASE codelens OWNER TO postgres;
EOF
fi

# 检查并安装 Redis
if ! command -v redis-cli &> /dev/null; then
    echo "安装 Redis..."
    apt-get install -y redis-server
    systemctl start redis-server
    systemctl enable redis-server
fi

# 安装 PM2
if ! command -v pm2 &> /dev/null; then
    echo "安装 PM2..."
    npm install -g pm2
fi

echo "📦 安装项目依赖..."
pnpm install

echo "🏗️ 构建项目..."
pnpm build

echo "🔧 配置环境变量..."
cp .env.production .env

echo "🗄️ 初始化数据库..."
cd apps/api
node dist/db/init.js || echo "数据库已初始化"
cd ../..

echo "🚀 启动服务..."
# 停止旧服务
pm2 delete codelens-api codelens-web || true

# 启动 API 服务
cd apps/api
pm2 start dist/index.js --name codelens-api --env production
cd ../..

# 启动 Web 服务 (使用 serve)
npm install -g serve
cd apps/web
pm2 start "serve -s dist -l 5173" --name codelens-web
cd ../..

# 保存 PM2 配置
pm2 save
pm2 startup

echo "✅ 部署完成！"
echo "📊 服务状态："
pm2 status

echo ""
echo "🌐 访问地址："
echo "  - API: http://47.116.6.132:8787"
echo "  - Web: http://47.116.6.132:5173"
echo ""
echo "📝 查看日志："
echo "  - API: pm2 logs codelens-api"
echo "  - Web: pm2 logs codelens-web"

ENDSSH

# 4. 清理本地临时文件
echo "🧹 清理临时文件..."
rm codelens-deploy.tar.gz

echo "✅ 部署完成！"
echo ""
echo "🌐 访问地址："
echo "  - API: http://47.116.6.132:8787"
echo "  - Web: http://47.116.6.132:5173"
