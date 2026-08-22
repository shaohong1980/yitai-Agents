# 易台 Yitai-agent-team 🐾

> 基于 **DeepSeek Harness（dsh）** 插件架构的本地多 Agent 团队工作台。
> 一个「易台多 Agent 办公室」+ 记忆 / 语音 / 会议 / 群聊 / 任务交付的完整 Agent 团队。

易台把单个 Harness 会话变成一个**可编排的 Agent 团队**：易总管（队长）拆解目标、分派给专职员工，员工可以是 **durable 可续聊 subagent**（真实执行），也可以回退**可视化模拟**（demo 模式）——办公室面板实时展示每位员工的状态、走动、汇报与任务进度。

---

## ✨ 特性一览

| 能力 | 插件 | 说明 |
| --- | --- | --- |
| **易台多 Agent 办公室** | `plugin-yitai-office` | 易总管 + 5 名专职员工，可视化工位面板 |
| **durable 磁盘状态** | `plugin-yitai-office` | `office.json` + 邮箱，重启冷恢复 |
| **事件驱动调度器** | `plugin-yitai-office` | 空闲员工自动认领 ready 任务并唤醒 |
| **durable 可续聊员工** | `plugin-yitai-office` | subagent 员工（persona + 工具过滤） |
| **任务 DAG + attempt 能力** | `plugin-yitai-office` | 依赖图 + 迟到写入防护 + 安全转派 |
| **多 Agent 会议室** | `plugin-yitai-office` | 圆桌讨论 + 自动纪要 |
| **任务看板 + 自动验收** | `plugin-yitai-office` | 派活→执行→验货→审批 |
| **群聊视图** | `plugin-yitai-office` | 仿微信群头脑风暴 + 语音 |
| **3D 知识图谱** | `plugin-yitai-office` | 群聊/会议自动抽取概念可视化 |
| **记忆系统** | `plugin-yitai-memory` | 焦点栈 + 记忆衰减 + SQLite/FTS 检索 |
| **语音 ASR/TTS** | `plugin-yitai-voice` | 讯飞 ASR + MiniMax/豆包 TTS |
| **Token 压缩** | `plugin-yitai-tokenjuice` | 大段工具输出压缩，全文落盘 |

---

## 🚀 快速开始

```bash
# 1. 启动 Harness Web UI（默认 http://127.0.0.1:3080）
./scripts/start.sh --port 3080

# 2. 打开易台多 Agent 办公室面板（实时事件流）
#    http://127.0.0.1:3888/
```

要求：Node 22+（推荐 hermes 目录的 node）、pnpm、DeepSeek Harness 已构建。

---

## 🏗 架构

```
E:\Myworkspace\                          # 易台 Agent 团队，独立仓库
├── cordis.patch.yml                     # 主 patch 覆盖层（--patch 注入）
├── plugins\
│   ├── plugin-hello\                    # 管道自检（hello world）
│   ├── plugin-yitai-memory\             # 易台记忆系统
│   │   └── src\
│   │       ├── index.ts                 # 插件入口（session 事件 + 工具 + 服务）
│   │       ├── store.ts                 # SQLite 记忆库（node:sqlite + FTS5）
│   │       ├── focus-stack.ts           # 焦点栈（push/pop/回归/压缩回填）
│   │       └── tools.ts                 # memory_search/upsert/recall 等工具
│   ├── plugin-yitai-office\             # 易台多 Agent 办公室（借鉴 dsh-agent-teams 架构）
│   │   ├── src\
│   │   │   ├── index.ts                 # 组合层：HTTP/WS 面板 + 工具 + 系统提示 + /yitai 命令
│   │   │   ├── office.ts                # 办公室引擎门面（磁盘真相 + 调度 + 成员 + 可视化桥接）
│   │   │   ├── state.ts                 # 磁盘持久化 + per-office 锁 + 任务 DAG/attempt 能力
│   │   │   ├── scheduler.ts             # 事件驱动调度器（agent/status idle → 认领 → 唤醒）
│   │   │   ├── members.ts               # durable 可续聊 subagent 员工（persona + 工具过滤）
│   │   │   ├── types.ts                 # durable 办公室/任务/邮箱类型
│   │   │   ├── team.ts                  # 可视化工位/走动状态模型（demo 模式）
│   │   │   └── meeting.ts               # 多 Agent 会议室引擎
│   │   └── office\index.html            # 可视化面板（实时流 + 任务/会议/图谱/语音）
│   ├── plugin-yitai-voice\              # 语音 ASR/TTS
│   └── plugin-yitai-tokenjuice\         # Token 工具结果压缩
├── config\
│   ├── yitai-demo.patch.yml             # 演示模式覆盖层（无真实 subagent）
│   └── test-memory-only.patch.yml       # 仅记忆插件的最小组合
├── scripts\
│   ├── start.sh                         # Git Bash 启动
│   └── start.ps1                        # PowerShell 启动
├── skills\                              # 团队技能包
└── docs\                                # 项目文档
```

## 🔌 零侵入原则

- **不改 Harness 源码**：官方仓库 `E:\deepseek-harness` 保持 `git pull` 可升级。
- 所有插件通过 `pnpm dsh web --patch E:/Myworkspace/cordis.patch.yml` 挂载。
- 插件以绝对 `file://` URL 引用，Harness 官方代码零改动。
- 依赖解析：`E:\Myworkspace\node_modules` 是到 `~/.dsh/profiles/node_modules` 的 junction，共享 Harness 同一份 cordis/dsh 包。

---

## 🏢 易台多 Agent 办公室

`plugin-yitai-office` 借鉴 [@nanmicoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) 的团队引擎架构：

- **磁盘真相源**：办公室状态持久化到 `<workspace>/.yitai-office/office/office.json` + `inbox/*.jsonl`，重启后冷恢复团队/任务/邮箱。
- **事件驱动调度**：监听 `agent/status` 的 idle 边，空闲员工自动认领 ready 任务并被唤醒（无需常驻轮询）。
- **durable 员工**：开启 `liveDelegation` 后，5 名员工 spawn 为 durable 可续聊 subagent（persona + 工具过滤），跨轮次/跨重启保持会话。
- **任务 DAG + attempt 能力**：任务可声明 `dependencies`，每次执行带单调 `attempt` + 唯一 `attemptId`；转派先失效旧能力，迟到写入无法覆盖新结果。
- 无可用真实 subagent（缺 API Key）时自动回退**可视化模拟**，面板照常运转。

### 团队成员

| 员工 | id | 角色 |
| --- | --- | --- |
| 易总管 | `yitai` | 主管 Agent · 调度（队长，拆解/分派/验收） |
| File Agent | `file` | 文件管理 |
| Computer Agent | `computer` | 电脑操作 |
| App Agent | `app` | 应用调度 |
| 诸葛 | `zhuge` | 规划参谋 |
| 小搜 | `find` | 检索专员 |

### 工具

```
yitai_dispatch        → 广播任务，易总管拆解并分派
yitai_status          → 团队/任务板/邮箱全景
yitai_create_task     → 建任务（支持 dependencies / assignee）
yitai_claim_task      → （成员）领取任务，返回 attempt_id
yitai_update_task     → （成员）带 attempt_id 推进状态
yitai_reassign_task   → （队长）安全转派/接管
yitai_send_message    → 成员/队长互发消息（durable 邮箱 + 唤醒）
meeting_create/say/round/end/status/minutes
```

### 系统提示 + 斜杠命令

- 注册 `yitai-office:usage` 系统提示协议段，教模型以「易总管/队长」身份建团队、拆任务、派发、验收。
- `/yitai <目标>` 斜杠命令确定性激活团队协作。

### 配置

```yaml
# cordis.patch.yml 的 yitai-orchestrator.config
liveDelegation: true     # 真实 durable subagent 员工
demoMode: true           # 无真实成员时回退可视化模拟
subagentProvider: spawn  # spawn / fork
stateDir: .yitai-office  # 磁盘状态目录
port: 3888               # 面板端口
tickIntervalMs: 4200     # demo 模拟 tick 间隔
```

---

## 🏛 多 Agent 会议室

在 Harness 内直接开多 Agent 圆桌会议，可调度办公室员工 + 外部 A2A Agent。

**设计借鉴（借算法不借框架）：**
- **AutoGen GroupChatManager** → 发言轮转 / 自动选发言人（`speakerPolicy: round-robin | auto`）
- **MetaGPT MessagePool** → 会场消息流（统一总线便于纪要/权限）
- **Generative Agents** → 上下文选择：旧内容滚动压缩成摘要，控制上下文窗口

```
meeting_create(标题, 参会者)   → 创建会议室
meeting_say(会议室id, 发言)    → 用户发言，自动驱动 N 轮 AI 讨论
meeting_round(会议室id, 轮数)  → 驱动讨论
meeting_end(会议室id)          → 生成纪要，写入易台记忆库
meeting_status(会议室id?)      → 查看状态/摘要
meeting_minutes(会议室id)      → 查看纪要
```

**配置：**
```yaml
meeting:
  speakerPolicy: round-robin   # 或 auto（LLM 选发言人）
  autoRounds: 2                # 用户发言后自动讨论轮数
  keepTurns: 8                 # 保留最近多少条原文
  summarizeAfterChars: 6000    # 超过该字符触发摘要压缩
```

---

## 📋 任务看板 + 自动验收

**「📋 任务」视图**：派活 → 执行 → 自动验货 → 人工审批 → 完成

- 状态机：todo → running → review → done（review 驳回 → todo 带意见）
- 建任务可指定执行者：我 / 爱马仕 / ClaudeCode / OpenHuman / Codex
- **自动验收**：执行完成后自动调「验货员」（默认 Codex，有工具能力）用 `dir/type/python` 等命令**实际核实交付物**——文件是否存在、内容是否匹配、能否运行，必须给出可复核证据。
- 人工审批：待验收卡片「✓ 批准 / ✗ 驳回（填意见）」

后端：`/api/tasks`（GET/POST）+ `/api/tasks/:id/(run|approve|reject)`

---

## 👥 群聊视图

**「👥 群聊」视图**：仿微信群的头脑风暴（与「办公室/任务」并列）。

- 配色与主面板一致，微信式消息流、时间分隔线、「正在输入…」动画
- 成员：5 个外部 Agent + 我；每 Agent 独立 `contextId` 保持群聊记忆
- 语音：🎤 讯飞 RTASR / Web Speech 回退；🔊 MiniMax / 豆包 TTS / 浏览器语音回退

后端：`/api/group-chat`（GET 历史 + busy / POST 发消息）

---

## 🔮 3D 知识图谱 + 语音

**「🔮 图谱」视图**：群聊与会议记录 → 自动抽取主题 → 3D 球形力导图。

- Three.js 透明球壳 + 发光节点 + 贝塞尔连线 + 神经信号粒子，本地 `three.module.js`（免 CDN）
- 中文 n-gram（2-4 字）+ 英文词概念抽取 → 主题词节点（大小=频次，颜色=来源 agent）+ 共现链接
- 拖拽旋转 / 滚轮缩放 / 悬停高亮 / 点击点亮

后端：`/api/knowledge-graph`、`/api/knowledge`（记忆库图谱）、`/api/knowledge/export|import`

**语音：**
- ASR：讯飞 RTASR 流式转写（HMAC 签名），浏览器 Web Speech 回退
- TTS：MiniMax / 豆包（方舟），浏览器 speechSynthesis 回退
- 后端：`/api/voice-config`（GET/POST，key 不返回前端）、`/api/tts`、`/api/asr`

---

## 🔌 外部 A2A 接入

会议桌与群聊支持**外部 A2A 参会者**：发言时通过 A2A 协议调用真实 Agent。

| 参会者 | A2A 端点 | 说明 |
| --- | --- | --- |
| 爱马仕 (Hermes) | http://127.0.0.1:9900 | Hermes gateway（完整 agent） |
| ClaudeCode | http://127.0.0.1:9920 | Claude Code CLI |
| OpenHuman | http://127.0.0.1:9930 | OpenHuman core（本地 Ollama） |
| Codex | http://127.0.0.1:9940 | Codex CLI |

实现：`meeting.ts` 的 `ParticipantDef.a2aUrl` 字段——配置了该字段的参会者发言轮次调用 `message/send`（`contextId = <会议id>:<参会者id>` 保持多轮记忆）；未配置的走本地 `llmFn`。

---

## 🧠 记忆系统（plugin-yitai-memory）

- **焦点栈**：push/pop/回归/压缩回填（最近记忆优先进入上下文）
- **记忆衰减**：长期未访问的记忆逐步降权
- **SQLite + FTS5**：`$DSH_HOME/yitai-memory/memory.db`，轻量语义检索
- **工具**：`memory_search` / `memory_upsert` / `memory_recall` 等
- 记忆类型：事实 / 用户画像 / 对话 / 会议纪要 / 任务记录，可被办公室知识图谱读取

---

## 🛠 技能包（skills/）

`task-breakdown` · `web-research` · `report-writing` · `meeting-notes` · `code-review`

---

## 📝 待办

- 记忆 LLM 识别器（需 API Key）
- Harness 前端 UI 槽嵌入（替代独立面板页）
- 语音 Provider Key 一键配置引导

---

## 📄 License

MIT
