/**
 * plugin-yitai-office —— 多Agent 1+5 多 Agent 办公室编排器（借鉴 dsh-agent-teams 重写）。
 *
 * 架构（模块化，借鉴 @nanmicoder/dsh-agent-teams）：
 *   - types.ts    : durable 办公室/任务/邮箱类型（依赖 DAG + attempt 能力）
 *   - state.ts    : 磁盘真相源（office.json + inbox/*.jsonl）+ per-office 锁 + 迁移规则
 *   - members.ts  : durable 可续聊 subagent 员工（persona + 工具过滤 + followup 唤醒）
 *   - scheduler.ts: 事件驱动调度器（agent/status idle → 认领 → 唤醒）
 *   - office.ts   : 办公室引擎门面（状态 + 调度 + 成员 + 可视化桥接）
 *   - team.ts     : 可视化工位/走动/气泡状态模型（demo 模式兜底）
 *   - meeting.ts  : 多 Agent 会议室引擎（保持不变）
 *
 * 本文件 = 组合层：HTTP/WS 办公室面板 + 工具注册 + 系统提示协议段 +
 *            /yitai 斜杠命令 + 会议/知识图谱/语音/群聊/A2A。
 */

import { createServer } from 'node:http'
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer, WebSocket } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-llm'
import { YitaiTeam, AGENTS } from './team.ts'
import { MeetingManager, type MeetingEvent, type SpeakerPolicy } from './meeting.ts'
import { createYitaiOffice, ROLE_PERSONAS, type YitaiOfficeApi } from './office.ts'
import type { YitaiTask, YitaiTaskStatus } from './types.ts'

export const name = 'plugin-yitai-office'

export const inject = ['tools', 'subagents', 'llm', 'agents', 'systemPrompt']

export interface YitaiConfig {
  /** 面板服务端口（默认 3888） */
  port?: number
  /** Harness Web UI 端口（默认 3080，注入到面板 HTML 的 iframe/状态栏） */
  harnessPort?: number
  /** 自主模拟 tick 间隔 ms（默认 4200，0 关闭） */
  tickIntervalMs?: number
  /** 是否把任务真正委托给 durable subagent 员工（默认 true） */
  liveDelegation?: boolean
  /** 是否允许真实成员缺省时走可视化模拟（默认 true） */
  demoMode?: boolean
  /** subagent provider 名（默认 spawn） */
  subagentProvider?: string
  /** 成员模型覆盖（可选） */
  memberModel?: string
  /** 办公室状态目录名（默认 .yitai-office） */
  stateDir?: string
  /** 办公室 id（默认 office） */
  officeId?: string
  /** 工作区目录（默认 process.cwd()） */
  workspace?: string
  /** 每 Agent 独立模型/Provider（agent squad 能力） */
  agents?: Record<string, { provider?: string; model?: string }>
  /** 全局模型/Provider 默认值 */
  llm?: { provider?: string; model?: string }
  /** 多 Agent 会议室引擎配置 */
  meeting?: {
    speakerPolicy?: SpeakerPolicy
    autoRounds?: number
    keepTurns?: number
    summarizeAfterChars?: number
  }
}

export interface YitaiTeamService {
  team: YitaiTeam
  office: YitaiOfficeApi
  dispatch(text: string): Promise<string>
  status(): Promise<unknown>
  getEventPort(): number
}

const __dirname = dirname(fileURLToPath(import.meta.url))

export function apply(ctx: Context, config: YitaiConfig = {}) {
  /* ============ 记忆库访问后端 ============
   * 优先注入 memory 插件提供的 yitai.memory 服务（同一 SQLite 连接、走 FTS/衰减逻辑）；
   * 缺省（单独挂载本插件时）回退直连 memory.db，兼容旧行为。 */
  interface MemoryBackend {
    queryAll(sql: string, params?: unknown[]): Record<string, unknown>[]
    upsertMemory(mem: {
      mem_id: string; content: string; type?: string; title?: string; detail?: string
      entities?: string[]; tags?: string[]; salience?: number; source_ref?: string
    }): unknown
  }
  const memoryService = ctx.get('yitai.memory') as { store?: MemoryBackend } | undefined
  let fallbackMemDb: DatabaseSync | null = null
  function memoryBackend(): MemoryBackend | null {
    if (memoryService?.store) return memoryService.store
    if (fallbackMemDb) return fallbackMemDb as unknown as MemoryBackend
    try {
      const memRoot = `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/yitai-memory`
      const db = new DatabaseSync(`${memRoot}/memory.db`)
      fallbackMemDb = db
      return {
        queryAll: (sql, params = []) => db.prepare(sql).all(...params) as Record<string, unknown>[],
        upsertMemory: (mem) => {
          const now = new Date().toISOString()
          db.prepare(`
            INSERT INTO memories (mem_id, type, title, content, detail, entities, tags, salience, source_ref, created_at, updated_at, last_accessed, access_count, visibility)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mem_id) DO UPDATE SET
              type=excluded.type, title=excluded.title, content=excluded.content, detail=excluded.detail,
              entities=excluded.entities, tags=excluded.tags, salience=excluded.salience,
              source_ref=excluded.source_ref, updated_at=excluded.updated_at, visibility=excluded.visibility
          `).run(
            mem.mem_id, mem.type ?? 'fact', mem.title ?? '', mem.content, mem.detail ?? '',
            JSON.stringify(mem.entities ?? []), JSON.stringify(mem.tags ?? []), mem.salience ?? 3,
            mem.source_ref ?? '', now, now, null, 0, 'visible',
          )
        },
      }
    } catch { return null }
  }

  const port = config.port ?? 3888
  const harnessPort = config.harnessPort ?? 3080
  const tickInterval = config.tickIntervalMs ?? 4200
  const liveDelegation = config.liveDelegation ?? true
  const demoMode = config.demoMode ?? true
  // 默认工作区 = 插件项目根（src → plugin → plugins → Myworkspace），避免污染 E:/deepseek-harness
  const workspace = config.workspace ?? dirname(dirname(dirname(__dirname)))

  /* ============ 可视化团队 + 办公室引擎 ============ */

  const team = new YitaiTeam((event) => broadcastJSON(event))

  let clients = new Set<WebSocket>()

  function broadcastJSON(obj: unknown): void {
    const payload = JSON.stringify(obj)
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  /** durable 办公室引擎：磁盘真相 + 事件调度 + durable 成员。 */
  const office = createYitaiOffice(ctx, team, (event) => broadcastJSON(event), {
    stateDir: config.stateDir ?? '.yitai-office',
    officeId: config.officeId ?? 'office',
    workspace,
    liveDelegation,
    demoMode,
  })

  // 异步初始化（office.json 落盘）；失败仅告警，不阻塞启动。
  void office.init().catch((error: unknown) => {
    ctx.logger.warn(`[yitai-office] 办公室状态初始化失败：${String(error)}`)
  })

  /* ============ HTTP + WebSocket 服务 ============ */

  const htmlPath = join(__dirname, '../office/index.html')
  let htmlCache: string | null = null
  try {
    // 运行时注入 Harness 端口占位符：改配置端口无需再同步改 HTML
    htmlCache = readFileSync(htmlPath, 'utf8').replaceAll('__HARNESS_PORT__', String(harnessPort))
  } catch (e) {
    ctx.logger.warn(`[yitai-office] 未找到 office/index.html: ${String(e)}`)
  }

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    if (url === '/' || url === '/office') {
      if (htmlCache) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(htmlCache)
      } else {
        res.writeHead(404)
        res.end('office page not found')
      }
      return
    }
    if (url === '/group-chat' || url === '/office/group-chat.html') {
      try {
        const body = readFileSync(join(__dirname, '../office/group-chat.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('group chat page not found')
      }
      return
    }
    // 静态资源：office 目录下的 js/map（knowledge-sphere.js 等）
    if (/\.(js|mjs|map)$/.test(url)) {
      const rel = url.replace(/^\//, '').replace(/\.\.\//g, '').replace(/\.\./g, '')
      const file = join(__dirname, '../office', rel)
      try {
        const body = readFileSync(file)
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
      return
    }
    if (url === '/api/status') {
      void office.snapshot().then((snap) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(snap))
      }).catch((e) => {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, error: String(e) }))
      })
      return
    }
    if (url === '/api/plugins') {
      const KNOWN: { name: string; description: string }[] = [
        { name: 'plugin-hello', description: '工作台管道自检（hello world）' },
        { name: 'plugin-yitai-memory', description: '易台记忆系统（SQLite + FTS + 焦点栈）' },
        { name: 'plugin-yitai-office', description: '多Agent办公室编排器（本面板）' },
        { name: 'plugin-yitai-voice', description: '语音 ASR/TTS（需 Provider Key）' },
        { name: 'plugin-yitai-tokenjuice', description: 'Token 用量节流管理' },
        { name: 'plugin-dsh-utils', description: '通用工具集（时间/计算/JSON/编码…）' },
        { name: 'plugin-dsh-mcp-panel', description: 'MCP 面板服务（端口 3890）' },
      ]
      const live = new Set<string>()
      try {
        ctx.registry.forEach((runtime) => { if (runtime.name) live.add(runtime.name) })
      } catch { /* 注册表不可用时视为全部未知 */ }
      const plugins = KNOWN.map(p => ({ ...p, status: live.has(p.name) ? 'online' : 'offline' }))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ plugins, total: plugins.length, live: plugins.filter(p => p.status === 'online').length }))
      return
    }

    if (url === '/api/knowledge') {
      // 读取易台记忆库生成球形图谱节点与连线（读不到则返回空，由前端用演示节点兜底）
      let nodes: { _nid: string; label: string; type: string; salience: number; tags: string[]; entities: string[] }[] = []
      let links: { source: string; target: string }[] = []
      let typeCounts: Record<string, number> = {}
      try {
        const db = memoryBackend()
        if (!db) throw new Error('memory db unavailable')
        const rows = db.queryAll(
          `SELECT mem_id, type, title, content, tags, entities, salience FROM memories WHERE visibility='visible' LIMIT 120`,
        ) as Record<string, unknown>[]
        const typeRows = db.queryAll(`SELECT type, COUNT(*) AS n FROM memories WHERE visibility='visible' GROUP BY type`) as Record<string, unknown>[]
        for (const r of typeRows) typeCounts[String(r.type)] = Number(r.n)
        const arrOf = (v: unknown): string[] => {
          try { const t = JSON.parse(String(v || '[]')); return Array.isArray(t) ? t.map(String) : [] } catch { return [] }
        }
        nodes = rows.map((r) => {
          const id = String(r.mem_id)
          const content = String(r.content ?? '')
          return {
            _nid: id,
            label: String(r.title || content || id).slice(0, 24),
            type: String(r.type || 'fact'),
            salience: Number(r.salience ?? 3),
            tags: arrOf(r.tags),
            entities: arrOf(r.entities),
          }
        })
        const seen = new Set<string>()
        const addLink = (a: string, b: string): void => {
          if (a === b) return
          const key = `${a}|${b}`
          const rev = `${b}|${a}`
          if (seen.has(key) || seen.has(rev)) return
          seen.add(key)
          links.push({ source: a, target: b })
        }
        const groups: string[][] = []
        for (const r of rows) {
          groups.push(arrOf(r.tags), arrOf(r.entities))
        }
        for (const group of groups) {
          for (let i = 0; i < group.length; i++) {
            const members = nodes.filter(n => n.tags.includes(group[i]) || n.entities.includes(group[i]))
            for (let j = 0; j < members.length - 1; j++) {
              for (let k = j + 1; k < members.length; k++) {
                addLink(members[j]!._nid, members[k]!._nid)
              }
            }
          }
        }
        if (nodes.length > 1) {
          const core = [...nodes].sort((a, b) => b.salience - a.salience)[0]!
          const linked = new Set<string>()
          for (const l of links) { linked.add(l.source); linked.add(l.target) }
          for (const n of nodes) {
            if (!linked.has(n._nid) && n._nid !== core._nid) addLink(core._nid, n._nid)
          }
        }
      } catch {
        nodes = []
        links = []
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ nodes, links, count: nodes.length, typeCounts }))
      return
    }
    if (url === '/api/knowledge/export') {
      try {
        const db = memoryBackend()
        if (!db) throw new Error('memory db unavailable')
        const memories = db.queryAll(
          `SELECT mem_id, type, title, content, detail, entities, tags, salience, source_ref, created_at, updated_at, visibility FROM memories ORDER BY created_at`,
        )
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ app: '多Agent办公室', exportedAt: new Date().toISOString(), memories }))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      }
      return
    }
    if (url === '/api/knowledge/import' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const memories = Array.isArray(parsed) ? parsed : (parsed.memories || parsed.nodes || [])
          if (!Array.isArray(memories) || memories.length === 0) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'empty data' }))
            return
          }
          const db = memoryBackend()
          if (!db) throw new Error('memory db unavailable')
          const now = new Date().toISOString()
          const arrOf = (v: unknown): string[] => {
            try { const t = JSON.parse(String(v || '[]')); return Array.isArray(t) ? t.map(String) : [] } catch { return [] }
          }
          const upsertSQL = `
            INSERT INTO memories (mem_id, type, title, content, detail, entities, tags, salience, source_ref, created_at, updated_at, last_accessed, access_count, visibility)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mem_id) DO UPDATE SET
              type=excluded.type, title=excluded.title, content=excluded.content, detail=excluded.detail,
              entities=excluded.entities, tags=excluded.tags, salience=excluded.salience,
              source_ref=excluded.source_ref, updated_at=excluded.updated_at, visibility=excluded.visibility
          `
          let inserted = 0
          for (const m of memories) {
            if (!m || typeof m !== 'object') continue
            const memId = (m as { _nid?: unknown; mem_id?: unknown })._nid || (m as { mem_id?: unknown }).mem_id
            if (!memId) continue
            db.queryAll(upsertSQL, [
              String(memId),
              String((m as { type?: unknown }).type || 'fact'),
              String((m as { title?: unknown; label?: unknown }).title || (m as { label?: unknown }).label || ''),
              String((m as { content?: unknown }).content || ''),
              String((m as { detail?: unknown }).detail || ''),
              JSON.stringify(Array.isArray((m as { entities?: unknown }).entities) ? (m as { entities: string[] }).entities : arrOf((m as { entities?: unknown }).entities)),
              JSON.stringify(Array.isArray((m as { tags?: unknown }).tags) ? (m as { tags: string[] }).tags : arrOf((m as { tags?: unknown }).tags)),
              Number((m as { salience?: unknown }).salience ?? 3),
              String((m as { source_ref?: unknown }).source_ref || 'imported'),
              String((m as { created_at?: unknown }).created_at || now),
              String((m as { updated_at?: unknown }).updated_at || now),
              null, 0,
              String((m as { visibility?: unknown }).visibility || 'visible'),
            ])
            inserted++
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, count: inserted }))
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      })
      return
    }

    if (url === '/api/dispatch' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body || '{}')
            const task = typeof parsed.task === 'string' ? parsed.task : '日常事务'
            // durable 任务入池；无队长时走可视化模拟
            const { task: created, delegated } = await office.dispatch(task)
            if (!delegated) playDemoFloor(task, created.id)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, task, taskId: created.id, delegated }))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          }
        })()
      })
      return
    }
    if (url === '/api/agent-chat' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body || '{}')
            const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : 'yitai'
            const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''
            if (!message) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'empty message' })); return }
            const reply = await chatWithAgent(agentId, message)
            team.say(agentId, reply.slice(0, 150))
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, agentId, reply }))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          }
        })()
      })
      return
    }
    if (url === '/api/voice-config' && req.method === 'GET') {
      const safe = {
        tts_provider: voiceConfig.tts_provider || 'browser',
        minimax: { model: voiceConfig.minimax?.model || '', voice: voiceConfig.minimax?.voice || '', has_key: !!voiceConfig.minimax?.api_key, has_group: !!voiceConfig.minimax?.group_id },
        doubao: { model: voiceConfig.doubao?.model || '', voice: voiceConfig.doubao?.voice || '', has_key: !!voiceConfig.doubao?.api_key },
        asr_provider: voiceConfig.asr_provider || 'browser',
        xunfei: {
          has_app: !!voiceConfig.xunfei?.app_id,
          has_key: !!voiceConfig.xunfei?.api_key,
          has_secret: !!voiceConfig.xunfei?.api_secret,
        },
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(safe))
      return
    }
    if (url === '/api/voice-config' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const p = JSON.parse(body || '{}')
          if (p.tts_provider) voiceConfig.tts_provider = String(p.tts_provider)
          if (p.asr_provider) voiceConfig.asr_provider = String(p.asr_provider)
          if (p.xunfei) {
            const clean: any = {}
            for (const k of ['app_id', 'api_key', 'api_secret']) {
              if (p.xunfei[k] !== undefined && p.xunfei[k] !== null && p.xunfei[k] !== '') clean[k] = String(p.xunfei[k])
            }
            voiceConfig.xunfei = { ...voiceConfig.xunfei, ...clean }
          }
          if (p.minimax) {
            voiceConfig.minimax = { ...voiceConfig.minimax, ...p.minimax }
            if (p.minimax.api_key === '') voiceConfig.minimax.api_key = ''
          }
          if (p.doubao) {
            voiceConfig.doubao = { ...voiceConfig.doubao, ...p.doubao }
            if (p.doubao.api_key === '') voiceConfig.doubao.api_key = ''
          }
          saveVoiceConfig()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      })
      return
    }
    if (url === '/api/tts' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const p = JSON.parse(body || '{}')
            const text = String(p.text || '').slice(0, 2000)
            if (!text) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'empty text' })); return }
            const provider = String(p.provider || voiceConfig.tts_provider || 'minimax')
            let audio: Buffer
            if (provider === 'doubao') {
              if (!voiceConfig.doubao?.api_key) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: '豆包未配置 API Key' })); return }
              audio = await doubaoTTS(text, voiceConfig.doubao)
            } else {
              if (!voiceConfig.minimax?.api_key || !voiceConfig.minimax?.group_id) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'MiniMax 未配置 API Key / GroupId' })); return }
              audio = await minimaxTTS(text, voiceConfig.minimax)
            }
            res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-voice-provider': provider })
            res.end(audio)
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          }
        })()
      })
      return
    }
    if (url === '/api/asr' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const p = JSON.parse(body || '{}')
            const b64 = String(p.audio || '')
            if (!b64) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'empty audio' })); return }
            const pcm = Buffer.from(b64, 'base64')
            if (pcm.length < 100) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'audio too short' })); return }
            const xf = voiceConfig.xunfei || {}
            if (!xf.app_id || !xf.api_key || !xf.api_secret) {
              res.writeHead(400); res.end(JSON.stringify({ ok: false, error: '讯飞 ASR 未配置(设置 → 语音 → 讯飞 AppId/Key/Secret)' })); return
            }
            const text = await xunfeiASR(pcm, xf)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, text }))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          }
        })()
      })
      return
    }

    if (url === '/api/knowledge-graph') {
      const g = buildKnowledgeGraph()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(g))
      return
    }
    if (url === '/api/tasks' && req.method === 'GET') {
      void office.state().then((st) => {
        const list = (st?.tasks ?? []).map(taskJSON).sort((a, b) => b.createdAt - a.createdAt)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ tasks: list }))
      }).catch((e) => {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e) }))
      })
      return
    }
    if (url === '/api/tasks' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body || '{}')
            const title = String(parsed.title || '').trim()
            if (!title) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'title required' })); return }
            let assignee = String(parsed.assignee || 'auto')
            if (assignee === 'auto') {
              const text = title + ' ' + String(parsed.desc || '')
              if (/代码|开发|程序|脚本|bug|部署|接口|测试|修复|python|js/.test(text)) assignee = 'codex'
              else if (/claudecode|claude/.test(text)) assignee = 'claudecode'
              else if (/文档|PPT|课件|公文|纪要|报告|方案|总结|培训|word|docx/.test(text)) assignee = 'hermes'
              else if (/检索|查询|搜索|资料|调研|数据|信息|新闻|图表/.test(text)) assignee = 'hermes'
              else if (/图片|海报|设计|视频|音频|语音|图像/.test(text)) assignee = 'openhuma'
              else assignee = 'hermes'
            }
            const ext = EXTERNAL_AGENTS.find(a => a.id === assignee)
            const t = await office.createTask({
              subject: title,
              description: String(parsed.desc || ''),
              assignee: ext ? assignee : (assignee === 'me' ? 'yitai' : assignee),
              extUrl: ext?.url ?? null,
            })
            if (ext) {
              void runTask(t)   // 仅外部 A2A agent 自动启动；员工/我走调度或手动
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, task: taskJSON(t), autoStarted: t.assignee !== 'yitai' }))
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          }
        })()
      })
      return
    }
    // /api/tasks/:id/:action  run | approve | reject
    if (url.startsWith('/api/tasks/') && req.method === 'POST') {
      const seg = url.split('/')
      const tid = seg[3], action = seg[4]
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const st = await office.state()
            const t = st?.tasks.find((x) => x.id === tid)
            if (!t) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'task not found' })); return }
            const parsed = JSON.parse(body || '{}')
            if (action === 'run') {
              if (t.status !== 'pending' && t.status !== 'failed') { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: '只有待办/失败任务可运行' })); return }
              void runTask(t)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, task: taskJSON(t) }))
            } else if (action === 'approve') {
              if (t.status !== 'review') { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'only review tasks can be approved' })); return }
              const attemptId = t.attemptId
              if (!attemptId) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'task has no active attempt' })); return }
              const done = await office.updateTask(t.id, attemptId, 'completed', t.output)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, task: taskJSON(done) }))
            } else if (action === 'reject') {
              if (t.status !== 'review') { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'only review tasks can be rejected' })); return }
              const rejected = await office.updateTask(t.id, t.attemptId ?? '', 'pending', t.output)
              await office.patchTask(t.id, { comment: String(parsed.comment || '未通过验收') })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, task: taskJSON(rejected) }))
            } else {
              res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
            }
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          }
        })()
      })
      return
    }
    if (url === '/api/ext-agents') {
      void (async () => {
        const agents = await Promise.all(EXTERNAL_AGENTS.map(async a => ({
          ...a, online: await checkExtHealth(a.url),
        })))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ agents }))
      })()
      return
    }
    if (url === '/api/group-chat' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ messages: groupHistory.slice(-200), busy: groupBusyIds() }))
      return
    }
    if (url === '/api/group-chat' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
          if (!text) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'empty' })); return }
          groupHistory.push({ sender: 'user', name: '我', role: 'user', text, ts: Date.now() })
          void startGroupTurn(text)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, busy: true }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      })
      return
    }
    if (url === '/api/meetings' || url.startsWith('/api/meetings/')) {
      const seg = url.split('/')
      const mid = seg[3]
      if (!mid) {
        const list = meetings.list().map(r => ({
          id: r.id, title: r.title, status: r.status, roundCount: r.roundCount,
          participants: r.participants.map(p => ({ id: p.id, name: p.name, role: p.role })),
          messageCount: r.transcript.length,
          last: r.transcript[r.transcript.length - 1]?.text ?? '',
          createdAt: r.createdAt,
        }))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ meetings: list }))
        return
      }
      const room = meetings.get(mid)
      if (!room) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'meeting not found' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        id: room.id, title: room.title, status: room.status, roundCount: room.roundCount,
        participants: room.participants.map(p => ({ id: p.id, name: p.name, role: p.role })),
        transcript: room.transcript,
        digest: room.digest,
        minutes: room.minutes ?? null,
      }))
      return
    }
    if (url === '/api/meeting' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const raw = parsed.participants
          const ids = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/)).map((s: unknown) => String(s).trim()).filter(Boolean)
          const room = meetings.create(String(parsed.title || '新会议'), ids, { autoRounds: Number(parsed.rounds ?? 2) })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, id: room.id, title: room.title, participants: room.participants.map(p => p.name) }))
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      })
      return
    }
    if (url.startsWith('/api/meeting/') && req.method === 'POST') {
      const seg = url.split('/')
      const mid = seg[3]
      const action = seg[4]
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body || '{}')
            if (action === 'round') {
              const tail = await meetings.round(mid, Number(parsed.turns ?? 1))
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, tail }))
            } else if (action === 'say') {
              const tail = await meetings.say(mid, String(parsed.text || ''))
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, tail }))
            } else if (action === 'end') {
              const minutes = await meetings.end(mid)
              saveMeetingMinutes(mid, minutes)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, minutes }))
            } else {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
            }
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          }
        })()
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.send(JSON.stringify({ type: 'snapshot', ...team.snapshot(), timestamp: Date.now() }))
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data))
        if (msg?.type === 'dispatch' && typeof msg.task === 'string') {
          void office.dispatch(msg.task).then(({ task: created, delegated }) => {
            if (!delegated) playDemoFloor(msg.task, created.id)
          })
        }
      } catch {
        // 忽略非法消息
      }
    })
    ws.on('close', () => clients.delete(ws))
  })

  /* ============ 资源生命周期（ctx.effect 保证卸载时清理） ============ */

  ctx.effect(() => {
    // tick 前先看办公室有没有待办任务：无任务时员工保持空闲（不做假装工作动画）
    const tickTimer = tickInterval > 0 ? setInterval(() => {
      void office.state().then((st) => {
        const hasTasks = st?.tasks.some(t => t.status === 'pending' || t.status === 'claimed' || t.status === 'in_progress' || t.status === 'review') ?? false
        team.tick(hasTasks)
      }).catch(() => team.tick(false))
    }, tickInterval) : undefined
    server.listen(port, '127.0.0.1', () => {
      ctx.logger.info(`[yitai-office] 🏢 多Agent办公室面板: http://127.0.0.1:${port}/`)
    })
    return () => {
      if (tickTimer) clearInterval(tickTimer)
      team.dispose()
      wss.close()
      server.close()
      try { fallbackMemDb?.close() } catch { /* noop */ }
    }
  })

  team.log('🏢 多Agent办公室上线（durable 引擎 + 事件调度），易总管坐镇调度，6 名 AI 员工就位', 'sys')

  /* ============ 会议室引擎（多 Agent 会议系统） ============ */

  const meetingCfg = config.meeting ?? {}

  /** 通用 LLM 文本生成（接 ctx.llm.stream + BlockAssembler；可按 agentId 选模型） */
  async function llmText(agentId: string | undefined, system: string, userText: string, maxTokens = 1000): Promise<string> {
    const agentLlm = agentId ? config.agents?.[agentId] : undefined
    const provider = agentLlm?.provider ?? config.llm?.provider ?? 'deepseek-official'
    const model = agentLlm?.model ?? config.llm?.model ?? 'deepseek-v4-flash'
    const assembler = new BlockAssembler()
    const options = {
      provider,
      model,
      system,
      reasoningEffort: 'off' as const,
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: userText }] }],
      maxTokens,
      signal: AbortSignal.timeout(60_000),
    }
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const blocks = assembler.blocks()
    const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    if (!text && assembler.finish?.kind === 'error') {
      throw new Error(`LLM 调用失败: ${JSON.stringify((assembler.finish as { failure?: unknown }).failure ?? {})}`)
    }
    return text
  }

  const meetings = new MeetingManager(
    (ev: MeetingEvent) => broadcastJSON(ev),
    async (opts) => llmText(opts.agentId, opts.persona, opts.userText, opts.maxTokens),
  )

  ctx.logger.info(`[yitai-orchestrator] 🏢 会议室引擎就绪（speakerPolicy=${meetingCfg.speakerPolicy ?? 'round-robin'}）`)

  /* ============ liveDelegation：角色 persona（来自 office.ts）+ 记忆 ============ */

  /** 把一次 Agent 对话写入易台记忆库（type=dialog），让图谱球记录对话内容 */
  function saveChatMemory(agentId: string, agentName: string, userText: string, reply: string): void {
    try {
      const backend = memoryBackend()
      if (!backend) return
      const memId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const q = userText.length > 40 ? userText.slice(0, 40) + '…' : userText
      backend.upsertMemory({
        mem_id: memId,
        type: 'dialog',
        title: `${agentName}：${q}`,
        content: `【你 → ${agentName}】${userText}\n【${agentName}】${reply}`,
        detail: '',
        entities: [agentName, agentId],
        tags: ['对话', agentName],
        salience: 4,
        source_ref: 'yitai-office-chat',
      })
    } catch { /* 记忆写入失败不影响对话 */ }
  }

  /**
   * Agent 智能对话：用角色 persona + Harness LLM 直接回话。
   * 让办公室里的 AI 员工能自我介绍、回答问题、接单讨论。
   */
  async function chatWithAgent(agentId: string, userText: string): Promise<string> {
    const ext = EXTERNAL_AGENTS.find(a => a.id === agentId)
    if (ext) {
      const reply = await callExternalA2A(ext.url, `ui:${ext.id}`, userText)
      saveChatMemory(agentId, ext.name, userText, reply)
      return reply
    }
    const def = AGENTS.find(a => a.id === agentId)
    if (!def) throw new Error(`unknown agent: ${agentId}`)
    const persona = ROLE_PERSONAS[agentId] ?? ROLE_PERSONAS.yitai
    const system = `${persona}\n\n你是「${def.name}（${def.role}）」——多Agent办公室里的 AI 员工。用户正在直接跟你对话。请以该身份用中文简洁、友好地回应。若用户让你自我介绍，请介绍你的职责和能力。`
    const text = await llmText(agentId, system, userText, 1000)
    saveChatMemory(agentId, def.name, userText, text)
    return text
  }

  /**
   * 可视化演示流：把 durable 任务投到办公室地板动画，动画结束后同步
   * office.finishDemoTask（demo 模式/UI 派发时走这条路径）。
   */
  function playDemoFloor(text: string, taskId: string): void {
    team.dispatch(text, (task) => {
      void office.finishDemoTask(taskId).catch((e) => {
        ctx.logger.warn(`[yitai-office] demo 任务完成同步失败：${String(e)}`)
      })
    })
  }

  // ── 外部 A2A Agent(会议桌成员,与 meeting.ts 一致) ──
  const EXTERNAL_AGENTS: { id: string; name: string; role: string; url: string }[] = [
    { id: 'hermes', name: '爱马仕', role: '外部 · Hermes', url: 'http://127.0.0.1:9900' },
    { id: 'claudecode', name: 'ClaudeCode', role: '外部 · 开发', url: 'http://127.0.0.1:9920' },
    { id: 'openhuma', name: 'OpenHuman', role: '外部 · 编排', url: 'http://127.0.0.1:9930' },
    { id: 'codex', name: 'Codex', role: '外部 · 编码', url: 'http://127.0.0.1:9940' },
  ]

  async function callExternalA2A(url: string, ctxId: string, text: string): Promise<string> {
    const payload = {
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { contextId: ctxId, message: { role: 'user', parts: [{ kind: 'text', text }] } },
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const res = await fetch(url + '/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return `[外部 agent HTTP ${res.status}]`
      const data: any = await res.json()
      const task = data?.result?.task ?? data?.result ?? {}
      const status = task.status ?? {}
      const msg = status.message ?? {}
      const reply = (msg.parts ?? []).map((p: any) => p.text ?? '').join('')
      return reply || '[外部 agent 返回空]'
    } catch (e: any) {
      clearTimeout(timer)
      return `[外部 agent 调用失败: ${String(e?.message ?? e).slice(0, 150)}]`
    }
  }

  // ── 群聊(微信群风格,5 个外部 agent + 用户) ──
  interface GroupMsg {
    sender: string      // 'user' 或 agent id
    name: string
    role: 'user' | 'agent'
    text: string
    ts: number
  }
  const groupHistory: GroupMsg[] = []
  let groupTurnPromise: Promise<void> | null = null
  const GROUP_TURN_TIMEOUT = 240_000

  /** 易总管本地拆解(不进 A2A):按关键词建议执行者 */
  function yitaiDispatch(text: string): string {
    const t = String(text || '')
    let advice = ''
    if (/代码|开发|程序|脚本|bug|部署|接口|测试|修复/.test(t)) advice = '涉及代码开发 → 建议 Codex / ClaudeCode 主责执行，我派活后跟进验收。'
    else if (/文档|PPT|课件|公文|纪要|报告|方案|总结|培训/.test(t)) advice = '涉及文档产出 → 建议爱马仕(Hermes)主责起草，易台配合检索素材，我负责验收。'
    else if (/检索|查询|搜索|资料|调研|数据|信息|新闻/.test(t)) advice = '涉及信息检索 → 建议易台主责检索，ClaudeCode 辅助分析，我汇总验收。'
    else if (/图片|海报|设计|视频|音频|语音/.test(t)) advice = '涉及多媒体 → 建议 OpenHuman 主责，爱马仕协助排版，我验收质量。'
    else advice = '已接单，我来拆解分派给最合适的 Agent，执行后统一验收。'
    return advice + '\n(正式派单请到 📋 任务看板：建任务→指派→自动验货→你审批)'
  }

  // 群聊上下文版本:agent 被防循环拦截时自动开新会话,保持群聊可用
  const groupCtxVer: Record<string, number> = {}
  function groupCtx(agentId: string): string {
    return `group:${agentId}:v${groupCtxVer[agentId] || 1}`
  }

  async function startGroupTurn(userText: string): Promise<void> {
    if (groupTurnPromise) return  // 上一轮未结束,忽略
    // 易总管先接单(本地响应,不消耗外部 A2A 上下文)
    const title = String(userText || '').slice(0, 40)
    groupHistory.push({
      sender: 'yitai', name: '易总管', role: 'agent',
      text: `收到「${title}」！${yitaiDispatch(userText)}`, ts: Date.now(),
    })
    // @ 定向：消息里 @了谁就只发给谁（支持 id 或中文名），没 @ 则广播全部
    let groupMembers = EXTERNAL_AGENTS
    const mentioned = new Set<string>()
    const mentionRe = /@([^\s@，。,。!！?？]+)/g
    let mm: RegExpExecArray | null
    while ((mm = mentionRe.exec(userText)) !== null) {
      const name = mm[1]!.toLowerCase()
      for (const a of EXTERNAL_AGENTS) {
        if (name === a.id || name === a.name.toLowerCase()
          || name === a.name.replace(/[^a-z0-9]/gi, '').toLowerCase()) mentioned.add(a.id)
      }
    }
    if (mentioned.size > 0) groupMembers = EXTERNAL_AGENTS.filter(a => mentioned.has(a.id))
    const jobs = groupMembers.map(async (a) => {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 120_000)
        const reply = await callExternalA2A(a.url, groupCtx(a.id), userText)
        clearTimeout(timer)
        if (/anti-loop|exceeded \d+ turns/i.test(reply)) {
          groupCtxVer[a.id] = (groupCtxVer[a.id] || 1) + 1
          const retry = await callExternalA2A(a.url, groupCtx(a.id), userText)
          groupHistory.push({
            sender: a.id, name: a.name, role: 'agent',
            text: retry + '\n(已自动切换新对话上下文)',
            ts: Date.now(),
          })
          return
        }
        groupHistory.push({ sender: a.id, name: a.name, role: 'agent', text: reply, ts: Date.now() })
      } catch (e: any) {
        groupHistory.push({ sender: a.id, name: a.name, role: 'agent',
          text: `[回复失败: ${String(e?.message ?? e).slice(0, 120)}]`, ts: Date.now() })
      }
    })
    groupTurnPromise = Promise.all(jobs).finally(() => { groupTurnPromise = null })
  }

  function groupBusyIds(): string[] {
    return groupTurnPromise ? EXTERNAL_AGENTS.map(a => a.id) : []
  }

  // ── 任务看板 + 审批（基于 durable office 任务） ──
  const UI_STATUS: Record<YitaiTaskStatus, string> = {
    pending: 'todo', claimed: 'running', in_progress: 'running', review: 'review',
    completed: 'done', failed: 'failed', cancelled: 'cancelled',
  }

  function taskJSON(t: YitaiTask) {
    const ext = EXTERNAL_AGENTS.find(a => a.id === t.assignee)
    return {
      id: t.id,
      title: t.subject,
      desc: t.description ?? '',
      assignee: t.assignee ?? 'yitai',
      status: UI_STATUS[t.status],
      result: t.output,
      verifyReport: t.verifyReport,
      verifyPass: t.verifyPass,
      comment: t.comment,
      dependencies: t.dependencies,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      assigneeName: ext ? ext.name : (t.assignee === 'yitai' ? '我' : t.assignee),
      assigneeUrl: ext?.url ?? null,
    }
  }

  /** 执行任务：队长代领 → 调 assignee（A2A 或本地）→ 进入待验收 */
  async function runTask(t: YitaiTask): Promise<void> {
    const ext = EXTERNAL_AGENTS.find(a => a.id === t.assignee)
    let attemptId: string
    try {
      attemptId = await office.claimTask(t.id, 'yitai')
    } catch { return }
    let reply: string
    if (ext) {
      try {
        await office.updateTask(t.id, attemptId, 'in_progress')
        reply = await callExternalA2A(ext.url, `task:${t.id}`, `【任务】${t.subject}\n${t.description ?? ''}\n请执行并给出结果。`)
      } catch (e: any) {
        reply = `[执行失败: ${String(e?.message ?? e).slice(0, 150)}]`
      }
    } else {
      reply = '（未指定执行 Agent，请手动完成后标记验收）'
    }
    await office.updateTask(t.id, attemptId, 'review', reply)
    if (VERIFIER) void verifyTask(t)
  }

  /**
   * 自动验收(参考易台 verifyDelivery):
   * 验货员 Agent 用工具(list_dir/read_file/exec)实际核实交付产物是否真实存在、内容是否匹配任务。
   */
  async function verifyTask(t: YitaiTask): Promise<void> {
    const attemptId = t.attemptId
    if (!attemptId) return
    const st = await office.state()
    const fresh = st?.tasks.find(x => x.id === t.id)
    if (!fresh || fresh.status !== 'review') return
    const ext = EXTERNAL_AGENTS.find(a => a.id === fresh.assignee)
    const prompt =
      `你是验货员。员工「${ext ? ext.name : fresh.assignee}」针对任务「${fresh.subject}」交付了以下内容。\n` +
      `请用工具(读文件/列目录/执行命令)实际核实交付产物是否真实存在、内容是否匹配任务。\n` +
      `规则:必须给出可复核的证据(文件路径/命令输出/运行结果);没有证据就判不通过。\n` +
      `返回格式:第一行只写"通过"或"不通过",随后列出证据。\n\n` +
      `【任务描述】${fresh.description ?? ''}\n【交付内容】${String(fresh.output || '').slice(0, 2000)}`
    try {
      const verdict = await callExternalA2A(VERIFIER!.url, `task:${t.id}:verify`, prompt)
      const v = String(verdict || '').trim()
      const failSignal = /不通过|未通过|不存在|无法验证|未找到|缺少(?:关键|交付|证据)/i.test(v)
      const passSignal = /^通过|通过。|通过\n|已确认|已验证|核实通过|ok\b/i.test(v)
      const pass = passSignal && !failSignal
      fresh.verifyReport = v.slice(0, 1200)
      fresh.verifyPass = pass
      fresh.comment = pass ? undefined : '自动验收未通过:' + v.slice(0, 200)
      if (!pass) {
        await office.updateTask(fresh.id, attemptId, 'pending', fresh.output)
      }
    } catch (e: any) {
      fresh.verifyReport = `[验货调用失败:${String(e?.message ?? e).slice(0, 120)}]`
      fresh.verifyPass = undefined
    }
  }

  // 验货员:有工具能力的外部 agent(能实际读文件/跑命令核实交付物)
  const VERIFIER_ID = 'codex'
  const VERIFIER = EXTERNAL_AGENTS.find(a => a.id === VERIFIER_ID)

  // ── 知识图谱(参考易台 concept-extractor + knowledge-sphere) ──
  // 群聊 + 会议记录 → 中文 n-gram 概念抽取 → 主题词节点 + 共现链接
  const GRAPH_STOP_WORDS = new Set([
    '的','了','是','在','我','你','他','她','它','我们','你们','他们','这','那','有','没有',
    '和','与','把','被','因为','所以','如果','一个','一些','什么','怎么','为什么',
    '帮我','请','好的','明白','告诉','让','做','去','来','说','给','大家','你好','请问',
    '可以','应该','需要','进行','通过','工作','问题','现在','已经','还是','就是','一下',
    '大家好','我觉得','我认为','谢谢','哈哈','收到','没错','是的','嗯','哦',
  ])

  /** 中文 n-gram(2-4字)+ 英文词抽取,返回词频 Map */
  function extractConcepts(text: string): Map<string, number> {
    const freq = new Map<string, number>()
    const bump = (w: string) => {
      if (!w || w.length < 2 || GRAPH_STOP_WORDS.has(w)) return
      if (/^[\W_]+$/.test(w) || w.includes('**')) return
      if (/^[a-zA-Z]$/.test(w)) return
      freq.set(w, (freq.get(w) || 0) + 1)
    }
    const cleaned = String(text || '')
      .replace(/[，。！？、；：""''【】\[\]()（）\d\s\n\r*#`_~|>\-]+/g, ' ')
      .trim()
    const chinese = cleaned.replace(/[a-zA-Z]+/g, ' ')
    for (let i = 0; i < chinese.length - 1; i++) {
      for (let len = 2; len <= 4 && i + len <= chinese.length; len++) {
        const seg = chinese.slice(i, i + len).trim()
        if (seg.length >= 2 && !seg.includes(' ')) bump(seg)
      }
    }
    const english = String(text || '').match(/[a-zA-Z]{3,}/g) || []
    for (const word of english) bump(word.toLowerCase())
    return freq
  }

  /** 构建图谱:节点(主题词)+ 链接(同消息共现) */
  function buildKnowledgeGraph(limit = 40) {
    const sources: { text: string; agent: string }[] = []
    groupHistory.forEach(m => sources.push({ text: m.text, agent: m.name }))
    try {
      const meetingList = meetings.list()
      ;(meetingList as any[]).forEach((mt: any) => {
        ;(mt.transcript ?? []).forEach((t: any) => {
          const who = t.senderName || t.sender || '会议'
          const txt = t.text || t.content || ''
          if (txt) sources.push({ text: txt, agent: who })
        })
      })
    } catch { /* 会议记录不可用则只用群聊 */ }

    const nodeFreq = new Map<string, number>()
    const nodeAgents = new Map<string, Set<string>>()
    const linkStrength = new Map<string, number>()
    const msgConcepts: { concepts: string[]; agent: string }[] = []

    sources.forEach(s => {
      const f = extractConcepts(s.text)
      const concepts = [...f.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w)
      if (!concepts.length) return
      msgConcepts.push({ concepts, agent: s.agent })
      concepts.forEach(w => {
        nodeFreq.set(w, (nodeFreq.get(w) || 0) + 1)
        if (!nodeAgents.has(w)) nodeAgents.set(w, new Set())
        nodeAgents.get(w)!.add(s.agent)
      })
      for (let i = 0; i < Math.min(5, concepts.length); i++) {
        for (let j = i + 1; j < Math.min(5, concepts.length); j++) {
          const a = concepts[i], b = concepts[j]
          const key = a < b ? a + '|' + b : b + '|' + a
          linkStrength.set(key, (linkStrength.get(key) || 0) + 1)
        }
      }
    })

    const top = [...nodeFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    const topSet = new Set(top.map(([w]) => w))
    const nodes = top.map(([w, count]) => ({
      id: w, label: w, count,
      agents: [...(nodeAgents.get(w) || [])].slice(0, 4),
      r: 8 + Math.min(22, count * 3),
    }))
    const links = [...linkStrength.entries()]
      .map(([key, strength]) => {
        const [a, b] = key.split('|')
        if (!topSet.has(a) || !topSet.has(b)) return null
        return { source: a, target: b, strength }
      })
      .filter((l): l is { source: string; target: string; strength: number } => l !== null)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 80)

    return { nodes, links, totalMessages: sources.length }
  }

  // ── 语音(参考易台 voice:tts-providers/cloud-asr) ──
  const VOICE_CONFIG_FILE = join(__dirname, '../office/voice-config.json')
  let voiceConfig: any = {
    tts_provider: 'browser',
    minimax: { api_key: '', group_id: '', model: 'speech-02-hd', voice: 'female-shaonv' },
    doubao: { api_key: '', model: 'doubao-tts-large-preview', voice: 'zh_female_xiaohe_uranus_bigtts' },
    asr_provider: 'browser',
    xunfei: { app_id: '', api_key: '', api_secret: '' },
  }
  try {
    if (existsSync(VOICE_CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(VOICE_CONFIG_FILE, 'utf8'))
      voiceConfig = { ...voiceConfig, ...saved }
    }
  } catch { /* 配置损坏则用默认 */ }
  function saveVoiceConfig() {
    try { writeFileSync(VOICE_CONFIG_FILE, JSON.stringify(voiceConfig, null, 2), 'utf8') } catch (e) { console.warn('[yitai] voice config save failed:', String(e)) }
  }

  /** 调 MiniMax TTS */
  async function minimaxTTS(text: string, cfg: any): Promise<Buffer> {
    const url = `https://api.minimaxi.com/v1/t2a_v2?GroupId=${cfg.group_id}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model || 'speech-02-hd',
        text,
        stream: false,
        voice_setting: { voice_id: cfg.voice || 'female-shaonv', speed: 1.0, vol: 1.0 },
        audio_setting: { format: 'mp3', sample_rate: 24000 },
      }),
    })
    if (!res.ok) throw new Error(`MiniMax TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data: any = await res.json()
    const audioBase64 = data?.data?.audio
    if (!audioBase64) throw new Error('MiniMax TTS 无音频返回')
    return Buffer.from(audioBase64, 'base64')
  }

  /** 调豆包(方舟)TTS */
  async function doubaoTTS(text: string, cfg: any): Promise<Buffer> {
    const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model || 'doubao-tts-large-preview',
        input: text,
        voice_type: cfg.voice || 'zh_female_xiaohe_uranus_bigtts',
        response_format: 'mp3',
        speed_ratio: 1.0,
      }),
    })
    if (!res.ok) throw new Error(`豆包 TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('豆包 TTS 无音频返回')
    return buf
  }

  // ── 科大讯飞 RTASR(实时语音转写) ──
  function xunfeiSign(appId: string, apiKey: string): { ts: string; signa: string } {
    const ts = Math.floor(Date.now() / 1000).toString()
    const md5Base = crypto.createHash('md5').update(appId + ts).digest('hex')
    const signa = crypto.createHmac('sha1', apiKey).update(md5Base).digest('base64')
    return { ts, signa }
  }

  function xunfeiASR(pcmBuffer: Buffer, cfg: { app_id: string; api_key: string; api_secret: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const { ts, signa } = xunfeiSign(cfg.app_id, cfg.api_key)
        const url = `wss://rtasr.xfyun.cn/v1/ws?appid=${cfg.app_id}&ts=${ts}&signa=${encodeURIComponent(signa)}&lang=cn`
        const ws = new WebSocket(url)
        const CHUNK = 1280
        const parts: string[] = []
        const timer = setTimeout(() => { try { ws.close() } catch { /* noop */ } }, 30000)
        ws.on('open', () => {
          for (let i = 0; i < pcmBuffer.length; i += CHUNK) {
            ws.send(pcmBuffer.subarray(i, i + CHUNK))
          }
          ws.send(JSON.stringify({ end: true }))
        })
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(String(data))
            if (msg.action === 'error') { clearTimeout(timer); reject(new Error(`讯飞错误: ${msg.desc || 'unknown'}`)); ws.close(); return }
            if (msg.action === 'result') {
              const parsed = JSON.parse(msg.data)
              const st = parsed?.cn?.st
              const text = (st?.rt || []).flatMap((r: any) => r.ws || []).flatMap((w: any) => w.cw || []).map((cw: any) => cw.w || '').join('')
              if (text) parts.push(text)
            }
          } catch { /* 非 JSON 帧忽略 */ }
        })
        ws.on('close', () => {
          clearTimeout(timer)
          resolve(parts.join('').trim() || '')
        })
        ws.on('error', (err) => { clearTimeout(timer); reject(new Error('讯飞连接失败: ' + err.message)) })
      } catch (e: any) {
        reject(new Error('讯飞 ASR 初始化失败: ' + String(e?.message ?? e)))
      }
    })
  }

  async function checkExtHealth(url: string): Promise<boolean> {
    for (const path of ['/health', '/']) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 4000)
        await fetch(url + path, { signal: controller.signal })
        clearTimeout(timer)
        return true
      } catch (e: any) {
        clearTimeout(timer)
        const isNetworkErr = e?.name === 'AbortError' || e?.cause?.code === 'ECONNREFUSED' || String(e).includes('fetch failed')
        if (isNetworkErr) return false
      }
    }
    return true
  }

  /* ============ 工具注册 ============ */

  /** 会议纪要写入易台记忆库（type=meeting，source_ref 标记会议室） */
  function saveMeetingMinutes(meetingId: string, minutes: string): void {
    try {
      const room = meetings.get(meetingId)
      if (!room) return
      const backend = memoryBackend()
      if (!backend) return
      const memId = `meeting_${meetingId}_${Date.now()}`
      backend.upsertMemory({
        mem_id: memId,
        type: 'meeting',
        title: `会议纪要：${room.title}`,
        content: minutes,
        detail: `${room.title}\n参会者：${room.participants.map(p => p.name).join('、')}`,
        entities: room.participants.map(p => p.id),
        tags: ['会议', room.title],
        salience: 5,
        source_ref: `meeting:${meetingId}`,
      })
      ctx.logger.info(`[yitai-orchestrator] 📝 会议纪要已写入记忆库：${memId}`)
    } catch (e) {
      ctx.logger.warn(`[yitai-orchestrator] 纪要写入记忆库失败: ${String(e)}`)
    }
  }

  ctx.tools.register(defineTool({
    name: 'yitai_dispatch',
    description: '把任务广播给多Agent办公室：易总管(调度)拆解并分派给下属员工执行。开启 liveDelegation 时员工为真实 durable subagent；否则为可视化模拟。适合需要分工协作的复杂任务。',
    parameters: {
      task: { type: 'string', description: '要广播的任务描述', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const { task, delegated } = await office.dispatch(args.task, exec.agent)
      if (!delegated) playDemoFloor(args.task, task.id)
      return delegated
        ? `📣 已派发任务「${task.subject}」（${task.id}）并委托 durable subagent 员工真实执行。`
        : `📣 已派发任务「${task.subject}」（${task.id}），办公室以模拟模式运转（无可用真实 subagent）。`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'yitai_status',
    description: '查询多Agent办公室当前状态：每位 AI 员工的状态、当前任务、累计完成数、任务板（含依赖/attempt）、最近日志与未读邮箱。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const snap = await office.snapshot()
      const lines = snap.agents.map(a => `- ${a.id}: ${a.status}${a.task !== '—' ? `「${a.task}」` : ''}（完成 ${a.done} 件）`)
      const taskLines = snap.tasks.slice(-10).map(t =>
        `  ${t.id} [${t.status}] ${t.subject}${t.assignee ? ` → ${t.assignee}` : ''}${t.dependencies.length ? ` (依赖:${t.dependencies.join(',')})` : ''}${t.attempt ? ` (attempt:${t.attempt})` : ''}`,
      )
      const logs = snap.logs.slice(0, 8).map(l => `  ${l.time} ${l.msg}`)
      const st = await office.state()
      let mailbox = ''
      if (st) {
        const captainMail = await office.readMailbox('captain')
        if (captainMail.length) mailbox = `\n📬 队长未读消息 ${captainMail.length} 条：\n${captainMail.slice(-3).map(m => `  [${m.from}] ${m.content.slice(0, 80)}`).join('\n')}`
      }
      return `团队状态（累计完成 ${snap.doneCount} 件）：\n${lines.join('\n')}\n任务板：\n${taskLines.join('\n') || '  （暂无任务）'}${mailbox}\n最近日志：\n${logs.join('\n')}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'yitai_claim_task',
    description: '（成员工具）领取一个任务。返回 attempt_id，之后的 yitai_update_task 必须携带它。队长/员工均可调用。',
    parameters: {
      taskId: { type: 'string', description: '任务 id（如 t1）', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = exec.agent ? exec.agent.id : 'yitai'
      const st = await office.state()
      const memberName = st?.members.find(m => m.id === caller)?.name ?? 'yitai'
      const attemptId = await office.claimTask(String(args.taskId), memberName)
      return `已认领任务 ${args.taskId}。attempt_id=${attemptId}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'yitai_update_task',
    description: '（成员工具）携带当前 attempt_id 推进任务状态：in_progress / completed / failed。stale attempt 会拒绝（任务已被转派/接管）。',
    parameters: {
      taskId: { type: 'string', description: '任务 id', required: true },
      attemptId: { type: 'string', description: '认领时返回的 attempt_id', required: true },
      status: { type: 'string', description: '目标状态：in_progress / completed / failed / review', required: true },
      output: { type: 'string', description: '完成/失败时的结果说明' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const status = String(args.status)
      if (!['in_progress', 'completed', 'failed', 'review'].includes(status)) {
        throw new Error(`不支持的状态：${status}`)
      }
      const t = await office.updateTask(
        String(args.taskId),
        String(args.attemptId),
        status as YitaiTaskStatus,
        args.output !== undefined ? String(args.output) : undefined,
      )
      return `任务 ${t.id} → ${t.status}${t.output ? `\n输出：${t.output.slice(0, 200)}` : ''}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'yitai_reassign_task',
    description: '（队长工具）转派任务：安全接管/重新分配。使旧 attempt 失效，等待旧执行者安静后重新调度。assignee 可为员工 id（file/computer/app/zhuge/find）或 captain。',
    parameters: {
      taskId: { type: 'string', description: '任务 id', required: true },
      to: { type: 'string', description: '目标执行者：file/computer/app/zhuge/find/captain', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const t = await office.reassignTask(String(args.taskId), String(args.to))
      await office.kick()
      return `任务 ${t.id} 已转派给 ${t.assignee}，调度器将重新派发。`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'yitai_send_message',
    description: '成员/队长互发消息：写入 durable 邮箱并唤醒收件成员。to 可为员工 id（file/computer/app/zhuge/find）或 captain。',
    parameters: {
      to: { type: 'string', description: '收件人：员工 id 或 captain', required: true },
      content: { type: 'string', description: '消息内容', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const caller = exec.agent ? exec.agent.id : 'yitai'
      const st = await office.state()
      const from = st?.members.find(m => m.id === caller)?.name ?? 'yitai'
      await office.sendMessage(from, String(args.to), String(args.content))
      return `已发送消息：${from} → ${args.to}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'yitai_create_task',
    description: '（队长工具）在办公室任务板上创建任务，支持依赖（dependencies）与指派（assignee）。适合把复杂目标拆解为多个带依赖的子任务。',
    parameters: {
      subject: { type: 'string', description: '任务标题', required: true },
      description: { type: 'string', description: '任务详情' },
      assignee: { type: 'string', description: '执行者：file/computer/app/zhuge/find 或外部 agent id（codex/hermes/…），缺省共享池' },
      dependencies: { type: 'array', items: { type: 'string' }, description: '必须先完成的任务 id 列表' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const deps = Array.isArray(args.dependencies) ? args.dependencies.map(String) : []
      const t = await office.createTask({
        subject: String(args.subject),
        description: args.description !== undefined ? String(args.description) : undefined,
        assignee: args.assignee !== undefined ? String(args.assignee) : undefined,
        dependencies: deps,
      })
      await office.kick()
      return `已创建任务 ${t.id}「${t.subject}」（${t.status}${t.dependencies.length ? `，依赖 ${t.dependencies.join(',')}` : ''}），调度器已触发。`
    },
  }))

  /* ============ 多 Agent 会议室工具 ============ */

  ctx.tools.register(defineTool({
    name: 'meeting_create',
    description: '创建多Agent会议室并邀请参会者。参会者 id 可用：yitai(易台)/hermes(爱马仕)/openhuma(OpenHuman)/yitai(易总管)/zhuge(诸葛)/file(文件)/computer(电脑)/app(应用)/find(检索)，多个用逗号分隔。',
    parameters: {
      title: { type: 'string', description: '会议主题', required: true },
      participants: { type: 'string', description: '参会者 id，逗号分隔（如 yitai,hermes,openhuma）', required: true },
      rounds: { type: 'number', description: '用户发言后自动讨论轮数（默认 2）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const ids = String(args.participants).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
      const room = meetings.create(String(args.title), ids, { autoRounds: Number(args.rounds ?? meetingCfg.autoRounds ?? 2) })
      return `🏢 已创建会议室「${room.title}」（${room.id}）\n参会者：${room.participants.map(p => `${p.name}(${p.role})`).join('、')}\n\n下一步：用 meeting_say(meetingId, 议题) 发言开始讨论，或 meeting_round(meetingId) 驱动一轮讨论。`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meeting_say',
    description: '在指定会议室发言，随后自动驱动若干轮 AI 讨论。',
    parameters: {
      meetingId: { type: 'string', description: '会议室 id', required: true },
      text: { type: 'string', description: '发言内容', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const tail = await meetings.say(String(args.meetingId), String(args.text))
      return `🗣 已发言，AI 员工讨论如下：\n${tail}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meeting_round',
    description: '驱动会议室讨论若干轮（每轮由一位参会者发言，自动或轮流）。',
    parameters: {
      meetingId: { type: 'string', description: '会议室 id', required: true },
      turns: { type: 'number', description: '轮数（默认 1）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const tail = await meetings.round(String(args.meetingId), Number(args.turns ?? 1))
      return `🔁 讨论完成：\n${tail}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meeting_end',
    description: '结束会议室，生成会议纪要并写入易台记忆库。',
    parameters: {
      meetingId: { type: 'string', description: '会议室 id', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const minutes = await meetings.end(String(args.meetingId))
      saveMeetingMinutes(String(args.meetingId), minutes)
      return minutes
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meeting_status',
    description: '查看会议室列表，或指定会议室的状态、参会者、摘要与最近讨论。',
    parameters: {
      meetingId: { type: 'string', description: '会议室 id（可选，不填则列出全部）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return meetings.statusText(args.meetingId ? String(args.meetingId) : undefined)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'meeting_minutes',
    description: '查看已结束会议的纪要。',
    parameters: {
      meetingId: { type: 'string', description: '会议室 id', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return meetings.formatMinutes(String(args.meetingId))
    },
  }))

  ctx.logger.info('[yitai-orchestrator] 已注册 yitai_dispatch / yitai_status / yitai_claim_task / yitai_update_task / yitai_reassign_task / yitai_send_message / yitai_create_task + 6 个会议室工具')

  /* ============ 系统提示：Yitai 办公室使用协议 ============ */

  ctx.systemPrompt.section({
    name: 'yitai-orchestrator:usage',
    order: 118,
    text: `当用户要求用 Yitai 多Agent办公室处理任务（例如"用 Yitai 办公室做 X"），或收到 /yitai 激活指令时，你就是易总管（队长）。遵循如下协议：
1. 调用 yitai_dispatch 广播任务；你成为队长，负责拆解、分派、验收。
2. 复杂目标用 yitai_create_task 拆成带 dependencies 的子任务，指派给合适的员工（file/computer/app/zhuge/find）或外部 agent。
3. 用 yitai_status 监控团队与任务板；空闲成员会由共享调度器自动认领 ready 任务并唤醒。
4. 工作被阻塞/停滞需要转派时，先调用 yitai_reassign_task（assignee=captain 表示你接管）。
5. 任务携带 attempt_id：成员用 yitai_claim_task 领取并拿到 attempt_id，之后每次 yitai_update_task 都带上；stale-attempt 拒绝 = 任务已转派，停止。
6. 成员间/成员→队长用 yitai_send_message 直达邮箱并唤醒对方。
7. 汇总团队成员结果呈现给用户。需要多人讨论时用 meeting_create/say/round 开会。`,
  })

  /* ============ /yitai 斜杠命令（确定性激活） ============ */

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'yitai',
      description: 'run a goal with the Yitai multi-agent office (you become the 易总管/captain)',
      input: { hint: '<goal — 要办公室完成的目标>' },
      handler(invocation) {
        const goal = invocation.rawInput.trim()
        if (goal === '') {
          return { kind: 'error', text: '用法：/yitai <goal — 要办公室完成的目标>' }
        }
        invocation.agent.followup(createUserMessage({
          content: [{ type: 'text', text: `/yitai${invocation.rawInput}` }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: `Yitai 办公室已激活 — 易总管将为目标拆解并派发：${goal}` }
      },
    }), 'yitai: slash command')
  })

  /* ============ 服务暴露 ============ */

  const service: YitaiTeamService = {
    team,
    office,
    dispatch: (text) => office.dispatch(text).then(({ task }) => task.id),
    status: () => office.snapshot(),
    getEventPort: () => port,
  }
  ctx.provide('yitai.team', service)

  ctx.logger.info(`[yitai-orchestrator] 🏢 多Agent办公室就绪（liveDelegation=${liveDelegation}, demoMode=${demoMode}, port=${port}, state=${workspace}/.yitai-office）`)
}
