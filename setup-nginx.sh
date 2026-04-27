#!/bin/bash

# Nginx 配置脚本
# 在服务器上执行此脚本

set -e

echo "🔧 配置 Nginx..."

# 检查并安装 Nginx
if ! command -v nginx &> /dev/null; then
    echo "安装 Nginx..."
    apt-get update
    apt-get install -y nginx
fi

# 复制配置文件
echo "📝 创建 Nginx 配置..."
cat > /etc/nginx/sites-available/codelens << 'EOF'
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

    # 日志
    access_log /var/log/nginx/codelens-access.log;
    error_log /var/log/nginx/codelens-error.log;
}
EOF

# 启用站点
echo "🔗 启用站点..."
ln -sf /etc/nginx/sites-available/codelens /etc/nginx/sites-enabled/

# 删除默认站点（可选）
rm -f /etc/nginx/sites-enabled/default

# 测试配置
echo "✅ 测试 Nginx 配置..."
nginx -t

# 重启 Nginx
echo "🔄 重启 Nginx..."
systemctl restart nginx
systemctl enable nginx

# 检查状态
echo "📊 Nginx 状态:"
systemctl status nginx --no-pager

echo ""
echo "✅ Nginx 配置完成！"
echo ""
echo "🌐 访问地址："
echo "  - Web: http://sunlingyue.cn/code"
echo "  - API: http://sunlingyue.cn/code-api"
echo ""
echo "💡 建议配置 HTTPS："
echo "  apt-get install -y certbot python3-certbot-nginx"
echo "  certbot --nginx -d sunlingyue.cn -d www.sunlingyue.cn"
echo ""
echo "📝 查看日志："
echo "  - Nginx 访问日志: tail -f /var/log/nginx/codelens-access.log"
echo "  - Nginx 错误日志: tail -f /var/log/nginx/codelens-error.log"
