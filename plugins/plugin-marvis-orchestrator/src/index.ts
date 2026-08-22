/**
 * plugin-marvis-orchestrator —— 多Agent 1+5 多 Agent 办公室编排器。
 *
 * 复刻「多Agent办公室 v3」原型的服务器端实现：
 *   - 团队引擎：雷总管(调度) + 5 名专职员工，各自有工位/状态/任务。
 *   - Tick 心跳：空闲员工自主开始工作/思考/休息（白龙马 Tick 循环的 Cordis 事件化）。
 *   - 工具：marvis_dispatch（广播任务）/ marvis_status（查询团队状态）。
 *   - 可视化：本地 HTTP 服务托管 office 面板，WebSocket 实时推送团队事件。
 *   - 可选 liveDelegation：把子任务委托给 Harness 的 subagent（需 API Key）。
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
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-llm'
import { MarvisTeam, AGENTS } from './team.ts'
import { MeetingManager, type MeetingEvent, type SpeakerPolicy } from './meeting.ts'

export const name = 'plugin-marvis-orchestrator'

export const inject = ['tools', 'subagents', 'llm']

export interface MarvisConfig {
  /** 面板服务端口（默认 3888） */
  port?: number
  /** 自主模拟 tick 间隔 ms（默认 4200，0 关闭） */
  tickIntervalMs?: number
  /** 是否把任务真正委托给 Harness subagent（默认 false=模拟） */
  liveDelegation?: boolean
  /** subagent provider 名（默认 spawn） */
  subagentProvider?: string
  /** 每 Agent 独立模型/Provider（agent squad 能力，参考 toolclub/agent_team_gui） */
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

export interface MarvisTeamService {
  team: MarvisTeam
  dispatch(text: string): string
  status(): unknown
  getEventPort(): number
}

const __dirname = dirname(fileURLToPath(import.meta.url))

export function apply(ctx: Context, config: MarvisConfig = {}) {
  const port = config.port ?? 3888
  const tickInterval = config.tickIntervalMs ?? 4200
  const liveDelegation = config.liveDelegation ?? false

  /* ============ 团队引擎 ============ */

  const team = new MarvisTeam((event) => broadcastJSON(event))

  let clients = new Set<WebSocket>()

  function broadcastJSON(obj: unknown): void {
    const payload = JSON.stringify(obj)
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  /* ============ HTTP + WebSocket 服务 ============ */

  const htmlPath = join(__dirname, '../office/index.html')
  let htmlCache: string | null = null
  try {
    htmlCache = readFileSync(htmlPath, 'utf8')
  } catch (e) {
    ctx.logger.warn(`[marvis-office] 未找到 office/index.html: ${String(e)}`)
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
      // 支持子目录(如 vendor/three/three.module.js),防目录穿越
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(team.snapshot()))
      return
    }
    if (url === '/api/plugins') {
      const KNOWN: { name: string; description: string }[] = [
        { name: 'plugin-hello', description: '工作台管道自检（hello world）' },
        { name: 'plugin-bailongma-memory', description: '白龙马记忆系统（SQLite + FTS + 焦点栈）' },
        { name: 'plugin-marvis-orchestrator', description: '多Agent办公室编排器（本面板）' },
        { name: 'plugin-bailongma-voice', description: '语音 ASR/TTS（需 Provider Key）' },
        { name: 'plugin-bailongma-tokenjuice', description: 'Token 用量节流管理' },
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
      // 读取白龙马记忆库生成球形图谱节点与连线（读不到则返回空，由前端用演示节点兜底）
      let nodes: { _nid: string; label: string; type: string; salience: number; tags: string[]; entities: string[] }[] = []
      let links: { source: string; target: string }[] = []
      let typeCounts: Record<string, number> = {}
      try {
        const memRoot = `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/bailongma-memory`
        const db = new DatabaseSync(`${memRoot}/memory.db`)
        const rows = db.prepare(
          `SELECT mem_id, type, title, content, tags, entities, salience FROM memories WHERE visibility='visible' LIMIT 120`,
        ).all() as Record<string, unknown>[]
        const typeRows = db.prepare(`SELECT type, COUNT(*) AS n FROM memories WHERE visibility='visible' GROUP BY type`).all() as Record<string, unknown>[]
        for (const r of typeRows) typeCounts[String(r.type)] = Number(r.n)
        db.close()
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
        // 连线来源：1) 共享标签 2) 共享实体 3) 核心节点向孤立节点星型辐射
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
            // 同一组标签/实体下的记忆两两相连
            const members = nodes.filter(n => n.tags.includes(group[i]) || n.entities.includes(group[i]))
            for (let j = 0; j < members.length - 1; j++) {
              for (let k = j + 1; k < members.length; k++) {
                addLink(members[j]!._nid, members[k]!._nid)
              }
            }
          }
        }
        // 核心节点（salience 最高）向孤立节点星型辐射，保证没有孤岛
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
        const memRoot = `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/bailongma-memory`
        const db = new DatabaseSync(`${memRoot}/memory.db`)
        const memories = db.prepare(
          `SELECT mem_id, type, title, content, detail, entities, tags, salience, source_ref, created_at, updated_at, visibility FROM memories ORDER BY created_at`,
        ).all()
        db.close()
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
          const memRoot = `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/bailongma-memory`
          const db = new DatabaseSync(`${memRoot}/memory.db`)
          const now = new Date().toISOString()
          const arrOf = (v: unknown): string[] => {
            try { const t = JSON.parse(String(v || '[]')); return Array.isArray(t) ? t.map(String) : [] } catch { return [] }
          }
          const upsert = db.prepare(`
            INSERT INTO memories (mem_id, type, title, content, detail, entities, tags, salience, source_ref, created_at, updated_at, last_accessed, access_count, visibility)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mem_id) DO UPDATE SET
              type=excluded.type, title=excluded.title, content=excluded.content, detail=excluded.detail,
              entities=excluded.entities, tags=excluded.tags, salience=excluded.salience,
              source_ref=excluded.source_ref, updated_at=excluded.updated_at, visibility=excluded.visibility
          `)
          let inserted = 0
          for (const m of memories) {
            if (!m || typeof m !== 'object') continue
            const memId = (m as { _nid?: unknown; mem_id?: unknown })._nid || (m as { mem_id?: unknown }).mem_id
            if (!memId) continue
            upsert.run(
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
            )
            inserted++
          }
          db.close()
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
        try {
          const parsed = JSON.parse(body || '{}')
          const task = typeof parsed.task === 'string' ? parsed.task : '日常事务'
          team.dispatch(task)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, task }))
        } catch {
          res.writeHead(400)
          res.end('bad request')
        }
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
            const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : 'marvis'
            const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''
            if (!message) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'empty message' })); return }
            const reply = await chatWithAgent(agentId, message)
            // 面板上让该 agent 回显气泡
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
            // 留空/undefined 不修改(保护已配置的 key)
            const clean: any = {}
            for (const k of ['app_id', 'api_key', 'api_secret']) {
              if (p.xunfei[k] !== undefined && p.xunfei[k] !== null && p.xunfei[k] !== '') clean[k] = String(p.xunfei[k])
            }
            voiceConfig.xunfei = { ...voiceConfig.xunfei, ...clean }
          }
          if (p.minimax) {
            voiceConfig.minimax = { ...voiceConfig.minimax, ...p.minimax }
            if (p.minimax.api_key === '') voiceConfig.minimax.api_key = ''   // 显式清空
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
      const list = [...tasks.values()].map(taskJSON).sort((a, b) => b.createdAt - a.createdAt)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ tasks: list }))
      return
    }
    if (url === '/api/tasks' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const title = String(parsed.title || '').trim()
          if (!title) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'title required' })); return }
          let assignee = String(parsed.assignee || 'auto')
          // 自动派单:按任务内容关键词推断最合适的执行者(参考雷总管拆解)
          if (assignee === 'auto') {
            const text = title + ' ' + String(parsed.desc || '')
            if (/代码|开发|程序|脚本|bug|部署|接口|测试|修复|python|js/.test(text)) assignee = 'codex'
            else if (/claudecode|claude/.test(text)) assignee = 'claudecode'
            else if (/文档|PPT|课件|公文|纪要|报告|方案|总结|培训|word|docx/.test(text)) assignee = 'hermes'
            else if (/检索|查询|搜索|资料|调研|数据|信息|新闻|图表/.test(text)) assignee = 'hermes'
            else if (/图片|海报|设计|视频|音频|语音|图像/.test(text)) assignee = 'openhuma'
            else assignee = 'hermes'
          }
          const t: TaskItem = {
            id: taskId(), title,
            desc: String(parsed.desc || ''),
            assignee,
            status: 'todo', createdAt: Date.now(), updatedAt: Date.now(),
          }
          tasks.set(t.id, t)
          // 自动启动:指派给外部 agent 的任务创建后立即执行(不必手动点)
          if (t.assignee !== 'me') {
            void runTask(t)
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, task: taskJSON(t), autoStarted: t.assignee !== 'me' }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
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
            const t = tasks.get(tid)
            if (!t) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'task not found' })); return }
            const parsed = JSON.parse(body || '{}')
            if (action === 'run') {
              if (t.status !== 'todo') { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'only todo tasks can run' })); return }
              void runTask(t)   // 后台执行,完成后 status → review
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, task: taskJSON(t) }))
            } else if (action === 'approve') {
              if (t.status !== 'review') { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'only review tasks can be approved' })); return }
              t.status = 'done'; t.updatedAt = Date.now()
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, task: taskJSON(t) }))
            } else if (action === 'reject') {
              if (t.status !== 'review') { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'only review tasks can be rejected' })); return }
              t.status = 'todo'; t.comment = String(parsed.comment || '未通过验收'); t.updatedAt = Date.now()
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, task: taskJSON(t) }))
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
        // 办公室侧栏外部工作站:白龙马已移除(任务/会议仍可用)
        const agents = await Promise.all(EXTERNAL_AGENTS.filter(a => a.id !== 'bailongma').map(async a => ({
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
          void startGroupTurn(text)   // 后台触发 5 个 agent 回复
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
    // 连接即发送当前全量快照
    ws.send(JSON.stringify({ type: 'snapshot', ...team.snapshot(), timestamp: Date.now() }))
    // 面板可发 dispatch 消息派发任务
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data))
        if (msg?.type === 'dispatch' && typeof msg.task === 'string') {
          team.dispatch(msg.task)
        }
      } catch {
        // 忽略非法消息
      }
    })
    ws.on('close', () => clients.delete(ws))
  })

  /* ============ 资源生命周期（ctx.effect 保证卸载时清理） ============ */

  ctx.effect(() => {
    const tickTimer = tickInterval > 0 ? setInterval(() => team.tick(), tickInterval) : undefined
    server.listen(port, '127.0.0.1', () => {
      ctx.logger.info(`[marvis-office] 🏢 多Agent办公室面板: http://127.0.0.1:${port}/`)
    })
    return () => {
      if (tickTimer) clearInterval(tickTimer)
      wss.close()
      server.close()
    }
  })

  team.log('🏢 多Agent办公室上线，雷总管坐镇调度，6 名 AI 员工就位', 'sys')

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
      // 关闭思考，让 agent 直接快速回话（避免 reasoning 吃满预算无输出）
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

  ctx.logger.info(`[marvis-orchestrator] 🏢 会议室引擎就绪（speakerPolicy=${meetingCfg.speakerPolicy ?? 'round-robin'}）`)

  /* ============ 工具注册 ============ */

  /* ============ liveDelegation：角色 persona ============ */

  const ROLE_PERSONAS: Record<string, string> = {
    marvis: '你是雷总管，办公室主管。负责协调排期、汇总子任务结果，产出简洁的统筹报告。',
    file: '你是 File Agent，文件管理专家。负责读写、归档、检索与版本管理，直接操作文件并汇报路径。',
    computer: '你是 Computer Agent，电脑操作专家。负责桌面与系统级操作：运行脚本、处理本地资源、执行命令。',
    app: '你是 App Agent，应用调度专家。负责调用第三方应用/连接器，对接外部服务并返回结果。',
    zhuge: '你是诸葛雷，规划参谋。把模糊需求拆成可执行计划与问题链，输出结构化步骤清单。',
    find: '你是雷找找，检索专员。搜索引擎与知识库检索专家，找资料最快，输出带来源的检索摘要。',
  }

  /** 把一次 Agent 对话写入白龙马记忆库（type=dialog），让图谱球记录对话内容 */
  function saveChatMemory(agentId: string, agentName: string, userText: string, reply: string): void {
    try {
      const memRoot = `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/bailongma-memory`
      const db = new DatabaseSync(`${memRoot}/memory.db`)
      const now = new Date().toISOString()
      const memId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const q = userText.length > 40 ? userText.slice(0, 40) + '…' : userText
      db.prepare(`
        INSERT INTO memories (mem_id, type, title, content, detail, entities, tags, salience, source_ref, created_at, updated_at, last_accessed, access_count, visibility)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memId, 'dialog', `${agentName}：${q}`,
        `【你 → ${agentName}】${userText}\n【${agentName}】${reply}`,
        '', JSON.stringify([agentName, agentId]), JSON.stringify(['对话', agentName]),
        4, 'marvis-office-chat', now, now, null, 0, 'visible',
      )
      db.close()
    } catch { /* 记忆写入失败不影响对话 */ }
  }

  /**
   * Agent 智能对话：用角色 persona + Harness LLM 直接回话。
   * 让办公室里的 AI 员工能自我介绍、回答问题、接单讨论。
   */
  // ── 外部 A2A Agent(会议桌成员,与 meeting.ts 一致) ──
  const EXTERNAL_AGENTS: { id: string; name: string; role: string; url: string }[] = [
    { id: 'hermes', name: '爱马仕', role: '外部 · Hermes', url: 'http://127.0.0.1:9900' },
    { id: 'bailongma', name: '白龙马', role: '外部 · 白龙马', url: 'http://127.0.0.1:9910' },
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

  /** 雷总管本地拆解(不进 A2A):按关键词建议执行者 */
  function marvisDispatch(text: string): string {
    const t = String(text || '')
    let advice = ''
    if (/代码|开发|程序|脚本|bug|部署|接口|测试|修复/.test(t)) advice = '涉及代码开发 → 建议 Codex / ClaudeCode 主责执行，我派活后跟进验收。'
    else if (/文档|PPT|课件|公文|纪要|报告|方案|总结|培训/.test(t)) advice = '涉及文档产出 → 建议爱马仕(Hermes)主责起草，白龙马配合检索素材，我负责验收。'
    else if (/检索|查询|搜索|资料|调研|数据|信息|新闻/.test(t)) advice = '涉及信息检索 → 建议白龙马主责检索，ClaudeCode 辅助分析，我汇总验收。'
    else if (/图片|海报|设计|视频|音频|语音/.test(t)) advice = '涉及多媒体 → 建议 OpenHuman 主责，爱马仕协助排版，我验收质量。'
    else advice = '已接单，我来拆解分派给最合适的 Agent，执行后统一验收。'
    // 职责分工:群里只讨论,正式派活去任务看板
    return advice + '\n(正式派单请到 📋 任务看板：建任务→指派→自动验货→你审批)'
  }

  // 群聊上下文版本:agent 被防循环拦截时自动开新会话,保持群聊可用
  const groupCtxVer: Record<string, number> = {}
  function groupCtx(agentId: string): string {
    return `group:${agentId}:v${groupCtxVer[agentId] || 1}`
  }

  async function startGroupTurn(userText: string): Promise<void> {
    if (groupTurnPromise) return  // 上一轮未结束,忽略
    // 雷总管先接单(本地响应,不消耗外部 A2A 上下文)
    const title = String(userText || '').slice(0, 40)
    groupHistory.push({
      sender: 'marvis', name: '雷总管', role: 'agent',
      text: `收到「${title}」！${marvisDispatch(userText)}`, ts: Date.now(),
    })
    // 群聊成员:白龙马已移除(外部工作站/任务/会议仍可用)
    const groupMembers = EXTERNAL_AGENTS.filter(a => a.id !== 'bailongma')
    const jobs = groupMembers.map(async (a) => {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 120_000)
        const reply = await callExternalA2A(a.url, groupCtx(a.id), userText)
        clearTimeout(timer)
        // 防循环拦截 → 自动开新上下文重试一次
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
        clearTimeout((e as any)?.timer)
        groupHistory.push({ sender: a.id, name: a.name, role: 'agent',
          text: `[回复失败: ${String(e?.message ?? e).slice(0, 120)}]`, ts: Date.now() })
      }
    })
    groupTurnPromise = Promise.all(jobs).finally(() => { groupTurnPromise = null })
    // 不 await:调用方立即返回,前端轮询看到消息逐个出现
  }

  function groupBusyIds(): string[] {
    // 简化:有进行中的轮次时,外部 agent 都算"思考中"
    return groupTurnPromise ? EXTERNAL_AGENTS.map(a => a.id) : []
  }

  // ── 任务看板 + 审批(HiveWard 审批治理的轻量落地) ──
  // 状态机: todo(待办) → running(执行中) → review(待验收/审批) → done(完成)
  //          review 被驳回 → todo(带意见)
  interface TaskItem {
    id: string
    title: string
    desc: string
    assignee: string          // 外部 agent id 或 'me'
    status: 'todo' | 'running' | 'verifying' | 'review' | 'done'
    result?: string
    verifyReport?: string     // 验货员自动验收报告
    verifyPass?: boolean      // 自动验收是否通过
    comment?: string          // 驳回/验货意见
    createdAt: number
    updatedAt: number
  }
  // 验货员:有工具能力的外部 agent(能实际读文件/跑命令核实交付物)
  const VERIFIER_ID = 'codex'
  const VERIFIER = EXTERNAL_AGENTS.find(a => a.id === VERIFIER_ID)
  const tasks = new Map<string, TaskItem>()
  let taskSeq = 0

  function taskId(): string {
    taskSeq += 1
    return `T-${Date.now().toString(36).toUpperCase()}${taskSeq}`
  }

  function taskJSON(t: TaskItem) {
    const ext = EXTERNAL_AGENTS.find(a => a.id === t.assignee)
    return { ...t, assigneeName: ext ? ext.name : '我', assigneeUrl: ext?.url ?? null }
  }
  // 供 verifyTask 提示词使用的员工名
  function taskAssigneeName(t: TaskItem): string {
    const ext = EXTERNAL_AGENTS.find(a => a.id === t.assignee)
    return ext ? ext.name : '我'
  }

  /** 执行任务:调 assignee(A2A 或本地),完成后进入验货 */
  async function runTask(t: TaskItem): Promise<void> {
    t.status = 'running'
    t.updatedAt = Date.now()
    const ext = EXTERNAL_AGENTS.find(a => a.id === t.assignee)
    let reply: string
    if (ext) {
      reply = await callExternalA2A(ext.url, `task:${t.id}`, `【任务】${t.title}\n${t.desc}\n请执行并给出结果。`)
    } else {
      reply = '（未指定执行 Agent，请手动完成后标记验收）'
    }
    t.result = reply
    t.status = 'verifying'
    t.updatedAt = Date.now()
    // 自动验收:验货员 Agent 用工具实际核实交付物
    if (VERIFIER) {
      void verifyTask(t)
    } else {
      t.status = 'review'
    }
  }

  /**
   * 自动验收(参考白龙马 verifyDelivery):
   * 验货员 Agent 用工具(list_dir/read_file/exec)实际核实交付产物是否真实存在、内容是否匹配任务。
   * 必须给出可复核证据(文件路径/命令输出),没有证据判不通过。
   */
  async function verifyTask(t: TaskItem): Promise<void> {
    const prompt =
      `你是验货员。员工「${taskAssigneeName(t)}」针对任务「${t.title}」交付了以下内容。\n` +
      `请用工具(读文件/列目录/执行命令)实际核实交付产物是否真实存在、内容是否匹配任务。\n` +
      `规则:必须给出可复核的证据(文件路径/命令输出/运行结果);没有证据就判不通过。\n` +
      `返回格式:第一行只写"通过"或"不通过",随后列出证据。\n\n` +
      `【任务描述】${t.desc}\n【员工交付内容】${String(t.result || '').slice(0, 2000)}`
    try {
      const verdict = await callExternalA2A(VERIFIER!.url, `task:${t.id}:verify`, prompt)
      const v = String(verdict || '').trim()
      const failSignal = /不通过|未通过|不存在|无法验证|未找到|缺少(?:关键|交付|证据)/i.test(v)
      const passSignal = /^通过|通过。|通过\n|已确认|已验证|核实通过|ok\b/i.test(v)
      const pass = passSignal && !failSignal
      t.verifyReport = v.slice(0, 1200)
      t.verifyPass = pass
      t.comment = pass ? undefined : '自动验收未通过:' + v.slice(0, 200)
      t.status = pass ? 'review' : 'todo'
      t.updatedAt = Date.now()
    } catch (e: any) {
      // 验货失败不阻塞:直接进人工待验收,由用户判断
      t.verifyReport = `[验货调用失败:${String(e?.message ?? e).slice(0, 120)}]`
      t.verifyPass = undefined
      t.status = 'review'
      t.updatedAt = Date.now()
    }
  }

  // ── 知识图谱(参考白龙马 concept-extractor + knowledge-sphere) ──
  // 群聊 + 会议记录 → 中文 n-gram 概念抽取 → 主题词节点 + 共现链接
  const GRAPH_STOP_WORDS = new Set([
    '的','了','是','在','我','你','他','她','它','我们','你们','他们','这','那','有','没有',
    '和','与','把','被','因为','所以','如果','一个','一些','什么','怎么','为什么',
    '帮我','请','好的','明白','告诉','让','做','去','来','说','给','大家','你好','请问',
    '可以','应该','需要','进行','通过','工作','问题','现在','已经','还是','就是','一下',
    '大家好','我觉得','我认为','谢谢','哈哈','好的','收到','没错','可以','是的','嗯','哦',
  ])

  /** 中文 n-gram(2-4字)+ 英文词抽取,返回词频 Map */
  function extractConcepts(text: string): Map<string, number> {
    const freq = new Map<string, number>()
    const bump = (w: string) => {
      if (!w || w.length < 2 || GRAPH_STOP_WORDS.has(w)) return
      if (/^[\W_]+$/.test(w) || w.includes('**')) return   // 纯符号/星号噪声
      if (/^[a-zA-Z]$/.test(w)) return                      // 单字母
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
    // 数据源:群聊历史 + 会议记录(meetings.list())
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
      // 共现链接(前 5 个概念两两连)
      for (let i = 0; i < Math.min(5, concepts.length); i++) {
        for (let j = i + 1; j < Math.min(5, concepts.length); j++) {
          const a = concepts[i], b = concepts[j]
          const key = a < b ? a + '\u0000' + b : b + '\u0000' + a
          linkStrength.set(key, (linkStrength.get(key) || 0) + 1)
        }
      }
    })

    // 排序取前 N 节点
    const top = [...nodeFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    const topSet = new Set(top.map(([w]) => w))
    const nodes = top.map(([w, count]) => ({
      id: w, label: w, count,
      agents: [...(nodeAgents.get(w) || [])].slice(0, 4),
      r: 8 + Math.min(22, count * 3),
    }))
    const links = [...linkStrength.entries()]
      .map(([key, strength]) => {
        const [a, b] = key.split('\u0000')
        if (!topSet.has(a) || !topSet.has(b)) return null
        return { source: a, target: b, strength }
      })
      .filter((l): l is { source: string; target: string; strength: number } => l !== null)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 80)

    return { nodes, links, totalMessages: sources.length }
  }

  // ── 语音(参考白龙马 voice:tts-providers/cloud-asr) ──
  // 配置持久化到 office/voice-config.json;TTS 走 MiniMax / 豆包(方舟) API
  const VOICE_CONFIG_FILE = join(__dirname, '../office/voice-config.json')
  let voiceConfig: any = {
    tts_provider: 'browser',       // browser | minimax | doubao
    minimax: { api_key: '', group_id: '', model: 'speech-02-hd', voice: 'female-shaonv' },
    doubao: { api_key: '', model: 'doubao-tts-large-preview', voice: 'zh_female_xiaohe_uranus_bigtts' },
    asr_provider: 'browser',       // browser | xunfei
    xunfei: { app_id: '', api_key: '', api_secret: '' },
  }
  try {
    if (existsSync(VOICE_CONFIG_FILE)) {
      const saved = JSON.parse(readFileSync(VOICE_CONFIG_FILE, 'utf8'))
      voiceConfig = { ...voiceConfig, ...saved }
    }
  } catch { /* 配置损坏则用默认 */ }
  function saveVoiceConfig() {
    try { writeFileSync(VOICE_CONFIG_FILE, JSON.stringify(voiceConfig, null, 2), 'utf8') } catch (e) { console.warn('[marvis] voice config save failed:', String(e)) }
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

  // ── 科大讯飞 RTASR(实时语音转写,参考白龙马 cloud-asr.js createXunfeiSession) ──
  // (crypto 与 WebSocket 已在文件顶部引入)

  /**
   * 一次性 PCM → 讯飞 RTASR 转写(模拟流式:连接后按 chunk 发送,结束后拿全文)
   * 签名: signa = HMAC-SHA1(apiKey, MD5(appId + ts)) base64
   */
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
        const CHUNK = 1280          // 讯飞要求按帧发送(25ms @16k)
        const chunks: Buffer[] = []
        const parts: string[] = []
        const timer = setTimeout(() => { try { ws.close() } catch { /* noop */ } }, 30000)
        ws.on('open', () => {
          for (let i = 0; i < pcmBuffer.length; i += CHUNK) {
            ws.send(pcmBuffer.subarray(i, i + CHUNK))
          }
          // 发结束帧
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
    // 任何 HTTP 响应(含 4xx/5xx)都说明服务在线;只有连接拒绝/超时才算离线。
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
        // HTTP 错误码(404 等)说明服务在,继续
      }
    }
    return true
  }

  async function chatWithAgent(agentId: string, userText: string): Promise<string> {
    const ext = EXTERNAL_AGENTS.find(a => a.id === agentId)
    if (ext) {
      const reply = await callExternalA2A(ext.url, `ui:${ext.id}`, userText)
      saveChatMemory(agentId, ext.name, userText, reply)
      return reply
    }
    const def = AGENTS.find(a => a.id === agentId)
    if (!def) throw new Error(`unknown agent: ${agentId}`)
    const persona = ROLE_PERSONAS[agentId] ?? ROLE_PERSONAS.marvis
    const system = `${persona}\n\n你是「${def.name}（${def.role}）」——多Agent办公室里的 AI 员工。用户正在直接跟你对话。请以该身份用中文简洁、友好地回应。若用户让你自我介绍，请介绍你的职责和能力。`
    const text = await llmText(agentId, system, userText, 1000)
    saveChatMemory(agentId, def.name, userText, text)
    return text
  }

  /**
   * 真实委托：为每位被派员工 spawn 一个 harness subagent。
   * @returns 是否成功委托（false 表示回退模拟）
   */
  async function delegateLive(task: string, agentId: string, parent: unknown, signal: AbortSignal): Promise<boolean> {
    const subagents = ctx.subagents
    if (!subagents || !parent) return false
    try {
      const def = AGENTS.find(a => a.id === agentId)
      if (!def) return false
      const persona = ROLE_PERSONAS[agentId] ?? ROLE_PERSONAS.marvis
      const run = await subagents.start(config.subagentProvider ?? 'spawn', {
        request: {
          parent: parent as never,
          prompt: [{ type: 'text', text: `请以「${def.name}（${def.role}）」的身份执行子任务：${task}\n\n完成后用 3-5 句话汇报结果。` }],
          label: `marvis:${agentId}`,
          persona,
        },
        signal,
      })
      // 异步等待结果，完成时更新团队状态
      void run.result.then((result) => {
        const text = result.output.map(b => b.type === 'text' ? b.text : '').join('\n').trim()
        team.completeTask(agentId, task)
        team.log(`📦 ${def.name}（subagent）完成任务「${task}」：${text.slice(0, 120)}`, 'done')
      }).catch(() => {
        team.log(`⚠️ ${def.name}（subagent）子任务失败，已回退为模拟`, 'marvis')
      })
      return true
    } catch (e) {
      ctx.logger.warn(`[marvis-orchestrator] liveDelegation spawn 失败: ${String(e)}`)
      return false
    }
  }

  ctx.tools.register(defineTool({
    name: 'marvis_dispatch',
    description: '把任务广播给多Agent办公室：雷总管(调度)拆解并分派给下属员工执行。适合需要分工协作的复杂任务。',
    parameters: {
      task: { type: 'string', description: '要广播的任务描述', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const task = team.dispatch(args.task)
      // 真实委托模式：对被派员工 spawn subagent
      if (liveDelegation) {
        const parent = exec.agent
        if (parent && ctx.subagents) {
          // 派给当前非 CEO 员工（团队刚 dispatch 完，取 picking 名单）
          const pool = AGENTS.filter(a => a.id !== 'marvis')
          let delegated = 0
          for (const p of pool) {
            const s = team.get(p.id)
            if (s.status === 'working' && s.task === task) {
              const ok = await delegateLive(task, p.id, parent, exec.signal)
              if (ok) delegated++
            }
          }
          if (delegated > 0) {
            team.log(`🤖 已委托 ${delegated} 名 subagent 真实执行「${task}」`, 'sys')
            return `📣 已派发任务「${task}」并委托 ${delegated} 个 subagent 真实执行。`
          }
        }
        return `📣 已派发任务「${task}」（当前无可用 subagent 委托，办公室以模拟模式运转）。`
      }
      return `📣 已派发任务「${task}」，办公室开始运转。`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'marvis_status',
    description: '查询多Agent办公室当前状态：每位 AI 员工的状态、当前任务、累计完成数、最近日志。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const snap = team.snapshot()
      const lines = snap.agents.map(a => `- ${a.id}: ${a.status}${a.task !== '—' ? `「${a.task}」` : ''}（完成 ${a.done} 件）`)
      const logs = snap.logs.slice(0, 8).map(l => `  ${l.time} ${l.msg}`)
      return `团队状态（共完成 ${snap.doneCount} 件）：\n${lines.join('\n')}\n最近日志：\n${logs.join('\n')}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'marvis_ask',
    description: '向多Agent办公室里的某位 AI 员工提问并获取回答。员工各有分工：marvis(雷总管·调度)/file(文件管理)/computer(电脑操作)/app(应用调度)/zhuge(规划参谋)/find(检索专员)。适合让某个专职员工自我介绍、咨询其领域问题。',
    parameters: {
      agentId: { type: 'string', description: '员工 id：marvis/file/computer/app/zhuge/find', required: true },
      question: { type: 'string', description: '要问的问题', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const reply = await chatWithAgent(args.agentId, args.question)
      const name = AGENTS.find(a => a.id === args.agentId)?.name ?? args.agentId
      return `【${name}】${reply}`
    },
  }))

  /* ============ 多 Agent 会议室工具 ============ */

  /** 会议纪要写入白龙马记忆库（type=meeting，source_ref 标记会议室，便于按会议隔离检索） */
  function saveMeetingMinutes(meetingId: string, minutes: string): void {
    try {
      const room = meetings.get(meetingId)
      if (!room) return
      const memRoot = `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/bailongma-memory`
      const db = new DatabaseSync(`${memRoot}/memory.db`)
      const now = new Date().toISOString()
      const memId = `meeting_${meetingId}_${Date.now()}`
      db.prepare(`
        INSERT INTO memories (mem_id, type, title, content, detail, entities, tags, salience, source_ref, created_at, updated_at, last_accessed, access_count, visibility)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memId, 'meeting', `会议纪要：${room.title}`,
        minutes,
        `${room.title}\n参会者：${room.participants.map(p => p.name).join('、')}`,
        JSON.stringify(room.participants.map(p => p.id)),
        JSON.stringify(['会议', room.title]),
        5, `meeting:${meetingId}`, now, now, null, 0, 'visible',
      )
      db.close()
      ctx.logger.info(`[marvis-orchestrator] 📝 会议纪要已写入记忆库：${memId}`)
    } catch (e) {
      ctx.logger.warn(`[marvis-orchestrator] 纪要写入记忆库失败: ${String(e)}`)
    }
  }

  ctx.tools.register(defineTool({
    name: 'meeting_create',
    description: '创建多Agent会议室并邀请参会者。参会者 id 可用：bailongma(白龙马)/hermes(爱马仕)/openhuma(OpenHuman)/marvis(雷总管)/zhuge(诸葛雷)/file(文件)/computer(电脑)/app(应用)/find(检索)，多个用逗号分隔。',
    parameters: {
      title: { type: 'string', description: '会议主题', required: true },
      participants: { type: 'string', description: '参会者 id，逗号分隔（如 bailongma,hermes,openhuma）', required: true },
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
    description: '结束会议室，生成会议纪要并写入白龙马记忆库。',
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

  ctx.logger.info('[marvis-orchestrator] 已注册 marvis_dispatch / marvis_status / marvis_ask + 6 个会议室工具')

  /* ============ 服务暴露 ============ */

  const service: MarvisTeamService = {
    team,
    dispatch: (text) => team.dispatch(text),
    status: () => team.snapshot(),
    getEventPort: () => port,
  }
  ctx.provide('marvis.team', service)

  ctx.logger.info(`[marvis-orchestrator] 🏢 多Agent办公室就绪（liveDelegation=${liveDelegation}, port=${port}）`)
}

