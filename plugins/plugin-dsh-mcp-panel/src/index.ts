/**
 * plugin-dsh-mcp-panel —— MCP 服务器管理面板。
 *
 * 能力：
 *   - 查看/添加/编辑/删除/启停 MCP 服务器（stdio 或 streamable-http）。
 *   - 通过 ctx.loader 动态挂载/卸载 `@deepseek-ai/dsh-mcp-client` 实例，无需重启。
 *   - 状态实时反映（connected / connecting / failed / disabled）。
 *   - 配置持久化到 $DSH_HOME/yitai-mcp/servers.json。
 *   - Web UI 面板：http://127.0.0.1:3890/
 *
 * 参考：PerryLink/dsh-mcp-panel（运行时管理面板）、Ceelog/dsh-plugin-setting-mcp（设置页管理）。
 */

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-mcp-client'

export const name = 'plugin-dsh-mcp-panel'
export const inject = ['loader']

export interface McpPanelConfig {
  /** 面板端口（默认 3890） */
  port?: number
  /** 配置持久化目录（默认 $DSH_HOME/yitai-mcp） */
  root?: string
}

/** 一个 MCP 服务器配置（兼容 mcp-client Config） */
export interface McpServerConfig {
  serverName: string
  enabled: boolean
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export function apply(ctx: Context, config: McpPanelConfig = {}) {
  const port = config.port ?? 3890
  const root = config.root ?? `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/yitai-mcp`
  const serversFile = join(root, 'servers.json')
  mkdirSync(root, { recursive: true })

  const loadServers = (): McpServerConfig[] => {
    try { return JSON.parse(readFileSync(serversFile, 'utf8')) as McpServerConfig[] } catch { return [] }
  }
  const saveServers = (servers: McpServerConfig[]): void => {
    writeFileSync(serversFile, JSON.stringify(servers, null, 2), 'utf8')
  }

  const servers = loadServers()

  /** 把 mcp-client 配置转成 loader entry 的 config */
  const toClientConfig = (s: McpServerConfig): Record<string, unknown> => {
    if (s.transport === 'stdio') {
      return {
        transport: 'stdio',
        serverName: s.serverName,
        command: s.command ?? '',
        args: s.args ?? [],
        env: s.env ?? {},
        cwd: s.cwd ?? '',
        toolCallTimeoutMs: s.toolCallTimeoutMs ?? 60000,
        failOnStartupError: false,
      }
    }
    return {
      transport: 'streamable-http',
      serverName: s.serverName,
      url: s.url ?? '',
      headers: s.headers ?? {},
      toolCallTimeoutMs: s.toolCallTimeoutMs ?? 60000,
      failOnStartupError: false,
    }
  }

  const entryId = (name: string): string => `mcp-${name}`

  /** 挂载一个启用的 MCP 服务器 */
  async function mountServer(s: McpServerConfig): Promise<void> {
    if (!s.enabled) return
    try {
      await ctx.loader.create({
        id: entryId(s.serverName),
        name: '@deepseek-ai/dsh-mcp-client',
        config: toClientConfig(s),
      })
      ctx.logger.info(`[mcp-panel] 已挂载 MCP 服务器: ${s.serverName}`)
    } catch (e) {
      ctx.logger.warn(`[mcp-panel] 挂载 MCP 失败 ${s.serverName}: ${String(e)}`)
    }
  }

  /** 卸载一个 MCP 服务器 */
  async function unmountServer(name: string): Promise<void> {
    try { await ctx.loader.remove(entryId(name)) } catch { /* 不存在则忽略 */ }
  }

  /** 获取服务器运行状态 */
  function getStatus(s: McpServerConfig): { status: string; detail?: string } {
    if (!s.enabled) return { status: 'disabled' }
    try {
      const entry = ctx.loader.resolve(entryId(s.serverName))
      const fiber = entry?.fiber
      if (!fiber) return { status: 'pending', detail: '未激活' }
      const st = fiber.state
      if (st === 2) return { status: 'connected', detail: '已连接' }
      if (st === 3) return { status: 'failed', detail: '连接失败' }
      if (st === 0) return { status: 'pending', detail: '连接中…' }
      return { status: 'unknown', detail: String(st) }
    } catch {
      return { status: 'pending', detail: '未挂载' }
    }
  }

  /** 全量同步：按配置挂载/卸载 */
  async function syncAll(): Promise<void> {
    for (const s of servers) {
      if (s.enabled) await mountServer(s)
      else await unmountServer(s.serverName)
    }
  }

  /* ============ HTTP 服务 ============ */

  const htmlCache = (() => {
    try { return readFileSync(join(__dirname, '../ui/index.html'), 'utf8') } catch { return null }
  })()

  const json = (res: ReturnType<typeof createServer> extends never ? never : any, code: number, data: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'

    if (url === '/' && method === 'GET') {
      if (htmlCache) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(htmlCache) }
      else { res.writeHead(404); res.end('panel not found') }
      return
    }

    if (url === '/api/servers' && method === 'GET') {
      json(res, 200, servers.map(s => ({ ...s, status: getStatus(s) })))
      return
    }

    if (url === '/api/servers' && method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        void (async () => {
          try {
            const s = JSON.parse(body || '{}') as McpServerConfig
            if (!s.serverName || !SERVER_NAME_RE.test(s.serverName)) { json(res, 400, { error: 'serverName 需为 1-32 位字母数字_-' }); return }
            if (servers.some(x => x.serverName === s.serverName)) { json(res, 409, { error: '已存在同名服务器' }); return }
            if (s.transport === 'stdio' && !s.command) { json(res, 400, { error: 'stdio 需要 command' }); return }
            if (s.transport === 'streamable-http' && !s.url) { json(res, 400, { error: 'streamable-http 需要 url' }); return }
            s.enabled = s.enabled !== false
            s.args = s.args ?? []; s.env = s.env ?? {}; s.cwd = s.cwd ?? ''
            s.headers = s.headers ?? {}; s.toolCallTimeoutMs = s.toolCallTimeoutMs ?? 60000
            servers.push(s); saveServers(servers)
            await mountServer(s)
            json(res, 200, { ...s, status: getStatus(s) })
          } catch (e) { json(res, 500, { error: String(e) }) }
        })()
      })
      return
    }

    const m = url.match(/^\/api\/servers\/([^/]+)(\/toggle)?$/)
    if (m) {
      const name = decodeURIComponent(m[1]!)
      const isToggle = m[2] === '/toggle'
      if (method === 'DELETE' && !isToggle) {
        void (async () => {
          const idx = servers.findIndex(s => s.serverName === name)
          if (idx < 0) { json(res, 404, { error: '未找到' }); return }
          await unmountServer(name)
          servers.splice(idx, 1); saveServers(servers)
          json(res, 200, { ok: true })
        })()
        return
      }
      if (method === 'PUT' && !isToggle) {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          void (async () => {
            try {
              const idx = servers.findIndex(s => s.serverName === name)
              if (idx < 0) { json(res, 404, { error: '未找到' }); return }
              const patch = JSON.parse(body || '{}') as Partial<McpServerConfig>
              const merged = { ...servers[idx]!, ...patch, serverName: name } as McpServerConfig
              servers[idx] = merged; saveServers(servers)
              await unmountServer(name)
              await mountServer(merged)
              json(res, 200, { ...merged, status: getStatus(merged) })
            } catch (e) { json(res, 500, { error: String(e) }) }
          })()
        })
        return
      }
      if (isToggle && method === 'POST') {
        void (async () => {
          const s = servers.find(x => x.serverName === name)
          if (!s) { json(res, 404, { error: '未找到' }); return }
          s.enabled = !s.enabled; saveServers(servers)
          if (s.enabled) await mountServer(s)
          else await unmountServer(name)
          json(res, 200, { ...s, status: getStatus(s) })
        })()
        return
      }
    }

    json(res, 404, { error: 'not found' })
  })

  ctx.effect(() => {
    server.listen(port, '127.0.0.1', () => {
      ctx.logger.info(`[mcp-panel] 🧩 MCP 面板: http://127.0.0.1:${port}/`)
    })
    void syncAll()
    return () => {
      server.close()
      for (const s of servers) void unmountServer(s.serverName)
    }
  })

  ctx.logger.info(`[mcp-panel] 已加载 ${servers.filter(s => s.enabled).length}/${servers.length} 个 MCP 服务器`)
}

