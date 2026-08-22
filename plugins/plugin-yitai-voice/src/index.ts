/**
 * plugin-yitai-voice —— 易台语音栈迁移（TTS 部分）。
 *
 * 能力：
 *   - TTS Provider 抽象：doubao（豆包）/ minimax / openai / elevenlabs / volcano（火山引擎）。
 *   - speak 工具：文本 → 语音，生成音频文件并通过本地 HTTP 提供 URL。
 *   - /audio/:id 静态服务 + /api/tts-config 状态查询。
 *   - ASR 预留：/api/asr-config 返回配置要求（云端 ASR 需要 WebSocket + 服务商 Key）。
 *
 * 配置示例（cordis.patch.yml）：
 *   config:
 *     port: 3889
 *     provider: openai
 *     openai:
 *       apiKey: sk-xxx
 *       voice: nova
 */

import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'plugin-yitai-voice'
export const inject = ['tools']

export interface VoiceConfig {
  port?: number
  provider?: string
  /** 数据目录（默认 $DSH_HOME/yitai-voice） */
  root?: string
  openai?: { apiKey?: string; baseURL?: string; voice?: string }
  doubao?: { apiKey?: string; voice?: string }
  minimax?: { apiKey?: string; voice?: string; groupId?: string }
  elevenlabs?: { apiKey?: string; voice?: string }
  volcano?: { appId?: string; token?: string; voice?: string }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 提供商的默认音色 */
const DEFAULT_VOICES: Record<string, string> = {
  openai: 'nova',
  doubao: 'zh_female_xiaohe_uranus_bigtts',
  minimax: 'female-shaonv',
  elevenlabs: '21m00Tcm4TlvDq8ikWAM',
  volcano: 'BV001_streaming',
}

export function apply(ctx: Context, config: VoiceConfig = {}) {
  const port = config.port ?? 3889
  const provider = config.provider ?? ''
  const root = config.root ?? `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/yitai-voice`
  const audioDir = join(root, 'audio')
  mkdirSync(audioDir, { recursive: true })

  const voiceOf = (p: string): string => {
    const map: Record<string, string | undefined> = {
      openai: config.openai?.voice,
      doubao: config.doubao?.voice,
      minimax: config.minimax?.voice,
      elevenlabs: config.elevenlabs?.voice,
      volcano: config.volcano?.voice,
    }
    return map[p] ?? DEFAULT_VOICES[p] ?? ''
  }

  const apiKeyOf = (p: string): string => {
    const map: Record<string, string | undefined> = {
      openai: config.openai?.apiKey,
      doubao: config.doubao?.apiKey,
      minimax: config.minimax?.apiKey,
      elevenlabs: config.elevenlabs?.apiKey,
    }
    return map[p] ?? ''
  }

  /** 合成前预检：返回缺什么 */
  function checkProvider(p: string): { ok: boolean; message: string } {
    if (!p) return { ok: false, message: '未配置 TTS 提供商。请在插件 config 里设置 provider: openai/doubao/minimax/elevenlabs/volcano。' }
    if (p === 'volcano') {
      if (!config.volcano?.appId || !config.volcano?.token) {
        return { ok: false, message: '火山引擎需要 appId 和 token。' }
      }
    } else if (!apiKeyOf(p)) {
      return { ok: false, message: `${p} 需要 apiKey。` }
    }
    return { ok: true, message: 'ok' }
  }

  /** 调用 provider TTS，返回音频 Buffer */
  async function synthesize(p: string, text: string): Promise<Buffer> {
    const voice = voiceOf(p)
    if (p === 'openai') {
      const base = config.openai?.baseURL ?? 'https://api.openai.com/v1'
      const res = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKeyOf(p)}` },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: text, voice, response_format: 'mp3' }),
      })
      if (!res.ok) throw new Error(`openai TTS ${res.status}: ${await res.text()}`)
      return Buffer.from(await res.arrayBuffer())
    }
    if (p === 'doubao') {
      // 豆包方舟 TTS
      const res = await fetch('https://openspeech.bytedance.com/api/v3/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer; ${apiKeyOf(p)}` },
        body: JSON.stringify({ app: { appid: apiKeyOf(p) }, user: { uid: 'yitai' }, audio: { voice_type: voice, encoding: 'mp3', speed_ratio: 1.0 }, request: { reqid: randomUUID(), text, operation: 'query' } }),
      })
      if (!res.ok) throw new Error(`doubao TTS ${res.status}: ${await res.text()}`)
      return Buffer.from(await res.arrayBuffer())
    }
    if (p === 'minimax') {
      const res = await fetch(`https://api.minimax.chat/v1/t2a_v2?GroupId=${config.minimax?.groupId ?? ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKeyOf(p)}` },
        body: JSON.stringify({ model: 'speech-01-hd', text, voice_setting: { voice_id: voice, speed: 1.0 } }),
      })
      if (!res.ok) throw new Error(`minimax TTS ${res.status}: ${await res.text()}`)
      const json = await res.json() as { audio_base64?: string }
      if (!json.audio_base64) throw new Error('minimax TTS 无 audio_base64')
      return Buffer.from(json.audio_base64, 'base64')
    }
    if (p === 'elevenlabs') {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': apiKeyOf(p) },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      })
      if (!res.ok) throw new Error(`elevenlabs TTS ${res.status}: ${await res.text()}`)
      return Buffer.from(await res.arrayBuffer())
    }
    if (p === 'volcano') {
      throw new Error('火山引擎 TTS 需要按文档构造签名请求，暂未内置；建议用 openai/minimax/doubao。')
    }
    throw new Error(`未知 TTS 提供商: ${p}`)
  }

  /* ============ HTTP 服务（音频 + 状态） ============ */

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Yitai Voice Service\nGET /api/tts-config\nGET /audio/:id\n')
      return
    }
    if (url === '/api/tts-config') {
      const check = checkProvider(provider)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ provider, ready: check.ok, guide: check.message, voice: voiceOf(provider), voices: Object.keys(DEFAULT_VOICES) }))
      return
    }
    if (url.startsWith('/audio/')) {
      const name = url.slice('/audio/'.length)
      const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '')
      const file = join(audioDir, safe)
      if (existsSync(file)) {
        const type = extname(file) === '.mp3' ? 'audio/mpeg' : 'audio/wav'
        res.writeHead(200, { 'content-type': type })
        res.end(readFileSync(file))
      } else {
        res.writeHead(404)
        res.end('audio not found')
      }
      return
    }
    res.writeHead(404)
    res.end()
  })

  ctx.effect(() => {
    server.listen(port, '127.0.0.1', () => {
      ctx.logger.info(`[yitai-voice] 🔊 语音服务: http://127.0.0.1:${port}/`)
    })
    return () => server.close()
  })

  /* ============ speak 工具 ============ */

  ctx.tools.register(defineTool({
    name: 'speak',
    description: '把文本合成为语音（TTS），返回音频 URL。用于朗读回复、语音通知、播报等。',
    parameters: {
      text: { type: 'string', description: '要朗读的文本', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const check = checkProvider(provider)
      if (!check.ok) return `❌ ${check.message}`
      try {
        const audio = await synthesize(provider, args.text)
        const id = `${Date.now()}-${randomUUID().slice(0, 8)}.mp3`
        writeFileSync(join(audioDir, id), audio)
        return `✅ 语音已生成: http://127.0.0.1:${port}/audio/${id}`
      } catch (e) {
        return `❌ TTS 失败: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }))

  ctx.logger.info(`[yitai-voice] 已注册 speak 工具（provider=${provider || '未配置'}）`)

  /* ============ 服务暴露 ============ */

  ctx.provide('yitai.voice', {
    speak: (text: string) => synthesize(provider, text),
    checkProvider: () => checkProvider(provider),
    getAudioUrl: (id: string) => `http://127.0.0.1:${port}/audio/${id}`,
  })
}

