#!/bin/bash

# CodeLens 自动部署脚本 (root 用户)
# 服务器: 47.116.6.132

set -e

SERVER_IP="47.116.6.132"
SERVER_USER="root"
SERVER_PASSWORD="Sunlingyao0912"
DEPLOY_DIR="/opt/codelens"

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

DEPLOY_DIR="/opt/codelens"

echo "📁 创建部署目录..."
mkdir -p ${DEPLOY_DIR}
cd ${DEPLOY_DIR}

echo "📦 解压项目..."
tar -xzf /tmp/codelens-deploy.tar.gz -C ${DEPLOY_DIR}
rm /tmp/codelens-deploy.tar.gz

echo "🔧 检查 Node.js..."
if ! command -v node &> /dev/null; then
    echo "安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

echo "当前 Node.js 版本: $(node -v)"

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

echo "🗄️ 检查数据库..."
if ! systemctl is-active --quiet postgresql; then
    echo "⚠️  PostgreSQL 未运行，尝试启动..."
    systemctl start postgresql || echo "请手动启动 PostgreSQL"
fi

if ! systemctl is-active --quiet redis-server && ! systemctl is-active --quiet redis; then
    echo "⚠️  Redis 未运行，尝试启动..."
    systemctl start redis-server || systemctl start redis || echo "请手动启动 Redis"
fi

echo "🚀 启动服务..."
pm2 delete codelens-api codelens-web || true

cd apps/api
pm2 start dist/index.js --name codelens-api --env production
cd ../..

cd apps/web
pm2 start "serve -s dist -l 5173" --name codelens-web
cd ../..

pm2 save
pm2 startup

echo "🔧 配置 Nginx..."
if ! command -v nginx &> /dev/null; then
    echo "安装 Nginx..."
    apt-get update
    apt-get install -y nginx
fi

cat > /etc/nginx/sites-available/codelens << 'NGINXCONF'
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

    # CodeLens Web 前端
    location /code/ {
        rewrite ^/code/(.*)$ /$1 break;
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # CodeLens Web 前端 (无尾部斜杠)
    location = /code {
        return 301 /code/;
    }

    access_log /var/log/nginx/codelens-access.log;
    error_log /var/log/nginx/codelens-error.log;
}
NGINXCONF

ln -sf /etc/nginx/sites-available/codelens /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
systemctl enable nginx

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
echo "  - Web: http://sunlingyue.cn/code"
echo "  - API: http://sunlingyue.cn/code-api"
echo ""
echo "💡 建议配置 HTTPS："
echo "  ssh root@47.116.6.132"
echo "  apt-get install -y certbot python3-certbot-nginx"
echo "  certbot --nginx -d sunlingyue.cn -d www.sunlingyue.cn"
echo ""
echo "📝 查看日志："
echo "  ssh ${SERVER_USER}@${SERVER_IP}"
echo "  pm2 logs codelens-api"
echo "  pm2 logs codelens-web"
