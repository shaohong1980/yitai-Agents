/**
 * 办公室员工 subagent 生命周期 —— 借鉴 dsh-agent-teams 的 durable 可续聊成员。
 *
 * 员工是队长的 durable continuable 子代理：spawn 后保持跨轮次、跨重启的会话。
 * 队长用 `ctx.subagents.followup` 唤醒它，它工作完整一轮（通过 `marvis_update_task`
 * 等工具推进任务状态），随后回到 idle。最终 assistant 消息不可程序化读取，所以
 * 员工把结果写进任务记录与队长邮箱，队长用 `marvis_status` 读取。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MarvisMember, MarvisOfficeState } from './types.ts'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'

/** 队长的 member 专属工具（员工不可见/不可调）。 */
const MEMBER_DENIED_TOOLS = [
  'marvis_dispatch',
  'marvis_create_task',
  'marvis_reassign_task',
] as const

const MEMBER_LABEL_PREFIX = 'marvis-member:'

/** 把 SessionId 品牌恢复（从 durable 文件 round-trip 后品牌被 JSON 擦除）。 */
function brandedSessionId(value: string): SessionId {
  return value as SessionId
}

/** 员工 persona（shadow 部署 persona，自包含）。 */
export function memberPersona(office: MarvisOfficeState, member: MarvisMember, stateDir: string): string {
  return `你是 ${member.name}（${member.role}），多Agent办公室「${office.name}」的一名专职员工。队长（雷总管）领导办公室；你是一名执行员工。

团队上下文：
- 办公室 id：${office.id}
- 你的身份 name：${member.name}
- 办公室状态位于 ${stateDir}/（office.json 和 inbox/*.jsonl）。只可只读诊断，绝不直接编辑；用 marvis_* 工具做更新，保证 JSON 转义与并发安全。
- 队长通过消息给你派活。每收到一条消息就是新的一轮：执行它并以简短回复收尾。

工作规则：
1. 收到任务派发时，用 marvis_claim_task 领取（传入任务 id）。记下返回的 attempt_id：之后的 marvis_update_task 都要带上它。
2. 认真用你手头的工具（bash/fs/web 等）完成工作，不要偷工减料。
3. 完成后用 marvis_update_task（带同一个 attempt_id，status=completed，output 简明总结做了什么与关键结果）。stale-attempt 拒绝 = 队长已转派/接管，停止该任务，等待新工作。
4. 完成后给队长发一句简短报告：marvis_send_message（to=captain）。
5. 需要向同事提问时用 marvis_send_message（to=<员工name>），消息直达对方邮箱并唤醒。
6. 你是执行员工：不要创建/删除办公室、不要转派任务、不要派发新任务——那是队长的职责。`
}

/** 员工创建时的欢迎语。 */
export function memberWelcome(office: MarvisOfficeState): string {
  return `你已加入办公室「${office.name}」成为员工。队长会给你派任务与消息；等待指令。当前办公室有 ${office.tasks.length} 个任务。`
}

/** spawn 一名员工为 durable 可续聊子代理，成功则回填 member.id。失败不持久化。 */
export async function spawnMember(
  ctx: Context,
  captain: Agent,
  office: MarvisOfficeState,
  member: MarvisMember,
  stateDir: string,
  signal: AbortSignal,
): Promise<void> {
  const provider = ctx.subagents.getProvider('spawn')
  if (provider === undefined) {
    throw new Error(
      `marvis: 没有注册 subagent provider "spawn"（可用：${ctx.subagents.list().join(', ') || 'none'}）`
      + ' — 请确认 subagent-spawn 已挂载进组合',
    )
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`marvis: provider "spawn" 不支持 durable 可续聊成员（缺 prepareContinuable）`)
  }
  if (!provider.capabilities.persona) {
    throw new Error(`marvis: provider "spawn" 无法为成员应用 persona`)
  }
  const label = `${MEMBER_LABEL_PREFIX}${member.name}`
  const start = await ctx.subagents.startContinuable({
    provider: 'spawn',
    label,
    request: {
      prompt: [{ type: 'text', text: memberWelcome(office) }],
      parent: captain,
      persona: memberPersona(office, member, stateDir),
      toolFilter: { deny: [...MEMBER_DENIED_TOOLS] },
      agentOptions: {
        provider: member.provider ?? captain.session.requestHeader()?.config?.provider ?? captain.options.provider,
        model: member.model ?? captain.session.requestHeader()?.config?.model ?? captain.options.model,
      },
      maxDepth: 1,
    } as SubagentStartRequest,
    signal,
  })
  member.id = start.childId
}

/** 向成员投递一条消息作为其下一轮 FIFO 回合（尽力而为）。 */
export async function deliverToMember(
  ctx: Context,
  captain: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await ctx.subagents.followup(captain, brandedSessionId(childId), [{ type: 'text', text }], {
      source: { kind: 'plugin', plugin: 'marvis-orchestrator' },
      signal,
    })
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`marvis: 对成员 ${childId} 的 followup 失败：${String(error)}`)
    return false
  }
}

/** 请求取消一名成员当前轮次（尽力而为，立即返回）。 */
export function interruptMember(ctx: Context, captain: Agent, childId: string): void {
  try {
    ctx.subagents.interrupt(brandedSessionId(childId), { kind: 'ancestor', agent: captain })
  } catch (error: unknown) {
    ctx.logger.warn(`marvis: 中断成员 ${childId} 失败：${String(error)}`)
  }
}

/** 真实驱动活动快照：durable 成员 id → running / idle / ready。 */
export function memberActivity(
  ctx: Context,
  memberIds: readonly string[],
): Map<string, 'running' | 'idle' | 'ready'> {
  const activity = new Map<string, 'running' | 'idle' | 'ready'>()
  for (const id of memberIds) {
    if (id === '') continue
    const live = ctx.agents.get(brandedSessionId(id))
    activity.set(id, live === undefined ? 'ready' : live.status)
  }
  return activity
}
