/**
 * plugin-bailongma-tokenjuice —— 工具结果压缩（TokenJuice）。
 *
 * 迁移自白龙马 src/runtime/tool-result-compressor.js。
 *
 * 思路：大段「只读/信息型」工具输出在进入模型上下文之前，先压成一行信息量足够的摘要，
 * 全文写入本地文件并把路径交给模型 —— 需要细节时用 read 工具按需取回。
 * 既保住正确性（细节不丢），又显著省 token。
 *
 * 实现：复用 Harness 的 surface replace 机制（与 dsh-compaction-tool-result-pruner 同款），
 * 在 `tool/result` 事件上追加一条替换事件。
 */

import { mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage, type ToolResultMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'

export const name = 'plugin-bailongma-tokenjuice'
export const inject = ['sessions']

export interface TokenJuiceConfig {
  /** 超过该字符数的结果才压缩 */
  thresholdChars?: number
  /** 只压缩白名单内的只读/信息型工具 */
  whitelist?: string[]
  /** 输出目录（默认 $DSH_HOME/bailongma-tokenjuice/outputs） */
  outputRoot?: string
  /** 单文件保存上限字符数 */
  maxSaveChars?: number
  /** 输出文件保留时长（天） */
  maxAgeDays?: number
}

const DEFAULT_WHITELIST = ['read', 'glob', 'grep', 'read_image', 'memory_search', 'memory_recall', 'list_dir']

/** 从 ContentBlock[] 提取文本长度 */
function measureText(blocks: readonly ContentBlock[]): number {
  let n = 0
  for (const b of blocks) {
    if (b.type === 'text') n += Array.from(b.text).length
  }
  return n
}

/** 从 ContentBlock[] 拼接纯文本 */
function joinText(blocks: readonly ContentBlock[]): string {
  return blocks.map(b => b.type === 'text' ? b.text : '').join('\n')
}

/** 从参数对象提取关键路径/查询（用于摘要定位） */
function argPath(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  const p = a.path ?? a.file ?? a.pattern ?? a.query ?? a.target ?? ''
  return typeof p === 'string' ? p.slice(0, 120) : ''
}

export function apply(ctx: Context, config: TokenJuiceConfig = {}) {
  const threshold = config.thresholdChars ?? 6000
  const whitelist = new Set(config.whitelist ?? DEFAULT_WHITELIST)
  const outputRoot = config.outputRoot ?? `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/bailongma-tokenjuice/outputs`
  const maxSaveChars = config.maxSaveChars ?? 100_000
  mkdirSync(outputRoot, { recursive: true })

  // callId → 工具名/参数（来自 tool/call 事件）
  const callInfo = new Map<string, { name: string; arguments: unknown }>()

  /** 压缩一次 tool/result；失败静默回退原结果 */
  function compress(session: unknown, event: { seq: number; data: { message: ToolResultMessage } }): void {
    try {
      const seq = event.seq
      const message = event.data.message
      const resultBlock = message.content[0]
      const blocks = resultBlock?.content ?? []
      const totalChars = measureText(blocks)
      if (totalChars <= threshold) return

      const info = callInfo.get(String(message.source.callId))
      const toolName = info?.name ?? 'unknown'
      if (!whitelist.has(toolName)) return
      // 跳过已经是替换结果的 tool/result（surfaceOp 是 replace 对象），防递归。
      // 原始 append 的 surfaceOp 是字符串 'append'；替换事件是 { op:'replace', ... } 对象。
      const rawEvent = event as unknown as { surfaceOp?: unknown }
      if (typeof rawEvent.surfaceOp === 'object' && rawEvent.surfaceOp !== null) return

      const fullText = joinText(blocks)
      const saved = fullText.slice(0, maxSaveChars)
      const hash = createHash('sha1').update(fullText).digest('hex').slice(0, 12)
      const file = join(outputRoot, `${Date.now()}-${hash}.txt`)
      writeFileSync(file, saved, 'utf8')

      const lines = fullText.split('\n').length
      const pathHint = argPath(info?.arguments)
      const summary = `[${toolName}] 结果 ${totalChars.toLocaleString()} 字符 / ${lines.toLocaleString()} 行${pathHint ? `（${pathHint}）` : ''}，已压缩。全文在 ${file}，需要细节时用 read 工具读取该文件。`
      const summaryBlock: ContentBlock = { type: 'text', text: summary }

      const replacement = freezeMessage<ToolResultMessage>({
        ...message,
        content: [{
          ...resultBlock,
          content: [summaryBlock],
        }] as [typeof resultBlock],
      })

      const sess = session as {
        append(type: 'tool/result', data: Record<string, unknown>, opts: { surfaceOp: { op: 'replace'; start: number; end: number }; sourceEventSeqs: number[] }): unknown
      }
      sess.append('tool/result', { ...event.data, message: replacement }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      ctx.logger.info(`[tokenjuice] 压缩 ${toolName} 结果：${totalChars}→${Array.from(summary).length} 字符，全文已存 ${file}`)
    } catch (e) {
      ctx.logger.warn(`[tokenjuice] 压缩失败（回退原结果）: ${String(e)}`)
    }
  }

  ctx.on('session/event', (session, event: { type: string; data?: { callId?: unknown; name?: unknown; arguments?: unknown; message?: unknown } }) => {
    const type = event.type
    if (type === 'tool/call' && event.data) {
      const d = event.data as { callId: string; name: string; arguments: string }
      try {
        callInfo.set(d.callId, { name: d.name, arguments: JSON.parse(d.arguments ?? '{}') })
      } catch {
        callInfo.set(d.callId, { name: d.name, arguments: {} })
      }
      return
    }
    if (type === 'tool/result' && event.data && typeof event.data.message === 'object') {
      compress(session, event as { seq: number; data: { message: ToolResultMessage } })
      // 限制 callInfo 大小
      if (callInfo.size > 500) {
        const first = callInfo.keys().next().value
        if (first !== undefined) callInfo.delete(first)
      }
    }
  })

  /* ============ 清理过期输出文件（ctx.effect） ============ */

  ctx.effect(() => {
    const maxAgeMs = (config.maxAgeDays ?? 7) * 24 * 60 * 60 * 1000
    const cleaner = setInterval(() => {
      try {
        const now = Date.now()
        for (const name of readdirSync(outputRoot)) {
          const p = join(outputRoot, name)
          const stat = statSync(p)
          if (now - stat.mtimeMs > maxAgeMs) rmSync(p, { force: true })
        }
      } catch { /* 忽略清理错误 */ }
    }, 6 * 60 * 60 * 1000)
    return () => clearInterval(cleaner)
  })

  ctx.logger.info(`[tokenjuice] 已就绪：阈值 ${threshold} 字符，白名单 ${[...whitelist].join('/')}`)
}

