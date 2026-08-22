#!/usr/bin/env bash
# Yitai Workbench 路径迁移辅助脚本
#
# --patch overlay 里插件 name 必须用绝对 file:// URL（相对路径基准是 $DSH_HOME/profiles/<name>/，
# 不是 patch 文件目录），所以仓库迁移到新路径后需要把里面的绝对路径替换为新仓库路径。
#
# 用法: ./scripts/fix-paths.sh [新仓库绝对路径]
#   不传参数时用当前目录（仓库根）自动替换。
set -e
cd "$(dirname "$0")/.."
WORKSPACE="$(pwd)"
OLD_PATH="${1:-E:/Myworkspace}"

echo "[fix-paths] 将 $OLD_PATH 替换为 $WORKSPACE"
sed -i "s|$OLD_PATH|$WORKSPACE|g" cordis.patch.yml
sed -i "s|$OLD_PATH|$WORKSPACE|g" config/test-memory-only.patch.yml
echo "[fix-paths] 完成。剩余旧路径："
grep -n "$OLD_PATH" cordis.patch.yml config/test-memory-only.patch.yml || echo "  （无，已全部替换）"
