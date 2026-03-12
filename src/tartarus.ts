import type { Asphodel } from './store.js'

/**
 * Shapes expected by tartarus-mcp's TartarusStore interface.
 * Defined here to avoid a hard dependency on tartarus-mcp.
 */
interface StoreOptions {
  topic?: string
  importance?: number
  persona_id?: string
  ttl?: number
  metadata?: Record<string, unknown>
}

interface RecallOptions {
  topic?: string
  persona_id?: string | null
  limit?: number
  min_importance?: number
}

interface ForgetOptions {
  id?: string
  topic?: string
  older_than_days?: number
  dry_run?: boolean
}

interface StoreResult {
  id: string
  key: string
  topic: string
  importance: number
  is_duplicate: boolean
}

interface RecallResult {
  id: string
  content: string
  topic: string
  importance: number
  rank_score: number
  access_count: number
  created_at: string
  last_accessed: string
  persona_id: string | null
  metadata: Record<string, unknown>
}

interface MemoryStats {
  total: number
  by_topic: Array<{ topic: string; count: number; avg_importance: number }>
  top_memory: string | null
  oldest: string | null
  newest: string | null
  avg_importance: number
  personas: number
}

/**
 * Wraps an Asphodel instance to satisfy tartarus-mcp's TartarusStore interface.
 *
 * Use this to back a Tartarus MCP server with Asphodel storage:
 *
 * ```ts
 * import { createServer } from 'tartarus-mcp'
 * import { Asphodel, SQLiteAdapter, AsphodelStore } from 'asphodel'
 *
 * const memory = new Asphodel(new SQLiteAdapter())
 * await memory.init()
 * const server = createServer({ store: new AsphodelStore(memory) })
 * ```
 *
 * Mapping notes:
 * - Memory IDs are integers in Asphodel; surfaced as strings to Tartarus.
 * - No importance scoring — defaults to 0.5.
 * - No deduplication — is_duplicate is always false.
 * - No TTL, persona_id, or metadata support — Asphodel ignores these.
 */
export class AsphodelStore {
  constructor(private readonly db: Asphodel) {}

  async store(content: string, opts: StoreOptions = {}): Promise<StoreResult> {
    const topics = opts.topic ? [opts.topic] : undefined
    const memory = await this.db.remember(content, { topics })
    return {
      id:           String(memory.id),
      key:          String(memory.id),
      topic:        memory.topics[0] ?? 'general',
      importance:   0.5,
      is_duplicate: false,
    }
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<RecallResult[]> {
    const limit = opts.limit ?? 5

    // Try topic recall first, fall back to full-text search
    const topic = opts.topic ?? query
    let memories = await this.db.recall(topic, { limit })
    if (memories.length === 0) {
      memories = await this.db.search(query, { limit })
    }

    return memories.map(m => ({
      id:           String(m.id),
      content:      m.content,
      topic:        m.topics[0] ?? 'general',
      importance:   0.5,
      rank_score:   0.5,
      access_count: 0,
      created_at:   m.created_at,
      last_accessed: m.created_at,
      persona_id:   null,
      metadata:     {},
    }))
  }

  async forget(opts: ForgetOptions): Promise<{ deleted: number; affected_ids: string[] }> {
    if (!opts.id && !opts.topic && opts.older_than_days == null) {
      throw new Error('Provide at least one of: id, topic, older_than_days')
    }

    if (opts.id) {
      const id = parseInt(opts.id, 10)
      if (isNaN(id)) return { deleted: 0, affected_ids: [] }
      if (opts.dry_run) return { deleted: 0, affected_ids: [opts.id] }
      const deleted = await this.db.forget(id)
      return { deleted: deleted ? 1 : 0, affected_ids: deleted ? [opts.id] : [] }
    }

    if (opts.topic) {
      const memories = await this.db.recall(opts.topic, { limit: 1000 })
      if (opts.dry_run) return { deleted: 0, affected_ids: memories.map(m => String(m.id)) }
      let deleted = 0
      const affected: string[] = []
      for (const m of memories) {
        if (await this.db.forget(m.id)) { deleted++; affected.push(String(m.id)) }
      }
      return { deleted, affected_ids: affected }
    }

    // older_than_days — list all, filter by age, delete
    if (opts.older_than_days != null) {
      const cutoff = Date.now() - opts.older_than_days * 86_400_000
      const all = await this.db.list(10_000, 0)
      const old = all.filter(m => new Date(m.created_at).getTime() < cutoff)
      if (opts.dry_run) return { deleted: 0, affected_ids: old.map(m => String(m.id)) }
      let deleted = 0
      const affected: string[] = []
      for (const m of old) {
        if (await this.db.forget(m.id)) { deleted++; affected.push(String(m.id)) }
      }
      return { deleted, affected_ids: affected }
    }

    return { deleted: 0, affected_ids: [] }
  }

  async stats(): Promise<MemoryStats> {
    const all = await this.db.list(10_000, 0)

    const topicCounts = new Map<string, number>()
    for (const m of all) {
      for (const t of m.topics) {
        topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1)
      }
    }

    const by_topic = Array.from(topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([topic, count]) => ({ topic, count, avg_importance: 0.5 }))

    const sorted = [...all].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )

    return {
      total:        all.length,
      by_topic,
      top_memory:   all[0]?.content.slice(0, 120) ?? null,
      oldest:       sorted[0]?.created_at ?? null,
      newest:       sorted[sorted.length - 1]?.created_at ?? null,
      avg_importance: 0.5,
      personas:     0,
    }
  }
}
