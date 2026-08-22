/**
 * 多Agent 团队引擎 —— 1+5 多 Agent 办公室的服务器端状态模型。
 *
 * 角色（复刻自 多Agent办公室 v3 原型）：
 *   - 易总管（调度）：坐镇图谱正下方，接单、拆解、分派、验收
 *   - 易总管（主管）：协调各工位排期与负载，向上对 CEO 汇报
 *   - 小文 / 小电 / 小应 / 诸葛 / 小搜：五名专职员工
 *
 * 状态：每个 agent 有 status / task / load / 位置；事件通过 callback 广播给
 * 面板（WebSocket）和 Harness 日志（tools）。
 */

export type AgentStatus = 'idle' | 'working' | 'thinking' | 'reporting' | 'sleep'

export interface AgentDef {
  id: string
  name: string
  role: string
  scarf: string
  desk: { x: number; y: number }
  desc: string
}

export interface AgentState {
  id: string
  status: AgentStatus
  task: string
  done: number
  load: number
  pos: { x: number; y: number }
  seat: number
  walking: boolean
}

export interface TeamEvent {
  type: 'boot' | 'status' | 'task-start' | 'task-done' | 'report' | 'dispatch' | 'walk' | 'log' | 'bubble' | 'group-msg' | 'task-created'
  walking?: boolean
  head?: string
  text?: string
  subject?: string
  assigneeId?: string
  assigneeName?: string
  agentId: string
  status?: AgentStatus
  task?: string
  message: string
  timestamp: number
}

/** 1+5 办公室工位（百分比坐标，员工各自办公桌） */
export const AGENTS: AgentDef[] = [
  { id: 'yitai', name: '易总管', role: '主管 Agent', scarf: '#ff7a59', desk: { x: 12, y: 22 }, desc: '办公室总管兼调度。接单、拆解、分派、验收，协调各工位排期与负载。' },
  { id: 'file', name: '小文', role: '文件管理', scarf: '#8b5cf6', desk: { x: 12, y: 53 }, desc: '文件读写、归档、检索与版本管理。' },
  { id: 'computer', name: '小电', role: '电脑操作', scarf: '#22b07d', desk: { x: 12, y: 85 }, desc: '桌面与系统级操作：开应用、跑脚本、处理本地资源。' },
  { id: 'app', name: '小应', role: '应用调度', scarf: '#f5b731', desk: { x: 88, y: 22 }, desc: '第三方 App / 连接器调用，对接外部世界。' },
  { id: 'zhuge', name: '诸葛', role: '规划参谋', scarf: '#3b6ef6', desk: { x: 88, y: 53 }, desc: '把模糊需求拆成可执行计划与问题链。' },
  { id: 'find', name: '小搜', role: '检索专员', scarf: '#0fb5ba', desk: { x: 88, y: 85 }, desc: '搜索引擎与知识库检索专家，找资料最快的一只。' },
]

/** 圆桌下缘汇报位（员工起身到圆桌旁向 CEO / 核心团队汇报） */
export const SEATS = [
  { x: 40, y: 60 }, { x: 48, y: 63 }, { x: 56, y: 63 }, { x: 62, y: 60 }, { x: 50, y: 66 },
]

const SAMPLE_TASKS = [
  '季度报表整理', '竞品调研', '用户反馈聚类', '代码重构评审', '知识库归档',
  '会议纪要摘要', '数据清洗', '发布前检查', '方案构思', '性能优化',
]
const WORK_PH = [
  '正在处理「{}」…', '执行子任务 2/5：{}', '调用工具链处理 {}', '「{}」进度 60%',
]
const THINK_PH = [
  '嗯…这个需求要先拆解', '在权衡两种实现方案', '复盘刚才的异常分支', '查阅历史案例找思路',
]

export class YitaiTeam {
  states = new Map<string, AgentState>()
  seatBusy: (string | null)[] = SEATS.map(() => null)
  doneCount = 0
  logLines: { time: string; cls: string; msg: string }[] = []
  private tickCounter = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()
  emitFn: (event: TeamEvent) => void

  constructor(emitFn: (event: TeamEvent) => void) {
    this.emitFn = emitFn
    for (const a of AGENTS) {
      this.states.set(a.id, {
        id: a.id,
        status: 'idle',
        task: '—',
        done: 0,
        load: 20 + Math.floor(Math.random() * 30),
        pos: { ...a.desk },
        seat: -1,
        walking: false,
      })
    }
  }

  /** 可清理的延迟执行：所有演示动画定时器统一登记，dispose 时一并取消。 */
  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }

  /** 取消全部未完成的演示动画定时器（插件卸载时调用）。 */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  get(id: string): AgentState {
    return this.states.get(id) ?? { id, status: 'idle', task: '—', done: 0, load: 20, pos: { x: 50, y: 50 }, seat: -1, walking: false }
  }

  setStatus(id: string, status: AgentStatus, task?: string): void {
    const s = this.states.get(id)
    if (!s) return
    s.status = status
    if (task !== undefined) s.task = task
    this.emitFn({ type: 'status', agentId: id, status, task: s.task, walking: s.walking, message: `${this.nameOf(id)} → ${status}`, timestamp: Date.now() })
  }

  /** 让某位员工"开口说话"（AI 对话回显到面板气泡） */
  say(agentId: string, text: string): void {
    this.emitFn({ type: "status", agentId, message: text, timestamp: Date.now() })
  }

  nameOf(id: string): string {
    return AGENTS.find(a => a.id === id)?.name ?? id
  }

  agentDef(id: string): AgentDef | undefined {
    return AGENTS.find(a => a.id === id)
  }

  /** 日志（同时进面板消息流） */
  log(msg: string, cls = ''): void {
    const t = new Date().toTimeString().slice(0, 8)
    this.logLines.unshift({ time: t, cls, msg })
    if (this.logLines.length > 60) this.logLines.pop()
    this.emitFn({ type: 'log', agentId: '', message: msg, timestamp: Date.now() })
    // 日志同时以消息形式进入面板
    this.emitFn({ type: 'status', agentId: '', message: msg, timestamp: Date.now() })
  }

  /** 开始处理任务 */
  startTask(id: string, task: string): void {
    this.setStatus(id, 'working', task)
    this.emitFn({ type: 'task-start', agentId: id, task, message: `${this.nameOf(id)} 在工位开始处理「${task}」`, timestamp: Date.now() })
  }

  /** 完成一个任务（标记 done 计数） */
  completeTask(id: string, task: string): void {
    const s = this.states.get(id)
    if (s) { s.done++; this.doneCount++ }
    this.emitFn({ type: 'task-done', agentId: id, task, message: `✅ ${this.nameOf(id)} 完成「${task}」`, timestamp: Date.now() })
  }

  /** "我"（人类老板）旁边的汇报位：boss 在 (50,84)，角色在其上方汇报。 */
  private static readonly BOSS_REPORT = { x: 50, y: 71 }

  /** 角色走到"我"旁边汇报（群聊联动），然后回工位。 */
  walkToBoss(id: string, reportText?: string): void {
    const s = this.states.get(id)
    if (!s) return
    if (s.seat >= 0 || s.walking || s.status === 'working') return  // 忙碌中跳过
    s.walking = true
    this.setStatus(id, s.status)  // 同步前端走路动画
    this.emitFn({ type: 'walk', agentId: id, message: `🚶 ${this.nameOf(id)} 起身走向你…`, timestamp: Date.now() })
    const target = YitaiTeam.BOSS_REPORT
    this.later(() => {
      s.pos = { ...target }
      s.walking = false
      this.setStatus(id, 'reporting')
      const txt = reportText ?? ((s.task && s.task !== '—' && s.task !== '-') ? `正在处理「${s.task}」` : '当前待命，随时可以接单')
      this.emitFn({ type: 'bubble', agentId: id, head: '📢 向你汇报', text: txt, timestamp: Date.now() })
      this.emitFn({ type: 'walk', agentId: id, message: `📢 ${this.nameOf(id)} 向你汇报：${txt}`, timestamp: Date.now() })
      // 稍后回工位
      this.later(() => {
        s.status = 'idle'
        s.pos = { ...this.agentDef(id)!.desk }
        this.emitFn({ type: 'walk', agentId: id, message: `↩ ${this.nameOf(id)} 汇报完毕，回到工位`, timestamp: Date.now() })
      }, 2600)
    }, 1000)
  }

  /** 全员依次来"我"旁边汇报（每个间隔 1.4s，模拟群聊下达指令后的报到）。 */
  reportToBoss(reportText?: string): void {
    const pool = AGENTS.filter(a => a.id !== 'yitai')
    pool.forEach((a, i) => {
      this.later(() => this.walkToBoss(a.id, reportText), i * 1400)
    })
  }

  /** 走向认知图谱汇报 */
  walkToTable(id: string): void {
    const s = this.states.get(id)
    if (!s) return
    const idx = this.seatBusy.findIndex(v => v === null)
    if (idx < 0) return
    this.seatBusy[idx] = id
    s.seat = idx
    s.walking = true
    this.setStatus(id, s.status)  // 同步前端走路动画（walking class）
    this.emitFn({ type: 'walk', agentId: id, message: `🚶 ${this.nameOf(id)} 起身前往认知图谱…`, timestamp: Date.now() })
    const target = SEATS[idx]
    this.later(() => {
      s.pos = { ...target }
      s.walking = false
      this.setStatus(id, 'reporting')  // 汇报形象（状态点蓝色）
      this.emitFn({ type: 'report', agentId: id, message: `${this.nameOf(id)} 在认知图谱向易总管汇报「${s.task}」`, timestamp: Date.now() })
      // 稍后回到工位
      this.later(() => {
        this.seatBusy[idx] = null
        s.seat = -1
        s.pos = { ...this.agentDef(id)!.desk }
        this.setStatus(id, Math.random() < 0.3 ? 'sleep' : 'idle')
      }, 2400)
    }, 1150)
  }

  /**
   * 派发一个任务给办公室（可视化演示流）。
   * @param text - 任务文本
   * @param onDone - 可选：整段演示完成后的回调（用于 durable 任务同步）
   */
  dispatch(text: string, onDone?: (task: string) => void): string {
    const task = text.trim() || SAMPLE_TASKS[Math.floor(Math.random() * SAMPLE_TASKS.length)]
    this.log(`📣 用户广播任务「${task}」，易总管开始拆解`, 'yitai')
    this.setStatus('yitai', 'thinking', '拆解：' + task)
    this.emitFn({ type: 'dispatch', agentId: 'yitai', task, message: `📣 易总管已接单：「${task}」`, timestamp: Date.now() })

    // 挑选 2-4 名非 CEO 员工
    const pool = AGENTS.filter(a => a.id !== 'yitai').sort(() => Math.random() - 0.5)
    const picked = pool.slice(0, 2 + Math.floor(Math.random() * 2))
    this.log(`易总管将任务分派给：${picked.map(p => p.name).join('、')}`, 'yitai')

    const lastIdx = picked.length - 1
    picked.forEach((p, i) => {
      this.later(() => {
        this.emitFn({ type: 'dispatch', agentId: p.id, task, message: `${p.name} 接到子任务，在工位开始执行`, timestamp: Date.now() })
        this.startTask(p.id, task)
        this.later(() => {
          this.walkToTable(p.id)
          // 最后一名员工汇报完成后触发 onDone
          if (i === lastIdx) {
            this.later(() => onDone?.(task), 2400 + 1150)
          }
        }, 5000 + i * 2500)
      }, 700 * (i + 1))
    })

    this.later(() => this.setStatus('yitai', 'idle'), 4000)
    return task
  }

  /** 自主 tick：有任务时随机开始工作/思考/休息；无任务时把假工作员工复位为空闲。 */
  tick(hasTasks = false, pendingTasks: string[] = []): void {
    this.tickCounter++
    if (!hasTasks) {
      // 没有真实/待办任务：不做"假装工作"动画，把残留的 working/thinking 复位为空闲
      for (const [id, s] of this.states) {
        if (s.seat >= 0 || s.walking) continue
        if (s.status !== 'idle') this.setStatus(id, 'idle')
      }
      // 15% 概率随机一名员工午休趴桌（让"睡觉"形象可见，办公室更真实）
      if (Math.random() < 0.15) {
        const rest = AGENTS.filter(a => a.id !== 'yitai' && this.states.get(a.id)?.status === 'idle')
        if (rest.length > 0) {
          const pick = rest[Math.floor(Math.random() * rest.length)]
          this.setStatus(pick.id, 'sleep')
        }
      }
      return
    }
    const pool = AGENTS.filter(a => a.id !== 'yitai')
    const available = pool.filter(a => {
      const s = this.states.get(a.id)!
      return s.seat < 0 && !s.walking && s.status !== 'working'
    })
    if (available.length === 0) return
    const a = available[Math.floor(Math.random() * available.length)]
    const s = this.states.get(a.id)!
    const r = Math.random()
    if (r < 0.4) {
      // 有真实待办任务时模拟执行真实任务（联动任务界面），否则用示例任务
      const task = pendingTasks.length > 0
        ? pendingTasks[Math.floor(Math.random() * pendingTasks.length)]
        : SAMPLE_TASKS[Math.floor(Math.random() * SAMPLE_TASKS.length)]
      this.startTask(a.id, task)
      this.emitFn({ type: 'status', agentId: a.id, status: 'working', task, message: WORK_PH[Math.floor(Math.random() * WORK_PH.length)].replace('{}', task), timestamp: Date.now() })
    } else if (r < 0.6) {
      this.setStatus(a.id, 'thinking', '方案构思')
      this.emitFn({ type: 'status', agentId: a.id, status: 'thinking', message: THINK_PH[Math.floor(Math.random() * THINK_PH.length)], timestamp: Date.now() })
    } else if (r < 0.75) {
      this.setStatus(a.id, 'sleep')
    }
  }

  snapshot(): { agents: AgentState[]; doneCount: number; logs: typeof this.logLines } {
    return {
      agents: AGENTS.map(a => this.get(a.id)),
      doneCount: this.doneCount,
      logs: this.logLines.slice(0, 30),
    }
  }
}

