import type {
  Adapter,
  AsphodelConfig,
  HybridSearchOptions,
  Memory,
  RecallOptions,
  RememberOptions,
  ScoredMemory,
  SearchOptions,
} from './types.js'
import { extractTopicsLocal } from './topic.js'
import { reciprocalRankFusion } from './hybrid/rrf.js'
import { scoreModifier } from './hybrid/decay.js'
import { normalizeEmbedding, DEDUP_THRESHOLD } from './hybrid/dedup.js'

const DEFAULT_MAX_TOPICS   = 10
const DEFAULT_RECALL_LIMIT = 10
const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_LIST_LIMIT   = 20

export class Asphodel {
  private readonly adapter: Adapter
  private readonly maxTopicsPerMemory: number
  private readonly extractTopics: (content: string) => Promise<string[]> | string[]
  private readonly hybrid: AsphodelConfig['hybrid']

  constructor(adapter: Adapter, config: AsphodelConfig = {}) {
    this.adapter = adapter
    this.maxTopicsPerMemory = config.maxTopicsPerMemory ?? DEFAULT_MAX_TOPICS
    this.extractTopics = config.extractTopics ??
      ((content: string) => extractTopicsLocal(content, this.maxTopicsPerMemory))
    this.hybrid = config.hybrid
  }

  async init(): Promise<void> {
    await this.adapter.init()
  }

  /**
   * Store a memory. If a HybridProvider is configured, also embeds the content
   * and stores a vector for future hybridSearch() calls.
   *
   * Semantic deduplication: when a hybrid provider is set, the content is embedded
   * and compared against the nearest existing memory. If cosine similarity exceeds
   * the dedup threshold the insert is skipped and the existing memory is returned
   * with isDuplicate: true.
   */
  async remember(content: string, options: RememberOptions = {}): Promise<Memory> {
    const topics = options.topics
      ? options.topics.slice(0, this.maxTopicsPerMemory).map(t => t.toLowerCase().trim())
      : await Promise.resolve(this.extractTopics(content))

    // ── Hybrid path: embed → dedup check → insert → vectorInsert ──────────
    if (this.hybrid && !options.skipDedup) {
      const rawEmbedding = await this.hybrid.embed(content)
      const embedding = normalizeEmbedding(rawEmbedding)

      // Semantic dedup: check nearest neighbor before inserting
      if (this.adapter.vectorSearch) {
        const nearest = await this.adapter.vectorSearch(embedding, 1)
        if (nearest[0] && nearest[0].score >= DEDUP_THRESHOLD) {
          return { ...nearest[0], isDuplicate: true }
        }
      }

      const id = await this.adapter.insert(content, topics)
      await this.adapter.vectorInsert?.(id, embedding)
      return { id, content, topics, created_at: new Date().toISOString() }
    }

    // ── Standard path ──────────────────────────────────────────────────────
    const id = await this.adapter.insert(content, topics)
    return { id, content, topics, created_at: new Date().toISOString() }
  }

  async recall(topic: string, options: RecallOptions = {}): Promise<Memory[]> {
    return this.adapter.recall(
      topic.toLowerCase().trim(),
      options.limit ?? DEFAULT_RECALL_LIMIT
    )
  }

  async search(query: string, options: SearchOptions = {}): Promise<Memory[]> {
    return this.adapter.search(query, options.limit ?? DEFAULT_SEARCH_LIMIT)
  }

  /**
   * Hybrid search: BM25 + vector cosine → RRF fusion → temporal decay ×
   * access-frequency boost → optional LLM rerank.
   *
   * Falls back to BM25-only search if no HybridProvider is configured or the
   * adapter does not support vectorSearch.
   */
  async hybridSearch(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<ScoredMemory[]> {
    const limit   = options.limit ?? DEFAULT_SEARCH_LIMIT
    const decay   = options.decay ?? true
    const doRerank = options.rerank ?? false

    // ── Fallback: BM25 only ───────────────────────────────────────────────
    if (!this.hybrid || !this.adapter.vectorSearch) {
      const results = await this.adapter.search(query, limit)
      return results.map((m, i) => ({
        ...m,
        recall_count: (m as ScoredMemory).recall_count ?? 0,
        score: 1 / (60 + i + 1),  // synthetic RRF-like score
      }))
    }

    // ── Phase 1: Candidate generation (parallel) ──────────────────────────
    const candidateLimit = Math.max(limit * 3, 20)

    const [bm25Results, queryEmbedding] = await Promise.all([
      this.adapter.search(query, candidateLimit),
      this.hybrid.embed(query).then(normalizeEmbedding),
    ])

    const vecResults = await this.adapter.vectorSearch(queryEmbedding, candidateLimit)

    // ── Phase 2: RRF fusion ───────────────────────────────────────────────
    const fused = reciprocalRankFusion([
      { results: bm25Results, weight: 0.75 },
      { results: vecResults,  weight: 0.60 },
    ])

    // ── Phase 3: Hydrate fused IDs with full memory data ─────────────────
    const byId = new Map<number, Memory & { recall_count: number }>()
    for (const m of bm25Results) {
      byId.set(m.id, { ...m, recall_count: (m as ScoredMemory).recall_count ?? 0 })
    }
    for (const m of vecResults) {
      if (!byId.has(m.id)) byId.set(m.id, m)
    }

    let scored: ScoredMemory[] = fused
      .filter(({ id }) => byId.has(id))
      .map(({ id, score }) => {
        const mem = byId.get(id)!
        return { ...mem, score, recall_count: mem.recall_count }
      })

    // ── Phase 4: Temporal decay × access-frequency boost ─────────────────
    if (decay) {
      scored = scored.map(m => ({
        ...m,
        score: m.score * scoreModifier(m.created_at, m.recall_count),
      }))
      scored.sort((a, b) => b.score - a.score)
    }

    // ── Phase 5: Optional LLM rerank ─────────────────────────────────────
    if (doRerank && this.hybrid.rerank) {
      const candidates = scored.slice(0, 40)
      scored = await this.hybrid.rerank(query, candidates)
    }

    // Bump recall_count for the results we're returning
    const returnSlice = scored.slice(0, limit)
    await this.adapter.bumpRecallCount?.(returnSlice.map(m => m.id))

    return returnSlice
  }

  async forget(id: number): Promise<boolean> {
    return this.adapter.forget(id)
  }

  async list(limit = DEFAULT_LIST_LIMIT, offset = 0): Promise<Memory[]> {
    return this.adapter.list(limit, offset)
  }

  async close(): Promise<void> {
    await this.adapter.close()
    await this.hybrid?.close?.()
  }
}
