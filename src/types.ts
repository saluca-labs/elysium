// ── Core types ────────────────────────────────────────────────────────────────

export interface Memory {
  id: number
  content: string
  topics: string[]   // max MAX_TOPICS_PER_MEMORY words
  created_at: string // ISO 8601
}

// ── Config ────────────────────────────────────────────────────────────────────

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
}

// ── API types ─────────────────────────────────────────────────────────────────

export interface RememberOptions {
  topics?: string[]  // override auto-extraction
}

export interface RecallOptions {
  limit?: number
}

export interface SearchOptions {
  limit?: number
}
