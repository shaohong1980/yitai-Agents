# Marvis Workbench 启动脚本 (PowerShell)
# 用法: .\scripts\start.ps1 [-Port 3080]
# 强制 Node 22+ : 用 node22 直接执行 pnpm.cjs,并把 node22 放进 PATH 最前,
# 这样 pnpm 内部 spawn 的 `node` 也是 22+(否则会用 D:\node20 的 v20,缺 node:sqlite)。
param([int]$Port = 3080)
$ErrorActionPreference = "Stop"

$env:PATH = "C:\Users\1\AppData\Local\hermes\node;" + $env:PATH
$Node = "C:\Users\1\AppData\Local\hermes\node\node.exe"
if (-not (Test-Path $Node)) { $Node = "D:\node24\node.exe" }
$Pnpm = "D:\node20\node_modules\pnpm\bin\pnpm.cjs"

Write-Host "[start] Node: $(& $Node --version)  pnpm: $(& $Node $Pnpm --version)" -ForegroundColor Cyan

Push-Location "E:\deepseek-harness"
try {
  & $Node $Pnpm dsh web --patch "E:\Myworkspace\cordis.patch.yml" --port $Port
} finally {
  Pop-Location
}
