#!/bin/bash

# ============================================
# CodeLens 服务器端部署脚本
# 在服务器上执行此脚本
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
DEPLOY_DIR="/opt/codelens"

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

cd apps/api

# 运行 Agent 迁移
if [ -f "migrate-to-dashscope.sh" ]; then
    bash migrate-to-dashscope.sh
    echo -e "${GREEN}✅ 数据库迁移完成${NC}"
else
    echo -e "${YELLOW}⚠️  迁移脚本不存在，跳过${NC}"
fi

cd $DEPLOY_DIR

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
