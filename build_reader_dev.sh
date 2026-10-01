#!/bin/bash
# 快速开发构建脚本 - 仅构建 reader zotero 目标并复制，不重启主应用
# 用法: ./build_reader_dev.sh
# 这个脚本只构建 zotero 目标（跳过 web/ios/android），大幅加快开发迭代速度

set -e

echo "🔨 构建 reader zotero 目标..."
cd reader
# 只构建 zotero 目标，跳过 web/ios/android 等其他目标
webpack --config-name zotero
cd ..

echo "📋 复制构建产物到 build/resource/reader/..."
cp -r reader/build/zotero/* build/resource/reader/

echo "✅ 完成！reader 模块已更新"
echo "运行 ./app/scripts/build_and_run -r"
./app/scripts/build_and_run -r