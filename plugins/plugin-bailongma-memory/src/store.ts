/**
 * 记忆 SQLite 存储层 —— 基于 node:sqlite（与 Harness 自身持久化同款技术栈）。
 *
 * 迁移自白龙马 src/db.js 的记忆表设计，简化裁剪：
 *   - memories：记忆节点（mem_id / type / title / content / entities / tags / salience / 软删除）
 *   - memory_fts：FTS5 全文索引（unicode61），中文查询走 LIKE 兜底
 *   - focus_frames：焦点栈持久化（重启可恢复）
 *   - action_log：行动日志（记忆审计）
 *   - profile：用户画像
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'

export interface MemoryRecord {
  mem_id: string
  type: string
  title: string
  content: string
  detail?: string
  entities: string[]
  tags: string[]
  salience: number
  source_ref?: string
  created_at: string
  updated_at: string
  last_accessed: string | null
  access_count: number
  visibility: 'visible' | 'hidden'
}

export interface FocusFrame {
  id: number
  topic: string[]
  hit_count: number
  last_seen_at: string
  conclusions: string[]
}

export interface ProfileEntry {
  key: string
  value: string
  confidence: number
  evidence: string
  updated_at: string
}

/** 默认数据目录：$DSH_HOME/bailongma-memory，可用配置覆盖 */
export function defaultDataRoot(): string {
  const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`
  return `${home}/bailongma-memory`
}

export class MemoryStore {
  private db: DatabaseSync

  constructor(public readonly root: string) {
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(`${root}/memory.db`)
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        mem_id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'fact',
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        entities TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        salience REAL NOT NULL DEFAULT 3,
        source_ref TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        visibility TEXT NOT NULL DEFAULT 'visible'
      );
      CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_mem_salience ON memories(salience DESC);
      CREATE INDEX IF NOT EXISTS idx_mem_updated ON memories(updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
        title, content, detail, entities, tags,
        content='memories', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
        INSERT INTO mem_fts(rowid, title, content, detail, entities, tags)
        VALUES (new.rowid, new.title, new.content, new.detail, new.entities, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, title, content, detail, entities, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.detail, old.entities, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, title, content, detail, entities, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.detail, old.entities, old.tags);
        INSERT INTO mem_fts(rowid, title, content, detail, entities, tags)
        VALUES (new.rowid, new.title, new.content, new.detail, new.entities, new.tags);
      END;

      CREATE TABLE IF NOT EXISTS focus_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL DEFAULT '[]',
        hit_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        conclusions TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS profile (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id INTEGER PRIMARY KEY,
        topics TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open',
        last_activity TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 1,
        last_summary TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS commitments (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  /* ============ 记忆 CRUD ============ */

  upsertMemory(mem: Partial<MemoryRecord> & { mem_id: string; content: string }): MemoryRecord {
    const now = new Date().toISOString()
    const existing = this.getMemory(mem.mem_id)
    const record: MemoryRecord = {
      mem_id: mem.mem_id,
      type: mem.type ?? existing?.type ?? 'fact',
      title: mem.title ?? existing?.title ?? '',
      content: mem.content,
      detail: mem.detail ?? existing?.detail ?? '',
      entities: mem.entities ?? existing?.entities ?? [],
      tags: mem.tags ?? existing?.tags ?? [],
      salience: mem.salience ?? existing?.salience ?? 3,
      source_ref: mem.source_ref ?? existing?.source_ref ?? '',
      created_at: mem.created_at ?? existing?.created_at ?? now,
      updated_at: mem.updated_at ?? now,
      last_accessed: existing?.last_accessed ?? null,
      access_count: existing?.access_count ?? 0,
      visibility: mem.visibility ?? existing?.visibility ?? 'visible',
    }
    this.db.prepare(`
      INSERT INTO memories (mem_id, type, title, content, detail, entities, tags, salience, source_ref, created_at, updated_at, last_accessed, access_count, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mem_id) DO UPDATE SET
        type=excluded.type, title=excluded.title, content=excluded.content, detail=excluded.detail,
        entities=excluded.entities, tags=excluded.tags, salience=excluded.salience,
        source_ref=excluded.source_ref, updated_at=excluded.updated_at, visibility=excluded.visibility
    `).run(
      record.mem_id, record.type, record.title, record.content, record.detail,
      JSON.stringify(record.entities), JSON.stringify(record.tags), record.salience,
      record.source_ref, record.created_at, record.updated_at, record.last_accessed,
      record.access_count, record.visibility,
    )
    return record
  }

  getMemory(memId: string): MemoryRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM memories WHERE mem_id = ? AND visibility = 'visible'`,
    ).get(memId) as Record<string, unknown> | undefined
    return row ? this.rowToMemory(row) : undefined
  }

  deleteMemory(memId: string): void {
    this.db.prepare(`DELETE FROM memories WHERE mem_id = ?`).run(memId)
  }

  downgradeMemory(memId: string, amount = 1): void {
    this.db.prepare(`UPDATE memories SET salience = MAX(0, salience - ?), updated_at = ? WHERE mem_id = ?`)
      .run(amount, new Date().toISOString(), memId)
  }

  /** 标记一次访问，用于热度衰减与最近召回 */
  touch(memId: string): void {
    this.db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE mem_id = ?`)
      .run(new Date().toISOString(), memId)
  }

  /**
   * 搜索记忆：
   *   - query 非空 → FTS5 优先 + LIKE 兜底（中文子串）
   *   - query 为空 → 按 salience/最近访问取 top
   *   - filterType / filterTags 可选过滤
   */
  search(options: {
    query?: string
    limit?: number
    filterType?: string
    filterTags?: string[]
    minSalience?: number
    entity?: string
  }): MemoryRecord[] {
    const limit = Math.max(1, options.limit ?? 10)
    const clauses: string[] = []
    const args: unknown[] = []

    const q = (options.query ?? '').trim()
    if (q) {
      // LIKE 兜底（分词 OR 匹配）——对中文子串最可靠，优先构造
      const terms = q.split(/\s+/).map(t => t.replace(/[%_]/g, '')).filter(Boolean)
      const likeFallback = (): void => {
        if (terms.length > 0) {
          const termClauses: string[] = []
          for (const term of terms) {
            const like = `%${term}%`
            termClauses.push(`(content LIKE ? OR title LIKE ? OR detail LIKE ?)`)
            args.push(like, like, like)
          }
          clauses.push(`(${termClauses.join(' OR ')})`)
        } else {
          clauses.push('0')
        }
      }
      // FTS5 尝试；命中且数量足够则用 FTS，否则回退 LIKE
      const ftsWords = terms.length > 0 ? terms : q.split(/\s+/)
      const matchStr = ftsWords.map(w => `"${w.replace(/"/g, '""')}"`).join(' ')
      let ftsHit = false
      try {
        const ftsRows = this.db.prepare(`
          SELECT rowid FROM mem_fts WHERE mem_fts MATCH ? ORDER BY rank LIMIT ?
        `).all(matchStr, limit * 3) as { rowid: number }[]
        if (ftsRows.length > 0) {
          const ids = ftsRows.map(r => r.rowid)
          const placeholders = ids.map(() => '?').join(',')
          clauses.push(`rowid IN (${placeholders})`)
          args.push(...ids)
          ftsHit = true
        }
      } catch {
        // FTS 语法错误 → 走 LIKE
      }
      if (!ftsHit) likeFallback()
    }
    if (options.filterType) {
      clauses.push(`type = ?`); args.push(options.filterType)
    }
    if (options.entity) {
      clauses.push(`entities LIKE ?`); args.push(`%"${options.entity}"%`)
    }
    if (options.minSalience !== undefined) {
      clauses.push(`salience >= ?`); args.push(options.minSalience)
    }
    if (options.filterTags?.length) {
      for (const t of options.filterTags) {
        clauses.push(`tags LIKE ?`); args.push(`%"${t.replace(/"/g, '')}"%`)
      }
    }
    clauses.push(`visibility = 'visible'`)

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(
      `SELECT * FROM memories ${where} ORDER BY salience DESC, last_accessed DESC LIMIT ?`,
    ).all(...args, limit) as Record<string, unknown>[]
    return rows.map(r => this.rowToMemory(r))
  }

  /** 按实体批量取记忆 */
  byEntity(entity: string, limit = 20): MemoryRecord[] {
    return this.search({ entity, limit })
  }

  /** 记忆衰减：超过阈值的老记忆降 salience，过低的软隐藏 */
  runDecay(thresholdDays: number, hiddenSalience: number): number {
    const cutoff = new Date(Date.now() - thresholdDays * 86400000).toISOString()
    const info = this.db.prepare(`
      UPDATE memories SET salience = MAX(0, salience - 0.5)
      WHERE last_accessed IS NULL AND created_at < ?
    `).run(cutoff)
    this.db.prepare(`
      UPDATE memories SET visibility = 'hidden'
      WHERE salience < ? AND visibility = 'visible'
    `).run(hiddenSalience)
    return Number(info.changes)
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE visibility='visible'`).get() as { n: number }
    return row.n
  }

  /** 最近 N 条记忆（用于归档/导出） */
  recent(limit = 20): MemoryRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE visibility='visible' ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[]
    return rows.map(r => this.rowToMemory(r))
  }

  private rowToMemory(row: Record<string, unknown>): MemoryRecord {
    return {
      mem_id: String(row.mem_id),
      type: String(row.type),
      title: String(row.title),
      content: String(row.content),
      detail: String(row.detail),
      entities: this.parseJsonArray(row.entities),
      tags: this.parseJsonArray(row.tags),
      salience: Number(row.salience),
      source_ref: String(row.source_ref),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_accessed: row.last_accessed ? String(row.last_accessed) : null,
      access_count: Number(row.access_count),
      visibility: (row.visibility as MemoryRecord['visibility']) ?? 'visible',
    }
  }

  private parseJsonArray(value: unknown): string[] {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed.map(String) : []
      } catch {
        return []
      }
    }
    return []
  }

  /* ============ 焦点栈 ============ */

  loadFrames(): FocusFrame[] {
    const rows = this.db.prepare(`SELECT * FROM focus_frames ORDER BY id ASC`).all() as Record<string, unknown>[]
    return rows.map(r => ({
      id: Number(r.id),
      topic: this.parseJsonArray(r.topic),
      hit_count: Number(r.hit_count),
      last_seen_at: String(r.last_seen_at),
      conclusions: this.parseJsonArray(r.conclusions),
    }))
  }

  replaceFrames(frames: { topic: string[]; hit_count: number; last_seen_at: string; conclusions: string[] }[]): void {
    this.db.exec(`DELETE FROM focus_frames`)
    const stmt = this.db.prepare(
      `INSERT INTO focus_frames (topic, hit_count, last_seen_at, conclusions) VALUES (?, ?, ?, ?)`,
    )
    for (const f of frames) {
      stmt.run(JSON.stringify(f.topic), f.hit_count, f.last_seen_at, JSON.stringify(f.conclusions))
    }
  }

  /* ============ 用户画像 ============ */

  upsertProfile(key: string, value: string, confidence: number, evidence: string): void {
    this.db.prepare(`
      INSERT INTO profile (key, value, confidence, evidence, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value, confidence=excluded.confidence, evidence=excluded.evidence, updated_at=excluded.updated_at
    `).run(key, value, confidence, evidence, new Date().toISOString())
  }

  listProfile(): ProfileEntry[] {
    const rows = this.db.prepare(`SELECT * FROM profile ORDER BY confidence DESC`).all() as Record<string, unknown>[]
    return rows.map(r => ({
      key: String(r.key),
      value: String(r.value),
      confidence: Number(r.confidence),
      evidence: String(r.evidence),
      updated_at: String(r.updated_at),
    }))
  }

  /* ============ 行动日志 ============ */

  logAction(kind: string, detail: string): void {
    this.db.prepare(`INSERT INTO action_log (kind, detail, created_at) VALUES (?, ?, ?)`)
      .run(kind, detail, new Date().toISOString())
  }

  recentActions(limit = 20): { id: number; kind: string; detail: string; created_at: string }[] {
    const rows = this.db.prepare(
      `SELECT * FROM action_log ORDER BY id DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[]
    return rows.map(r => ({
      id: Number(r.id),
      kind: String(r.kind),
      detail: String(r.detail),
      created_at: String(r.created_at),
    }))
  }

  /* ============ 线程 / 承诺 ============ */

  queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[]
  }

  upsertThreads(rows: { id: number; topics: string; status: string; last_activity: string; turn_count: number; last_summary: string }[]): void {
    this.db.exec(`DELETE FROM threads`)
    const stmt = this.db.prepare(
      `INSERT INTO threads (id, topics, status, last_activity, turn_count, last_summary) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) stmt.run(r.id, r.topics, r.status, r.last_activity, r.turn_count, r.last_summary)
  }

  upsertCommitments(rows: { id: number; thread_id: number; content: string; status: string; created_at: string }[]): void {
    this.db.exec(`DELETE FROM commitments`)
    const stmt = this.db.prepare(
      `INSERT INTO commitments (id, thread_id, content, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    for (const r of rows) stmt.run(r.id, r.thread_id, r.content, r.status, r.created_at)
  }

  /** 存储目录下的数据库文件路径，便于工具/诊断引用 */
  get dbPath(): string {
    return `${this.root}/memory.db`
  }
}

