#!/bin/bash

# CodeLens 自动部署脚本
# 服务器: 47.116.6.132

set -e

SERVER_IP="47.116.6.132"
SERVER_USER="admin"
SERVER_PASSWORD="${DEPLOY_PASSWORD:-Sunlingyao0912}"
DEPLOY_DIR="/home/admin/codelens"
PROJECT_NAME="CodeLens"

echo "🚀 开始部署 CodeLens 到服务器 ${SERVER_IP}..."

# 检查 sshpass 是否安装
if ! command -v sshpass &> /dev/null; then
    echo "❌ 错误: 未安装 sshpass"
    echo ""
    echo "请选择以下任一方式安装:"
    echo "  方式1: brew install esolitos/ipa/sshpass"
    echo "  方式2: 手动编译安装"
    echo "    curl -O -L https://sourceforge.net/projects/sshpass/files/sshpass/1.09/sshpass-1.09.tar.gz"
    echo "    tar xvzf sshpass-1.09.tar.gz && cd sshpass-1.09"
    echo "    ./configure && make && sudo make install"
    echo ""
    echo "或者使用 expect 方式部署（无需 sshpass）:"
    echo "  ./deploy-expect.sh"
    exit 1
fi

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

DEPLOY_DIR="/home/admin/codelens"
PROJECT_NAME="CodeLens"

# 加载 nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# 使用 Node.js 22
nvm use 22

echo "📁 创建部署目录..."
mkdir -p ${DEPLOY_DIR}
cd ${DEPLOY_DIR}

echo "📦 解压项目..."
tar -xzf /tmp/codelens-deploy.tar.gz -C ${DEPLOY_DIR}
rm /tmp/codelens-deploy.tar.gz

echo "🔧 检查系统依赖..."

# 检查并安装 pnpm
if ! command -v pnpm &> /dev/null; then
    echo "安装 pnpm..."
    npm install -g pnpm
fi

# 检查 PostgreSQL (假设已安装)
if ! command -v psql &> /dev/null; then
    echo "⚠️  PostgreSQL 未安装，请手动安装"
    echo "sudo apt-get update && sudo apt-get install -y postgresql postgresql-contrib"
fi

# 检查 Redis (假设已安装)
if ! command -v redis-cli &> /dev/null; then
    echo "⚠️  Redis 未安装，请手动安装"
    echo "sudo apt-get install -y redis-server"
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
echo ""
echo "💡 提示："
echo "  - 确保 PostgreSQL 和 Redis 已安装并运行"
echo "  - 如需初始化数据库，请运行: cd ${DEPLOY_DIR}/apps/api && node dist/db/init.js"
