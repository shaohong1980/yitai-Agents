#!/usr/bin/env bash
# Marvis Workbench 启动脚本 (Git Bash)
# 用法: ./scripts/start.sh [--port 3080]
# 强制 Node 22+ : 用 node22 直接执行 pnpm.cjs,并把 node22 放进 PATH 最前,
# 这样 pnpm 内部 spawn 的 `node` 也是 22+(否则会用 D:\node20 的 v20,缺 node:sqlite)。
set -e
cd "$(dirname "$0")/.."

NODE="C:/Users/1/AppData/Local/hermes/node/node.exe"
[ -f "$NODE" ] || NODE="D:/node24/node.exe"
PNPM="D:/node20/node_modules/pnpm/bin/pnpm.cjs"

export PATH="/c/Users/1/AppData/Local/hermes/node:$PATH"
echo "[start] Node: $("$NODE" --version)  pnpm: $("$NODE" "$PNPM" --version)  PATH-node: $(node --version)"
cd "E:/deepseek-harness"
"$NODE" "$PNPM" dsh web --patch "E:/Myworkspace/cordis.patch.yml" "$@"
