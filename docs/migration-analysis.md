# 白龙马 → Harness 工作台：迁移评估与其余值得搬迁的能力

> 本文档评估白龙马（D:\BaiLongma）各模块迁移到 DeepSeek Harness 工作台的可行性。
> 白龙马文件夹只读，本评估基于对其源码与文档的研读。

## 一、已完成迁移

| # | 白龙马模块 | 工作台实现 | 说明 |
| --- | --- | --- | --- |
| 1 | memory/focus.js | plugin-bailongma-memory/src/focus-stack.ts | 焦点栈 push/pop/回归/压缩回填 |
| 2 | memory/injector.js | index.ts 上下文注入 | ACI 预判注入的精简版（焦点+相关记忆进 prompt） |
| 3 | db.js 记忆表 | store.ts (node:sqlite + FTS5) | memories/action_log/profile/focus_frames |
| 4 | 记忆工具 | tools.ts | memory_search/upsert/recall/forget/focus_status/profile_* |
| 5 | runtime/tick-policy.js | plugin-marvis-orchestrator | Tick 心跳 → Cordis 事件化 setInterval |
| 6 | multi-agent/* | plugin-marvis-orchestrator/src/team.ts | 1+5 团队引擎 + 派发 + 汇报流程 |
| 7 | ui/brain-ui 面板 | office/index.html | 复刻 Marvis v3 原型 + WS 实时流 |

## 二、尚未迁移、但值得搬迁的能力（按价值排序）

### ★★★ 高价值

1. **记忆识别器（memory/recognizer.js）→ LLM 记忆抽取工具**
   - 现状：工作台目前是启发式偏好提取 + 模型自主调用 memory_upsert。
   - 白龙马：每轮结束用 LLM 判断"这一轮值得存什么"，按 mem_id 命名规则去重写入。
   - 迁移方式：插件监听 `turn/end` 事件，用 `ctx.llm` 调一次轻量识别（deepseek-v4-flash），
     产出候选记忆后写入。收益：记忆质量远超启发式。

2. **工具结果压缩（runtime/tool-result-compressor.js, TokenJuice）**
   - 现状：Harness 工具结果全文进上下文，token 贵。
   - 白龙马：超阈值工具输出压成一行摘要，全文落盘 `tool-outputs/<id>.txt` 按需取回。
   - 迁移方式：监听 `tool/result` 事件，超阈值时把 content 替换为摘要 + 落盘路径。
     收益：省 30-60% token。

3. **线程/承诺模型（memory/threads.js）**
   - 现状：Harness 会话日志是线性的，没有"多线索并行 + 指代恢复"。
   - 白龙马：threads + commitments，解决话题漂移和"那个网页""进度怎么样"指代。
   - 迁移方式：memory 插件加 threads 表，turn 开始时按文本分类归属线索。

### ★★ 中价值

4. **场景 UI / Agent 驱动界面（scene/ 模块, Scene Protocol）**
   - 核心：`UI = f(scene)`，Agent 声明语义状态，UI 投影渲染。
   - 迁移方式：插件提供 `ui_set` 工具 + `ctx.on('scene/change')`，把 scene 状态推给面板。
     工作台面板可改为 scene 投影，Agent 通过 `ui_set` 直接控制工位面板显示什么。

5. **技能学习闭环（skills/registry.js, Agent Skills）**
   - Harness 自带 `@deepseek-ai/dsh-skill`（tool-skill），白龙马是 `learn_skill` + 用量遥测 + 生命周期。
   - 迁移价值：Harness 已有基础，白龙马的 learn/improve 循环可作为 skill 增强插件。

6. **预取缓存（memory/prefetch 相关）**
   - 定时抓取天气/新闻/榜单 → 有效期内自动注入。适合"早报""行情"类场景。
   - 迁移方式：插件加 prefetch_cache 表 + cron 轮询 + 注入。

### ★ 可选 / 依赖外部服务

7. **媒体生成**（generate_image/music/video）：强依赖 MiniMax Key，价值高但独立于核心工作台。
8. **社交连接器**（social/）：微信/Discord 桥接，依赖账号凭证；Harness 有 ACP/网关，可后续做。
9. **热点/世界杯面板**：信息面板，简单但时效性强，可作为面板扩展。
10. **本地 Agent 委托**（delegate_to_agent）：扫描本机 Claude Code/Codex 等，工作台可做 `list_agents`。

## 三、不建议迁移的

- **Electron 桌面壳**：Harness 是 Web 优先，桌面壳属于产品壳而非能力。
- **激活页/配置迁移**：Harness 有自己的 settings/credentials 体系。
- **硬编码 Provider 列表**：Harness 的 pi-ai 适配器更灵活，白龙马 Provider 逻辑不必搬。
- **Brain UI 整套前端**：工作台用独立面板 + 后续嵌入 Harness UI 槽，不复刻 Brain UI。

## 四、建议的下一步开发顺序

1. LLM 记忆识别器（turn/end 事件 + ctx.llm 轻量抽取）→ 记忆质量质变
2. 工具结果压缩（TokenJuice）→ token 成本立降
3. 线程/承诺模型 → 解决指代漂移
4. liveDelegation：marvis_dispatch 真正 spawn subagent
5. Scene Protocol：让 Agent 能 `ui_set` 控制面板
6. voice 插件（ASR/TTS，配 Key 后可测）
7. 把面板嵌入 Harness Web UI 的侧边栏/路由
