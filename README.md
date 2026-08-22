# Marvis Workbench 🐾

基于 **DeepSeek Harness（dsh）** 插件架构的本地 AI 工作台：
白龙马（BaiLongma）能力迁移 + Marvis 多 Agent 办公室。

## 快速开始

```bash
# 1. 启动 Harness Web UI（默认 http://127.0.0.1:3080）
./scripts/start.sh --port 3080

# 2. 打开 Marvis 多 Agent 办公室面板（实时事件流）
#    http://127.0.0.1:3888/
```

要求：Node 22+（推荐 hermes 目录的 node）、pnpm、Harness 已构建。

## 架构

```
E:\Myworkspace\                         # 你的代码，独立仓库
├── cordis.patch.yml                    # 主 patch 覆盖层（--patch 注入）
├── plugins\
│   ├── plugin-hello\                   # 管道自检（hello world）
│   ├── plugin-bailongma-memory\        # 白龙马记忆系统迁移
│   │   └── src\
│   │       ├── index.ts                # 插件入口（session 事件 + 工具 + 服务）
│   │       ├── store.ts                # SQLite 记忆库（node:sqlite + FTS5）
│   │       ├── focus-stack.ts          # 焦点栈（push/pop/回归/压缩回填）
│   │       └── tools.ts                # memory_search/upsert/recall 等工具
│   └── plugin-marvis-orchestrator\     # Marvis 1+5 多 Agent 办公室（借鉴 dsh-agent-teams 重写）
│       ├── src\
│       │   ├── index.ts                # 组合层：HTTP/WS 面板 + 工具 + 系统提示 + /marvis 命令
│       │   ├── office.ts               # 办公室引擎门面（磁盘真相 + 调度 + 成员 + 可视化桥接）
│       │   ├── state.ts                # 磁盘持久化 + per-office 锁 + 任务 DAG/attempt 能力
│       │   ├── scheduler.ts            # 事件驱动调度器（agent/status idle → 认领 → 唤醒）
│       │   ├── members.ts              # durable 可续聊 subagent 员工（persona + 工具过滤）
│       │   ├── types.ts                # durable 办公室/任务/邮箱类型
│       │   ├── team.ts                 # 可视化工位/走动状态模型（demo 模式）
│       │   └── meeting.ts              # 多 Agent 会议室引擎
│       └── office\index.html           # 可视化面板（复刻 v3 原型 + 实时流）
├── scripts\
│   ├── start.sh                        # Git Bash 启动
│   └── start.ps1                       # PowerShell 启动
└── docs\                               # 迁移文档
```

## 零侵入原则

- **不改 Harness 源码**：官方仓库 `E:\deepseek-harness` 保持 `git pull` 可升级。
- 所有插件通过 `pnpm dsh web --patch E:/Myworkspace/cordis.patch.yml` 挂载。
- 插件以绝对 `file://` URL 引用，Harness 官方代码零改动。
- 依赖解析：`E:\Myworkspace\node_modules` 是到 `~/.dsh/profiles/node_modules` 的 junction，
  共享 Harness 安装的同一份 cordis/dsh 包。

## 已迁移能力

| 模块 | 插件 | 状态 |
| --- | --- | --- |
| 焦点栈 | plugin-bailongma-memory | ✅ |
| 记忆衰减 | plugin-bailongma-memory | ✅ |
| SQLite 记忆库 + FTS | plugin-bailongma-memory | ✅ |
| 记忆工具（search/upsert/recall） | plugin-bailongma-memory | ✅ |
| 用户画像 | plugin-bailongma-memory | ✅ |
| Marvis 1+5 多 Agent 办公室 | plugin-marvis-orchestrator | ✅ |
| 可视化工位面板（实时 WS） | plugin-marvis-orchestrator | ✅ |
| durable 磁盘状态（office.json + 邮箱，冷恢复） | plugin-marvis-orchestrator | ✅ |
| 事件驱动调度器（idle → 认领 → 唤醒） | plugin-marvis-orchestrator | ✅ |
| durable 可续聊 subagent 员工 | plugin-marvis-orchestrator | ✅ |
| 任务 DAG 依赖 + attempt 能力 | plugin-marvis-orchestrator | ✅ |
| 任务派发/状态/成员工具 | plugin-marvis-orchestrator | ✅ |
| 多 Agent 会议室（圆桌讨论 + 纪要） | plugin-marvis-orchestrator | ✅ |

## Marvis 办公室（借鉴 dsh-agent-teams 重写）

`plugin-marvis-orchestrator` 借鉴 [@nanmicoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) 的架构重写了团队引擎：

- **磁盘真相源**：办公室状态持久化到 `<workspace>/.marvis-office/office/office.json` + `inbox/*.jsonl`，重启后冷恢复团队/任务/邮箱。
- **事件驱动调度**：监听 `agent/status` 的 idle 边，空闲员工自动认领 ready 任务并被唤醒（无需常驻轮询）。
- **durable 员工**：开启 `liveDelegation` 后，5 名员工 spawn 为 durable 可续聊 subagent（persona + 工具过滤），跨轮次/跨重启保持会话。
- **任务 DAG + attempt 能力**：任务可声明 `dependencies`，每次执行带单调 `attempt` + 唯一 `attemptId`；转派先失效旧能力，迟到写入无法覆盖新结果。
- **成员工具**：`marvis_claim_task` / `marvis_update_task` / `marvis_send_message` / `marvis_reassign_task` / `marvis_create_task`。
- **系统提示协议段 + `/marvis` 斜杠命令**：让模型知道何时以「雷总管/队长」身份建团队、拆任务、派发、验收。
- 无可用真实 subagent（缺 API Key）时自动回退**可视化模拟**，面板照常运转。

**配置**（`cordis.patch.yml` 的 `marvis-orchestrator.config`）：
```yaml
liveDelegation: true     # 真实 durable subagent 员工
demoMode: true           # 无真实成员时回退可视化模拟
subagentProvider: spawn  # spawn / fork
stateDir: .marvis-office # 磁盘状态目录
```

## 待办（见 docs/）

- voice 插件（ASR/TTS，需 Provider Key）
- 记忆 LLM 识别器（需 API Key）
- Harness 前端 UI 槽嵌入（替代独立面板页）

## 智能 Agent 对话

办公室里的 AI 员工现在可以对话了：
- **面板侧栏**：点击某个员工 → 输入框直接聊天（如"介绍一下你自己"）
- **主对话**：在 Harness 聊天里让模型调用 `marvis_ask` 工具找任意员工
- 每员工可配独立模型：`cordis.patch.yml` 里 `marvis-orchestrator.config.agents.<id>`

## 多 Agent 会议室（plugin-marvis-orchestrator）

在 Harness 内直接开多 Agent 圆桌会议，可调度白龙马 / 爱马仕 / OpenHuman / 办公室员工。

**设计借鉴（借算法不借框架）：**
- **AutoGen GroupChatManager** → 发言轮转 / 自动选发言人（`speakerPolicy: round-robin | auto`）
- **MetaGPT MessagePool** → 会场消息流（所有消息经会议室总线，便于纪要/权限）
- **Generative Agents** → 上下文选择：旧内容滚动压缩成摘要，只保留最近若干条原文，控制上下文窗口

**工具：**
```
meeting_create(标题, 参会者)   → 创建会议室（参会者：bailongma/hermes/openhuma/ceo/marvis/zhuge/file/computer/app/find）
meeting_say(会议室id, 发言)    → 用户发言，自动驱动 N 轮 AI 讨论
meeting_round(会议室id, 轮数)  → 驱动讨论（每人轮流/自动发言一轮）
meeting_end(会议室id)          → 生成纪要，写入白龙马记忆库（type=meeting, source_ref=meeting:<id>）
meeting_status(会议室id?)      → 查看会议室状态/摘要/最近讨论
meeting_minutes(会议室id)      → 查看纪要
```

**配置**（`cordis.patch.yml` 的 `marvis-orchestrator.config`）：
```yaml
meeting:
  speakerPolicy: round-robin   # 或 auto（LLM 选发言人）
  autoRounds: 2                # 用户发言后自动讨论轮数
  keepTurns: 8                 # 保留最近多少条原文进上下文
  summarizeAfterChars: 6000    # 超过该字符触发摘要压缩
```

**面板**：办公室面板右上角 🏢 按钮 → 创建会议室、实时观看发言、结束生成纪要。
**REST**：`GET /api/meetings`、`POST /api/meeting`、`POST /api/meeting/:id/{round|say|end}`

## 通用工具（plugin-dsh-utils）

时间 / 计算 / JSON / 编码 / 正则 / CSV / Markdown —— 零依赖工具集。

## 技能包（skills/）

task-breakdown · web-research · report-writing · meeting-notes · code-review

## 调研参考

见 `docs/github-research.md`（dsh 插件生态调研 + 已集成内容 + 后续建议）。

## 五 Agent 外部接入(2026-08-22)

会议桌(plugin-marvis-orchestrator)支持**外部 A2A 参会者**:发言时通过 A2A 协议调用真实 agent,而非本地模拟。

| 参会者 | A2A 端点 | 说明 |
| --- | --- | --- |
| 爱马仕(Hermes) | http://127.0.0.1:9900 | Hermes gateway(完整 agent,DeepSeek) |
| 白龙马 | http://127.0.0.1:9910 | 爻台多 Agent 办公室 |
| ClaudeCode | http://127.0.0.1:9920 | Claude Code CLI(DeepSeek 后端) |
| OpenHuman | http://127.0.0.1:9930 | OpenHuman core(本地 Ollama) |
| Codex | http://127.0.0.1:9940 | Codex CLI(DeepSeek) |

实现:meeting.ts 的 `ParticipantDef.a2aUrl` 字段——配置了该字段的参会者,发言轮次调用
`message/send`(contextId = `<会议id>:<参会者id>` 保持多轮记忆);未配置的走本地 llmFn。
参会者 ID 别名:hermes / bailongma / claudecode / openhuma(oh) / codex / yaotai。

依赖:5 个 A2A 服务需先启动(见 D:\ClaudeCode\a2a-test\start-family.bat)。

## 界面优化(2026-08-22 第二轮)

Marvis 面板(office/index.html)+ 后端(index.ts)新增:

1. **外部成员工作站** — 侧栏顶部显示会议桌 5 个外部 A2A Agent(爱马仕/白龙马/ClaudeCode/OpenHuman/Codex)的状态卡片:绿点在线/红点离线/黄点思考中,点击直接对话(经后端 /api/agent-chat 代理,走 A2A message/send)
2. **健康状态轮询** — 后端 /api/ext-agents 每 20s 探测 5 个端点(任何 HTTP 响应算在线,连接拒绝/超时算离线)
3. **会议一键选人** — 会议弹窗新增「✨ 外部5人」按钮,一键填入 hermes,bailongma,claudecode,openhuma,codex
4. **思考反馈** — 与外部 Agent 对话时状态点变黄色脉冲 + "思考中…"
5. **会议记录导出** — 会议详情新增「⬇ 导出」,生成 Markdown 下载

后端:/api/ext-agents(健康列表)、/api/agent-chat(外部 agent 走 A2A)

## 群聊视图(2026-08-22 第三轮,仿微信群)

**主面板第 4 个视图「👥 群聊」**(与「办公室 / 分屏 / 主对话」并列),
内嵌 iframe 加载 `office/group-chat.html`(http://127.0.0.1:3888/group-chat),
完全仿微信群、不混入办公室/会议室元素:

- 配色与主面板一致(深色主题:背景 #0b0e16、面板 #141926、我的气泡 accent 蓝 #3b6ef6、对方气泡 #1c2436)
- 顶部导航:群名 + 成员数,点击弹出「群成员(6)」抽屉(头像/角色/在线状态)
- 成员条:6 个头像横排(5 Agent + 我),在线绿点/离线灰点,15 秒刷新
- 消息流:时间分隔线(今天/日期)、对方气泡带名字 + 时间、我的气泡右侧
- 底部输入:微信式输入栏(＋ / 输入框 / 绿色发送),Enter 发送、Shift+Enter 换行
- 回复期间显示「正在输入…」三点动画(对应 Agent 思考中)
- 3 秒轮询;每个 Agent 独立 contextId(group:<id>)保持群聊记忆

后端:/api/group-chat(GET 历史 + busy / POST 发消息,后台并发调 5 个 A2A Agent)

## 任务看板 + 自动验收(2026-08-22 第四轮,参考 HiveWard 审批 + 白龙马 verifyDelivery)

**「📋 任务」视图**(第 4 个视图):派活 → 执行 → 自动验货 → 人工审批 → 完成

- 状态机:todo(待办)→ running(执行中)→ verifying(验货中)→ review(待验收/审批)→ done(完成)
  - 待验收被驳回 → todo(带驳回意见)
- 建任务可指定执行者:我(手动)/ 爱马仕 / 白龙马 / ClaudeCode / OpenHuman / Codex
- **自动验收**(核心):执行完成后自动调「验货员」(默认 Codex,有工具能力)用
  `dir/type/python` 等命令**实际核实交付物**——文件是否存在、内容是否匹配、能否运行,
  必须给出可复核证据,第一行"通过/不通过",没有证据判不通过
  - 验货通过 → 进入待验收(带 ✅ 验货报告)
  - 验货不通过 → 自动退回待办(带 ❌ 验货意见)
- 人工审批:待验收卡片上「✓ 批准 / ✗ 驳回(填意见)」

后端:/api/tasks(GET/POST)+ /api/tasks/:id/(run|approve|reject)
实测:Codex 写 print_1_to_10.py → 验货员 `dir` 确认文件存在、`type` 核对内容、
`python` 实跑输出 → 判定「通过」并附完整证据链。

## 知识图谱视图(2026-08-22 第五轮,参考白龙马 knowledge-sphere + concept-extractor)

**「🔮 图谱」视图**(第 5 个):群聊与会议记录 → 自动抽取主题 → 力导图可视化

- 数据流:群聊历史 + 会议记录 → 中文 n-gram(2-4字)+ 英文词概念抽取
  (去停用词/符号噪声/频次排序)→ 主题词节点(大小=频次,颜色=来源 agent)+ 共现链接
- 渲染:SVG 简易力导图(斥力+连边引力+中心引力,150 轮迭代收敛)
- 交互:悬停/点击节点高亮,右侧图例显示各 agent 颜色,点击节点看频次/涉及 agent
- 高频主题(≥5 次)提示"建议沉淀为固定流程"
- 顶部「↻ 刷新」重新抽取;切到图谱视图自动渲染

后端:/api/knowledge-graph(节点/链接/消息数)

## 3D 球形图谱 + 语音(2026-08-22 第六轮,参考白龙马 knowledge-sphere + voice)

**「🔮 图谱」= 白龙马 knowledge-sphere 完整搬迁**(Three.js 3D):
- 透明线框球壳 + 发光节点 Sprite + 贝塞尔连线 + 神经信号粒子
- 大气辉光 + 双层轨道环 + 中心核心光晕 + 内部星尘 + 星空背景
- 自研轻量 3D 力学(球壳吸附 + 连边弹簧 + 软斥力);自动旋转
- 拖拽旋转 / 滚轮缩放 / 悬停高亮 / 点击点亮(神经元放电)
- 节点颜色=来源 agent(图例对应);本地 three.module.js(1.3MB,免 CDN)
- 文件:office/knowledge-sphere.js(白龙马原版)+ office/vendor/three/three.module.js

**🎙️ 语音识别(ASR)** — 群聊页 🎤 按钮:
- **科大讯飞 RTASR(默认,已从白龙马迁移配置)**:录音(MediaRecorder)→ 解码重采样
  (16k 16bit PCM)→ POST /api/asr → 后端 HMAC-SHA1 签名连 wss://rtasr.xfyun.cn 流式转写
- 回退:浏览器 Web Speech API(Chrome/Edge 免费中文)
- 说完自动填入输入框并发送到群里;语音识别浮层显示状态

**🔊 语音合成(TTS)** — 群聊页 🔊 按钮 + 设置:
- **豆包·方舟(默认,key 已从白龙马迁移)**:model seed-tts-2.0、音色小何 2.0,走 /api/tts 代理
- MiniMax(已迁移 key,可选)
- 默认回退:浏览器 speechSynthesis(中文女声)

**🔊 语音合成(TTS)** — 群聊页 🔊 按钮 + 设置:
- 默认:浏览器 speechSynthesis(中文女声,零配置)
- 可配置 MiniMax / 豆包(方舟)API:设置 → 🎙️ 语音 tab 填 API Key/GroupId/模型/音色
- 自动朗读开关:agent 消息出现自动朗读;每条消息旁 🔊 可手动朗读
- API 失败自动回退浏览器语音

后端:/api/voice-config(GET/POST,key 不返回前端只报 has_key)、/api/tts(MiniMax/豆包代理,返回 mp3)

## 三视图职责分工(2026-08-22 第七轮)

消除办公室/群聊/任务功能重叠,明确分工:

- **🏢 办公室 = 指挥中心(看全局)**:内部员工状态、八卦圆桌组织架构、统计面板。
  底部广播输入框已移除;八卦成员点击提示去群聊/任务;底部引导条可一键跳转
- **👥 群聊 = 头脑风暴(出想法)**:开放式讨论、快速问答、语音输入/输出。
  雷总管接单只给建议(不派活),消息带任务意图时提示"正式派单请到 📋 任务看板"
- **📋 任务 = 正式工程(落交付)**:建任务→指派执行者→自动验货→人工审批→完成。
  唯一派活入口,有明确交付物的活来这里

一句话:办公室看全局,群聊出想法,任务落交付。
