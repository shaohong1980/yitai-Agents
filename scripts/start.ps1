# Yitai Workbench 启动脚本 (PowerShell)
# 用法: .\scripts\start.ps1 [-Port 3080]
#
# 可移植性：优先使用环境变量，其次自动探测常见位置：
#   HARNESS_DIR   DeepSeek Harness 仓库目录（默认：本仓库同级 ..\deepseek-harness）
#   NODE_BIN      Node 22+ 可执行文件（默认探测 hermes node / D:\node24 / PATH）
#   PNPM_BIN      pnpm.cjs 路径（默认探测仓库 node_modules / PATH）
param([int]$Port = 3080)
$ErrorActionPreference = "Stop"

$WorkDir = Split-Path -Parent $PSScriptRoot

# --- 环境变量优先，默认探测 ---
$HarnessDir = if ($env:HARNESS_DIR) { $env:HARNESS_DIR } else { Join-Path $WorkDir "..\deepseek-harness" }
$NodeBin = $env:NODE_BIN
$PnpmBin = $env:PNPM_BIN

if (-not $NodeBin) {
  $candidates = @(
    Join-Path $env:USERPROFILE "AppData\Local\hermes\node\node.exe",
    "D:\node24\node.exe",
    "C:\Program Files\nodejs\node.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $NodeBin = $c; break } }
}
if (-not $NodeBin) { $NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $NodeBin -or -not (Test-Path $NodeBin)) {
  Write-Host "[start] 找不到 Node 22+。请安装 Node 22+ 后重试，或设置 NODE_BIN 环境变量。" -ForegroundColor Red
  exit 1
}

if (-not $PnpmBin) {
  $localPnpm = Join-Path $WorkDir "node_modules\pnpm\bin\pnpm.cjs"
  if (Test-Path $localPnpm) { $PnpmBin = $localPnpm }
  else { $PnpmBin = (Get-Command pnpm -ErrorAction SilentlyContinue).Source }
}
if (-not $PnpmBin) {
  Write-Host "[start] 找不到 pnpm。请设置 PNPM_BIN 环境变量（指向 pnpm.cjs），或先 pnpm install。" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $HarnessDir)) {
  Write-Host "[start] 找不到 DeepSeek Harness 仓库：$HarnessDir" -ForegroundColor Red
  Write-Host "[start] 请设置 HARNESS_DIR 环境变量指向你的 Harness 仓库。" -ForegroundColor Red
  exit 1
}

# Node 目录放进 PATH 最前，保证 pnpm 内部 spawn 的 node 也是 22+
$env:PATH = (Split-Path -Parent $NodeBin) + ";" + $env:PATH
Write-Host "[start] Node: $(& $NodeBin --version)  pnpm: $(& $NodeBin $PnpmBin --version)" -ForegroundColor Cyan

Push-Location $HarnessDir
try {
  & $NodeBin $PnpmBin dsh web --patch (Join-Path $WorkDir "cordis.patch.yml") --port $Port
} finally {
  Pop-Location
}
