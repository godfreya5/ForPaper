#!/bin/bash
# AI Chat 构建脚本

set -e

echo "================================================"
echo "AI Chat - 安装依赖和构建"
echo "================================================"

# 进入 ai-chat 目录
cd "$(dirname "$0")"

# 检查 node_modules 是否存在
if [ ! -d "node_modules" ]; then
    echo ""
    echo "📦 首次构建，正在安装依赖..."
    echo ""
    npm install
else
    echo ""
    echo "✓ 依赖已存在，跳过安装"
    echo ""
fi

# 构建
echo ""
echo "🔨 正在构建 AI Chat..."
echo ""
npm run build

echo ""
echo "================================================"
echo "✓ 构建完成！"
echo "================================================"
echo ""
echo "输出文件："
echo "  - chrome/content/zotero/ai-chat/ai-chat-bundle.js"
echo "  - chrome/content/zotero/ai-chat/fonts/ (如果有字体文件)"
echo ""

