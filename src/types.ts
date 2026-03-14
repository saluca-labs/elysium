// ── Core types ────────────────────────────────────────────────────────────────

export interface Memory {
  id: number
  content: string
  topics: string[]   // max MAX_TOPICS_PER_MEMORY words
  created_at: string // ISO 8601
  /** Set to true when hybridSearch detects the stored memory is a near-duplicate. */
  isDuplicate?: boolean
}

/** Memory enriched with a relevance score. Returned by hybridSearch(). */
export interface ScoredMemory extends Memory {
  /** Fused relevance score (higher = better). Not comparable across queries. */
  score: number
  /** How many times this memory has been recalled. Used for access-frequency boost. */
  recall_count: number
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface HybridProvider {
  /** Embedding dimensions — must match the dimensions stored in the adapter schema. */
  readonly dims: number
  /** Embed text into a float vector. */
  embed(text: string): Promise<number[]>
  /**
   * Optional LLM reranker. Re-scores top candidates after RRF fusion.
   * If not provided, rerank: true in HybridSearchOptions is a no-op.
   */
  rerank?(query: string, memories: ScoredMemory[]): Promise<ScoredMemory[]>
  /** Release model resources. */
  close?(): Promise<void>
}

export interface AsphodelConfig {
  /** Max topic words per memory. Default: 10 */
  maxTopicsPerMemory?: number
  /** Max memories stored per topic word. Default: 10 */
  maxMemoriesPerTopic?: number
  /**
   * Optional AI-powered topic extractor. Receives content, returns topic words.
   * Falls back to built-in heuristic if not provided.
   */
  extractTopics?: (content: string) => Promise<string[]> | string[]
  /**
   * Optional hybrid search provider (embeddings + optional reranker).
   * When set, remember() stores vector embeddings and hybridSearch() is enabled.
   * Without this, hybridSearch() falls back to BM25-only search.
   */
  hybrid?: HybridProvider
}

// ── Adapter interface ─────────────────────────────────────────────────────────

export interface Adapter {
  init(): Promise<void>
  insert(content: string, topics: string[]): Promise<number>
  recall(topic: string, limit: number): Promise<Memory[]>
  search(query: string, limit: number): Promise<Memory[]>
  forget(id: number): Promise<boolean>
  list(limit: number, offset: number): Promise<Memory[]>
  close(): Promise<void>

  // ── Optional hybrid search extensions ──────────────────────────────────────
  // Adapters that support vector search implement these.
  // Callers must check for existence before calling.

  /** Store an L2-normalized embedding for a memory. */
  vectorInsert?(id: number, embedding: number[]): Promise<void>

  /**
   * Find the k nearest memories by vector similarity.
   * Returns ScoredMemory[] ordered by similarity (desc), with recall_count populated.
   * score = approximate cosine similarity (1 - L2²/2 on normalized vectors).
   */
  vectorSearch?(embedding: number[], limit: number): Promise<ScoredMemory[]>

  /** Increment the recall_count for a set of memory IDs. */
  bumpRecallCount?(ids: number[]): Promise<void>
}

// ── API types ─────────────────────────────────────────────────────────────────

export interface RememberOptions {
  topics?: string[]  // override auto-extraction
  /** Skip semantic deduplication check even if hybrid provider is configured. */
  skipDedup?: boolean
}

export interface RecallOptions {
  limit?: number
}

export interface SearchOptions {
  limit?: number
}

export interface HybridSearchOptions {
  limit?: number
  /**
   * Apply temporal decay × access-frequency boost to RRF scores.
   * Default: true (when hybrid provider is configured).
   */
  decay?: boolean
  /**
   * Run an LLM reranker pass on the top candidates after RRF fusion.
   * Requires the HybridProvider to implement rerank().
   * Default: false.
   */
  rerank?: boolean
}
