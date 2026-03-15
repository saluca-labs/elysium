import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { Adapter, Memory, ScoredMemory } from '../types.js'
import { l2ToCosineSimilarity } from '../hybrid/dedup.js'

export interface SQLiteAdapterOptions {
  /** Path to the SQLite database file. Defaults to ASPHODEL_DB env or ~/.asphodel/memory.db */
  dbPath?: string
  /** Max memories per topic before oldest is evicted. Default: 10 */
  maxMemoriesPerTopic?: number
  /**
   * Embedding dimensions for vector search.
   * Required to enable the memories_vec table (sqlite-vec extension).
   * Must match the dimensions produced by your HybridProvider.
   * Default: 0 (vector search disabled).
   */
  vectorDims?: number
}

export class SQLiteAdapter implements Adapter {
  private db!: Database.Database
  private readonly path: string
  private readonly maxMemoriesPerTopic: number
  private readonly vectorDims: number
  private vecLoaded = false

  constructor(opts: SQLiteAdapterOptions | string = {}) {
    // Accept legacy string argument for backward compat
    if (typeof opts === 'string') {
      opts = { dbPath: opts }
    }
    this.path = opts.dbPath ?? process.env.ASPHODEL_DB ?? join(homedir(), '.asphodel', 'memory.db')
    this.maxMemoriesPerTopic = opts.maxMemoriesPerTopic ?? 10
    this.vectorDims = opts.vectorDims ?? 0
  }

  async init(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new Database(this.path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    // Migration 001: core schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        content    TEXT NOT NULL,
        topics     TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS topic_index (
        word      TEXT NOT NULL,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        PRIMARY KEY (word, memory_id)
      );

      CREATE INDEX IF NOT EXISTS idx_topic_word ON topic_index(word);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content=memories,
        content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
    `)

    // Migration 002: recall_count for access-frequency boost
    const cols = this.db
      .prepare(`PRAGMA table_info(memories)`)
      .all() as Array<{ name: string }>
    if (!cols.some(c => c.name === 'recall_count')) {
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0`
      )
    }

    // Migration 003: vector search via sqlite-vec (optional — skipped if not installed
    // or vectorDims is 0)
    if (this.vectorDims > 0) {
      this.vecLoaded = this.tryLoadSqliteVec()
      if (this.vecLoaded) {
        // vec0 uses implicit rowid as the memory ID.
        // We insert with BigInt(memory_id) as rowid so the join
        // "memories m ON m.id = CAST(v.rowid AS INTEGER)" works correctly.
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
            embedding float[${this.vectorDims}]
          );
        `)
      }
    }
  }

  /**
   * Attempt to load the sqlite-vec extension.
   * Returns true if loaded successfully, false if not installed.
   */
  private tryLoadSqliteVec(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void }
      sqliteVec.load(this.db)
      return true
    } catch {
      return false
    }
  }

  async insert(content: string, topics: string[]): Promise<number> {
    const now = new Date().toISOString()

    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO memories (content, topics, created_at) VALUES (?, ?, ?)`)
      .run(content, JSON.stringify(topics), now)

    const id = Number(lastInsertRowid)

    const insertIndex = this.db.prepare(
      `INSERT OR IGNORE INTO topic_index (word, memory_id) VALUES (?, ?)`
    )
    const countForWord = this.db.prepare(
      `SELECT COUNT(*) as n FROM topic_index WHERE word = ?`
    )
    const deleteOldest = this.db.prepare(`
      DELETE FROM topic_index
      WHERE word = ? AND memory_id = (
        SELECT ti.memory_id FROM topic_index ti
        JOIN memories m ON m.id = ti.memory_id
        WHERE ti.word = ?
        ORDER BY m.created_at ASC
        LIMIT 1
      )
    `)

    for (const word of topics) {
      const { n } = countForWord.get(word) as { n: number }
      if (n >= this.maxMemoriesPerTopic) {
        deleteOldest.run(word, word)
      }
      insertIndex.run(word, id)
    }

    return id
  }

  async recall(topic: string, limit: number): Promise<Memory[]> {
    const rows = this.db.prepare(`
      SELECT m.id, m.content, m.topics, m.created_at, m.recall_count
      FROM memories m
      JOIN topic_index ti ON ti.memory_id = m.id
      WHERE ti.word = ?
      ORDER BY m.id DESC
      LIMIT ?
    `).all(topic.toLowerCase().trim(), limit) as Array<{
      id: number; content: string; topics: string; created_at: string; recall_count: number
    }>

    const memories = rows.map(r => ({ ...r, topics: JSON.parse(r.topics) as string[] }))
    if (memories.length > 0) {
      this.bumpRecallCountSync(memories.map(m => m.id))
    }
    return memories
  }

  async search(query: string, limit: number): Promise<Memory[]> {
    const rows = this.db.prepare(`
      SELECT m.id, m.content, m.topics, m.created_at, m.recall_count
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Array<{
      id: number; content: string; topics: string; created_at: string; recall_count: number
    }>

    const memories = rows.map(r => ({ ...r, topics: JSON.parse(r.topics) as string[] }))
    if (memories.length > 0) {
      this.bumpRecallCountSync(memories.map(m => m.id))
    }
    return memories
  }

  // ── Hybrid search extensions ───────────────────────────────────────────────

  /**
   * Store an L2-normalized float embedding alongside a memory.
   * Uses sqlite-vec's vec0 virtual table with rowid = memory_id.
   *
   * Note: sqlite-vec alpha (0.1.x) requires the rowid to be passed as BigInt —
   * regular JS numbers are sent as float64 by better-sqlite3 and rejected.
   * Embeddings are serialized as JSON arrays and deserialized by vec_f32().
   */
  async vectorInsert(id: number, embedding: number[]): Promise<void> {
    if (!this.vecLoaded) return
    this.db
      .prepare(`INSERT OR REPLACE INTO memories_vec(rowid, embedding) VALUES (?, vec_f32(?))`)
      .run(BigInt(id), JSON.stringify(embedding))
  }

  /**
   * K-nearest-neighbor search using sqlite-vec.
   * Embeddings must be L2-normalized before calling; scores are approximate
   * cosine similarities derived from L2 distance (1 - d²/2 on unit vectors).
   */
  async vectorSearch(embedding: number[], limit: number): Promise<ScoredMemory[]> {
    if (!this.vecLoaded) return []

    const rows = this.db.prepare(`
      SELECT m.id, m.content, m.topics, m.created_at, m.recall_count, v.distance
      FROM memories_vec v
      JOIN memories m ON m.id = CAST(v.rowid AS INTEGER)
      WHERE v.embedding MATCH vec_f32(?)
        AND k = ?
      ORDER BY v.distance
    `).all(JSON.stringify(embedding), limit) as Array<{
      id: number
      content: string
      topics: string
      created_at: string
      recall_count: number
      distance: number
    }>

    return rows.map(r => ({
      id:           r.id,
      content:      r.content,
      topics:       JSON.parse(r.topics) as string[],
      created_at:   r.created_at,
      recall_count: r.recall_count,
      score:        l2ToCosineSimilarity(r.distance),
    }))
  }

  /** Increment recall_count for a list of memory IDs. */
  async bumpRecallCount(ids: number[]): Promise<void> {
    this.bumpRecallCountSync(ids)
  }

  private bumpRecallCountSync(ids: number[]): void {
    const stmt = this.db.prepare(`UPDATE memories SET recall_count = recall_count + 1 WHERE id = ?`)
    const updateAll = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(id)
    })
    updateAll(ids)
  }

  // ── Standard operations ────────────────────────────────────────────────────

  async forget(id: number): Promise<boolean> {
    const { changes } = this.db
      .prepare(`DELETE FROM memories WHERE id = ?`)
      .run(id)
    return changes > 0
  }

  async list(limit: number, offset: number): Promise<Memory[]> {
    const rows = this.db.prepare(`
      SELECT id, content, topics, created_at, recall_count
      FROM memories
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as Array<{
      id: number; content: string; topics: string; created_at: string; recall_count: number
    }>

    return rows.map(r => ({ ...r, topics: JSON.parse(r.topics) as string[] }))
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
