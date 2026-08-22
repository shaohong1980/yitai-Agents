/**
 * Durable Marvis office state types —— 借鉴 dsh-agent-teams 的磁盘真相源模型。
 *
 * 办公室状态持久化在 `<workspace>/.marvis-office/office.json`：
 *   - members：固定工位员工（file/computer/app/zhuge/find）+ 可选真实 subagent 会话 id
 *   - tasks：任务 DAG（dependencies）+ attempt 能力模型（attemptId 防迟到覆盖）
 *   - inbox/：每名成员/队长一个 JSONL 邮箱（成员→队长直报，队长→成员派活）
 */
export type MarvisTaskStatus =
  | 'pending'      // 待执行（依赖满足且无人领取）
  | 'claimed'      // 已被成员/队长领取
  | 'in_progress'  // 执行中
  | 'review'       // 交付后待人工验收（A2A 外部交付）
  | 'completed'    // 终态：完成
  | 'failed'       // 终态：失败
  | 'cancelled'    // 终态：取消

/** 终态集合：终态后不可再被认领/执行。 */
export const TERMINAL_TASK_STATUSES: readonly MarvisTaskStatus[] = ['completed', 'failed', 'cancelled']

/** 任务状态机允许的迁移（review 可被驳回回 pending，对应审批流）。 */
export const TASK_TRANSITIONS: Readonly<Record<MarvisTaskStatus, readonly MarvisTaskStatus[]>> = {
  pending: ['claimed', 'in_progress', 'cancelled'],
  claimed: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled', 'review'],
  review: ['completed', 'failed', 'cancelled', 'pending'],   // pending = 审批驳回，重回待办
  completed: [],
  failed: ['pending'],      // 允许失败重试（可选）
  cancelled: [],
}

/** 一个任务（任务板 / 办公室共用）。 */
export interface MarvisTask {
  /** 办公室内稳定任务 id（t1、t2、…）。 */
  id: string
  /** 简要标题。 */
  subject: string
  /** 任务详情。 */
  description?: string
  status: MarvisTaskStatus
  /** 执行者：员工 id（file/computer/app/zhuge/find）或 marvis/captain；未指派等待认领。 */
  assignee?: string
  /** 必须先行完成的依赖任务 id 列表。 */
  dependencies: string[]
  /** 完成/失败时执行者写入的结果。 */
  output?: string
  /** 单调执行代数：转派/重试会使所有旧 attempt 失效。 */
  attempt?: number
  /** 当前 claimed/in_progress 执行的能力凭证；成员更新时必须携带。 */
  attemptId?: string
  /** 尚未开始下一 attempt 的吊销/交接代数。 */
  handoffId?: string
  /** 交接正在让旧执行者安静；调度器在此期间不得派发。 */
  reassigning?: boolean
  createdAt: number
  updatedAt: number
  // ---- UI / 外部 A2A 扩展 ----
  /** 指派的外部 A2A agent 端点（codex/hermes/…），非空则走 A2A 执行。 */
  extUrl?: string | null
  /** 验货员自动验收报告。 */
  verifyReport?: string
  /** 自动验收是否通过。 */
  verifyPass?: boolean
  /** 驳回/验货意见。 */
  comment?: string
}

/** 成员生命周期状态（兼容 office UI 的 status 词表）。 */
export type MarvisMemberStatus = 'idle' | 'working' | 'thinking' | 'reporting' | 'sleep' | 'removed'

/** 一名办公室员工：durable 可续聊 subagent + 团队侧记录。 */
export interface MarvisMember {
  /** durable 可续聊 subagent 会话 id（未 spawn 时为 ''）。 */
  id: string
  /** 员工 id：file/computer/app/zhuge/find。 */
  name: string
  /** 角色说明。 */
  role: string
  status: MarvisMemberStatus
  /** spawn 时快照的 LLM provider。 */
  provider?: string
  /** spawn 时快照的模型。 */
  model?: string
  joinedAt: number
}

/** 一条邮箱消息（队长邮箱 inbox/captain.jsonl，成员 inbox/<name>.jsonl）。 */
export interface MarvisMessage {
  id: string
  /** captain 或成员 name。 */
  from: string
  to: string
  content: string
  ts: number
  /** 进程内投递租约：防止 fallback 与实时投递竞争。 */
  deliveryClaimedAt?: number
  /** 收件方 Harness 收件箱接受后置位。 */
  deliveredAt?: number
  /** 收件方已消费/已展示 fallback 后置位。 */
  readAt?: number
}

/** 完整 durable 办公室记录。 */
export interface MarvisOfficeState {
  name: string
  /** 净化后的目录 id。 */
  id: string
  description?: string
  /** 拥有该办公室的队长会话（可选：UI 派发时为 undefined）。 */
  captainSessionId?: string
  createdAt: number
  /** 办公室员工（固定工位名单）。 */
  members: MarvisMember[]
  tasks: MarvisTask[]
  /** 单调任务 id 计数器。 */
  taskSeq: number
  /** 累计完成数（office UI 右上角）。 */
  doneCount: number
}
