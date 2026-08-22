# Marvis Workbench 项目状态

> 按实施方案 8 步推进，记录每步的完成情况。

## 步骤进度

| 步骤 | 内容 | 状态 | 验证方式 |
| --- | --- | --- | --- |
| 1 | 跑通 Harness 官方 demo | ✅ | `dsh web` 启动，HTTP 200 |
| 2 | hello-plugin 最小示例 | ✅ | 插件经 `--patch` 成功加载，console 输出 |
| 3 | memory 插件（记忆读写） | ✅ | SQLite 建表成功；store/focus 单测通过 |
| 4 | voice 插件（ASR/TTS） | ✅ 骨架 | 服务启动；speak 工具注册；需 Provider Key 实测 |
| 5 | 多 Agent 调度插件（1+5） | ✅ | 团队引擎 + 派发/状态工具 + WS 事件流实测 |
| 6 | Web UI 可视化面板 | ✅ | office 面板 HTTP 200，WS 实时事件流实测 |
| 7 | 端到端联调 | ✅ 基础 | 全插件同进程启动无冲突；记忆 E2E 模拟通过 |
| 8 | 扩展 MCP 技能 / IM 渠道 | ⏳ 待办 | Harness 自带 MCP/skill；IM 需凭证 |

## 运行验证记录

```
[plugin-hello] 插件加载成功 ✅
dsh web: http://127.0.0.1:3088
office HTTP 200 (http://127.0.0.1:3888/)
voice config HTTP 200 (http://127.0.0.1:3889/api/tts-config)
WS dispatch 实测: 雷司令接单 → 拆解 → 分派 → 员工开始处理 ✅
HTTP dispatch 实测: POST /api/dispatch → CEO thinking, agent working ✅
```

## 环境事实（重要）

- **Node 版本**：Harness 要求 `^22.19 || >=24`；本机默认 node20 也能跑（有 WARN），
  但推荐用 `C:\Users\1\AppData\Local\hermes\node`（v22.23.2）。
- **pnpm**：9.15（Harness 声明 11.7，WARN 但可用）。
- **依赖解析**：`E:\Myworkspace\node_modules` 是到 `~/.dsh/profiles/node_modules` 的 junction。
- **SQLite**：全链路用 `node:sqlite`（Node 22 内置），与 Harness 自身持久化同款，无需原生编译。
- **数据目录**：记忆库在 `~/.dsh/bailongma-memory/memory.db`，语音在 `~/.dsh/bailongma-voice/`。

## 已知限制

1. **焦点回归判断**：纯关键词启发式，复杂话题漂移识别不准确（白龙马用 LLM 分类器仲裁，可后续加）。
2. **记忆识别**：目前是启发式偏好提取 + 模型自主调 memory_upsert；LLM 识别器（turn/end + ctx.llm）待做。
3. **voice**：无 Provider Key，speak 工具返回配置引导；火山引擎签名请求未内置。
4. **面板端口**：office 页面硬编码 3888；改端口需同步改 HTML 的 WS_PORT。
5. **liveDelegation**：marvis_dispatch 目前是模拟；true 时需 API Key 且 subagent 服务在 web profile 中挂载。

## 更新：DeepSeek API Key 已启用（2026-08-15）

**凭据位置**：`~/.dsh/.credentials.yaml`（Harness 托管凭据，工作台代码零硬编码）。

### 新完成的能力

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| LLM 记忆识别器 | recognizer.ts（turn/end + ctx.llm.stream） | ✅ 实机提取 `preference_project_stack` |
| 焦点回填降噪 | 仅 ≥2 次命中的持续话题写结论 | ✅ |
| liveDelegation | orchestrator 用 ctx.subagents 真实 spawn | ✅ 已接线（需对话中触发 marvis_dispatch） |
| 进程退出修复 | ctx.on('dispose') → ctx.effect() | ✅ headless exit=0 |

### 实测记录

```
headless 任务「记住：我的项目偏好用 TypeScript 和 pnpm」
→ LLM 识别器提取: preference_project_stack
  "用户的项目技术栈偏好：TypeScript 作为开发语言，pnpm 作为包管理器。"
→ SQLite 写入成功，进程正常退出
```

### 关键技术修正

1. **资源清理**：插件自有定时器/HTTP 服务器必须用 `ctx.effect(() => { ...; return cleanup })`，
   `ctx.on('dispose')` 在一次性子进程（headless）中不可靠，会导致进程挂起。
2. **识别器防挂死**：`AbortSignal.any([外部取消, 20s 超时])`，dispose 时 abort。
3. **识别触发**：只在 `turn/end` 且用户输入 ≥4 字符时触发，fire-and-forget + 防重入。

## 更新：TokenJuice + 线程/承诺模型（2026-08-15 · 续）

### 新增插件 plugin-bailongma-tokenjuice

工具结果压缩（TokenJuice），迁移自白龙马 tool-result-compressor.js。
- 大段只读工具输出（read/glob/grep/read_image/memory_search 等）进模型前压成一行摘要 + 全文落盘路径
- 模型需要细节时按路径用 read 工具取回，省 token 且不丢细节
- 复用 Harness 的 surface replace 机制（同 dsh-compaction-tool-result-pruner）
- 实测：53KB read 结果 → 82 字符摘要（压缩 99.5%），Agent 仍正确完成任务

### 线程/承诺模型（memory 插件新增 threads.ts）

解决话题漂移 + 指代恢复：
- 开放/后台线索管理，前台指针随用户消息切换
- 指代问句（"刚才的演讲稿写好了吗"）按关键词匹配到对应线索，而非当前线索
- 承诺（"我会稍后…"）钉住线索温度，注入当前上下文
- 持久化到 SQLite（threads / commitments 表），重启可恢复

### 已修复

1. TokenJuice 递归防护 bug：surfaceOp 对 append 是字符串 'append' 而非对象，误跳过所有 append → 修正
2. 线程 CLOSE_RE 误杀："写好了吗"含"好了"被误判为结束 → 收紧结束语正则
3. 指代恢复："刚才的X"现在按关键词匹配所有开放线索（resume 而非 continue）
4. 焦点栈噪声：加入 system-reminder 指令文本的停用词

### 当前能力矩阵（7 项）

记忆库 · 焦点栈 · LLM 识别器 · 线程/承诺 · 多Agent办公室 · 语音 · TokenJuice
