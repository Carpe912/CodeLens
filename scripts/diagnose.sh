#!/bin/bash

# CodeLens 服务诊断脚本
# 用于检查服务器上的 API 服务状态

SERVER="root@47.116.6.132"
DEPLOY_PATH="/root/CodeLens"

echo "=========================================="
echo "CodeLens 服务诊断"
echo "=========================================="

echo -e "\n1. 检查 PM2 进程状态..."
ssh $SERVER "pm2 status"

echo -e "\n2. 检查 API 服务日志（最后 30 行）..."
ssh $SERVER "pm2 logs codelens-api --lines 30 --nostream"

echo -e "\n3. 检查端口监听状态..."
ssh $SERVER "netstat -tlnp | grep 8787 || echo '端口 8787 未监听'"

echo -e "\n4. 测试健康检查端点..."
ssh $SERVER "curl -s http://localhost:8787/health || echo 'API 服务无响应'"

echo -e "\n5. 检查数据库连接..."
ssh $SERVER "pg_isready -h localhost -p 5432 || echo '数据库未就绪'"

echo -e "\n6. 检查 Redis 连接..."
ssh $SERVER "redis-cli ping || echo 'Redis 未就绪'"

echo -e "\n7. 检查环境变量配置..."
# ⚠️ 只打印「变量名」，不打印值。`pm2 env` 的输出是 `KEY: value` 形式，
# 旧写法 grep -E '(EMBED_API_KEY|ANTHROPIC|...)' 会把密钥明文打到终端/日志里。
ssh $SERVER "cd $DEPLOY_PATH && pm2 env 0 | grep -oE '(DEEPSEEK_[A-Z_]*|ANTHROPIC[A-Z_]*|EMBED_[A-Z_]*|DASHSCOPE_[A-Z_]*|LLM_[A-Z_]*|RERANK_[A-Z_]*|DB_[A-Z]*|REDIS_[A-Z]*)' | sort -u"

echo -e "\n8. 检查磁盘空间..."
ssh $SERVER "df -h | grep -E '(Filesystem|/$)'"

echo -e "\n9. 检查内存使用..."
ssh $SERVER "free -h"

echo -e "\n=========================================="
echo "诊断完成"
echo "=========================================="
