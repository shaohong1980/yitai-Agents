/**
 * 线程/承诺模型 —— 基于 src/memory/threads.js。
 *
 * 解决两个问题：
 *   1. 话题漂移：同时保留多条开放线索，前台线索指针随用户消息切换。
 *   2. 指代恢复：对「那个网页」「进度怎么样」这类指代性问句，回到对应线索上下文。
 *
 * 承诺（commitments）：助手承诺「我会…」会钉住相关线索的温度，避免任务上下文过早冷却。
 *
 * 纯启发式分类（与 Harness 插件保持轻量），失败静默。
 */

import { MemoryStore } from './store.ts'
import { extractKeywords } from './focus-stack.ts'

export interface ThreadRecord {
  id: number
  topics: string[]
  status: 'open' | 'background' | 'closed'
  lastActivity: string
  turnCount: number
  lastSummary: string
}

export interface Commitment {
  id: number
  threadId: number
  content: string
  status: 'pending' | 'done'
  createdAt: string
}

export type ThreadClassify =
  | { kind: 'continue'; threadId: number }
  | { kind: 'resume'; threadId: number }
  | { kind: 'new' }
  | { kind: 'none' }

// 明确的结束语（避免把"写好了吗"这类带"好了"的指代问句误判为结束）
const CLOSE_RE = /(?:就这样吧|就这样|结束了|没有其他事了|没事了|再见|下次再说|到此为止|好的谢谢|谢谢再见|够了够了|没有别的了|可以了谢谢|不用了谢谢)/i
const DEICTIC_RE = /(?:那个|这个|上次|之前|刚才|进度|进展|怎么样了|那个文件|那个网页|上次聊的|那件事|写好了吗|搞定了吗)/i
const NEW_TOPIC_RE = /(?:换个话题|换个方向|新问题|另外|对了|顺便|接下来看|我们来说说|还有一件事|再问一个)/i

/** 找与关键词重叠最多的开放线索（返回 index，无则 -1） */
function bestThreadIndex(openThreads: ThreadRecord[], kws: Set<string>, fromIndex: number): number {
  let best = -1
  let bestScore = 0
  for (let i = fromIndex; i >= 0; i--) {
    const thread = openThreads[i]
    if (!thread) continue
    const score = thread.topics.filter(topic => kws.has(topic)).length
    if (score > bestScore) { bestScore = score; best = i }
  }
  return bestScore > 0 ? best : -1
}

/** 线程分类：根据用户消息判断延续/恢复/新开 */
export function classifyThread(text: string, openThreads: ThreadRecord[], store: MemoryStore): ThreadClassify {
  const t = String(text ?? '').trim()
  if (t.length < 4) return { kind: 'none' }
  if (CLOSE_RE.test(t)) return { kind: 'none' }
  if (openThreads.length === 0) return { kind: 'new' }

  const kws = new Set(extractKeywords(t, 12))
  const current = openThreads[openThreads.length - 1]
  const isDeictic = DEICTIC_RE.test(t)

  // 指代性问句：先按关键词在所有开放线索里找最相关的一条
  // （"刚才的演讲稿" → 演讲稿线索，而不是当前天气线索）
  if (isDeictic) {
    const idx = bestThreadIndex(openThreads, kws, openThreads.length - 1)
    if (idx >= 0) {
      return idx === openThreads.length - 1
        ? { kind: 'continue', threadId: openThreads[idx]!.id }
        : { kind: 'resume', threadId: openThreads[idx]!.id }
    }
    // 指代但没匹配到任何线索 → 回当前线索
    if (current) return { kind: 'continue', threadId: current.id }
  }

  // 明示新话题
  if (NEW_TOPIC_RE.test(t)) return { kind: 'new' }

  // 与当前线索主题重叠 → 延续
  const currentOverlap = current.topics.filter(topic => kws.has(topic)).length
  if (currentOverlap > 0) return { kind: 'continue', threadId: current.id }

  // 与后台线索重叠 → 恢复
  const bgIdx = bestThreadIndex(openThreads, kws, openThreads.length - 2)
  if (bgIdx >= 0) return { kind: 'resume', threadId: openThreads[bgIdx]!.id }

  return { kind: 'new' }
}

/** 从助手回复里提取承诺（"我会/我答应/稍后/接下来" + 动词短语） */
const COMMIT_RE = /(?:我会|我来|我答应|稍后|接下来我|待会我|马上|等会我)([^。！？!?\n]{2,40})/

export function extractCommitment(assistantText: string): string | null {
  const m = String(assistantText ?? '').match(COMMIT_RE)
  if (!m || !m[1]) return null
  const seg = m[1].trim()
  if (seg.length < 2) return null
  return `承诺：${seg}`
}

/** 运行时管理器 */
export class ThreadManager {
  threads: ThreadRecord[] = []
  commitments: Commitment[] = []
  private store: MemoryStore

  constructor(store: MemoryStore) {
    this.store = store
    // 从 store 恢复（在 store.ts 增加对应表）
    try {
      const rows = store.queryAll?.('SELECT * FROM threads WHERE status != ? ORDER BY id', ['closed']) ?? []
      this.threads = rows.map(r => ({
        id: Number(r.id), topics: JSON.parse(String(r.topics)), status: r.status,
        lastActivity: String(r.last_activity), turnCount: Number(r.turn_count), lastSummary: String(r.last_summary),
      }))
    } catch { this.threads = [] }
  }

  /** 处理用户消息，返回分类结果 */
  onUserMessage(text: string): ThreadClassify {
    const cls = classifyThread(text, this.threads, this.store)
    if (cls.kind === 'none') return cls
    const now = new Date().toISOString()

    if (cls.kind === 'new') {
      const id = Date.now()
      this.threads.push({
        id, topics: extractKeywords(text, 12), status: 'open', lastActivity: now, turnCount: 1, lastSummary: text.slice(0, 80),
      })
      // 保持最多 6 条开放线索，超出把最老的转后台
      if (this.threads.length > 6) {
        const oldest = this.threads.shift()
        if (oldest) oldest.status = 'background'
      }
      this.persist()
    } else {
      const target = this.threads.find(th => th.id === cls.threadId)
      if (target) {
        target.lastActivity = now
        target.turnCount++
        target.lastSummary = text.slice(0, 80)
        // 恢复的线索移到前台（末尾）
        if (cls.kind === 'resume') {
          const idx = this.threads.indexOf(target)
          this.threads.splice(idx, 1)
          this.threads.push(target)
        }
        this.persist()
      }
    }
    return cls
  }

  /** 处理助手回复：提取承诺钉住当前线索 */
  onAssistantMessage(text: string): void {
    const commit = extractCommitment(text)
    if (!commit || this.threads.length === 0) return
    const current = this.threads[this.threads.length - 1]
    this.commitments.push({ id: Date.now(), threadId: current.id, content: commit, status: 'pending', createdAt: new Date().toISOString() })
    this.persistCommitments()
  }

  /** 当前前台线索的上下文（用于注入/指代恢复） */
  currentContext(maxSummary = 3): string {
    if (this.threads.length === 0) return ''
    const current = this.threads[this.threads.length - 1]
    const pending = this.commitments.filter(c => c.threadId === current.id && c.status === 'pending').slice(-3)
    const lines = [`当前线索「${current.topics.slice(0, 3).join('、')}」（已 ${current.turnCount} 轮）`, `最近内容：${current.lastSummary}`]
    for (const c of pending) lines.push(`待办承诺：${c.content}`)
    return lines.join('\n')
  }

  /** 归档当前线索 */
  closeCurrent(): void {
    const current = this.threads.pop()
    if (current) {
      current.status = 'closed'
      this.persist()
      this.store.logAction('thread_close', current.topics.join(','))
    }
  }

  private persist(): void {
    try {
      this.store.upsertThreads?.(this.threads.map(t => ({
        id: t.id, topics: JSON.stringify(t.topics), status: t.status,
        last_activity: t.lastActivity, turn_count: t.turnCount, last_summary: t.lastSummary,
      })))
    } catch { /* 静默 */ }
  }

  private persistCommitments(): void {
    try {
      this.store.upsertCommitments?.(this.commitments.map(c => ({
        id: c.id, thread_id: c.threadId, content: c.content, status: c.status, created_at: c.createdAt,
      })))
    } catch { /* 静默 */ }
  }
}

