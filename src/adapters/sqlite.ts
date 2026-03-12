import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { Adapter, Memory } from '../types.js'

export class SQLiteAdapter implements Adapter {
  private db!: Database.Database
  private readonly path: string
  private readonly maxMemoriesPerTopic: number

  constructor(dbPath?: string, maxMemoriesPerTopic = 10) {
    this.path = dbPath ?? process.env.ASPHODEL_DB ?? join(homedir(), '.asphodel', 'memory.db')
    this.maxMemoriesPerTopic = maxMemoriesPerTopic
  }

  async init(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new Database(this.path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
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
      SELECT m.id, m.content, m.topics, m.created_at
      FROM memories m
      JOIN topic_index ti ON ti.memory_id = m.id
      WHERE ti.word = ?
      ORDER BY m.id DESC
      LIMIT ?
    `).all(topic.toLowerCase().trim(), limit) as Array<{
      id: number; content: string; topics: string; created_at: string
    }>

    return rows.map(r => ({ ...r, topics: JSON.parse(r.topics) }))
  }

  async search(query: string, limit: number): Promise<Memory[]> {
    const rows = this.db.prepare(`
      SELECT m.id, m.content, m.topics, m.created_at
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Array<{
      id: number; content: string; topics: string; created_at: string
    }>

    return rows.map(r => ({ ...r, topics: JSON.parse(r.topics) }))
  }

  async forget(id: number): Promise<boolean> {
    const { changes } = this.db
      .prepare(`DELETE FROM memories WHERE id = ?`)
      .run(id)
    return changes > 0
  }

  async list(limit: number, offset: number): Promise<Memory[]> {
    const rows = this.db.prepare(`
      SELECT id, content, topics, created_at
      FROM memories
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as Array<{
      id: number; content: string; topics: string; created_at: string
    }>

    return rows.map(r => ({ ...r, topics: JSON.parse(r.topics) }))
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
