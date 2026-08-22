/**
 * LLM 记忆识别器 —— 迁移自白龙马 src/memory/recognizer.js。
 *
 * 在每轮对话结束时，用 LLM 判断这一轮有哪些信息值得存为长期记忆，
 * 并按 mem_id 命名规则去重写入。设计要点：
 *   - 只对含用户实质内容的回合触发（空回合/纯工具回合跳过）。
 *   - 一次调用产出 JSON 数组，批量写入。
 *   - mem_id 命名：person_/object_/article_/concept_/fact_/procedure_/constraint_/lesson_
 *   - 失败静默降级（不影响主对话流程）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import type { MemoryStore } from './store.ts'

/** 默认单轮识别超时：防止网络挂死拖住进程 */
export const DEFAULT_RECOGNIZER_TIMEOUT_MS = 20_000

/** 一次识别结果：候选记忆列表 */
export interface RecognizedMemory {
  mem_id?: string
  type?: string
  title?: string
  content: string
  detail?: string
  entities?: string[]
  tags?: string[]
  salience?: number
}

/** 识别器配置 */
export interface RecognizerConfig {
  provider: string
  model: string
  /** 识别提示中的用户标识（用于 entities 标记） */
  userLabel?: string
  /** 单轮识别超时 ms */
  timeoutMs?: number
  /** 最大注入的会话片段字符数 */
  maxInputChars?: number
}

export const RECOGNIZER_PROMPT = `You are the memory recognizer of a personal AI workbench. Your ONLY job is to decide what is worth saving as long-term memory from the user-assistant turn below. Do NOT answer, plan, or execute the task.

## What to save
- Stable user preferences, long-term constraints, explicit facts about the user.
- Conclusions or experience that cost effort (web research, tool results, long summaries).
- Stable facts about people (user, contacts, public figures).
- Knowledge, concepts, methods, reusable procedures, hard constraints, failure lessons.

## What NOT to save
- Pure small talk, greetings, temporary state, one-off instructions ("stop now", "until I return").
- Anything already fully present in the short-term conversation.

## Output format (STRICT)
Return a JSON array only, no markdown fence, no prose. Each element:
{"mem_id":"fact_{snake}","type":"fact|person|object|article|knowledge","title":"短标题","content":"核心内容","entities":["user:001"],"tags":["kind:procedure"|"kind:constraint"|"kind:failure_lesson"|"domain:xxx"|"trigger:xxx"],"salience":1-5}

mem_id naming: person_{id} / object_{slug} / article_{hash8} / concept_{snake} / fact_{snake} / procedure_{domain}_{snake} / constraint_{domain}_{snake} / lesson_{domain}_{snake}.
If nothing worth saving, return [].`

/** 从 LLM 输出里稳健提取 JSON 数组 */
export function parseRecognitionJson(raw: string): RecognizedMemory[] {
  let text = String(raw ?? '').trim()
  // 去 markdown 围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  // 找第一个 [ 到最后一个 ]
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(m => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map(m => ({
        mem_id: typeof m.mem_id === 'string' ? m.mem_id : undefined,
        type: typeof m.type === 'string' ? m.type : 'fact',
        title: typeof m.title === 'string' ? m.title : '',
        content: m.content.trim(),
        detail: typeof m.detail === 'string' ? m.detail : undefined,
        entities: Array.isArray(m.entities) ? m.entities.map(String) : [],
        tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
        salience: typeof m.salience === 'number' ? m.salience : 3,
      }))
  } catch {
    return []
  }
}

/**
 * 运行一轮记忆识别。
 * @param ctx Harness 上下文（需已注入 llm 服务）
 * @param store 记忆库
 * @param userText 本轮用户输入
 * @param assistantText 本轮助手回复
 * @param config 识别器配置
 * @returns 写入的记忆数
 */
export async function runRecognition(
  ctx: Context,
  store: MemoryStore,
  userText: string,
  assistantText: string,
  config: RecognizerConfig,
  signal?: AbortSignal,
): Promise<number> {
  const input = `[User turn]\n${userText.slice(0, config.maxInputChars ?? 4000)}\n\n[Assistant turn]\n${assistantText.slice(0, config.maxInputChars ?? 4000)}\n\nReturn the JSON array of memories worth saving.`

  const messages: Message[] = [{
    role: 'user',
    content: [{ type: 'text', text: input }],
  }]

  // 组合外部取消信号 + 超时：dispose 中止 / 网络挂死兜底
  const timeoutMs = config.timeoutMs ?? DEFAULT_RECOGNIZER_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  const options: GenerateOptions = {
    provider: config.provider,
    model: config.model,
    system: RECOGNIZER_PROMPT,
    messages,
    maxTokens: 1024,
    signal: combined,
  }

  const assembler = new BlockAssembler()
  try {
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  } catch {
    return 0 // 静默降级
  }
  if (assembler.finish?.reason?.kind === 'error') return 0

  const blocks = assembler.blocks()
  const text = blocks.map(b => b.type === 'text' ? (b.text ?? '') : '').join('')
  const candidates = parseRecognitionJson(text)
  if (candidates.length === 0) return 0

  const userLabel = config.userLabel ?? 'user:001'
  let written = 0
  for (const c of candidates) {
    const memId = c.mem_id ?? `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    store.upsertMemory({
      mem_id: memId,
      type: c.type ?? 'fact',
      title: c.title ?? '',
      content: c.content,
      detail: c.detail,
      entities: c.entities ?? [],
      // 默认把用户实体标上
      tags: c.tags ?? [],
      salience: c.salience ?? 3,
    })
    // 若识别出是用户相关事实且没带实体，补用户标签
    if ((c.entities === undefined || c.entities.length === 0) && /user|我|我的|prefer|喜欢|偏好/.test(c.content) === false) {
      // 无实体时用 tags 保留来源
    }
    written++
  }
  store.logAction('memory_recognized', `${written} memories`)
  return written
}

/** 从 session event 的 content 数组提取纯文本 */
export function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

