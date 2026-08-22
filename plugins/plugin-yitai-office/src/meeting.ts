/**
 * meeting.ts —— 多 Agent 会议室引擎。
 *
 * 借 AutoGen GroupChatManager 的 speaker-selection 思路做发言轮转；
 * 借 MetaGPT MessagePool 的发布/订阅思路做会场消息流；
 * 借 Stanford Generative Agents 的记忆检索打分思路做上下文选择（新近度优先）。
 *
 * 设计约束：
 *   - 进程内运行，零框架依赖（不引入 AutoGen/LangGraph 运行时）。
 *   - LLM 调用全部通过注入的 llmFn 完成，index.ts 负责接 ctx.llm。
 *   - 事件通过 emitFn 广播，供 WS 面板 / Harness 日志消费。
 *   - 上下文隔离：每个 MeetingRoom 持有自己的 transcript + digest，
 *     会议室之间互不串扰（对应豆包方案第 1 条）。
 */

export type MeetingStatus = 'preparing' | 'running' | 'ended'
export type SpeakerPolicy = 'round-robin' | 'auto'

export interface ParticipantDef {
  id: string
  name: string
  role: string
  persona: string
  /** 外部 A2A agent 端点；配置后该参会者发言时通过 A2A 协议调用真实 agent */
  a2aUrl?: string
}

export interface MeetingMessage {
  id: string
  /** participant id / 'user' / 'system' */
  speaker: string
  name: string
  text: string
  ts: number
}

export interface MeetingEvent {
  type: 'meeting-opened' | 'meeting-message' | 'meeting-round' | 'meeting-ended' | 'meeting-log' | 'meeting-error'
  meetingId: string
  meetingTitle?: string
  message?: MeetingMessage
  text?: string
  status?: MeetingStatus
  participants?: ParticipantDef[]
  timestamp: number
}

/** 由 index.ts 注入的 LLM 调用函数（接 ctx.llm.stream + BlockAssembler） */
export type MeetingLLM = (opts: {
  /** 参会者 id（用于 per-agent 模型配置）；总结/纪要时为 undefined 走全局默认 */
  agentId?: string
  /** system prompt（persona / 任务身份） */
  persona: string
  /** user prompt */
  userText: string
  maxTokens?: number
}) => Promise<string>

export interface MeetingRoom {
  id: string
  title: string
  status: MeetingStatus
  participants: ParticipantDef[]
  transcript: MeetingMessage[]
  /** 滚动摘要：旧内容压缩后的要点行 */
  digest: string[]
  /** transcript 中 < summarizedUpTo 的消息已折叠进 digest */
  summarizedUpTo: number
  minutes?: string
  speakerPolicy: SpeakerPolicy
  /** 用户发言后自动讨论几轮 */
  autoRounds: number
  /** 保留最近多少条原文进上下文 */
  keepTurns: number
  /** transcript 未摘要字符超过该值触发压缩 */
  summarizeAfterChars: number
  busy: boolean
  createdAt: number
  lastRoundAt: number
  turnIndex: number
  roundCount: number
}

export interface MeetingCreateOpts {
  speakerPolicy?: SpeakerPolicy
  autoRounds?: number
  keepTurns?: number
  summarizeAfterChars?: number
}

/** 参会者注册表：办公室员工 + 爱马仕 / OpenHuman / ClaudeCode / Codex */
export const MEETING_PARTICIPANTS: Record<string, ParticipantDef> = {
  yitai: {
    id: 'yitai', name: '易总管', role: '主管 Agent · 调度',
    persona: '你是易总管，办公室总管兼调度。有全局调度视角，善于掌控讨论节奏、总结分歧、拍板结论；同时协调排期、汇总子任务结果。发言直接、注重统筹与可行性。',
  },
  file: {
    id: 'file', name: 'File Agent', role: '文件管理',
    persona: '你是 File Agent，文件管理专家。关注文档、归档、检索与版本管理，发言会提示资料/文件层面的影响。',
  },
  computer: {
    id: 'computer', name: 'Computer Agent', role: '电脑操作',
    persona: '你是 Computer Agent，电脑操作专家。关注脚本、本地资源、系统级执行，发言会提示实现与执行层面的问题。',
  },
  app: {
    id: 'app', name: 'App Agent', role: '应用调度',
    persona: '你是 App Agent，应用调度专家。关注第三方应用与连接器集成，发言会提示外部服务对接的影响。',
  },
  zhuge: {
    id: 'zhuge', name: '诸葛', role: '规划参谋',
    persona: '你是诸葛，规划参谋。把模糊需求拆成可执行计划与问题链，发言输出结构化步骤。',
  },
  find: {
    id: 'find', name: '小搜', role: '检索专员',
    persona: '你是小搜，检索专员。搜索引擎与知识库检索专家，发言带来源意识、关注事实与信息缺口。',
  },
  hermes: {
    id: 'hermes', name: '爱马仕', role: '独立 Agent',
    persona: '你是爱马仕，一名独立强 Agent。思维严谨、视野开阔，擅长从架构与系统全局剖析问题，给出可落地的方案。',
    a2aUrl: 'http://127.0.0.1:9900',
  },
  openhuma: {
    id: 'openhuma', name: 'OpenHuman', role: '独立 Agent',
    persona: '你是 OpenHuman，一名独立强 Agent。洞察本质、贴近用户，关注需求价值与体验，发言总能切中要害。',
    a2aUrl: 'http://127.0.0.1:9930',
  },
  claudecode: {
    id: 'claudecode', name: 'ClaudeCode', role: '独立 Agent',
    persona: '你是 ClaudeCode，一名独立强 Agent。工程功底深厚，务实高效，关注实现可行性、质量与风险，发言直接可执行。',
    a2aUrl: 'http://127.0.0.1:9920',
  },
  codex: {
    id: 'codex', name: 'Codex', role: '独立 Agent',
    persona: '你是 Codex，工程编码代理。务实严谨，直接读写代码、验证结果，发言关注工程实现、可验证性与风险。',
    a2aUrl: 'http://127.0.0.1:9940',
  },
}

export function defaultParticipant(id: string): ParticipantDef {
  return { id, name: id, role: '参会者', persona: `你是 ${id}，一名 AI 参会者。请基于会议内容从你的专业视角发言，简洁、有观点。` }
}

/** id 别名归一化（支持用户输入大小写/别名） */
const ID_ALIASES: Record<string, string> = {
  openhuman: 'openhuma',
  oh: 'openhuma',
  op: 'openhuma',
  hermes: 'hermes',
  claude: 'claudecode',
  cc: 'claudecode',
  codex: 'codex',
  cx: 'codex',
}

export function resolveParticipants(ids: string[]): ParticipantDef[] {
  const seen = new Set<string>()
  const out: ParticipantDef[] = []
  for (const raw of ids) {
    const id = ID_ALIASES[String(raw).trim().toLowerCase()] ?? String(raw).trim().toLowerCase()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(MEETING_PARTICIPANTS[id] ?? defaultParticipant(id))
  }
  return out
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function charCount(msgs: MeetingMessage[]): number {
  let n = 0
  for (const m of msgs) n += m.text.length
  return n
}

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8)
}

export class MeetingManager {
  rooms = new Map<string, MeetingRoom>()
  private emitFn: (event: MeetingEvent) => void
  private llmFn: MeetingLLM

  constructor(emitFn: (event: MeetingEvent) => void, llmFn: MeetingLLM) {
    this.emitFn = emitFn
    this.llmFn = llmFn
  }

  /* ================= 生命周期 ================= */

  create(title: string, ids: string[], opts: MeetingCreateOpts = {}): MeetingRoom {
    const participants = resolveParticipants(ids)
    if (participants.length === 0) throw new Error('至少需要 1 名参会者')
    const id = uid('m')
    const room: MeetingRoom = {
      id,
      title: title.trim() || `会议 ${id.slice(2, 8)}`,
      status: 'running',
      participants,
      transcript: [],
      digest: [],
      summarizedUpTo: 0,
      speakerPolicy: opts.speakerPolicy ?? 'round-robin',
      autoRounds: opts.autoRounds ?? 2,
      keepTurns: opts.keepTurns ?? 8,
      summarizeAfterChars: opts.summarizeAfterChars ?? 6000,
      busy: false,
      createdAt: Date.now(),
      lastRoundAt: Date.now(),
      turnIndex: 0,
      roundCount: 0,
    }
    this.rooms.set(id, room)
    this.addMessage(room, 'system', '系统', `🏢 会议「${room.title}」已创建，参会者：${room.participants.map(p => `${p.name}(${p.role})`).join('、')}。`)
    this.emitFn({ type: 'meeting-opened', meetingId: id, meetingTitle: room.title, participants, status: room.status, timestamp: Date.now() })
    return room
  }

  get(id: string): MeetingRoom | undefined {
    return this.rooms.get(id)
  }

  list(): MeetingRoom[] {
    return [...this.rooms.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  listActive(): MeetingRoom[] {
    return this.list().filter(r => r.status === 'running')
  }

  addMessage(room: MeetingRoom, speaker: string, name: string, text: string): MeetingMessage {
    const msg: MeetingMessage = { id: uid('msg'), speaker, name, text, ts: Date.now() }
    room.transcript.push(msg)
    this.emitFn({ type: 'meeting-message', meetingId: room.id, meetingTitle: room.title, message: msg, status: room.status, timestamp: Date.now() })
    return msg
  }

  /* ================= 上下文构建（借 Generative Agents 新近度优先） ================= */

  private buildContext(room: MeetingRoom, speaker: ParticipantDef): string {
    const parts: string[] = []
    parts.push(`会议主题：${room.title}`)
    parts.push(`参会者：${room.participants.map(p => p.name).join('、')}（你的 id：${speaker.id}）`)
    if (room.digest.length > 0) {
      parts.push(`【历史要点摘要】\n${room.digest.join('\n')}`)
    }
    const recent = room.transcript.slice(room.summarizedUpTo)
    if (recent.length > 0) {
      parts.push('【最近讨论】')
      for (const m of recent) parts.push(`[${m.name}] ${m.text}`)
    }
    parts.push(`你是「${speaker.name}（${speaker.role}）」，现在是你的发言轮次。请基于以上讨论发表你的观点：可以补充、质疑、提出方案或推进结论。用中文，2-4 句话，观点明确。`)
    return parts.join('\n\n')
  }

  private async maybeSummarize(room: MeetingRoom): Promise<void> {
    const recent = room.transcript.slice(room.summarizedUpTo)
    if (recent.length <= room.keepTurns) return
    if (charCount(recent) < room.summarizeAfterChars) return
    const toCompress = recent.slice(0, recent.length - room.keepTurns)
    if (toCompress.length === 0) return
    try {
      const text = toCompress.map(m => `[${m.name}] ${m.text}`).join('\n')
      const summary = await this.llmFn({
        persona: '你是会议记录员，负责把一段会议讨论压缩成要点摘要，只保留关键观点、分歧与结论。',
        userText: `请把以下会议记录压缩成 3-6 条要点（每条一行，用「- 」开头，中文）：\n\n${text}`,
        maxTokens: 600,
      })
      room.digest.push(...summary.split('\n').map(l => l.trim()).filter(Boolean))
      room.summarizedUpTo += toCompress.length
      this.emitFn({ type: 'meeting-log', meetingId: room.id, meetingTitle: room.title, text: `🧠 上下文已压缩：${toCompress.length} 条历史 → 摘要`, timestamp: Date.now() })
    } catch (e) {
      this.emitFn({ type: 'meeting-log', meetingId: room.id, meetingTitle: room.title, text: `⚠️ 摘要压缩失败（继续使用原文）：${String(e)}`, timestamp: Date.now() })
    }
  }

  /* ================= 发言人选择（借 AutoGen GroupChatManager） ================= */

  private pickNext(room: MeetingRoom): ParticipantDef {
    const ps = room.participants
    if (ps.length === 0) throw new Error('no participants')
    const last = room.transcript[room.transcript.length - 1]
    // 刚才是用户发言 → 从第一位参会者开始
    if (last && last.speaker === 'user') room.turnIndex = 0
    const p = ps[room.turnIndex % ps.length]
    room.turnIndex = (room.turnIndex + 1) % ps.length
    return p
  }

  private async pickNextAuto(room: MeetingRoom): Promise<ParticipantDef> {
    const ps = room.participants
    if (ps.length <= 1) return this.pickNext(room)
    try {
      const recent = room.transcript.slice(-6)
      const board = recent.map(m => `[${m.name}] ${m.text}`).join('\n')
      const prompt = `当前会议「${room.title}」讨论如下：\n${board || '（还没有讨论内容）'}\n\n可发言者（id: 角色）：\n${ps.map(p => `${p.id}: ${p.name}（${p.role}）`).join('\n')}\n\n请根据讨论内容，选一位最应该发言的参会者，只返回其 id（如 zhuge），不要输出其他内容。`
      const pick = (await this.llmFn({
        persona: '你是会议主持人，决定下一位发言人。选最合适推进讨论的那位。',
        userText: prompt,
        maxTokens: 20,
      })).trim().toLowerCase()
      const found = ps.find(p => pick.includes(p.id))
      if (found) {
        // 已消费的轮次游标向后对齐，避免 round-robin 与 auto 冲突
        const idx = ps.indexOf(found)
        room.turnIndex = (idx + 1) % ps.length
        return found
      }
    } catch { /* 回退 round-robin */ }
    return this.pickNext(room)
  }

  /* ================= 发言驱动 ================= */

  /** 用户发言；随后自动驱动 autoRounds 轮讨论 */
  async say(meetingId: string, text: string): Promise<string> {
    const room = this.rooms.get(meetingId)
    if (!room) throw new Error(`会议室不存在：${meetingId}`)
    if (room.status !== 'running') throw new Error('会议已结束')
    if (room.busy) return '会议室正忙，请稍后再发言。'
    this.addMessage(room, 'user', '用户', text.trim())
    if (room.autoRounds > 0) await this.round(meetingId, room.autoRounds)
    return this.tail(room, 3)
  }

  /**
   * 外部 A2A 参会者发言：标准 A2A message/send，contextId = `<meeting>:<speaker>`
   * 保持每个外部 agent 在本会议中的多轮记忆。
   */
  private async callExternal(url: string, ctxId: string, prompt: string): Promise<string> {
    const payload = {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: {
        contextId: ctxId,
        message: { role: 'user', parts: [{ kind: 'text', text: prompt }] },
      },
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000)
      const res = await fetch(url + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return `[外部 agent HTTP ${res.status}]`
      const data: any = await res.json()
      // 兼容两种响应结构: {result:{task:{status:{message}}}} 与 {result:{status:{message}}}
      const task = data?.result?.task ?? data?.result ?? {}
      const status = task.status ?? {}
      const msg = status.message ?? {}
      const text = (msg.parts ?? []).map((p: any) => p.text ?? '').join('')
      return text || `[外部 agent 返回空]`
    } catch (e: any) {
      return `[外部 agent 调用失败: ${String(e?.message ?? e).slice(0, 150)}]`
    }
  }

  /** 驱动 turns 轮讨论（每人一轮发言） */
  async round(meetingId: string, turns = 1): Promise<string> {
    const room = this.rooms.get(meetingId)
    if (!room) throw new Error(`会议室不存在：${meetingId}`)
    if (room.status !== 'running') throw new Error('会议已结束')
    if (room.busy) return '会议室正忙，请稍后再试。'
    room.busy = true
    try {
      for (let i = 0; i < turns; i++) {
        const speaker = room.speakerPolicy === 'auto' ? await this.pickNextAuto(room) : this.pickNext(room)
        const context = this.buildContext(room, speaker)
        const text = speaker.a2aUrl
          ? await this.callExternal(speaker.a2aUrl, `${room.id}:${speaker.id}`, context)
          : await this.llmFn({
              agentId: speaker.id,
              persona: speaker.persona,
              userText: context,
              maxTokens: 900,
            })
        room.roundCount++
        room.lastRoundAt = Date.now()
        this.addMessage(room, speaker.id, speaker.name, text)
        await this.maybeSummarize(room)
      }
    } finally {
      room.busy = false
    }
    return this.tail(room, Math.min(turns + 1, 6))
  }

  /** 尾部若干条消息的纯文本（供工具回显） */
  tail(room: MeetingRoom, n: number): string {
    return room.transcript.slice(-n).map(m => `[${m.name}] ${m.text}`).join('\n')
  }

  /* ================= 会议结束 / 纪要 ================= */

  async end(meetingId: string): Promise<string> {
    const room = this.rooms.get(meetingId)
    if (!room) throw new Error(`会议室不存在：${meetingId}`)
    if (room.status === 'ended') return room.minutes ?? '(无纪要)'
    let minutes: string
    try {
      const history = room.transcript.map(m => `[${m.name}] ${m.text}`).join('\n')
      minutes = await this.llmFn({
        persona: '你是会议纪要官，输出结构清晰的中文会议纪要。',
        userText: `会议主题：${room.title}\n参会者：${room.participants.map(p => `${p.name}（${p.role}）`).join('、')}\n\n完整记录：\n${history}\n\n请生成会议纪要，包含：1) 会议议题 2) 讨论要点 3) 结论/共识 4) 行动项（标注负责人）。`,
        maxTokens: 1500,
      })
    } catch (e) {
      minutes = `（纪要生成失败，回退原文：${String(e)}）\n\n${room.transcript.map(m => `[${m.name}] ${m.text}`).join('\n')}`
    }
    room.minutes = minutes
    room.status = 'ended'
    this.emitFn({ type: 'meeting-ended', meetingId: room.id, meetingTitle: room.title, text: minutes, status: room.status, timestamp: Date.now() })
    this.emitFn({ type: 'meeting-log', meetingId: room.id, meetingTitle: room.title, text: `🏁 会议「${room.title}」已结束，共 ${room.roundCount} 轮发言。`, timestamp: Date.now() })
    return minutes
  }

  /** 会议状态文本（供 meeting_status 工具） */
  statusText(meetingId?: string): string {
    if (meetingId) {
      const room = this.rooms.get(meetingId)
      if (!room) return `❌ 会议室不存在：${meetingId}`
      const lines = [
        `📋 会议室 ${room.id} · ${room.title}`,
        `状态：${room.status} ｜ 发言轮次：${room.roundCount} ｜ 消息：${room.transcript.length} 条`,
        `参会者：${room.participants.map(p => p.name).join('、')}`,
      ]
      if (room.digest.length > 0) lines.push(`摘要：\n${room.digest.join('\n')}`)
      const tail = room.transcript.slice(-4)
      if (tail.length > 0) lines.push(`最近讨论：\n${tail.map(m => `[${m.name}] ${m.text.slice(0, 100)}`).join('\n')}`)
      if (room.minutes) lines.push(`纪要已生成（meeting_end 可查看）。`)
      return lines.join('\n')
    }
    const active = this.listActive()
    const ended = this.list().filter(r => r.status === 'ended')
    const lines = [`🏢 会议室（进行中 ${active.length}，已结束 ${ended.length}）：`]
    if (active.length === 0 && ended.length === 0) lines.push('  暂无会议。用 meeting_create 创建会议室。')
    for (const r of [...active, ...ended]) {
      const last = r.transcript[r.transcript.length - 1]
      lines.push(`- ${r.id} · ${r.title}（${r.status}）参会 ${r.participants.length} 人${last ? `｜最新：${last.name}: ${last.text.slice(0, 40)}` : ''}`)
    }
    return lines.join('\n')
  }

  formatMinutes(meetingId: string): string {
    const room = this.rooms.get(meetingId)
    if (!room) return `❌ 会议室不存在：${meetingId}`
    if (room.minutes) return `📝 会议纪要（${room.title}）：\n${room.minutes}`
    return `会议「${room.title}」尚未结束，暂无纪要。用 meeting_end 结束并生成纪要。`
  }
}
