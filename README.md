# elysium

Asphodel (`@saluca/asphodel`): simple local-first memory storage for AI agents, as a TypeScript library. Integer IDs, topic-word index, SQLite and Postgres support.

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

## Status

Source-available library, version 0.3.0 in `package.json`, not published anywhere. What works today: the SQLite adapter (topic index, FTS5 full-text search, optional sqlite-vec vectors), the `Asphodel` API below, and `hybridSearch`, which falls back to full-text search when no embedding provider is set. CI runs the 23 SQLite tests in `tests/asphodel.test.ts`. The Postgres adapter, `LocalHybridProvider` (local GGUF models through `node-llama-cpp`) and `AsphodelStore` have no tests in this repo and were not run for this README.

> **Correction, 2026-10-22.** Earlier versions of this README said four things the code does not do:
>
> 1. *"auto-extracted topics: ["api", "key", "rotates"]"* for `"the API key rotates every 90 days"`. The built-in extractor keeps every non-stopword of three or more characters, up to `maxTopicsPerMemory`, so the result is `["api", "key", "rotates", "every", "days"]` (see Quickstart).
> 2. `maxMemoriesPerTopic` was shown as an `Asphodel` config option. `Asphodel` ignores it; the cap is set on the adapter: `new SQLiteAdapter({ maxMemoriesPerTopic })` or `new PostgresAdapter(url, maxMemoriesPerTopic)`.
> 3. *"the oldest memory for that topic is evicted"*. The oldest memory is removed from that topic's index only. It stays in `memories` and is still found by `search` and `list`.
> 4. *"Two tables"*. The SQLite adapter also creates an FTS5 table (`memories_fts`) with insert and delete triggers, a `recall_count` column, and, when `vectorDims` is set and sqlite-vec loads, a `memories_vec` table. The Postgres adapter adds a GIN full-text index.

## Install

This package is not available from npm (see the note above). Build it from source. Tested 2026-10-22 with Node.js 24.15 and npm 11.12 on Windows; CI uses Node.js 20 on Ubuntu (`engines` says `>=18`).

```bash
git clone https://github.com/saluca-labs/elysium.git
cd elysium
npm ci --ignore-scripts=false
npm run build
```

`--ignore-scripts=false` is needed only if your npm config sets `ignore-scripts=true`: the `better-sqlite3` dependency builds or downloads its native binding in an install script, and without it every test fails with "Could not locate the bindings file".

To use the build from another local project, depend on the directory, for example `npm install ../elysium`, then import it as `@saluca/asphodel` (the name in this repo's `package.json`).

For Postgres support, also install the peer dependency:

```bash
npm install pg
```

Vector search needs the optional peers `sqlite-vec` (SQLite vectors) and, for `LocalHybridProvider`, `node-llama-cpp` plus GGUF model files you supply.

## Quickstart

`examples/quickstart.mjs` runs the example above against the local build and a throwaway database:

```bash
npm run build
node examples/quickstart.mjs
```

Output from a run on 2026-10-22:

```text
remember -> 1 [ 'preferences', 'ui' ]
remember -> 2 [ 'api', 'key', 'rotates', 'every', 'days' ]
recall("preferences") -> [ 'user prefers dark mode' ]
search("rotates") -> [ 'the API key rotates every 90 days' ]
hybridSearch("API key") -> [ 'the API key rotates every 90 days' ] (no HybridProvider: full-text only)
forget(1) -> true
list() -> [ '2: the API key rotates every 90 days' ]
```

## Usage

### Adapters

#### SQLite (default)

```ts
import { Asphodel, SQLiteAdapter } from '@saluca/asphodel'

const db = new Asphodel(new SQLiteAdapter())
// or specify a path:
const db = new Asphodel(new SQLiteAdapter('/path/to/memory.db'))
// or options: { dbPath, maxMemoriesPerTopic, vectorDims }
const db = new Asphodel(new SQLiteAdapter({ dbPath: '/path/to/memory.db', maxMemoriesPerTopic: 10 }))
// or via env: ASPHODEL_DB (default ~/.asphodel/memory.db)
```

#### Postgres

```ts
import { Asphodel, PostgresAdapter } from '@saluca/asphodel'

const db = new Asphodel(new PostgresAdapter('postgresql://user:pass@host/db'))
// or via env: ASPHODEL_DATABASE_URL
// optional second argument: maxMemoriesPerTopic (default 10)
```

### API

#### `remember(content, options?)`

Store a memory. Topics are extracted automatically or provided explicitly.

```ts
const memory = await db.remember("the API key rotates every 90 days")
// auto-extracted topics: ["api", "key", "rotates", "every", "days"]

const memory = await db.remember("user prefers dark mode", {
  topics: ["preferences", "ui"]
})
```

#### `recall(topic, options?)`

Retrieve memories by topic word. Returns most recent first.

```ts
const memories = await db.recall("preferences")
const memories = await db.recall("preferences", { limit: 5 })
```

#### `search(query, options?)`

Full-text search across memory content.

```ts
const memories = await db.search("API key rotation")
```

#### `hybridSearch(query, options?)`

Full-text and vector results fused with reciprocal rank fusion, then temporal decay and an access-frequency boost, then an optional rerank. Options: `limit`, `decay` (default true), `hyde` (default false), `rerank` (default false). Without a `hybrid` provider in the config, or with an adapter that has no `vectorSearch`, it returns full-text results only.

```ts
const memories = await db.hybridSearch("API key", { limit: 5 })
```

#### `forget(id)`

Delete a memory by ID.

```ts
await db.forget(42)
```

#### `list(limit?, offset?)`

Page through all memories, most recent first.

```ts
const page = await db.list(20, 0)
```

#### `close()`

Release the database connection.

```ts
await db.close()
```

### Configuration

```ts
const db = new Asphodel(adapter, {
  maxTopicsPerMemory: 10,     // max topic words per memory (default: 10)

  // plug in your own AI topic extractor
  extractTopics: async (content) => {
    const response = await openai.chat.completions.create({ ... })
    return response.choices[0].message.content.split(',').map(t => t.trim())
  },

  // optional embedding provider; enables vectors in remember() and hybridSearch()
  hybrid: myHybridProvider,
})
```

The per-topic cap (`maxMemoriesPerTopic`, default 10) is an adapter option, not an `Asphodel` option. When a topic reaches it, the oldest memory is dropped from that topic's index; the memory itself is kept.

### Schema

The SQLite adapter creates:

```sql
memories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  content      TEXT NOT NULL,
  topics       TEXT NOT NULL DEFAULT '[]',  -- JSON array
  created_at   TEXT NOT NULL,
  recall_count INTEGER NOT NULL DEFAULT 0
)

topic_index (
  word      TEXT NOT NULL,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (word, memory_id)
)

memories_fts  -- FTS5 virtual table over memories.content, kept in sync by triggers
memories_vec  -- sqlite-vec table, only when vectorDims > 0 and sqlite-vec loads
```

The Postgres adapter creates `memories` and `topic_index` with a GIN full-text index on `content`.

No hashes. No UUIDs. No proprietary formats.

### Custom Adapter

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
  // optional, for hybridSearch: vectorInsert, vectorSearch, bumpRecallCount
}
```

## Architecture

`Asphodel` (`src/store.ts`) holds the API and delegates storage to an `Adapter` (`src/types.ts`).

- `src/adapters/sqlite.ts`: SQLite through `better-sqlite3`, FTS5 search, optional sqlite-vec vectors.
- `src/adapters/postgres.ts`: Postgres through `pg` (optional peer).
- `src/topic.ts`: the built-in stopword topic extractor.
- `src/hybrid/`: reciprocal rank fusion (`rrf.ts`), temporal decay (`decay.ts`), embedding normalisation and duplicate threshold (`dedup.ts`), and `LocalHybridProvider` (`local.ts`), which embeds, generates HyDE queries and reranks with local GGUF models through `node-llama-cpp`.
- `src/tartarus.ts`: `AsphodelStore`, an adapter from `Asphodel` to a store/recall/forget/stats interface with string ids, added as a Tartarus MCP adapter in commit `328a238`. The current tartarus-mcp does not use it; it vendors its own copy of the core.

```mermaid
flowchart LR
  API[Asphodel<br/>src/store.ts] --> AD{Adapter}
  AD --> SQ[SQLiteAdapter<br/>FTS5, sqlite-vec]
  AD --> PG[PostgresAdapter]
  API -. optional .-> HP[HybridProvider<br/>e.g. LocalHybridProvider]
```

## Citation

No archived record yet.

## License

Functional Source License 1.1, Apache 2.0 Future License (`FSL-1.1-ALv2`), see [LICENSE](./LICENSE). Each version becomes available under the Apache License 2.0 on the second anniversary of its release. Copyright Saluca LLC.

The `@saluca/asphodel` releases that were on npm (0.1.0 and 0.4.0) were published with an `Apache-2.0` licence field, and copies of those releases remain licensed under Apache 2.0. The name was removed from the npm registry on 2026-09-16.

GitHub shows this repository's licence as "Other" because its licence detector does not include the FSL; the SPDX identifier is `FSL-1.1-ALv2`.

## Links

- [tartarus-mcp](https://github.com/saluca-labs/tartarus-mcp): the MCP memory server, which vendors an Apache-2.0 copy of the Asphodel core
- Enterprise features (hash-chained audit trails, multi-tenant isolation, compliance controls) are available at [asphodel.ai](https://asphodel.ai).
- [llms.txt](./llms.txt): a link map of this repo for AI agents

_Last updated: 2026-10-22_
