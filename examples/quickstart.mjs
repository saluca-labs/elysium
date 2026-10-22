// Quickstart from the README, run against the local build (npm run build first).
// Uses a throwaway SQLite file so it never touches ~/.asphodel/memory.db.
// Usage: node examples/quickstart.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Asphodel, SQLiteAdapter } from '../dist/index.js'

const dir = mkdtempSync(join(tmpdir(), 'asphodel-quickstart-'))
const db = new Asphodel(new SQLiteAdapter(join(dir, 'memory.db')))
await db.init()

const a = await db.remember('user prefers dark mode', { topics: ['preferences', 'ui'] })
const b = await db.remember('the API key rotates every 90 days')
console.log('remember ->', a.id, a.topics)
console.log('remember ->', b.id, b.topics)
console.log('recall("preferences") ->', (await db.recall('preferences')).map(m => m.content))
console.log('search("rotates") ->', (await db.search('rotates')).map(m => m.content))
console.log('hybridSearch("API key") ->', (await db.hybridSearch('API key')).map(m => m.content), '(no HybridProvider: full-text only)')
console.log('forget(1) ->', await db.forget(1))
console.log('list() ->', (await db.list()).map(m => `${m.id}: ${m.content}`))

await db.close()
rmSync(dir, { recursive: true, force: true })
