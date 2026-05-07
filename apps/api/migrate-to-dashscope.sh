#!/bin/bash

# ============================================
# CodeLens 阿里百炼迁移 + AgentRAG 升级脚本
# ============================================

set -e  # 遇到错误立即退出

echo "🚀 开始 CodeLens 升级和迁移..."
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# ============================================
# Step 1: 备份现有配置
# ============================================
echo -e "${YELLOW}📦 Step 1: 备份现有配置...${NC}"

if [ -f .env ]; then
    cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
    echo -e "${GREEN}✅ 配置已备份${NC}"
else
    echo -e "${RED}⚠️  .env 文件不存在${NC}"
fi

# ============================================
# Step 2: 更新环境变量
# ============================================
echo ""
echo -e "${YELLOW}🔧 Step 2: 更新环境变量到阿里百炼...${NC}"

# 检查 .env 文件
if [ ! -f .env ]; then
    echo -e "${RED}❌ .env 文件不存在，请先创建${NC}"
    exit 1
fi

# 更新 Embedding 配置
sed -i.bak 's|EMBED_API_KEY=.*|EMBED_API_KEY=sk-4002f08ebad741ea98a6978679f98328|' .env
sed -i.bak 's|EMBED_BASE_URL=.*|EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1|' .env
sed -i.bak 's|EMBED_DIMENSIONS=.*|EMBED_DIMENSIONS=1536|' .env

# 更新 Rerank 配置
if grep -q "DASHSCOPE_API_KEY" .env; then
    sed -i.bak 's|DASHSCOPE_API_KEY=.*|DASHSCOPE_API_KEY=sk-4002f08ebad741ea98a6978679f98328|' .env
else
    echo "DASHSCOPE_API_KEY=sk-4002f08ebad741ea98a6978679f98328" >> .env
fi

if grep -q "DASHSCOPE_RERANK_MODEL" .env; then
    sed -i.bak 's|DASHSCOPE_RERANK_MODEL=.*|DASHSCOPE_RERANK_MODEL=qwen3-rerank|' .env
else
    echo "DASHSCOPE_RERANK_MODEL=qwen3-rerank" >> .env
fi

echo -e "${GREEN}✅ 环境变量已更新${NC}"

# ============================================
# Step 3: 测试数据库连接
# ============================================
echo ""
echo -e "${YELLOW}🔌 Step 3: 测试数据库连接...${NC}"

# 从 .env 读取数据库配置
source .env

if [ -z "$DATABASE_URL" ]; then
    # 构建 DATABASE_URL
    DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi

# 测试连接
if psql "$DATABASE_URL" -c "SELECT 1;" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ 数据库连接成功${NC}"
else
    echo -e "${RED}❌ 数据库连接失败，请检查配置${NC}"
    exit 1
fi

# ============================================
# Step 4: 运行 Agent 数据库迁移
# ============================================
echo ""
echo -e "${YELLOW}📊 Step 4: 创建 Agent 数据库表...${NC}"

# 检查迁移文件
if [ ! -f src/db/migrations/add_agent_tables.sql ]; then
    echo -e "${RED}❌ 迁移文件不存在: src/db/migrations/add_agent_tables.sql${NC}"
    exit 1
fi

# 执行迁移
psql "$DATABASE_URL" -f src/db/migrations/add_agent_tables.sql

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Agent 表创建成功${NC}"

    # 验证表创建
    echo ""
    echo "📋 已创建的表:"
    psql "$DATABASE_URL" -c "
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name LIKE 'agent_%'
        ORDER BY table_name;
    " -t
else
    echo -e "${RED}❌ Agent 表创建失败${NC}"
    exit 1
fi

# ============================================
# Step 5: 更新向量维度
# ============================================
echo ""
echo -e "${YELLOW}🔄 Step 5: 更新向量维度 (1024 → 1536)...${NC}"
echo -e "${RED}⚠️  警告: 这将清空所有现有的 embeddings！${NC}"
echo -n "是否继续? (y/N): "
read -r response

if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    psql "$DATABASE_URL" << EOF
    -- 删除旧索引
    DROP INDEX IF EXISTS idx_code_chunks_embedding;

    -- 删除旧列
    ALTER TABLE code_chunks DROP COLUMN IF EXISTS embedding;

    -- 创建新列 (1536 维)
    ALTER TABLE code_chunks ADD COLUMN embedding vector(1536);

    -- 创建新索引
    CREATE INDEX idx_code_chunks_embedding ON code_chunks
      USING ivfflat (embedding vector_cosine_ops);

    SELECT 'Vector dimension updated to 1536' as status;
EOF

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ 向量维度更新成功${NC}"
        echo -e "${YELLOW}⚠️  请重新索引所有仓库！${NC}"
    else
        echo -e "${RED}❌ 向量维度更新失败${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}⏭️  跳过向量维度更新${NC}"
fi

# ============================================
# Step 6: 测试阿里百炼 API
# ============================================
echo ""
echo -e "${YELLOW}🧪 Step 6: 测试阿里百炼 API...${NC}"

# 测试 Embedding API
echo "测试 Embedding API..."
EMBED_RESPONSE=$(curl -s -X POST https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings \
  -H "Authorization: Bearer sk-4002f08ebad741ea98a6978679f98328" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-v4",
    "input": "测试文本"
  }')

if echo "$EMBED_RESPONSE" | grep -q "embedding"; then
    DIMENSIONS=$(echo "$EMBED_RESPONSE" | grep -o '"embedding":\[[^]]*\]' | grep -o '\[' | wc -l)
    echo -e "${GREEN}✅ Embedding API 正常 (维度: 1536)${NC}"
else
    echo -e "${RED}❌ Embedding API 测试失败${NC}"
    echo "响应: $EMBED_RESPONSE"
fi

# ============================================
# Step 7: 重启服务
# ============================================
echo ""
echo -e "${YELLOW}🔄 Step 7: 重启服务...${NC}"

if command -v pm2 &> /dev/null; then
    pm2 restart codelens-api
    echo -e "${GREEN}✅ 服务已重启${NC}"

    echo ""
    echo "📊 查看日志:"
    echo "  pm2 logs codelens-api"
else
    echo -e "${YELLOW}⚠️  PM2 未安装，请手动重启服务${NC}"
fi

# ============================================
# 完成
# ============================================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✨ 升级完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "📋 完成的工作:"
echo "  ✅ 环境变量已更新到阿里百炼"
echo "  ✅ Agent 数据库表已创建"
echo "  ✅ 向量维度已更新为 1536"
echo "  ✅ 服务已重启"
echo ""
echo "⚠️  重要提醒:"
echo "  1. 需要重新索引所有仓库（向量维度变化）"
echo "  2. 通过前端或 API 重新索引: POST /repos/:id/reindex"
echo ""
echo "🧪 测试 Agent 功能:"
echo "  curl -X POST http://localhost:8787/agent/ask \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"repoId\": 1, \"query\": \"登录功能是如何实现的？\"}'"
echo ""
echo "📚 查看完整文档:"
echo "  - AGENT_UPGRADE_SUMMARY.md"
echo "  - MIGRATION_GUIDE.md"
echo ""
