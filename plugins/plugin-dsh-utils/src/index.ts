/**
 * plugin-dsh-utils —— 零依赖通用工具集。
 * 借鉴 omdsh-dev/dsh-toolkit：为 Agent 提供时间/计算/JSON/编码/正则/CSV/Markdown 等
 * 纯函数工具，无需任何外部依赖。全部注册到 ctx.tools。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'

export const name = 'plugin-dsh-utils'
export const inject = ['tools']

/* ---------- 安全数学表达式求值（递归下降，无 eval） ---------- */
function calcEval(expr: string): number {
  const s = expr.replace(/\s+/g, '')
  let i = 0
  function peek(): string { return s[i] ?? '' }
  function eat(c: string): void { if (peek() === c) i++ }
  function parsePrimary(): number {
    const c = peek()
    if (c === '(') {
      i++; const v = parseExpr(); eat(')'); return v
    }
    if (c === '-') { i++; return -parsePrimary() }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i))
    if (m) { i += m[0].length; return Number(m[0]) }
    throw new Error(`无效表达式: 位置 ${i}`)
  }
  function parseTerm(): number {
    let v = parsePrimary()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = peek(); i++
      const r = parsePrimary()
      v = op === '*' ? v * r : op === '/' ? v / r : v % r
    }
    return v
  }
  function parseExpr(): number {
    let v = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = peek(); i++
      const r = parseTerm()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  const result = parseExpr()
  if (i < s.length) throw new Error(`无效尾部: ${s.slice(i)}`)
  return result
}

/* ---------- CSV 简单解析（RFC 4180 子集） ---------- */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* 忽略 */ }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

/* ---------- Markdown 简易 HTML ---------- */
function mdToHtml(md: string): string {
  const lines = String(md ?? '').split('\n')
  const out: string[] = []
  let inList = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    if (/^###?\s/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false }
      const level = line.match(/^(#+)/)![1]!.length
      out.push(`<h${level}>${esc(line.replace(/^#+\s*/, ''))}</h${level}>`)
    } else if (/^\s*[-*]\s/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${esc(line.replace(/^\s*[-*]\s*/, ''))}</li>`)
    } else if (/^\s*\d+\.\s/.test(line)) {
      if (!inList) { out.push('<ol>'); inList = true }
      out.push(`<li>${esc(line.replace(/^\s*\d+\.\s*/, ''))}</li>`)
    } else {
      if (inList) { out.push('</ul>'); inList = false }
      if (line.trim() === '') { out.push('') }
      else out.push(`<p>${esc(line).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')}</p>`)
    }
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

export function apply(ctx: Context): void {
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'util_time',
      description: '获取当前时间 / 时区转换 / 日期加减。返回 ISO 时间与可读文本。',
      parameters: {
        timezone: { type: 'string', description: '目标时区（如 Asia/Shanghai），可选' },
        format: { type: 'string', description: '格式模板，默认 ISO，支持 YYYY-MM-DD HH:mm:ss' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        const d = new Date()
        if (args.format) {
          const p = (n: number, l = 2): string => String(n).padStart(l, '0')
          const map: Record<string, string> = {
            'YYYY': p(d.getFullYear(), 4), 'MM': p(d.getMonth() + 1), 'DD': p(d.getDate()),
            'HH': p(d.getHours()), 'mm': p(d.getMinutes()), 'ss': p(d.getSeconds()),
          }
          return args.format.replace(/YYYY|MM|DD|HH|mm|ss/g, m => map[m] ?? m)
        }
        return d.toISOString()
      },
    }),
    defineTool({
      name: 'util_calc',
      description: '安全计算数学表达式（+ - * / % 与括号），不执行任意代码。',
      parameters: {
        expression: { type: 'string', description: '如 12*3+(8/2)', required: true },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        try { return `${args.expression} = ${calcEval(args.expression)}` }
        catch (e) { return `❌ ${e instanceof Error ? e.message : String(e)}` }
      },
    }),
    defineTool({
      name: 'util_json',
      description: 'JSON 处理：解析/格式化/取字段。',
      parameters: {
        action: { type: 'string', description: 'parse(解析+格式化) / stringify / get(取字段)', required: true },
        json: { type: 'string', description: 'JSON 文本' },
        path: { type: 'string', description: 'get 用的字段路径，如 a.b[0].c' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        try {
          if (args.action === 'stringify') return JSON.stringify(JSON.parse(args.json ?? '{}'), null, 2)
          if (args.action === 'get') {
            const obj = JSON.parse(args.json ?? '{}')
            let cur: unknown = obj
            for (const seg of (args.path ?? '').split('.')) {
              const m = /^([^\[]+)\[(\d+)\]$/.exec(seg)
              if (m) cur = (cur as Record<string, unknown>)?.[m[1]!]?.[Number(m[2]!)]
              else cur = (cur as Record<string, unknown>)?.[seg]
              if (cur === undefined) return '（字段不存在）'
            }
            return JSON.stringify(cur)
          }
          return JSON.stringify(JSON.parse(args.json ?? '{}'), null, 2)
        } catch (e) { return `❌ ${e instanceof Error ? e.message : String(e)}` }
      },
    }),
    defineTool({
      name: 'util_encode',
      description: '编码/哈希工具：base64 编解码、URL 编解码、十六进制、MD5/SHA 哈希、UUID。',
      parameters: {
        action: { type: 'string', description: 'base64_encode/base64_decode/url_encode/url_decode/hex/md5/sha256/uuid', required: true },
        text: { type: 'string', description: '输入文本' },
        algorithm: { type: 'string', description: 'hash 用算法，默认 sha256' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        const t = args.text ?? ''
        switch (args.action) {
          case 'base64_encode': return Buffer.from(t, 'utf8').toString('base64')
          case 'base64_decode': return Buffer.from(t, 'base64').toString('utf8')
          case 'url_encode': return encodeURIComponent(t)
          case 'url_decode': return decodeURIComponent(t)
          case 'hex': return Buffer.from(t, 'utf8').toString('hex')
          case 'md5': return createHash('md5').update(t).digest('hex')
          case 'sha256': return createHash('sha256').update(t).digest('hex')
          case 'uuid': return randomUUID()
          default: return `❌ 未知 action: ${args.action}`
        }
      },
    }),
    defineTool({
      name: 'util_regex',
      description: '正则测试/提取/替换。',
      parameters: {
        action: { type: 'string', description: 'test / extract / replace', required: true },
        pattern: { type: 'string', description: '正则模式', required: true },
        text: { type: 'string', description: '目标文本', required: true },
        flags: { type: 'string', description: '标志，如 gi' },
        replacement: { type: 'string', description: 'replace 用的替换串' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        try {
          const re = new RegExp(args.pattern, args.flags ?? '')
          if (args.action === 'test') return String(re.test(args.text))
          if (args.action === 'extract') {
            const ms = [...args.text.matchAll(re)].slice(0, 20)
            return ms.map(m => m[0] + (m[1] ? ` → ${m.slice(1).join(' | ')}` : '')).join('\n') || '（无匹配）'
          }
          return args.text.replace(re, args.replacement ?? '')
        } catch (e) { return `❌ ${e instanceof Error ? e.message : String(e)}` }
      },
    }),
    defineTool({
      name: 'util_csv',
      description: 'CSV 解析与查询：解析成表格，可过滤/统计。',
      parameters: {
        csv: { type: 'string', description: 'CSV 文本', required: true },
        query: { type: 'string', description: '可选：显示前 N 行（如 head 5）或全部' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        const rows = parseCsv(args.csv)
        if (rows.length === 0) return '（空）'
        const head = rows[0]!.map(h => h.trim())
        let body = rows.slice(1)
        if (args.query && /^head\s+(\d+)/.test(args.query)) {
          const n = Number(/^head\s+(\d+)/.exec(args.query)![1])
          body = body.slice(0, n)
        }
        const fmt = (r: string[]): string => r.map((c, i) => `${head[i] ?? i}:${c}`).join(' | ')
        return `共 ${rows.length - 1} 行，${head.length} 列\n${body.slice(0, 20).map(fmt).join('\n')}${body.length > 20 ? `\n…还有 ${body.length - 20} 行` : ''}`
      },
    }),
    defineTool({
      name: 'util_markdown',
      description: 'Markdown 转简易 HTML（标题/列表/粗体/斜体）。',
      parameters: {
        markdown: { type: 'string', description: 'Markdown 文本', required: true },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) {
        return mdToHtml(args.markdown)
      },
    }),
  ]
  for (const tool of tools) ctx.tools.register(tool)
  ctx.logger.info(`[dsh-utils] 已注册 ${tools.length} 个工具（时间/计算/JSON/编码/正则/CSV/Markdown）`)
}

