#!/bin/bash

echo "=== CodeLens 诊断脚本 ==="
echo ""

echo "1. 检查 PM2 服务状态"
pm2 status
echo ""

echo "2. 检查端口监听"
netstat -tlnp | grep -E '(5173|8787)'
echo ""

echo "3. 测试本地服务"
echo "测试 API (8787):"
curl -s http://localhost:8787/health || echo "API 无响应"
echo ""
echo "测试 Web (5173):"
curl -s -I http://localhost:5173 | head -5 || echo "Web 无响应"
echo ""

echo "4. 检查 Nginx 配置"
echo "Nginx 配置文件:"
cat /etc/nginx/sites-enabled/codelens
echo ""

echo "5. 测试 Nginx 配置"
nginx -t
echo ""

echo "6. 检查 Nginx 日志 (最后 20 行)"
echo "错误日志:"
tail -20 /var/log/nginx/codelens-error.log 2>/dev/null || echo "无错误日志"
echo ""
echo "访问日志:"
tail -20 /var/log/nginx/codelens-access.log 2>/dev/null || echo "无访问日志"
echo ""

echo "7. 测试通过 Nginx 访问"
echo "测试 /code:"
curl -s -I http://localhost/code | head -5
echo ""
echo "测试 /code-api/health:"
curl -s http://localhost/code-api/health
echo ""

echo "=== 诊断完成 ==="
