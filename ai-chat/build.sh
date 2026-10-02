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

# 中文化脚注回链标签（mdast-util-to-hast 默认输出 "Back to reference N"，
# 该文案不在我们源码里，需在依赖安装后打补丁；已打过则自动跳过）
FOOTER_JS="node_modules/mdast-util-to-hast/lib/footer.js"
if [ -f "$FOOTER_JS" ] && grep -q "'Back to reference '" "$FOOTER_JS"; then
    echo "🌐 中文化 mdast-util-to-hast 脚注回链标签..."
    sed -i.bak "s/'Back to reference '/'返回参考文献 '/" "$FOOTER_JS" && rm -f "$FOOTER_JS.bak"
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

