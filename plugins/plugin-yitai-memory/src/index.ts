/**
 * plugin-yitai-memory —— 易台记忆系统迁移到 DeepSeek Harness。
 *
 * 核心能力：
 *   1. 焦点栈：监听 session/event，按关键词自动 push/pop/回归，pop 出的帧结论回填长期记忆。
 *   2. SQLite 持久化：node:sqlite + FTS5，存储记忆节点、焦点帧、用户画像、行动日志。
 *   3. 记忆工具：memory_search / memory_upsert / memory_recall / memory_forget / focus_status /
 *      profile_list / profile_update 注册到 ctx.tools，模型可直接调用。
 *   4. 上下文注入：每轮会话前把当前焦点 + 相关记忆注入 system prompt（ACI 预判注入的精简版）。
 *   5. 记忆衰减：定时把久未访问的记忆降权，过低自动隐藏。
 *
 * 零侵入：不改 Harness 源码，纯插件 + --patch 挂载。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MemoryStore, defaultDataRoot, type MemoryRecord } from './store.ts'
import { FocusStack, extractKeywords, type FocusFrameState } from './focus-stack.ts'
import { buildMemoryTools } from './tools.ts'
import { runRecognition, extractContentText, type RecognizerConfig } from './recognizer.ts'
import { ThreadManager } from './threads.ts'

export const name = 'plugin-yitai-memory'

export const inject = ['sessions', 'tools', 'llm']

export interface MemoryPluginConfig {
  /** 记忆库数据目录（默认 $DSH_HOME/yitai-memory） */
  root?: string
  /** 记忆注入条数 */
  injectLimit?: number
  /** 衰减阈值（天）：超过 N 天未访问的老记忆降权 */
  decayDays?: number
  /** 衰减后低于该 salience 的记忆隐藏 */
  hiddenSalience?: number
  /** 心跳间隔（秒）：执行记忆衰减/整理 */
  decayIntervalSec?: number
  /** 自动识别并保存"用户偏好"类记忆（启发式，不调 LLM） */
  heuristicProfile?: boolean
  /** 是否启用 LLM 记忆识别（turn/end 时用 ctx.llm 抽取长期记忆） */
  llmRecognition?: boolean
  /** LLM 识别用的 provider/model（默认 deepseek-official / deepseek-v4-flash） */
  llm?: { provider?: string; model?: string }
  /** 识别器配置 */
  recognizer?: Partial<RecognizerConfig>
}

export interface YitaiMemoryService {
  store: MemoryStore
  focus: FocusStack
  threads: ThreadManager
  /** 搜索记忆（供其他插件调用） */
  search(options: { query?: string; limit?: number; type?: string; tag?: string[]; entity?: string }): MemoryRecord[]
  /** 写入记忆 */
  upsert(mem: { mem_id: string; content: string; type?: string; title?: string; detail?: string; entities?: string[]; tags?: string[]; salience?: number }): MemoryRecord
  /** 当前焦点上下文（供注入器读取） */
  currentFocusContext(): string
}

/** 提取一段用户消息里的纯文本（剥掉 content 块包装） */
function extractUserText(event: unknown): string {
  const data = (event as { data?: { content?: unknown } }).data
  if (!data) return ''
  const content = data.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: { text?: string }) => (c && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 启发式偏好提取：从用户消息里找出"我喜欢/我希望/别忘了/以后都"这类稳定偏好 */
const PREFERENCE_RE = /(?:我喜欢|我喜欢用|我更喜欢|我希望|别忘了|记住|以后都|以后要|尽量|偏好|习惯|不喜欢|讨厌)/

function heuristicProfile(text: string): { key: string; value: string } | null {
  const m = text.match(PREFERENCE_RE)
  if (!m) return null
  const idx = m.index ?? 0
  const segment = text.slice(idx).split(/[。！？!?\n]/)[0]?.trim() ?? ''
  if (segment.length < 6 || segment.length > 120) return null
  return { key: 'preference', value: segment }
}

export function apply(ctx: Context, config: MemoryPluginConfig = {}) {
  const root = config.root ?? defaultDataRoot()
  const store = new MemoryStore(root)
  const focus = new FocusStack(store.loadFrames().map((f): FocusFrameState => ({
    topic: f.topic,
    hitCount: f.hit_count,
    lastSeenTick: 0,
    startedAt: f.last_seen_at,
    conclusions: f.conclusions,
  })))
  const threads = new ThreadManager(store)

  ctx.logger.info(`[yitai-memory] 记忆库已打开: ${store.dbPath}（${store.count()} 条记忆）`)

  /* ============ LLM 记忆识别（turn/end 触发） ============ */

  const llmRecognition = config.llmRecognition ?? true
  const recognizerConfig: RecognizerConfig = {
    provider: config.llm?.provider ?? 'deepseek-official',
    model: config.llm?.model ?? 'deepseek-v4-flash',
    ...(config.recognizer ?? {}),
  }
  let turnUserText = ''
  let turnAssistantText = ''
  let recognitionRunning = false
  const recognitionAbort = new AbortController()

  // 回合文本收集（在现有 session/event 处理器之外监听，保持职责单一）
  ctx.on('session/event', (session, event: { type: string; data?: { content?: unknown; message?: { content?: unknown } } }) => {
    if (event.type === 'user/message') {
      turnUserText = extractContentText(event.data?.content) || turnUserText
    } else if (event.type === 'assistant/message') {
      const msg = event.data?.message
      if (msg) turnAssistantText = extractContentText(msg.content) || turnAssistantText
    } else if (event.type === 'turn/end') {
      if (llmRecognition && turnUserText.trim().length >= 4 && !recognitionRunning) {
        const userText = turnUserText
        const assistantText = turnAssistantText
        recognitionRunning = true
        void runRecognition(ctx, store, userText, assistantText, recognizerConfig, recognitionAbort.signal)
          .then(written => {
            if (written > 0) ctx.logger.info(`[yitai-memory] LLM 识别器写入 ${written} 条长期记忆`)
          })
          .finally(() => { recognitionRunning = false })
      }
      turnUserText = ''
      turnAssistantText = ''
    }
  })

  /* ============ 会话事件监听：焦点栈 + 启发式记忆 ============ */

  ctx.on('session/event', (session, event: { type: string; data?: unknown }) => {
    const type = event.type
    // 用户消息 → 更新焦点栈
    if (type === 'user/message') {
      const text = extractUserText(event)
      if (text) {
        const result = focus.update(text)
        if (result.framesToCompress.length > 0) {
          for (const frame of result.framesToCompress) {
            // 只对持续话题（≥2 次命中）写焦点结论，避免单帧噪声
            if (frame.hitCount < 2) continue
            const topicLabel = frame.topic.filter(k => k.length >= 2).slice(0, 3).join('、')
            const conclusion = `此前持续专注的话题「${topicLabel}」（命中 ${frame.hitCount} 次）`
            store.upsertMemory({
              mem_id: `focus_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'knowledge',
              title: `焦点回填：${topicLabel}`,
              content: conclusion,
              salience: 2.5,
              tags: ['kind:focus_conclusion'],
            })
          }
          store.replaceFrames(focus.toPersistable())
          ctx.logger.info(`[yitai-memory] 焦点栈失活/回归，压缩回填 ${result.framesToCompress.length} 帧`)
        }
        // 启发式偏好提取
        if (config.heuristicProfile !== false) {
          const pref = heuristicProfile(text)
          if (pref) {
            store.upsertProfile(pref.key, pref.value, 0.55, 'heuristic')
            ctx.logger.info(`[yitai-memory] 学习到用户偏好: ${pref.value}`)
          }
        }
        // 线程分类（话题漂移 + 指代恢复）
        const threadCls = threads.onUserMessage(text)
        if (threadCls.kind !== 'none') {
          ctx.logger.info(`[yitai-memory] 线索: ${threadCls.kind}${threadCls.kind !== 'new' ? ` #${threadCls.threadId}` : ''}（开放 ${threads.threads.length} 条）`)
        }
      }
    } else if (type === 'assistant/message') {
      const msg = event.data?.message
      if (msg) {
        const assistantText = extractContentText(msg.content)
        if (assistantText) threads.onAssistantMessage(assistantText)
      }
    }
    // 回合结束 → 持久化焦点栈 + 线程
    if (type === 'turn/end') {
      store.replaceFrames(focus.toPersistable())
    }
  })

  /* ============ 记忆工具注册 ============ */

  const tools = buildMemoryTools({ store, focus })
  for (const tool of tools) ctx.tools.register(tool)
  // 线程状态工具
  ctx.tools.register(defineTool({
    name: 'thread_status',
    description: '查看当前会话线索状态：开放/后台线索、前台指针、待办承诺。用于理解话题脉络与恢复"那个/上次"指代。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      if (threads.threads.length === 0) return '当前没有开放线索。'
      return threads.threads.map((t, i) => {
        const front = i === threads.threads.length - 1 ? '（前台）' : ''
        const pending = threads.commitments.filter(c => c.threadId === t.id && c.status === 'pending')
        const p = pending.length ? ` 待办:${pending.slice(-2).map(c => c.content).join('; ')}` : ''
        return `- #${t.id} [${t.topics.slice(0, 3).join('、')}] ${t.turnCount}轮${front}${p}`
      }).join('\n')
    },
  }))
  ctx.logger.info(`[yitai-memory] 已注册 ${tools.length + 1} 个记忆工具`)

  /* ============ 服务暴露 ============ */

  const service: YitaiMemoryService = {
    store,
    focus,
    threads,
    search: (options) => store.search({
      query: options.query,
      limit: options.limit,
      filterType: options.type,
      filterTags: options.tag,
      entity: options.entity,
    }),
    upsert: (mem) => store.upsertMemory(mem),
    currentFocusContext: () => {
      const frames = focus.frames
      if (frames.length === 0) return ''
      return frames
        .map((f, i) => `- 帧${i}: ${f.topic.join('、')}（命中 ${f.hitCount} 次）`)
        .join('\n')
    },
  }
  ctx.provide('yitai.memory', service)

  /* ============ 上下文注入：焦点 + 相关记忆进 system prompt ============ */

  // 监听用户消息，提前检索相关记忆注入（ACI 预判注入的精简版）
  const injectLimit = config.injectLimit ?? 6
  ctx.on('session/event', (session, event: { type: string; data?: unknown }) => {
    if (event.type !== 'user/message') return
    const text = extractUserText(event)
    if (!text) return
    const related = store.search({ query: extractKeywords(text, 5).join(' '), limit: injectLimit })
    if (related.length === 0) return
    const sectionText = `以下是与当前话题相关的长期记忆（可据此回答，也可用 memory_search 进一步检索）：\n${related.map(m => `- [${m.mem_id}] ${m.title || m.content}`).join('\n')}`
    // 通过 service 暴露当前注入，供 UI/其他插件读取
    service['_lastInjection'] = sectionText
  })

  /* ============ 定时衰减 ============ */

  const decayDays = config.decayDays ?? 60
  const hiddenSalience = config.hiddenSalience ?? 1
  const decayInterval = (config.decayIntervalSec ?? 3600) * 1000

  /* ============ 清理（ctx.effect 保证 fiber 卸载时执行） ============ */

  ctx.effect(() => {
    const decayTimer = setInterval(() => {
      const changed = store.runDecay(decayDays, hiddenSalience)
      if (changed > 0) ctx.logger.info(`[yitai-memory] 记忆衰减完成，处理 ${changed} 条`)
    }, decayInterval)
    return () => {
      clearInterval(decayTimer)
      recognitionAbort.abort()
      store.replaceFrames(focus.toPersistable())
      store.close()
    }
  })
}

