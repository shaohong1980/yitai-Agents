/**
 * 焦点栈（Focus Stack）—— 基于 src/memory/focus.js。
 *
 * 设计原则：
 *   - 「专注」是连续判断的副产品：当关键词命中栈顶话题 → 承诺确认；命中下层话题 → 多帧 pop（回归）；
 *     完全新话题 → push 新帧；帧太久没被命中 → 自动失活 pop。
 *   - pop 出的帧进入压缩回填流水线（conclusions），沉淀到长期记忆。
 *   - 栈是内存状态，但会持久化到 SQLite（重启可恢复）。
 */

/** 栈深上限：push 第 N+1 帧时，shift 出栈底那帧。 */
export const MAX_FOCUS_DEPTH = 4

/** 单帧 conclusions 数量上限（滚动丢最旧）。 */
export const FRAME_CONCLUSIONS_LIMIT = 5

/** 帧失活阈值（消息数）：超过这个数没被命中就 pop 栈顶。 */
export const FOCUS_FRAME_STALE = 20

/** 关键词最低门槛：少于这个数说明消息太空泛，不参与焦点判断。 */
const MIN_KEYWORDS_FOR_FRAME = 2

/** 单帧 topic 关键词数量上限。 */
const TOPIC_KEYWORDS_LIMIT = 8

/** 太短的消息直接跳过焦点判断。 */
const MIN_MESSAGE_LENGTH = 4

/** 明显的一次性叶子查询：不该开启/切换专注帧。 */
const ONE_OFF_LEAF_RE = /天气|气温|温度|下雨|下雪|空气质量|AQI|几点|几号|星期几|汇率|热搜|新闻|在吗|早上好|晚上好|谢谢|收到/i
const SUSTAINED_FOCUS_RE = /分析|优化|修复|实现|修改|设计|写|做|排查|调试|构建|部署|项目|代码|文件|机制|方案|测试|review|debug|fix|implement|build|调研|整理|摘要|归档/i

/** 判断是否是一次性叶子查询（不该动焦点栈）。 */
export function isLikelyOneOffLeaf(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (SUSTAINED_FOCUS_RE.test(t)) return false
  if (/^(hello|hi|hey|在吗|早上好|晚上好|谢谢|收到)$/i.test(t)) return true
  return t.length <= 40 && ONE_OFF_LEAF_RE.test(t)
}

/**
 * 从消息正文提取关键词（简易中文分词）：
 *   - CJK 连续片段（2~6 字）整体作为候选；
 *   - 更长片段切成 2-gram（提升子串命中率）；
 *   - 英文/数字词取小写。
 */
export function extractKeywords(text: string, budget = 8): string[] {
  const t = String(text ?? '').trim()
  if (!t) return []
  const words = new Set<string>()
  const cjk = t.match(/[一-鿿]{2,}/g)
  if (cjk) for (const w of cjk) {
    if (w.length >= 2 && w.length <= 6) words.add(w)
    if (w.length >= 3) {
      for (let i = 0; i <= w.length - 2; i++) words.add(w.slice(i, i + 2))
    }
  }
  const en = t.match(/[a-zA-Z0-9_\-.]{2,}/g)
  if (en) for (const w of en) words.add(w.toLowerCase())
  // 去掉过度通用词（含 system-reminder 指令文本的常见噪声）
  const stop = new Set([
    '这个', '那个', '什么', '怎么', '一个', '可以', '需要', '进行', '我们', '你们', '他们',
    '然后', '就是', '现在', '这样', '不是', '没有', '还有', '已经', '帮我', '我分', '应该',
    '一下', '快点', '继续', '回到', '刚才', '先生', '这个', '那个',
    'system', 'reminder', 'the', 'following', 'workspace', 'instructions', 'this', 'will',
    'you', 'your', 'that', 'with', 'from', 'have', 'are', 'for', 'and', 'not', '以下是',
    '重要', '提示', '用户', '指令', '回合', '对话',
  ])
  const result = [...words].filter(w => !stop.has(w) && w.length > 1)
  return result.slice(0, budget)
}

export interface FocusFrameState {
  topic: string[]
  hitCount: number
  lastSeenTick: number
  startedAt: string
  conclusions: string[]
}

export interface FocusUpdateResult {
  event: 'none' | 'pushed' | 'returned' | 'stale'
  poppedFrames: FocusFrameState[]
  /** 需要回填压缩的帧 */
  framesToCompress: FocusFrameState[]
}

/** 焦点栈运行时管理器 */
export class FocusStack {
  frames: FocusFrameState[] = []
  private tick = 0

  constructor(initial: FocusFrameState[] = []) {
    this.frames = [...initial]
  }

  current(): FocusFrameState | null {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1] : null
  }

  /** 心跳计数推进；返回本次是否发生了失活 pop */
  private advanceTick(): void {
    this.tick++
    // 栈顶帧太久没被命中 → 失活
    const top = this.current()
    if (top && this.tick - top.lastSeenTick > FOCUS_FRAME_STALE) {
      this.frames.pop()
    }
  }

  /**
   * 处理一条用户消息，更新焦点栈。
   * @returns 更新结果（事件类型 + 需要压缩回填的帧）
   */
  update(messageText: string): FocusUpdateResult {
    const text = String(messageText ?? '').trim()
    if (text.length < MIN_MESSAGE_LENGTH) return { event: 'none', poppedFrames: [], framesToCompress: [] }
    if (isLikelyOneOffLeaf(text)) return { event: 'none', poppedFrames: [], framesToCompress: [] }

    this.advanceTick()

    const kws = extractKeywords(text, 8)
    if (kws.length < MIN_KEYWORDS_FOR_FRAME) return { event: 'none', poppedFrames: [], framesToCompress: [] }

    const framesToCompress: FocusFrameState[] = []
    let event: FocusUpdateResult['event'] = 'none'
    let matched = false

    // 从栈顶往下找命中的帧
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i]
      if (frame === undefined) continue
      const overlap = frame.topic.filter(t => kws.includes(t)).length
      if (overlap > 0) {
        matched = true
        if (i === this.frames.length - 1) {
          // 命中栈顶 → 承诺确认（不 push，只刷新热度）
          frame.hitCount++
          frame.lastSeenTick = this.tick
          event = 'none'
        } else {
          // 命中下层 → 回归：pop 上层帧
          const popped = this.frames.splice(i + 1)
          frame.hitCount++
          frame.lastSeenTick = this.tick
          event = 'returned'
          framesToCompress.push(...popped)
        }
        break
      }
    }

    // 栈空，或没有任何帧命中 → 新话题 push
    if (!matched) {
      this.frames.push(this.makeFrame(kws.slice(0, TOPIC_KEYWORDS_LIMIT)))
      event = 'pushed'
      while (this.frames.length > MAX_FOCUS_DEPTH) {
        const shifted = this.frames.shift()
        if (shifted) framesToCompress.push(shifted)
      }
    }

    return { event, poppedFrames: [], framesToCompress }
  }

  private makeFrame(topic: string[]): FocusFrameState {
    return {
      topic,
      hitCount: 1,
      lastSeenTick: this.tick,
      startedAt: new Date().toISOString(),
      conclusions: [],
    }
  }

  /** 向当前帧追加一条结论（用于 pop 时压缩回填） */
  addConclusion(conclusion: string): void {
    const top = this.current()
    if (!top) return
    top.conclusions.push(conclusion)
    if (top.conclusions.length > FRAME_CONCLUSIONS_LIMIT) top.conclusions.shift()
  }

  toPersistable(): { topic: string[]; hit_count: number; last_seen_at: string; conclusions: string[] }[] {
    return this.frames.map(f => ({
      topic: f.topic,
      hit_count: f.hitCount,
      last_seen_at: new Date().toISOString(),
      conclusions: f.conclusions,
    }))
  }
}

