# AGENTS.md

Instructions for AI coding agents working in this repository.

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
- If you change public API or schema, update `README.md` (including the Quickstart output), `llms.txt` and `llms-full.txt` in the same PR.
- No em-dashes in docs.

## Do not

- Publish to npm or add a publish workflow.
- Edit `dist/` (generated) or `package-lock.json` by hand.
- Commit secrets, hostnames, internal paths or personal emails.

## Done means

`npm run build`, `npm test`, `npx tsc --noEmit` and `npm run check:meta` pass, and `llms-full.txt` was regenerated if `README.md` or this file changed.
