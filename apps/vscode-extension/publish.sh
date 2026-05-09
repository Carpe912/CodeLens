#!/bin/bash

# VSCode插件发布脚本

set -e

echo "🚀 CodeLens VSCode插件发布脚本"
echo "================================"
echo ""

# 检查是否安装了vsce
if ! command -v vsce &> /dev/null; then
    echo "❌ vsce未安装，正在安装..."
    npm install -g @vscode/vsce
fi

# 检查必需文件
echo "📋 检查必需文件..."
required_files=("package.json" "README.md" "CHANGELOG.md" ".vscodeignore")
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        echo "❌ 缺少文件: $file"
        exit 1
    fi
    echo "✅ $file"
done

# 检查publisher字段
publisher=$(node -p "require('./package.json').publisher")
if [ "$publisher" == "your-publisher-id" ] || [ -z "$publisher" ]; then
    echo ""
    echo "⚠️  请先在package.json中设置正确的publisher ID"
    echo "   当前值: $publisher"
    echo ""
    echo "步骤："
    echo "1. 访问 https://marketplace.visualstudio.com/manage"
    echo "2. 创建发布者账号"
    echo "3. 将publisher ID填入package.json"
    exit 1
fi

echo ""
echo "📦 当前配置："
echo "   名称: $(node -p "require('./package.json').displayName")"
echo "   版本: $(node -p "require('./package.json').version")"
echo "   发布者: $publisher"
echo ""

# 编译
echo "🔨 编译TypeScript..."
npm run compile

# 询问发布类型
echo ""
echo "请选择发布类型："
echo "1) 打包测试 (生成.vsix文件)"
echo "2) 发布补丁版本 (patch: x.x.X)"
echo "3) 发布次要版本 (minor: x.X.0)"
echo "4) 发布主要版本 (major: X.0.0)"
echo "5) 取消"
echo ""
read -p "请输入选项 (1-5): " choice

case $choice in
    1)
        echo ""
        echo "📦 打包插件..."
        vsce package
        echo ""
        echo "✅ 打包完成！"
        echo "   文件: $(ls -t *.vsix | head -1)"
        echo ""
        echo "测试安装命令："
        echo "   code --install-extension $(ls -t *.vsix | head -1)"
        ;;
    2)
        echo ""
        echo "🚀 发布补丁版本..."
        vsce publish patch
        echo ""
        echo "✅ 发布成功！"
        ;;
    3)
        echo ""
        echo "🚀 发布次要版本..."
        vsce publish minor
        echo ""
        echo "✅ 发布成功！"
        ;;
    4)
        echo ""
        echo "🚀 发布主要版本..."
        vsce publish major
        echo ""
        echo "✅ 发布成功！"
        ;;
    5)
        echo "取消发布"
        exit 0
        ;;
    *)
        echo "❌ 无效选项"
        exit 1
        ;;
esac

echo ""
echo "🎉 完成！"
