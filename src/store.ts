import type { Adapter, AsphodelConfig, Memory, RecallOptions, RememberOptions, SearchOptions } from './types.js'
import { extractTopicsLocal } from './topic.js'

const DEFAULT_MAX_TOPICS = 10
const DEFAULT_MAX_PER_TOPIC = 10
const DEFAULT_RECALL_LIMIT = 10
const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_LIST_LIMIT = 20

export class Asphodel {
  private readonly adapter: Adapter
  private readonly maxTopicsPerMemory: number
  private readonly extractTopics: (content: string) => Promise<string[]> | string[]

  constructor(adapter: Adapter, config: AsphodelConfig = {}) {
    this.adapter = adapter
    this.maxTopicsPerMemory = config.maxTopicsPerMemory ?? DEFAULT_MAX_TOPICS
    this.extractTopics = config.extractTopics ??
      ((content: string) => extractTopicsLocal(content, this.maxTopicsPerMemory))
  }

  async init(): Promise<void> {
    await this.adapter.init()
  }

  async remember(content: string, options: RememberOptions = {}): Promise<Memory> {
    const topics = options.topics
      ? options.topics.slice(0, this.maxTopicsPerMemory).map(t => t.toLowerCase().trim())
      : await Promise.resolve(this.extractTopics(content))

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

  async forget(id: number): Promise<boolean> {
    return this.adapter.forget(id)
  }

  async list(limit = DEFAULT_LIST_LIMIT, offset = 0): Promise<Memory[]> {
    return this.adapter.list(limit, offset)
  }

  async close(): Promise<void> {
    await this.adapter.close()
  }
}
