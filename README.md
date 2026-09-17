# Asphodel

Simple local-first memory storage for AI agents. Integer IDs, topic-word index, SQLite and Postgres support.

> **Not published from this repo.** The npm package `@saluca/asphodel` is retired: npm was retired as a Saluca channel on 2026-09-16 and the name no longer resolves on the npm registry.
> This repository is marked `"private": true` so it can never be published to that name.
> The published `@saluca/asphodel@0.1.0` was built from commit
> [`a83211e`](https://github.com/saluca-labs/elysium/commit/a83211e) of this repo.
> The published `0.4.0` was built from a different repository, not from this one.
> The `0.3.0` in `package.json` describes this code and was never published.
> The open-source memory MCP server is [tartarus-mcp](https://github.com/saluca-labs/tartarus-mcp).

```ts
import { Asphodel, SQLiteAdapter } from '@saluca/asphodel'

const db = new Asphodel(new SQLiteAdapter())
await db.init()

await db.remember("user prefers dark mode", { topics: ["preferences", "ui"] })
const results = await db.recall("preferences")
```

## Install

This package is not available from npm (see the note above). Build it from source:

```bash
git clone https://github.com/saluca-labs/elysium.git
cd elysium
npm ci
npm run build
```

To use the build from another local project, depend on the directory, for example `npm install ../elysium`, then import it as `@saluca/asphodel` (the name in this repo's `package.json`).

For Postgres support, also install the peer dependency:

```bash
npm install pg
```

## Adapters

### SQLite (default)

```ts
import { Asphodel, SQLiteAdapter } from '@saluca/asphodel'

const db = new Asphodel(new SQLiteAdapter())
// or specify a path:
const db = new Asphodel(new SQLiteAdapter('/path/to/memory.db'))
// or via env: ASPHODEL_DB
```

### Postgres

```ts
import { Asphodel, PostgresAdapter } from '@saluca/asphodel'

const db = new Asphodel(new PostgresAdapter('postgresql://user:pass@host/db'))
// or via env: ASPHODEL_DATABASE_URL
```

## API

### `remember(content, options?)`

Store a memory. Topics are extracted automatically or provided explicitly.

```ts
const memory = await db.remember("the API key rotates every 90 days")
// auto-extracted topics: ["api", "key", "rotates"]

const memory = await db.remember("user prefers dark mode", {
  topics: ["preferences", "ui"]
})
```

### `recall(topic, options?)`

Retrieve memories by topic word. Returns most recent first.

```ts
const memories = await db.recall("preferences")
const memories = await db.recall("preferences", { limit: 5 })
```

### `search(query, options?)`

Full-text search across memory content.

```ts
const memories = await db.search("API key rotation")
```

### `forget(id)`

Delete a memory by ID.

```ts
await db.forget(42)
```

### `list(limit?, offset?)`

Page through all memories, most recent first.

```ts
const page = await db.list(20, 0)
```

### `close()`

Release the database connection.

```ts
await db.close()
```

## Configuration

```ts
const db = new Asphodel(adapter, {
  maxTopicsPerMemory: 10,     // max topic words per memory (default: 10)
  maxMemoriesPerTopic: 10,    // max memories per topic word (default: 10)

  // plug in your own AI topic extractor
  extractTopics: async (content) => {
    const response = await openai.chat.completions.create({ ... })
    return response.choices[0].message.content.split(',').map(t => t.trim())
  }
})
```

When `maxMemoriesPerTopic` is reached, the oldest memory for that topic is evicted automatically.

## Schema

Two tables:

```sql
memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  topics     TEXT NOT NULL,  -- JSON array
  created_at TEXT NOT NULL
)

topic_index (
  word      TEXT NOT NULL,
  memory_id INTEGER NOT NULL,
  PRIMARY KEY (word, memory_id)
)
```

No hashes. No UUIDs. No proprietary formats.

## Custom Adapter

Implement the `Adapter` interface to bring your own storage backend:

```ts
import type { Adapter, Memory } from '@saluca/asphodel'

class MyAdapter implements Adapter {
  async init(): Promise<void> { ... }
  async insert(content: string, topics: string[]): Promise<number> { ... }
  async recall(topic: string, limit: number): Promise<Memory[]> { ... }
  async search(query: string, limit: number): Promise<Memory[]> { ... }
  async forget(id: number): Promise<boolean> { ... }
  async list(limit: number, offset: number): Promise<Memory[]> { ... }
  async close(): Promise<void> { ... }
}
```

## License

Functional Source License 1.1, Apache 2.0 Future License (`FSL-1.1-ALv2`), see [LICENSE](./LICENSE). Each version becomes available under the Apache License 2.0 on the second anniversary of its release. Copyright Saluca LLC.

The `@saluca/asphodel` releases that were on npm (0.1.0 and 0.4.0) were published with an `Apache-2.0` licence field, and copies of those releases remain licensed under Apache 2.0. The name was removed from the npm registry on 2026-09-16.

Enterprise features (hash-chained audit trails, multi-tenant isolation, compliance controls) are available at [asphodel.ai](https://asphodel.ai).