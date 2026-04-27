#!/bin/bash

# CodeLens 自动部署脚本 (使用 expect 内联)
# 服务器: 47.116.6.132

set -e

SERVER_IP="47.116.6.132"
SERVER_USER="admin"
SERVER_PASSWORD="Sunlingyao0912"
DEPLOY_DIR="/home/admin/codelens"

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
expect << EOF
set timeout 300
spawn scp -o StrictHostKeyChecking=no codelens-deploy.tar.gz ${SERVER_USER}@${SERVER_IP}:/tmp/
expect {
    "password:" {
        send "${SERVER_PASSWORD}\r"
        exp_continue
    }
    eof
}
EOF

# 3. 创建远程执行脚本
cat > /tmp/deploy-remote.sh << 'REMOTE_SCRIPT'
#!/bin/bash
set -e

# 加载 nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# 使用 Node.js 22
nvm use 22

DEPLOY_DIR="/home/admin/codelens"

echo "📁 创建部署目录..."
mkdir -p ${DEPLOY_DIR}
cd ${DEPLOY_DIR}

echo "📦 解压项目..."
tar -xzf /tmp/codelens-deploy.tar.gz -C ${DEPLOY_DIR}
rm /tmp/codelens-deploy.tar.gz

echo "🔧 检查依赖..."
command -v pnpm &> /dev/null || npm install -g pnpm
command -v pm2 &> /dev/null || npm install -g pm2
command -v serve &> /dev/null || npm install -g serve

echo "📦 安装项目依赖..."
pnpm install

echo "🏗️ 构建项目..."
pnpm build

echo "🔧 配置环境变量..."
cp .env.production .env

echo "🚀 启动服务..."
pm2 delete codelens-api codelens-web || true

cd apps/api
pm2 start dist/index.js --name codelens-api --env production
cd ../..

cd apps/web
pm2 start "serve -s dist -l 5173" --name codelens-web
cd ../..

pm2 save

echo "✅ 部署完成！"
pm2 status
REMOTE_SCRIPT

# 4. 上传并执行远程脚本
echo "🔧 在服务器上执行部署..."
expect << EOF
set timeout 600
spawn scp -o StrictHostKeyChecking=no /tmp/deploy-remote.sh ${SERVER_USER}@${SERVER_IP}:/tmp/
expect {
    "password:" {
        send "${SERVER_PASSWORD}\r"
        exp_continue
    }
    eof
}

spawn ssh -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_IP} "chmod +x /tmp/deploy-remote.sh && /tmp/deploy-remote.sh"
expect {
    "password:" {
        send "${SERVER_PASSWORD}\r"
        exp_continue
    }
    eof
}
EOF

# 5. 清理本地临时文件
echo "🧹 清理临时文件..."
rm codelens-deploy.tar.gz
rm /tmp/deploy-remote.sh

echo ""
echo "✅ 部署完成！"
echo ""
echo "🌐 访问地址："
echo "  - API: http://47.116.6.132:8787"
echo "  - Web: http://47.116.6.132:5173"
echo ""
echo "📝 查看日志："
echo "  ssh ${SERVER_USER}@${SERVER_IP}"
echo "  pm2 logs codelens-api"
echo "  pm2 logs codelens-web"
