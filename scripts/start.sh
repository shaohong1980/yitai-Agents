#!/usr/bin/env bash
# Yitai Workbench 启动脚本 (Git Bash / MSYS / WSL)
# 用法: ./scripts/start.sh [--port 3080]
#
# 可移植性：优先使用环境变量，其次自动探测常见位置：
#   HARNESS_DIR   DeepSeek Harness 仓库目录（默认：本仓库同级 ../deepseek-harness）
#   NODE_BIN      Node 22+ 可执行文件（默认探测 hermes node / D:/node24 / PATH）
#   PNPM_BIN      pnpm.cjs 路径（默认探测仓库 node_modules / PATH）
#
# 说明：cordis.patch.yml 内插件 name 已是相对路径（相对该文件），仓库整体
# 拷贝/改名后无需修改；仅 customSkillDirs 因解析基准为进程 cwd，迁移时需
# 把其中绝对路径替换为新仓库路径。
set -e
cd "$(dirname "$0")/.."
WORKSPACE="$(pwd)"

# --- 环境变量优先，默认探测 ---
HARNESS_DIR="${HARNESS_DIR:-$WORKSPACE/../deepseek-harness}"
NODE_BIN="${NODE_BIN:-}"
PNPM_BIN="${PNPM_BIN:-}"

if [ -z "$NODE_BIN" ]; then
  for cand in \
    "$HOME/AppData/Local/hermes/node/node.exe" \
    "D:/node24/node.exe" \
    "C:/Program Files/nodejs/node.exe"; do
    if [ -f "$cand" ]; then NODE_BIN="$cand"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -f "$NODE_BIN" ]; then
  echo "[start] 找不到 Node 22+。请安装 Node 22+ 后重试，或设置 NODE_BIN 环境变量。" >&2
  exit 1
fi

if [ -z "$PNPM_BIN" ]; then
  if [ -f "$WORKSPACE/node_modules/pnpm/bin/pnpm.cjs" ]; then
    PNPM_BIN="$WORKSPACE/node_modules/pnpm/bin/pnpm.cjs"
  else
    PNPM_BIN="$(command -v pnpm || true)"
  fi
fi
if [ -z "$PNPM_BIN" ]; then
  echo "[start] 找不到 pnpm。请设置 PNPM_BIN 环境变量（指向 pnpm.cjs），或先 pnpm install。" >&2
  exit 1
fi

if [ ! -d "$HARNESS_DIR" ]; then
  echo "[start] 找不到 DeepSeek Harness 仓库：$HARNESS_DIR" >&2
  echo "[start] 请设置 HARNESS_DIR 环境变量指向你的 Harness 仓库。" >&2
  exit 1
fi

# 把 Node 目录放进 PATH 最前，保证 pnpm 内部 spawn 的 `node` 也是 22+（否则可能用旧版，缺 node:sqlite）
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "[start] Node: $("$NODE_BIN" --version)  pnpm: $("$NODE_BIN" "$PNPM_BIN" --version)  PATH-node: $(node --version 2>/dev/null || echo n/a)"

cd "$HARNESS_DIR"
"$NODE_BIN" "$PNPM_BIN" dsh web --patch "$WORKSPACE/cordis.patch.yml" "$@"
