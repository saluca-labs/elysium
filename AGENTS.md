# AGENTS.md

Instructions for AI coding agents working in this repository.

## What this is

The source of Asphodel (`@saluca/asphodel` 0.3.0), a TypeScript library for local-first agent memory: integer ids, a topic-word index, full-text search and optional hybrid vector search, on SQLite or Postgres. The repository is named elysium; the package inside is `@saluca/asphodel`. It is a library, not a server or CLI, and it is not on npm.

## Read in this order

1. [README.md](README.md): the "Not published from this repo" note, "How it works" and the correction note in Status.
2. [src/store.ts](src/store.ts): the whole `Asphodel` API, including deduplication and the `hybridSearch` ranking.
3. [src/types.ts](src/types.ts): the `Adapter` and `HybridProvider` interfaces and every option type.
4. [src/adapters/sqlite.ts](src/adapters/sqlite.ts): the schema, FTS5 triggers and the per-topic cap.
5. [tests/asphodel.test.ts](tests/asphodel.test.ts): what is actually exercised (SQLite only).

## What you can and cannot see

- You can see the whole library and its SQLite tests.
- Nothing here tests `PostgresAdapter`, `LocalHybridProvider` or `AsphodelStore`; treat their behaviour as read from the code, not verified.
- The `@saluca/asphodel` 0.4.0 that was once on npm was built from a different repository; its successor line is vendored in [tartarus-mcp](https://github.com/saluca-labs/tartarus-mcp). Do not assume 0.4.0 features (importance, TTL, persona scope, exact-content dedup) exist here.
- `src/tartarus.ts`'s doc comment shows `import { createServer } from 'tartarus-mcp'`; that export does not exist.
- Embedding and rerank models are GGUF files the caller supplies; none are in the repo.

## Using it as an agent

```bash
git clone https://github.com/saluca-labs/elysium.git && cd elysium
npm ci --ignore-scripts=false && npm run build
node examples/quickstart.mjs          # remember, recall, search, hybridSearch, forget, list
```

From another local project: `npm install ../elysium`, then:

```ts
import { Asphodel, SQLiteAdapter } from '@saluca/asphodel'
const db = new Asphodel(new SQLiteAdapter('/path/to/memory.db'))
await db.init()
await db.remember('user prefers dark mode', { topics: ['preferences'] })
const hits = await db.recall('preferences')
```

## The only numbers to trust

| Number | Value | Source |
|---|---|---|
| Version | 0.3.0, never published | `package.json` |
| Tests | 23, SQLite only | `it(` in `tests/asphodel.test.ts` |
| Default recall and search limit | 10 | `DEFAULT_RECALL_LIMIT`, `DEFAULT_SEARCH_LIMIT` in `src/store.ts` |
| Default list limit | 20 | `DEFAULT_LIST_LIMIT` in `src/store.ts` |
| Topics per memory | at most 10 by default | `DEFAULT_MAX_TOPICS` in `src/store.ts` (`maxTopicsPerMemory`) |
| Memories indexed per topic word | the newest 10 by default | `maxMemoriesPerTopic` in `src/adapters/sqlite.ts` and `src/adapters/postgres.ts` |
| Semantic duplicate threshold | cosine 0.95 | `DEDUP_THRESHOLD` in `src/hybrid/dedup.ts` |
| Fusion weights | BM25 0.75, vector 0.60, HyDE 0.40; RRF k = 60 | `hybridSearch()` in `src/store.ts`, `RRF_K` in `src/hybrid/rrf.ts` |
| Rerank candidates | top 40 | `hybridSearch()` in `src/store.ts` |
| Default embedding dimensions | 384 | `LocalHybridProvider` constructor, `src/hybrid/local.ts` |
| Runtime dependencies | 1 (`better-sqlite3`), plus 3 optional peers | `package.json` |

No retrieval-quality or speed figure has a source in this repo; do not state one.

## Setup

```bash
npm ci --ignore-scripts=false   # better-sqlite3 needs its install script for the native binding
npm run build                   # tsc -> dist/ (CommonJS)
```

Node.js 18 or later; CI uses Node.js 20 on Ubuntu.

## Test

```bash
npm test                  # vitest: tests/asphodel.test.ts, SQLite in memory
npx tsc --noEmit
npm run check:meta        # package name, private flag, licence, repository URL
npm audit --audit-level=low
node examples/quickstart.mjs   # after npm run build; output should match the README Quickstart
```

Passing looks like: vitest reports 23 passed, `check:meta` prints `OK:`.

## Conventions

- TypeScript, one runtime dependency (`better-sqlite3`); `pg`, `sqlite-vec` and `node-llama-cpp` are optional peers. Do not add dependencies without a reason in the PR.
- The package stays `"private": true`. The `@saluca/asphodel` npm name is retired.
- If you change public API or schema, update `README.md` (including the Quickstart output and the diagrams), `llms.txt` and `llms-full.txt` in the same PR.
- No em-dashes in docs.

## Do not

- Publish to npm or add a publish workflow.
- Edit `dist/` (generated) or `package-lock.json` by hand.
- Commit secrets, hostnames, internal paths or personal emails.

## Done means

`npm run build`, `npm test`, `npx tsc --noEmit` and `npm run check:meta` pass, and `llms-full.txt` was regenerated if `README.md` or this file changed.
