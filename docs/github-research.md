# GitHub 调研：相似项目与可搬迁能力（基于 DeepSeek Harness）

> 调研时间：2026-08-15。来源：`awesome-dsh-plugin`（dsh 插件精选列表 ⭐1864）、GitHub 搜索。
> 本项目基于 **DeepSeek Harness**，一切皆插件（模型/工具/UI/记忆/agent loop 都可替换）。

## 一、相似项目参考

| 项目 | ⭐ | 可借鉴 |
| --- | --- | --- |
| [Devin-AXIS/iPolloWork](https://github.com/Devin-AXIS/iPolloWork) | 4058 | 自进化 agent 工作台；多 agent 编排、任务队列、记忆回放 |
| [zhu1090093659/dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) | 2217 | DSH Web UI 插件合集（任务看板/Git 图/侧栏/皮肤） |
| [liustack/modlens](https://github.com/liustack/modlens) | 1488 | DSH 视觉插件（图片问答/OCR/UI 还原） |
| [toolclub/agent_team_gui](https://github.com/toolclub/agent_team_gui) | - | 可复用 agent 小队：每 agent 独立 provider/model/工具策略 |
| [toolclub/dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) | - | 全局持久化 agent 小队（每 agent 模型/工具策略） |
| [LoserFox/distill](https://github.com/LoserFox/distill) | - | 自动对话蒸馏：后台 subagent 反思 + 技能创建/更新 |

## 二、已搬迁 / 已集成的能力

### 1. Agent 智能对话（解决"都不理我"）
- **办公室面板**：点击任意 agent，在侧栏对话框输入即回话（`/api/agent-chat`）
- **主对话**：注册 `marvis_ask` 工具，模型可在 Harness 聊天里直接让某位员工自我介绍/咨询
- **每 agent 独立模型**（借鉴 toolclub/agent_team_gui）：`config.agents.<id>.model/provider` 可让不同员工用不同模型
- 已实测：Marvis/雷找找/Computer/File/诸葛雷 均能按角色自我介绍

### 2. 零依赖工具集（借鉴 omdsh-dev/dsh-toolkit）
- 新增 `plugin-dsh-utils`：`util_time` / `util_calc` / `util_json` / `util_encode` / `util_regex` / `util_csv` / `util_markdown`
- 纯函数、零依赖、注册到 ctx.tools，任何 agent 都能用

### 3. Skill 包（借鉴 dsh-skill 生态）
- `E:\Myworkspace\skills\`：`task-breakdown`(规划拆解) / `web-research`(检索调研) / `report-writing`(报告) / `meeting-notes`(纪要) / `code-review`(审查)
- 通过 `skill-filesystem.customSkillDirs` 挂载，Harness 原生加载

### 4. 此前的记忆/图谱体系
- `plugin-bailongma-memory`：焦点栈 + SQLite + LLM 识别器 + 线程/承诺（对标 distill / dsh-memory 系）
- `plugin-marvis-orchestrator`：1+5 办公室 + 官方球形知识图谱 + 实时节点更新
- `plugin-bailongma-tokenjuice`：工具结果压缩
- `plugin-bailongma-voice`：TTS

## 三、值得后续搬迁（按价值排序）

### Memory（对标社区 dsh-memory 系）
- `highland0971/dsh-native-memory`：原生按工作区记忆（facts 存 harness 自身 seam）
- `flymysql/dsh-memory`：跨会话记忆 vault（remember/recall/forget + 每轮注入）
- `Jesse-njx/dsh-memory`：带引用（sessionId, seq）的蒸馏事实
- `Aik358/dsh-auto-memory`：三层记忆（用户/项目笔记/每日日志）

### MCP（Harness 原生支持）
- `Edge-Echo/dsh-mcp-bridge`：精选 MCP bundle（memory/filesystem/git/时间等）
- `PerryLink/dsh-mcp-panel`：MCP 运行时管理面板（连接状态可视化）
- `Ceelog/dsh-plugin-setting-mcp`：在设置页管理 MCP 服务器
- `kyo615/dsh-browser-control`：Playwright 浏览器控制 MCP
- `huey1in/trio`：浏览器自动化 + MCP 桥

### Skills
- `dhicoc/dsh-reverse-skill`：85 个逆向技能包
- `jeremy9682/dsh-skill-pack`：11 个工作流技能
- `Jesse-njx/dsh-skillport`：把已有 SKILL.md 库带进 DSH
- `YTxue/dsh-skill-manager-ytxue`：设置侧栏技能池管理

### 工具/能力
- `omdsh-dev/dsh-toolkit` 全家桶：diff/schema/stat 等（已集成核心子集）
- `SPYQWER1/dsh-codex-tools`：Codex 后端 web_search/image_gen/vision
- `taxueseek/dsh-files`：PDF/DOCX/XLSX 读取工具
- `kw78/dsh-office-tools`：Word/Excel 办公工具
- `1624318455/dsh-plugin-tts`：免费 Edge TTS 朗读（我们 voice 插件可参考）

### 工作流/自动化
- `truelove-dreamer/dsh-plugin-hooks`：Claude-Code 式生命周期钩子
- `LeemanCheung/dsh-task-dag`：subagent/工作流 DAG 可视化
- `omdsh-dev/dsh-inspect`：对抗式 检查→修复→复查 循环

## 四、安装社区插件的方式

```sh
# 在 harness 仓库里
cd E:/deepseek-harness
pnpm dsh plugin --profile web add <plugin-name>   # 从 dsh-market 安装
# 或手工：把插件包加入 cordis.patch.yml（本项目风格）
```

> ⚠️ 社区插件会以你的权限运行任意代码——安装前先看源码，别在存有密钥的机器上乱装。
