/**
 * YitaiOffice —— 办公室团队引擎门面。
 *
 * 借鉴 dsh-agent-teams 的架构：磁盘真相源 + 事件调度 + durable 成员 + attempt 能力，
 * 同时桥接现有办公室可视化（YitaiTeam / WS 广播），保持 UI 契约不变。
 *
 * 设计：
 *   - 办公室 = 一个持久化团队（固定工位 roster + 可选真实 subagent 成员）。
 *   - 任务 = durable 任务 DAG（dependencies + attemptId 能力）。
 *   - 真实执行 = 调度器（agent/status idle → 认领 → followup 唤醒成员）。
 *   - demo 模式 = liveDelegation 关闭 / 无队长 Agent 时，落到可视化模拟。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'
import {
  appendMailbox,
  CAPTAIN_KEY,
  ensureOffice,
  DEFAULT_STATE_DIR,
  readOffice,
  readUnreadMailbox,
  stateRootOf,
  transitionTask,
  writeOffice,
  withOfficeLock,
} from './state.ts'
import type { YitaiMember, YitaiMessage, YitaiOfficeState, YitaiTask, YitaiTaskStatus } from './types.ts'
import { installOfficeScheduler, type TeamScheduler } from './scheduler.ts'
import { AGENTS, type AgentDef, type TeamEvent, type YitaiTeam } from './team.ts'

/** 员工 role persona（spawn 真实成员用）。 */
export const ROLE_PERSONAS: Record<string, string> = {
  yitai: '你是易总管，办公室主管。负责协调排期、汇总子任务结果，产出简洁的统筹报告。',
  file: '你是 File Agent，文件管理专家。负责读写、归档、检索与版本管理，直接操作文件并汇报路径。',
  computer: '你是 Computer Agent，电脑操作专家。负责桌面与系统级操作：运行脚本、处理本地资源、执行命令。',
  app: '你是 App Agent，应用调度专家。负责调用第三方应用/连接器，对接外部服务并返回结果。',
  zhuge: '你是诸葛，规划参谋。把模糊需求拆成可执行计划与问题链，输出结构化步骤清单。',
  find: '你是小搜，检索专员。搜索引擎与知识库检索专家，找资料最快，输出带来源的检索摘要。',
}

/** 固定工位员工定义（file/computer/app/zhuge/find，不含易总管）。 */
export const WORKER_DEFS: AgentDef[] = AGENTS.filter((a) => a.id !== 'yitai')

/** 办公室 UI 快照（复用 YitaiTeam.snapshot 形状 + durable 任务）。 */
export interface OfficeSnapshot {
  agents: ReturnType<YitaiTeam['snapshot']>['agents']
  doneCount: number
  logs: ReturnType<YitaiTeam['snapshot']>['logs']
  tasks: YitaiTask[]
  office: YitaiOfficeState | undefined
}

/** 办公室配置。 */
export interface YitaiOfficeConfig {
  /** 状态目录名（默认 .yitai-office）。 */
  stateDir?: string
  /** 办公室 id（默认 office）。 */
  officeId?: string
  /** 工作区目录（办公室状态根）。 */
  workspace: string
  /** 是否启用真实 subagent 委托。 */
  liveDelegation: boolean
  /** 是否允许真实成员缺省时走可视化模拟。 */
  demoMode: boolean
}

/** 办公室公开 API（供 index.ts 使用）。 */
export interface YitaiOfficeApi {
  readonly stateDir: string
  readonly officeId: string
  /** 初始化/恢复办公室状态。 */
  init(captainSessionId?: string): Promise<void>
  /** 新建任务（持久化 + 广播 + 触发调度）。 */
  createTask(input: {
    subject: string
    description?: string
    assignee?: string
    dependencies?: string[]
    extUrl?: string | null
  }): Promise<YitaiTask>
  /** 广播任务（易总管拆解 → 建任务 → 调度/模拟）。 */
  dispatch(text: string, captain?: Agent): Promise<{ task: YitaiTask; delegated: boolean }>
  /** 认领任务，返回 attemptId。 */
  claimTask(taskId: string, memberName: string): Promise<string>
  /** 携带 attemptId 推进任务状态。 */
  updateTask(taskId: string, attemptId: string, status: YitaiTaskStatus, output?: string): Promise<YitaiTask>
  /** 转派任务（安全接管）。 */
  reassignTask(taskId: string, toMember: string): Promise<YitaiTask>
  /** 原地补丁任务字段（如 comment 驳回意见）。 */
  patchTask(taskId: string, patch: Partial<Pick<YitaiTask, 'comment'>>): Promise<YitaiTask>
  /** 成员/队长互发消息（durable 邮箱 + 唤醒）。 */
  sendMessage(from: string, to: string, content: string): Promise<void>
  /** 读取某人的未读邮箱。 */
  readMailbox(key: string): Promise<YitaiMessage[]>
  /** 确保员工被 spawn 为真实 subagent（有 captain 且 liveDelegation 时）。 */
  ensureMembers(captain: Agent): Promise<void>
  /** 让调度器立刻派发一轮 ready 任务。 */
  kick(): Promise<void>
  /** 供 demo 模拟完成时同步 durable 状态。 */
  finishDemoTask(taskId: string, output?: string): Promise<void>
  /** 磁盘真相：办公室状态。 */
  state(): Promise<YitaiOfficeState | undefined>
  /** UI 快照（复用 YitaiTeam.snapshot + 任务/邮箱补充）。 */
  snapshot(): Promise<OfficeSnapshot>
}

/** 创建一个办公室引擎实例。 */
export function createYitaiOffice(
  ctx: Context,
  team: YitaiTeam,
  broadcast: (event: TeamEvent) => void,
  config: YitaiOfficeConfig,
): YitaiOfficeApi {
  const stateDir = config.stateDir ?? DEFAULT_STATE_DIR
  const officeId = config.officeId ?? 'office'
  const workspace = config.workspace
  const stateRoot = join(stateRootOf(workspace, stateDir), officeId)
  const lockKey = `office:${stateRoot}`

  let currentCaptainId = ''

  /** 初始化完成前的等待门闩：避免首请求在 office.json 落盘前执行。 */
  let readyResolve!: () => void
  const readyPromise = new Promise<void>((resolve) => { readyResolve = resolve })

  /** 广播到 WS + 办公室日志。 */
  function emit(event: TeamEvent): void {
    broadcast(event)
  }

  async function loadOffice(): Promise<YitaiOfficeState | undefined> {
    await readyPromise
    return readOffice(stateRoot)
  }

  /** 种子：固定工位员工。 */
  function seedMembers(): YitaiMember[] {
    return WORKER_DEFS.map((a) => ({
      id: '',
      name: a.id,
      role: a.role,
      status: 'idle' as const,
      joinedAt: Date.now(),
    }))
  }

  // ---- 事件驱动调度器 ----
  const scheduler: TeamScheduler = installOfficeScheduler(ctx, {
    stateDir,
    officeId,
    workspace: () => workspace,
    deliver: async (childId, text, signal) => {
      const captain = ctx.agents.get(currentCaptainId as never) ?? undefined
      if (captain === undefined) return false
      const { deliverToMember } = await import('./members.ts')
      return deliverToMember(ctx, captain, childId, text, signal)
    },
  })

  async function init(captainSessionId?: string): Promise<void> {
    currentCaptainId = captainSessionId ?? ''
    try {
      await ensureOffice(stateRoot, {
        name: 'Yitai 办公室',
        id: officeId,
        description: '多Agent办公室：易总管 + 5 名专职员工（durable 团队）',
        ...(captainSessionId ? { captainSessionId } : {}),
        members: seedMembers(),
        tasks: [],
        taskSeq: 0,
        doneCount: 0,
      })
    } finally {
      readyResolve()
    }
  }

  async function createTask(input: {
    subject: string
    description?: string
    assignee?: string
    dependencies?: string[]
    extUrl?: string | null
  }): Promise<YitaiTask> {
    const subject = input.subject.trim()
    if (subject === '') throw new Error('任务标题不能为空')
    return withOfficeLock(lockKey, async () => {
      const office = await loadOffice()
      if (office === undefined) throw new Error('办公室尚未初始化')
      office.taskSeq += 1
      const task: YitaiTask = {
        id: `t${office.taskSeq}`,
        subject,
        description: input.description?.trim() || undefined,
        assignee: input.assignee,
        dependencies: input.dependencies ?? [],
        status: 'pending',
        extUrl: input.extUrl ?? null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      office.tasks.push(task)
      await writeOffice(stateRoot, office)
      emit({ type: 'status', agentId: '', message: `📋 新任务入池：${task.id} ${subject}`, timestamp: Date.now() })
      return task
    })
  }

  async function claimTask(taskId: string, memberName: string): Promise<string> {
    return withOfficeLock(lockKey, async () => {
      const office = await loadOffice()
      if (office === undefined) throw new Error('办公室尚未初始化')
      const task = office.tasks.find((t) => t.id === taskId)
      if (task === undefined) throw new Error(`没有任务 "${taskId}"`)
      if (task.status !== 'pending') throw new Error(`任务 "${taskId}" 当前状态 ${task.status}，不可认领`)
      const member = office.members.find((m) => m.name === memberName && m.status !== 'removed')
      if (member === undefined && memberName !== 'yitai' && memberName !== 'captain') {
        throw new Error(`没有名为 "${memberName}" 的成员`)
      }
      const { beginTaskAttempt } = await import('./state.ts')
      // 调度器已 beginTaskAttempt 时保留同一 attemptId（避免双代数）；否则新起一代。
      const attemptId = task.attemptId ?? beginTaskAttempt(task, memberName)
      if (!task.attemptId) task.assignee = memberName
      task.status = 'claimed'
      task.updatedAt = Date.now()
      await writeOffice(stateRoot, office)
      emit({ type: 'status', agentId: memberName, status: 'working', task: task.subject, message: `⚙️ ${memberName} 领取任务「${task.subject}」`, timestamp: Date.now() })
      return attemptId
    })
  }

  async function updateTask(
    taskId: string,
    attemptId: string,
    status: YitaiTaskStatus,
    output?: string,
  ): Promise<YitaiTask> {
    return withOfficeLock(lockKey, async () => {
      const office = await loadOffice()
      if (office === undefined) throw new Error('办公室尚未初始化')
      const task = await transitionTask(stateRoot, office, taskId, attemptId, status, output)
      if (status === 'completed') {
        emit({ type: 'task-done', agentId: task.assignee ?? '', task: task.subject, message: `✅ ${task.assignee ?? ''} 完成「${task.subject}」`, timestamp: Date.now() })
        emit({ type: 'status', agentId: task.assignee ?? '', status: 'idle', message: `✅ ${task.assignee ?? ''} 完成「${task.subject}」`, timestamp: Date.now() })
      } else if (status === 'failed') {
        emit({ type: 'status', agentId: task.assignee ?? '', status: 'idle', message: `⚠️ ${task.assignee ?? ''} 任务失败：${task.subject}`, timestamp: Date.now() })
      }
      return task
    })
  }

  async function reassignTask(taskId: string, toMember: string): Promise<YitaiTask> {
    return withOfficeLock(lockKey, async () => {
      const office = await loadOffice()
      if (office === undefined) throw new Error('办公室尚未初始化')
      const task = office.tasks.find((t) => t.id === taskId)
      if (task === undefined) throw new Error(`没有任务 "${taskId}"`)
      const member = office.members.find((m) => m.name === toMember && m.status !== 'removed')
      if (member === undefined && toMember !== 'yitai' && toMember !== 'captain') {
        throw new Error(`没有名为 "${toMember}" 的成员`)
      }
      const { invalidateTaskAttempt } = await import('./state.ts')
      invalidateTaskAttempt(task)
      task.status = 'pending'
      task.assignee = toMember
      task.reassigning = false   // 立即恢复可派发，调度器会重新认领
      task.updatedAt = Date.now()
      await writeOffice(stateRoot, office)
      emit({ type: 'status', agentId: toMember, message: `🔁 任务「${task.subject}」转派给 ${toMember}`, timestamp: Date.now() })
      return task
    })
  }

  async function patchTask(
    taskId: string,
    patch: Partial<Pick<YitaiTask, 'comment'>>,
  ): Promise<YitaiTask> {
    return withOfficeLock(lockKey, async () => {
      const office = await loadOffice()
      if (office === undefined) throw new Error('办公室尚未初始化')
      const task = office.tasks.find((t) => t.id === taskId)
      if (task === undefined) throw new Error(`没有任务 "${taskId}"`)
      if (patch.comment !== undefined) task.comment = patch.comment
      task.updatedAt = Date.now()
      await writeOffice(stateRoot, office)
      return task
    })
  }

  async function sendMessage(from: string, to: string, content: string): Promise<void> {
    const toKey = to === 'captain' ? CAPTAIN_KEY : to
    await appendMailbox(stateRoot, {
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from,
      to: toKey,
      content,
      ts: Date.now(),
    })
    // 尝试唤醒收件成员（durable 成员时）
    if (to !== 'captain') {
      const office = await loadOffice()
      const target = office?.members.find((m) => m.name === toKey && m.status !== 'removed')
      if (target && target.id !== '') {
        const captain = ctx.agents.get(currentCaptainId as never)
        if (captain) {
          const { deliverToMember } = await import('./members.ts')
          await deliverToMember(ctx, captain, target.id, `你收到一条来自 ${from} 的消息：\n${content}`, new AbortController().signal)
        }
      }
    }
    emit({ type: 'status', agentId: from, message: `✉️ ${from} → ${to}：${content.slice(0, 80)}`, timestamp: Date.now() })
  }

  async function ensureMembers(captain: Agent): Promise<void> {
    const office = await loadOffice()
    if (office === undefined) return
    for (const member of office.members) {
      if (member.status === 'removed' || member.id !== '') continue
      try {
        const { spawnMember } = await import('./members.ts')
        await spawnMember(ctx, captain, office, member, join(stateDir, officeId), new AbortController().signal)
        member.provider = captain.session.requestHeader()?.config?.provider ?? captain.options.provider
        member.model = captain.session.requestHeader()?.config?.model ?? captain.options.model
        await writeOffice(stateRoot, office)
        ctx.logger.info(`[yitai-office] 🤖 员工 ${member.name} 已 spawn 为 durable subagent：${member.id}`)
      } catch (error: unknown) {
        ctx.logger.warn(`[yitai-office] 员工 ${member.name} spawn 失败（回退模拟）：${String(error)}`)
        break // 一个失败往往意味着 provider/凭据整体不可用
      }
    }
  }

  async function dispatch(text: string, captain?: Agent): Promise<{ task: YitaiTask; delegated: boolean }> {
    const task = await createTask({ subject: text, description: undefined })
    // 真实委托：有队长且 liveDelegation 时，spawn 成员并交给调度器
    if (config.liveDelegation && captain) {
      currentCaptainId = captain.id
      const office = await loadOffice()
      if (office) {
        office.captainSessionId = captain.id
        await writeOffice(stateRoot, office)
      }
      await ensureMembers(captain)
      // 只有真正 spawn 出 durable 成员才算真实委托；否则回退 demo（避免任务卡死）
      const fresh = await loadOffice()
      const hasReal = fresh?.members.some((m) => m.id !== '' && m.status !== 'removed') ?? false
      if (hasReal) {
        await kick()
        return { task, delegated: true }
      }
      ctx.logger.warn('[yitai-office] 无可用真实 subagent 成员，回退可视化模拟')
      return { task, delegated: false }
    }
    // demo 模式：由调用方驱动可视化模拟，完成后 finishDemoTask 同步
    return { task, delegated: false }
  }

  async function finishDemoTask(taskId: string, output?: string): Promise<void> {
    return withOfficeLock(lockKey, async () => {
      const office = await loadOffice()
      if (office === undefined) return
      const task = office.tasks.find((t) => t.id === taskId)
      if (task === undefined || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return
      task.status = 'completed'
      task.updatedAt = Date.now()
      if (output !== undefined) task.output = output
      office.doneCount++
      await writeOffice(stateRoot, office)
      emit({ type: 'task-done', agentId: task.assignee ?? '', task: task.subject, message: `✅ ${task.assignee ?? ''} 完成「${task.subject}」`, timestamp: Date.now() })
    })
  }

  async function kick(): Promise<void> {
    await scheduler.kickOffice(officeId)
  }

  async function state(): Promise<YitaiOfficeState | undefined> {
    return loadOffice()
  }

  async function snapshot(): Promise<OfficeSnapshot> {
    const office = await loadOffice()
    const base = team.snapshot()
    return { ...base, tasks: office?.tasks ?? [], office }
  }

  return {
    stateDir,
    officeId,
    init,
    createTask,
    dispatch,
    claimTask,
    updateTask,
    reassignTask,
    patchTask,
    sendMessage,
    readMailbox: (key) => readUnreadMailbox(stateRoot, key === 'captain' ? CAPTAIN_KEY : key),
    ensureMembers,
    kick,
    finishDemoTask,
    state,
    snapshot,
  }
}
