import type { Context } from '@deepseek-ai/cordis'

export const name = 'plugin-hello'

export function apply(ctx: Context) {
  ctx.logger.info('[plugin-hello] 插件加载成功 ✅ — 工作台管道已打通')
  ctx.logger.info(`[plugin-hello] baseUrl=${ctx.baseUrl}`)
}
