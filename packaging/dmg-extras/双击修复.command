#!/bin/bash
# ForPaper 首次运行修复脚本
# 作用：移除 macOS 隔离属性（quarantine），解决「App 已损坏，无法打开」的提示。
# 原因：ForPaper 是开源软件，使用 ad-hoc 签名，未向 Apple 付费公证，
#       从网络下载后 macOS Gatekeeper 会拦截，本脚本一键解除拦截。

APP="/Applications/ForPaper.app"

echo "=========================================="
echo "  ForPaper 首次运行修复"
echo "=========================================="
echo

if [ ! -d "$APP" ]; then
    echo "❌ 未在「应用程序」文件夹中找到 ForPaper.app"
    echo
    echo "请先完成安装："
    echo "  1. 把本窗口中的 ForPaper.app 拖到右边的 Applications（应用程序）快捷方式"
    echo "  2. 然后重新双击本修复脚本"
    echo
    read -n 1 -s -r -p "按任意键退出..."
    exit 1
fi

echo "正在移除隔离属性..."
xattr -cr "$APP"

if [ $? -eq 0 ]; then
    echo
    echo "✅ 修复完成！现在可以从「应用程序」中正常打开 ForPaper 了。"
    echo "   （以后每次开机直接使用即可，无需再次运行本脚本）"
else
    echo
    echo "⚠️ 修复似乎未成功，请在「终端」中手动执行："
    echo "   xattr -cr /Applications/ForPaper.app"
fi

echo
read -n 1 -s -r -p "按任意键退出..."
