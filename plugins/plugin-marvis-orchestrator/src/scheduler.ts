/**
 * 事件驱动共享任务调度器 —— 借鉴 dsh-agent-teams 的 scheduler。
 *
 * Claude Code 的队友会一直轮询共享任务列表；DSH 的 continuable agent 暴露
 * 明确的 idle/running 边，所以本调度器无需保持轮询回合：每个 idle 边与每个
 * 任务图变更都尝试一次原子认领，并唤醒选中的 durable 成员。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import {
  beginTaskAttempt,
  readOffice,
  readUnreadMailbox,
  unsatisfiedDependencies,
  withOfficeLock,
  writeOffice,
} from './state.ts'
import type { MarvisMessage, MarvisTask } from './types.ts'

/** 调度器配置。 */
export interface OfficeSchedulerConfig {
  /** 状态目录名（默认 .marvis-office）。 */
  stateDir: string
  /** 办公室 id（默认 office）。 */
  officeId: string
  /** 解析工作区目录（队长 cwd 或进程 cwd）。 */
  workspace(): string
  /** 真正的消息投递：向某成员 durable id 投递文本（由 office 用 followup 实现）。 */
  deliver(childId: string, text: string, signal: AbortSignal): Promise<boolean>
}

export interface DispatchTicket {
  taskId: string
  memberName: string
  memberId: string
  attempt: number
  attemptId: string
  previousAssignee?: string
  subject: string
  description?: string
}

export interface TeamScheduler {
  /** 尝试给每个真正 idle/ready 的成员一份 ready 工作。 */
  kickOffice(officeId: string): Promise<void>
  /** 尝试投递 fallback 邮箱或给某成员一份 ready 任务。 */
  kickMember(officeId: string, memberName: string): Promise<void>
}

function stateRootOf(workspace: string, config: OfficeSchedulerConfig): string {
  return join(workspace, config.stateDir, config.officeId)
}

function lockKey(stateRoot: string): string {
  return `office:${stateRoot}`
}

/** 成员是否可被唤醒（live 状态为 idle，或不在 registry）。 */
function isMemberAvailable(ctx: Context, memberId: string): boolean {
  if (memberId === '') return false
  const live = ctx.agents.get(memberId as SessionId)
  return live === undefined || live.status === 'idle'
}

/** 成员名下仍在 claimed/in_progress 的开放任务（冷恢复：丢了执行回合）。 */
function ownedOpenTask(tasks: readonly MarvisTask[], memberName: string): MarvisTask | undefined {
  return tasks.find((task) => task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

/** 下一条 ready 任务：优先该成员名下的，其次未指派共享池。 */
function nextReadyTask(tasks: readonly MarvisTask[], memberName: string): MarvisTask | undefined {
  const ready = tasks.filter((task) => task.status === 'pending'
    && task.reassigning !== true
    && unsatisfiedDependencies([...tasks], task.dependencies).length === 0)
  return ready.find((task) => task.assignee === memberName)
    ?? ready.find((task) => task.assignee === undefined)
}

/** 派发提示词（成员读到后按协议执行）。 */
function assignmentPrompt(ticket: DispatchTicket, stateDir: string, officeId: string): string {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  return `Marvis 办公室自动任务派发（共享任务池）。

任务：${ticket.taskId} — ${ticket.subject}${description}
Attempt：${ticket.attempt}
Attempt id：${ticket.attemptId}

请用 marvis_claim_task 认领任务 ${ticket.taskId}，它会返回同一个 attempt_id；之后每次 marvis_update_task 都带上 attempt_id=${ticket.attemptId}。若被拒绝为 stale，说明任务已被转派，停止工作。本轮只做这一个任务，完成后把结果汇报给队长，然后回到 idle 等待调度器给你下一份 ready 任务。

状态目录：${stateDir}/${officeId}/ 只读诊断；只用 marvis_* 工具改办公室状态。`
}

/** fallback 邮箱投递提示词。 */
function fallbackMailboxPrompt(messages: readonly MarvisMessage[]): string {
  return [
    'Marvis 办公室投递了实时投递不可用期间持久化的消息：',
    ...messages.map((message) => `\n来自 ${message.from}：\n${message.content}`),
    '\n本轮处理这些消息。任务派发仍需要 marvis_claim_task + 当前 attempt_id。',
  ].join('\n')
}

/** 安装调度器与成员活动观察器。 */
export function installOfficeScheduler(ctx: Context, config: OfficeSchedulerConfig): TeamScheduler {
  const memberQueues = new Map<string, Promise<unknown>>()

  const serializeMember = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = memberQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    memberQueues.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (memberQueues.get(key) === tail) memberQueues.delete(key)
    }
  }

  const runtime: TeamScheduler = {
    async kickOffice(officeId) {
      const stateRoot = stateRootOf(config.workspace(), config)
      const office = await readOffice(stateRoot)
      if (office === undefined) return
      for (const member of office.members) {
        if (member.status === 'removed') continue
        await runtime.kickMember(officeId, member.name)
      }
    },

    async kickMember(officeId, memberName) {
      const stateRoot = stateRootOf(config.workspace(), config)
      const queueKey = `${stateRoot}:${memberName}`
      await serializeMember(queueKey, async () => {
        const office = await readOffice(stateRoot)
        if (office === undefined) return
        const member = office.members.find((candidate) => candidate.name === memberName && candidate.status !== 'removed')
        if (member === undefined || member.id === '' || !isMemberAvailable(ctx, member.id)) return

        // 邮箱 fallback 是真实待办：先投递再发新任务，Harness 接受后标记送达。
        const unread = await readUnreadMailbox(stateRoot, member.name)
        if (unread.length > 0) {
          const accepted = await config.deliver(member.id, fallbackMailboxPrompt(unread), new AbortController().signal)
          if (accepted) {
            const file = join(stateRoot, 'inbox', `${member.name}.jsonl`)
            void markDelivered(file, unread.map((m) => m.id))
          }
          return
        }

        const ticket = await withOfficeLock(lockKey(stateRoot), async (): Promise<DispatchTicket | undefined> => {
          const fresh = await readOffice(stateRoot)
          if (fresh === undefined) return undefined
          const currentMember = fresh.members.find((candidate) => candidate.name === memberName && candidate.status !== 'removed')
          if (currentMember === undefined || currentMember.id === '' || !isMemberAvailable(ctx, currentMember.id)) return undefined
          const task = ownedOpenTask(fresh.tasks, currentMember.name)
            ?? nextReadyTask(fresh.tasks, currentMember.name)
          if (task === undefined) {
            if (currentMember.status !== 'idle') {
              currentMember.status = 'idle'
              await writeOffice(stateRoot, fresh)
            }
            return undefined
          }
          const previousAssignee = task.assignee
          const attemptId = beginTaskAttempt(task, currentMember.name)
          currentMember.status = 'working'
          await writeOffice(stateRoot, fresh)
          return {
            taskId: task.id,
            memberName: currentMember.name,
            memberId: currentMember.id,
            attempt: task.attempt ?? 1,
            attemptId,
            previousAssignee,
            subject: task.subject,
            description: task.description,
          }
        })
        if (ticket === undefined) return

        const accepted = await config.deliver(
          ticket.memberId,
          assignmentPrompt(ticket, config.stateDir, config.officeId),
          new AbortController().signal,
        )
        if (accepted) return

        // 回滚仅我们这次精确失败的派发；并发队长交接已改能力则让位。
        await withOfficeLock(lockKey(stateRoot), async () => {
          const fresh = await readOffice(stateRoot)
          if (fresh === undefined) return
          const task = fresh.tasks.find((candidate) => candidate.id === ticket.taskId)
          if (task?.attemptId !== ticket.attemptId) return
          task.status = 'pending'
          task.assignee = ticket.previousAssignee
          task.attemptId = undefined
          task.handoffId = undefined
          task.reassigning = false
          task.updatedAt = Date.now()
          const currentMember = fresh.members.find((candidate) => candidate.name === ticket.memberName)
          if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle'
          await writeOffice(stateRoot, fresh)
        })
      })
    },
  }

  const syncMemberStatus = async (agent: Agent, status: AgentStatus): Promise<void> => {
    const stateRoot = stateRootOf(agent.session.header.cwd ?? config.workspace(), config)
    const office = await readOffice(stateRoot)
    if (office === undefined) return
    const member = office.members.find((candidate) => candidate.id === agent.id && candidate.status !== 'removed')
    if (member === undefined) return
    await withOfficeLock(lockKey(stateRoot), async () => {
      const fresh = await readOffice(stateRoot)
      const current = fresh?.members.find((candidate) => candidate.id === agent.id && candidate.status !== 'removed')
      if (fresh === undefined || current === undefined) return
      const next = status === 'running' ? 'working' : 'idle'
      if (current.status === next) return
      current.status = next
      await writeOffice(stateRoot, fresh)
    })
    if (status === 'idle') await runtime.kickMember(office.id, member.name)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error: unknown) => {
      ctx.logger.warn(`marvis: 成员状态调度失败（${agent.id}）：${String(error)}`)
    })
  })

  return runtime
}

/** 简化版：直接改写邮箱文件，把给定 id 标记为已送达。 */
async function markDelivered(file: string, ids: string[]): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises')
  let lines: string[] = []
  try {
    lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  } catch { return }
  const next: string[] = []
  for (const line of lines) {
    try {
      const msg = JSON.parse(line)
      if (ids.includes(msg.id)) { msg.deliveredAt = Date.now(); msg.readAt = Date.now() }
      next.push(JSON.stringify(msg))
    } catch { next.push(line) }
  }
  try {
    await writeFile(file, next.join('\n') + (next.length ? '\n' : ''), 'utf8')
  } catch { /* noop */ }
}
