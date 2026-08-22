/**
 * 记忆工具注册 —— 基于 src/capabilities/tools（记忆类工具）。
 *
 * 通过 @deepseek-ai/dsh-tools 的 defineTool 注册到 Harness 工具注册表，
 * 模型可以直接调用 memory_search / memory_upsert 等。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemoryStore } from './store.ts'
import type { FocusStack } from './focus-stack.ts'

export interface MemoryToolsContext {
  store: MemoryStore
  focus: FocusStack
}

const text = (s: unknown): string => String(s ?? '')

/** 把记忆记录渲染为文本块 */
function renderMemories(memories: { mem_id: string; type: string; title: string; content: string; salience: number; tags: string[]; entities: string[] }[]): string {
  if (memories.length === 0) return '（无匹配记忆）'
  return memories.map(m => {
    const tagStr = m.tags.length ? ` [${m.tags.join(',')}]` : ''
    const entStr = m.entities.length ? ` entities=${m.entities.join(',')}` : ''
    return `- [${m.mem_id}](${m.type}, salience=${m.salience})${tagStr} ${m.title}: ${m.content}${entStr}`
  }).join('\n')
}

export function buildMemoryTools(ctx: MemoryToolsContext): ToolDefinition[] {
  const { store, focus } = ctx

  return [
    defineTool({
      name: 'memory_search',
      description: '搜索长期记忆库。按关键词召回相关记忆节点（中文子串 + 全文检索 + 标签/实体过滤）。查询前先用这个工具做去重。',
      parameters: {
        query: { type: 'string', description: '搜索关键词或问题文本' },
        limit: { type: 'integer', description: '返回条数，默认 10' },
        type: { type: 'string', description: '按类型过滤：person/object/article/knowledge/fact' },
        tag: { type: 'array', items: { type: 'string' }, description: '按标签过滤，例如 kind:procedure / domain:file_work / trigger:xxx' },
        entity: { type: 'string', description: '按实体过滤，例如用户 ID 或 person_id' },
        minSalience: { type: 'number', description: '最低重要性阈值，默认 0' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: text(value) }],
      },
      async execute(args) {
        const memories = store.search({
          query: args.query,
          limit: args.limit ?? 10,
          filterType: args.type,
          filterTags: args.tag,
          entity: args.entity,
          minSalience: args.minSalience,
        })
        return renderMemories(memories)
      },
    }),

    defineTool({
      name: 'memory_upsert',
      description: '写入或更新一条长期记忆。mem_id 命名规则：person_{id} / object_{slug} / article_{hash8} / concept_{snake} / fact_{snake} / procedure_{domain}_{snake} / constraint_{domain}_{snake} / lesson_{domain}_{snake}。实体存 entities，行为规则/流程存 tags（kind:procedure / kind:constraint / kind:failure_lesson / domain:xxx / trigger:xxx）。',
      parameters: {
        mem_id: { type: 'string', description: '稳定记忆 ID，遵守命名规则', required: true },
        content: { type: 'string', description: '记忆核心内容', required: true },
        type: { type: 'string', description: 'person/object/article/knowledge/fact' },
        title: { type: 'string', description: '标题' },
        detail: { type: 'string', description: '详细信息' },
        entities: { type: 'array', items: { type: 'string' }, description: '关联实体（用户 ID / person_id / agent:xxx）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        salience: { type: 'number', description: '重要性 1-5，默认 3' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: text(value) }],
      },
      async execute(args) {
        const record = store.upsertMemory({
          mem_id: args.mem_id,
          content: args.content,
          type: args.type,
          title: args.title,
          detail: args.detail,
          entities: args.entities ?? [],
          tags: args.tags ?? [],
          salience: args.salience,
        })
        store.logAction('memory_upsert', args.mem_id)
        return `已写入记忆 [${record.mem_id}]（${record.type}, salience=${record.salience}）`
      },
    }),

    defineTool({
      name: 'memory_recall',
      description: '深度召回：搜索记忆并标记访问（影响衰减），返回与当前话题最相关的记忆。适合模型需要"回忆一下之前聊过什么"的场景。',
      parameters: {
        query: { type: 'string', description: '回忆关键词', required: true },
        limit: { type: 'integer', description: '返回条数，默认 5' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: text(value) }],
      },
      async execute(args) {
        const memories = store.search({ query: args.query, limit: args.limit ?? 5 })
        for (const m of memories) store.touch(m.mem_id)
        return renderMemories(memories)
      },
    }),

    defineTool({
      name: 'memory_forget',
      description: '删除或降权一条记忆。降权后它的 salience 下降，未来搜索优先级降低；salience 过低会自动隐藏。',
      parameters: {
        mem_id: { type: 'string', description: '要处理或降权的记忆 ID', required: true },
        action: { type: 'string', description: 'delete 彻底删除 / downgrade 降权（默认）' },
        amount: { type: 'number', description: '降权幅度，默认 1' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: text(value) }],
      },
      async execute(args) {
        if (args.action === 'delete') {
          store.deleteMemory(args.mem_id)
          store.logAction('memory_forget', args.mem_id)
          return `已删除记忆 [${args.mem_id}]`
        }
        store.downgradeMemory(args.mem_id, args.amount ?? 1)
        store.logAction('memory_downgrade', args.mem_id)
        return `已降权记忆 [${args.mem_id}]`
      },
    }),

    defineTool({
      name: 'focus_status',
      description: '查看当前焦点栈状态：正在专注的话题、帧深度、结论回填。用于感知当前对话的专注脉络。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: text(value) }],
      },
      async execute() {
        const frames = focus.frames
        if (frames.length === 0) return '当前没有活跃焦点帧。'
        return frames.map((f, i) => {
          const depth = i === frames.length - 1 ? '（栈顶·当前专注）' : `（深度 ${frames.length - 1 - i}）`
          const conclusions = f.conclusions.length ? ` 结论:${f.conclusions.join('; ')}` : ''
          return `- 帧${i}: [${f.topic.join(', ')}] 命中${f.hitCount}次${depth}${conclusions}`
        }).join('\n')
      },
    }),

    defineTool({
      name: 'profile_list',
      description: '查看已学习的用户画像（偏好、角色、领域、沟通风格等）。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: text(value) }],
      },
      async execute() {
        const entries = store.listProfile()
        if (entries.length === 0) return '（暂无用户画像）'
        return entries.map(e => `- ${e.key}: ${e.value} (confidence=${e.confidence}, evidence=${e.evidence})`).join('\n')
      },
    }),

    defineTool({
      name: 'profile_update',
      description: '写入一条用户画像（长期偏好 / 角色 / 领域 / 沟通风格）。当用户明确表达稳定的个人偏好时才写。',
      parameters: {
        key: { type: 'string', description: '画像键，如 role/domain/preference/style', required: true },
        value: { type: 'string', description: '画像值', required: true },
        confidence: { type: 'number', description: '置信度 0-1，默认 0.6' },
        evidence: { type: 'string', description: '证据来源' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: text(value) }],
      },
      async execute(args) {
        store.upsertProfile(args.key, args.value, args.confidence ?? 0.6, args.evidence ?? 'agent')
        store.logAction('profile_update', `${args.key}=${args.value}`)
        return `已写入用户画像 ${args.key}: ${args.value}`
      },
    }),
  ]
}

