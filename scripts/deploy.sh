#!/bin/bash

# CodeLens 部署脚本包装器
# 自动检测并切换到正确的 Node 版本

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 CodeLens 部署脚本${NC}"
echo ""

# 检查当前 Node 版本
CURRENT_NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)

if [ "$CURRENT_NODE_VERSION" -lt 18 ]; then
  echo -e "${YELLOW}⚠ 当前 Node 版本过低 (v${CURRENT_NODE_VERSION})，需要 >= 18${NC}"
  echo -e "${BLUE}尝试自动切换到 Node 22...${NC}"

  # 加载 nvm
  if [ -f "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh"

    # 尝试切换到 Node 22
    if nvm use 22 2>/dev/null; then
      echo -e "${GREEN}✓ 已切换到 Node 22${NC}"
    elif nvm use 18 2>/dev/null; then
      echo -e "${GREEN}✓ 已切换到 Node 18${NC}"
    else
      echo -e "${RED}✗ 未找到 Node 18 或 22，请先安装${NC}"
      echo -e "${YELLOW}运行: nvm install 22${NC}"
      exit 1
    fi
  else
    echo -e "${RED}✗ 未找到 nvm，请手动切换 Node 版本${NC}"
    echo -e "${YELLOW}运行: nvm use 22 && npm run deploy${NC}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ Node 版本符合要求 (v${CURRENT_NODE_VERSION})${NC}"
fi

echo ""
echo -e "${BLUE}开始执行部署...${NC}"
echo ""

# 执行部署脚本
node scripts/deploy.js

echo ""
echo -e "${GREEN}✨ 部署完成！${NC}"
