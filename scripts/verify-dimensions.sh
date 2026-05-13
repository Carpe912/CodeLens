#!/bin/bash
# 服务器端验证脚本 - 检查向量维度配置

echo "=========================================="
echo "CodeLens 向量维度验证脚本"
echo "=========================================="
echo ""

# 1. 检查当前位置
echo "📍 当前目录："
pwd
echo ""

# 2. 检查环境变量
echo "⚙️  环境变量配置："
echo "EMBED_MODEL: ${EMBED_MODEL:-未设置}"
echo "EMBED_DIMENSIONS: ${EMBED_DIMENSIONS:-未设置}"
echo ""

# 3. 检查代码中的维度定义
echo "📝 代码中的维度定义："
echo "code_chunks 表定义："
grep -A 2 "embedding vector" /root/CodeLens/apps/api/dist/db/index.js | head -3
echo ""

# 4. 运行维度检查脚本
echo "🔍 运行数据库维度检查..."
cd /root/CodeLens/apps/api
node dist/scripts/check-embedding-dimensions.js

echo ""
echo "=========================================="
echo "验证完成"
echo "=========================================="
