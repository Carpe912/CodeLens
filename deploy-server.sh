#!/bin/bash

# ============================================
# CodeLens 服务器端部署脚本
# 在服务器上执行此脚本
#
# ⚠️ 与 scripts/deploy.js 的关系（两条路径必须保持同步）
#   scripts/deploy.js  是「本地一键部署」入口（pnpm deploy），本地构建后
#                      scp 上传到 /root/CodeLens，再 ssh 执行服务器端步骤。
#   本脚本             是「服务器上手工执行」的等价流程，从 git 拉代码后
#                      自行构建，适用于服务器上直接改了代码的场景。
#   两者的 DEPLOY_DIR 曾经不一致（/opt/codelens vs /root/CodeLens），
#   会让「部署成功」与「实际运行的服务」指向不同目录。现统一为 /root/CodeLens。
# ============================================

set -e  # 遇到错误立即退出

echo "🚀 开始部署 CodeLens..."
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 配置
SERVER_USER="root"
SERVER_HOST="47.116.6.132"
# 必须与 scripts/deploy.js 的 CONFIG.server.deployPath 一致
DEPLOY_DIR="/root/CodeLens"

# ============================================
# Step 1: 拉取最新代码
# ============================================
echo -e "${YELLOW}📥 Step 1: 拉取最新代码...${NC}"

cd $DEPLOY_DIR
git pull origin main

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ 代码更新成功${NC}"
else
    echo -e "${RED}❌ 代码更新失败${NC}"
    exit 1
fi

# ============================================
# Step 2: 安装依赖
# ============================================
echo ""
echo -e "${YELLOW}📦 Step 2: 安装依赖...${NC}"

pnpm install

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ 依赖安装成功${NC}"
else
    echo -e "${RED}❌ 依赖安装失败${NC}"
    exit 1
fi

# ============================================
# Step 3: 构建项目
# ============================================
echo ""
echo -e "${YELLOW}🔨 Step 3: 构建项目...${NC}"

# 构建 API
echo "构建 API..."
pnpm build:api

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ API 构建成功${NC}"
else
    echo -e "${RED}❌ API 构建失败${NC}"
    exit 1
fi

# 构建前端
echo "构建前端..."
pnpm build:web

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ 前端构建成功${NC}"
else
    echo -e "${RED}❌ 前端构建失败${NC}"
    exit 1
fi

# ============================================
# Step 4: 运行数据库迁移
# ============================================
echo ""
echo -e "${YELLOW}🗄️  Step 4: 运行数据库迁移...${NC}"

cd $DEPLOY_DIR

# 原实现调用 apps/api/migrate-to-dashscope.sh —— 该脚本已在目录整理中删除，
# 于是 `if [ -f ... ]` 判定失败、打印「跳过」，**迁移实际从未执行过**。
# 这正是 002/003/004 长期缺失、call_graph 永远为空的直接原因之一。
#
# 现在改用带 schema_migrations 台账的迁移执行器：
#   - 按文件名顺序执行 migrations/ 下所有未执行的迁移
#   - 已执行的记录在 schema_migrations，避免破坏性迁移（002）被重复执行
#   - 跑编译产物（node）而非 tsx，因为服务器上装的是 --prod 依赖
node --env-file-if-exists=.env.production apps/api/dist/scripts/migrate.js

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ 数据库迁移完成${NC}"
else
    echo -e "${RED}❌ 数据库迁移失败${NC}"
    exit 1
fi

# 关系图重建（可选）：设置 REBUILD_GRAPH_REPO_IDS 才会执行
# 例：REBUILD_GRAPH_REPO_IDS=1 bash deploy-server.sh
if [ -n "$REBUILD_GRAPH_REPO_IDS" ]; then
    echo ""
    echo -e "${YELLOW}🕸️  重建关系图（repoId: $REBUILD_GRAPH_REPO_IDS）...${NC}"
    for REPO_ID in $(echo "$REBUILD_GRAPH_REPO_IDS" | tr ',' ' '); do
        node --env-file-if-exists=.env.production apps/api/dist/scripts/rebuild-graph.js "$REPO_ID"
    done
fi

# ============================================
# Step 5: 重启服务
# ============================================
echo ""
echo -e "${YELLOW}🔄 Step 5: 重启服务...${NC}"

# 重启 API 服务
pm2 restart codelens-api

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ API 服务重启成功${NC}"
else
    echo -e "${RED}❌ API 服务重启失败${NC}"
    exit 1
fi

# 重启前端服务
pm2 restart codelens-web

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ 前端服务重启成功${NC}"
else
    echo -e "${YELLOW}⚠️  前端服务重启失败（可能不存在）${NC}"
fi

# ============================================
# Step 6: 检查服务状态
# ============================================
echo ""
echo -e "${YELLOW}📊 Step 6: 检查服务状态...${NC}"

pm2 status

# ============================================
# 完成
# ============================================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✨ 部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "📋 服务状态:"
pm2 list | grep codelens
echo ""
echo "📝 查看日志:"
echo "  pm2 logs codelens-api"
echo "  pm2 logs codelens-web"
echo ""
echo "🌐 访问地址:"
echo "  前端: https://sunlingyue.cn/code/"
echo "  API: https://sunlingyue.cn/code-api/"
echo ""
