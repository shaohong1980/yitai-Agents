/**
 * Marvis 办公室状态持久化与纯逻辑规则 —— 借鉴 dsh-agent-teams 的
 * `<workspace>/<stateDir>/` 磁盘真相源 + 进程内 per-team 锁 + attempt 能力模型。
 *
 * 所有变更都跑在进程内 per-office 队列上，保证 read-modify-write 串行；
 * 用 `node:fs/promises` 直接读写（本插件拥有这份簿记，等价 host-plane 状态）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MarvisMessage, MarvisOfficeState, MarvisTask, MarvisTaskStatus } from './types.ts'
import { TASK_TRANSITIONS } from './types.ts'

/** 队长在邮箱中的键名。 */
export const CAPTAIN_KEY = 'captain'
/** 崩溃的实时投递租约在该时长后可重试。 */
const MAILBOX_DELIVERY_LEASE_MS = 60_000

/** 进程内 per-office 变更队列（promise 链）。 */
const locks = new Map<string, Promise<unknown>>()

/**
 * 串行化一个办公室的全部变更。
 * @param key - 变更作用域 key（如 `office:<stateRoot>`）。
 * @param fn - 需要独占执行的变更。
 */
export async function withOfficeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, previous.then(() => gate))
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

/** 超长 key 截断后追加短摘要。 */
const MAX_KEY_LENGTH = 48

/** 稳定短摘要，用于区分长 key / 纯符号名。 */
function keyDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8)
}

/**
 * 把任意名称折叠为安全的路径/key 段。
 * Unicode 字母与数字保留（中文/西里尔/希腊文可读），其余折叠为 `-`；
 * 纯符号名用摘要；超长截断 + 摘要防前缀碰撞（中文每字 3 字节）。
 */
export function sanitizeKey(name: string): string {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return `k-${keyDigest(name)}`
  const points = [...cleaned]
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`
  }
  return cleaned
}

/** 默认状态目录名。 */
export const DEFAULT_STATE_DIR = '.marvis-office'

/** 办公室状态文件。 */
const OFFICE_FILE = 'office.json'

/** 状态根目录：`<workspace>/<stateDir>/`。 */
export function stateRootOf(workspace: string, stateDir: string = DEFAULT_STATE_DIR): string {
  return join(workspace, stateDir)
}

/** 办公室文件路径。 */
export function officeFileOf(stateRoot: string): string {
  return join(stateRoot, OFFICE_FILE)
}

/** 邮箱目录路径。 */
export function inboxDirOf(stateRoot: string): string {
  return join(stateRoot, 'inbox')
}

/** 单条邮箱文件路径。 */
export function mailboxFileOf(stateRoot: string, key: string): string {
  return join(inboxDirOf(stateRoot), `${sanitizeKey(key)}.jsonl`)
}

/** 同步读办公室状态（冷恢复路径用）。 */
export function readOfficeSync(stateRoot: string): MarvisOfficeState | undefined {
  try {
    const raw = readFileSync(officeFileOf(stateRoot), 'utf8')
    return JSON.parse(raw) as MarvisOfficeState
  } catch {
    return undefined
  }
}

/** 异步读办公室状态。 */
export async function readOffice(stateRoot: string): Promise<MarvisOfficeState | undefined> {
  try {
    const raw = await readFile(officeFileOf(stateRoot), 'utf8')
    return JSON.parse(raw) as MarvisOfficeState
  } catch {
    return undefined
  }
}

/** 原子写办公室状态（tmp + rename）。 */
export async function writeOffice(stateRoot: string, state: MarvisOfficeState): Promise<void> {
  await mkdir(stateRoot, { recursive: true })
  const target = officeFileOf(stateRoot)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, target)
}

/** 初始化办公室状态文件；已存在则不覆盖。 */
export async function ensureOffice(
  stateRoot: string,
  seed: Omit<MarvisOfficeState, 'createdAt'>,
): Promise<MarvisOfficeState> {
  const existing = await readOffice(stateRoot)
  if (existing) return existing
  const state: MarvisOfficeState = { ...seed, createdAt: Date.now() }
  await writeOffice(stateRoot, state)
  return state
}

/** 返回尚未满足的依赖任务 id（全满足为空数组）。 */
export function unsatisfiedDependencies(tasks: MarvisTask[], dependencies: string[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return dependencies.filter((id) => byId.get(id)?.status !== 'completed')
}

/** 校验任务状态迁移。 */
export function transitionError(current: MarvisTaskStatus, next: MarvisTaskStatus): string | undefined {
  if (current === next) return undefined
  if (!TASK_TRANSITIONS[current].includes(next)) {
    return `任务状态不能从 "${current}" 迁移到 "${next}"`
  }
  return undefined
}

/** 激活任务当前代数并返回能力凭证 id（认领/转派时调用）。 */
export function beginTaskAttempt(task: MarvisTask, assignee: string): string {
  task.attempt = (task.attempt ?? 0) + 1
  task.attemptId = randomUUID()
  task.handoffId = undefined
  task.reassigning = false
  task.assignee = assignee
  task.updatedAt = Date.now()
  return task.attemptId
}

/** 使当前 attempt 失效（转派/接管前调用）。 */
export function invalidateTaskAttempt(task: MarvisTask): void {
  task.attemptId = undefined
  task.handoffId = randomUUID()
  task.reassigning = true
  task.updatedAt = Date.now()
}

/** 原子状态迁移（持有锁时调用）。 */
export async function transitionTask(
  stateRoot: string,
  office: MarvisOfficeState,
  taskId: string,
  attemptId: string | undefined,
  next: MarvisTaskStatus,
  output?: string,
): Promise<MarvisTask> {
  const task = office.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) throw new Error(`没有任务 "${taskId}"`)
  if (next !== 'pending') {
    // 状态推进必须携带当前 attemptId；驳回(pending)与取消除外
    if (attemptId === undefined || task.attemptId !== attemptId) {
      throw new Error(`stale attempt：任务 "${taskId}" 已被转派/接管，当前 attemptId 不匹配（请先 reassign）`)
    }
  }
  const err = transitionError(task.status, next)
  if (err) throw new Error(err)
  task.status = next
  if (output !== undefined) task.output = output
  task.updatedAt = Date.now()
  if (next === 'pending') {
    // 驳回/重试：清空能力凭证，让下一次认领/调度生成新代数
    task.attemptId = undefined
    task.reassigning = false
    task.handoffId = undefined
  }
  if (next === 'completed') office.doneCount++
  await writeOffice(stateRoot, office)
  return task
}

/* ================= 邮箱（durable mailbox） ================= */

/** 追加一条消息到某邮箱。 */
export async function appendMailbox(stateRoot: string, message: MarvisMessage): Promise<void> {
  const file = mailboxFileOf(stateRoot, message.to)
  await mkdir(inboxDirOf(stateRoot), { recursive: true })
  await writeFile(file, `${JSON.stringify(message)}\n`, { flag: 'a', encoding: 'utf8' })
}

/** 读取某邮箱全部未读（未 deliveredAt/readAt 或已超过投递租约）。 */
export async function readUnreadMailbox(stateRoot: string, key: string): Promise<MarvisMessage[]> {
  const file = mailboxFileOf(stateRoot, key)
  let lines: string[] = []
  try {
    lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  } catch {
    return []
  }
  const now = Date.now()
  const out: MarvisMessage[] = []
  for (const line of lines) {
    let msg: MarvisMessage
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.readAt !== undefined) continue
    if (msg.deliveredAt !== undefined
      && msg.deliveryClaimedAt !== undefined
      && now - msg.deliveryClaimedAt < MAILBOX_DELIVERY_LEASE_MS) continue
    out.push(msg)
  }
  return out
}

/** 标记一条消息为投递成功。 */
export async function acknowledgeMailbox(stateRoot: string, key: string, ids: string[]): Promise<void> {
  await mutateMailbox(stateRoot, key, (msg) => {
    if (!ids.includes(msg.id)) return msg
    return { ...msg, deliveredAt: Date.now() }
  })
}

/** 标记一条消息为已消费。 */
export async function markMailboxRead(stateRoot: string, key: string, ids: string[]): Promise<void> {
  await mutateMailbox(stateRoot, key, (msg) => {
    if (!ids.includes(msg.id)) return msg
    return { ...msg, readAt: Date.now() }
  })
}

/** 认领一次投递（写租约，防 fallback 与实时投递竞争）。 */
export async function claimMailboxDelivery(stateRoot: string, key: string, ids: string[]): Promise<void> {
  await mutateMailbox(stateRoot, key, (msg) => {
    if (!ids.includes(msg.id)) return msg
    return { ...msg, deliveryClaimedAt: Date.now() }
  })
}

/** 释放一次投递（回滚租约）。 */
export async function releaseMailboxDelivery(stateRoot: string, key: string, ids: string[]): Promise<void> {
  await mutateMailbox(stateRoot, key, (msg) => {
    if (!ids.includes(msg.id)) return msg
    return { ...msg, deliveryClaimedAt: undefined }
  })
}

/** 通用邮箱原地改写（读改写 + 原子写回）。 */
async function mutateMailbox(
  stateRoot: string,
  key: string,
  fn: (msg: MarvisMessage) => MarvisMessage,
): Promise<void> {
  const file = mailboxFileOf(stateRoot, key)
  let lines: string[] = []
  try {
    lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  } catch { return }
  const nextLines: string[] = []
  for (const line of lines) {
    let msg: MarvisMessage
    try { msg = JSON.parse(line) } catch { nextLines.push(line); continue }
    const next = fn(msg)
    nextLines.push(JSON.stringify(next))
  }
  await writeFile(file, nextLines.join('\n') + (nextLines.length ? '\n' : ''), 'utf8')
}

/** 归档整个办公室目录（删除时保留到 archive/）。 */
export async function archiveOffice(stateRoot: string, teamId: string): Promise<void> {
  const src = join(stateRoot, teamId)
  const archiveDir = join(stateRoot, 'archive')
  await mkdir(archiveDir, { recursive: true })
  const dst = join(archiveDir, teamId)
  try {
    await rm(dst, { recursive: true, force: true })
  } catch { /* noop */ }
  await rename(src, dst)
}

/** 列出所有活动办公室目录 id。 */
export async function listOffices(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(stateRoot, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && e.name !== 'archive').map((e) => e.name)
  } catch {
    return []
  }
}
