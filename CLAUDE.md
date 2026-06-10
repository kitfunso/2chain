# CLAUDE.md — 2chain v2

## Project Overview

2chain is a self-hostable tool registry for AI agents. It picks the right tool from many candidates via hybrid retrieval, gates by reliability, and validates every response on the wire. v2 strips the Atlas + Voyage dependencies so the same architecture runs on a laptop (SQLite + sqlite-vec) or behind a corporate firewall (Postgres + pgvector). MCP-native interface; Fastify + ajv + TypeScript backend.

## Architecture

See `docs/ARCHITECTURE.md` for the full picture. Two-line summary: services call `Storage` and `Embedder` interfaces only; concrete drivers (SQLite/Postgres, Ollama/transformers.js) live behind those interfaces and never leak into business logic.

## Non-Negotiable Rules

1. **Never import `pg` or `better-sqlite3` from `src/services/` or `src/server/routes/`.** Storage is accessed only via the `Storage` interface. Why: swapping personal ↔ enterprise must be a single env var, not a code change.

2. **Never call an embedding API from `src/services/`.** Embedding is accessed only via the `Embedder` interface. Why: same reason — Ollama, transformers.js, Voyage, OpenAI must be hot-swappable.

3. **No managed cloud SDK as a hard dependency.** The MongoDB driver, Voyage SDK, and Pinecone client must NOT appear in `package.json#dependencies`. They may appear under `optionalDependencies` if a user wants to plug them in. Why: enterprise procurement rejects projects with cloud SDKs in deps.

4. **License must stay MIT or Apache 2.0.** Never accept a transitive AGPL/SSPL dependency. Why: the whole point is enterprise adoption.

5. **No mocks in tests.** Tests run against a real SQLite or real Postgres (whichever the dev has running). Use `tmp_path` fixtures for SQLite, ephemeral schemas for Postgres. Why: locked from v1, mocks made the v1 cutover painful.

6. **Output contracts are enforced on every call, no exceptions.** ajv validation in `src/services/call.ts` is not optional, not configurable, not gated behind a feature flag. Why: this is the product's core trust layer; bypassing it defeats the registry's purpose.

7. **Reliability gate is enforced inside the SQL retrieval, not after.** `WHERE metadata.reliability_score >= 0.80` goes into both vector and text sub-queries. Why: filtering after retrieval wastes index work and lets bad tools influence ranking via false neighbours.

8. **Never break the demo.** The five demo prompts (DCF, arxiv, PR review, security audit, malformed-bot) must pass end-to-end on every commit to `master`. CI runs them. Why: the demo is the artifact judges, users, and stakeholders see; regressions kill momentum.

9. **No telemetry, no phone-home, no analytics-by-default.** v2 targets enterprise. Anything that calls out to a third party must be opt-in via env var, documented in README, off in the default config. Why: trust.

10. **`npm install` must succeed on a fresh Node 24 install with no native build tools.** Native deps (better-sqlite3, sqlite-vec) must ship prebuilt binaries on Windows x64, macOS arm64, and Linux x64. CI cross-OS smoke (`.github/workflows/v2-install-smoke.yml`) is the gate. Why: personal tier promise is "it just works" on every platform a solo dev runs.

11. **JSON Schema contracts are size + depth bounded.** Max 256 properties, max depth 8, max contract size 32KB enforced at `/push` time. ajv runs with `allErrors: false` for any schema not authored by an admin agent. Schema compile cache is LRU-bounded (1000 entries). Why: an unbounded schema is a CPU/memory DoS vector; the registry is internet-adjacent via MCP and must assume hostile inputs even on personal tier.

12. **Tool stubs are first-party only in v2.** All stubs live under `src/tools/` and ship with the binary. No upload-and-execute, no `eval`, no `Function` constructor, no dynamic `import()` from a URL. User-supplied stubs require worker/process isolation and arrive in v0.4+. Why: in-process stubs share the registry's memory and event loop; running untrusted code inside the same process defeats every other safety control.

13. **SQLite writes are queue-serialized; updateHook never reads.** All writes route through `src/storage/sqlite-write-queue.ts`. The `updateHook` callback only enqueues `{op, table, rowid}` to an in-memory queue; a separate async worker drains it using a read-only snapshot connection. Why: reading inside the hook re-enters SQLite during a write transaction and can deadlock the event loop; this pattern was discovered in outside-voice review before Phase 1 Step 9.

14. **Embedder swaps require a quantitative parity bar.** Any change to the embedding model (nomic-embed-text → mxbai-embed-large, → bge-large, etc.) must clear all three floors against the v2-native baseline (`tests/fixtures/v2-baseline-native.json`):

    - **NDCG@3** ≥ baseline `mean - 2 * stddev`
    - **Recall@3** drop ≤ 10% vs baseline mean
    - **Single-tool-unambiguous top-1 hit rate** ≥ baseline `mean - 2 * stddev` (catches "the corpus's canonical answer to a clear query stopped winning" regressions)

    NDCG@3 formula is pinned in `src/eval/ndcg.ts` and locked by `tests/v2-eval-ndcg.test.ts`: `gain(rel) = 2^rel - 1`, `discount(r) = log2(r + 1)` with r starting at 1, stable name+version tie-break on equal RRF score. Runner: `scripts/smoke/v2-golden-v2native.ts`. Demo-arc 10/10 gate from earlier revisions is dropped (user directive 2026-05-23). The v1-Voyage baseline (`tests/fixtures/legacy/v1-baseline.json`) is retained for diagnostic comparison but is no longer the gate. Why: a model swap that silently degrades retrieval is the easiest way to break agent trust, and the only way to catch it is to measure.

## Coding Conventions

- TypeScript 5.6, strict mode on (`"strict": true` in tsconfig), no `any` outside test fixtures.
- ESM only. Use `.js` extensions on import paths (Node ESM requirement).
- Imports grouped: stdlib → external → internal, alphabetical within group.
- Errors are typed (`class StorageError extends Error { code: string }`), never plain strings thrown.
- Logging via Fastify's pino logger; never `console.log` in `src/`.
- Tests live in `tests/` for unit, `scripts/smoke/` for integration; both run with `tsx --test`.
- Database access goes through `Storage` interface. Migrations are SQL files under `src/storage/migrations/{sqlite,postgres}/`, applied in lex order on startup.

## Critical Files

Read these before modifying their area:

- `src/types.ts` — shared types and the `Storage` / `Embedder` interfaces. Source of truth for cross-module contracts.
- `src/storage/index.ts` — driver selection logic. Edit with care; both backends must remain interchangeable.
- `src/storage/sqlite.ts` and `src/storage/postgres.ts` — keep behaviorally equivalent. If you change one, change the other.
- `src/services/call.ts` — the contract enforcement layer. Bugs here break trust.
- `src/services/discover.ts` — the hybrid retrieval orchestrator.
- `src/embeddings/index.ts` — embedder selection logic. Same care as storage.
- `docs/PRD.md` — scope guard. Check the "IS NOT" list before adding any feature.

## Safety Rules

- **API keys are sha256-hashed in the database.** Never store plaintext keys, never log them, never echo them back in responses.
- **Tool stubs are sandboxed by HTTP boundary, not by VM.** v2 does not run untrusted user-supplied code; bundled stubs are first-party. If a user wants to add their own stub, they fork the repo. Do not eval/Function/import-from-URL inside services.
- **No SQL string interpolation.** Use parameterised queries. Both pg and better-sqlite3 expose them.
- **Migrations are forward-only, idempotent, and tracked in a `_migrations` table.** No down-migrations. Why: nobody actually runs down-migrations safely in production.

## Common Mistakes to Avoid

- **Importing `better-sqlite3` types in service code.** Looks innocent, drags Node-binding types into otherwise-portable modules. Use the `Storage` interface types only.
- **Forgetting that `additionalProperties: false` in input contracts breaks MCP clients.** Claude Code and others add metadata fields to tool inputs. Default to `additionalProperties: true` on inputs (output stays strict). Documented incident from v1.
- **Embedding the query at request time without caching.** Pre-warm common queries at server boot; cache in-memory by query text. Saves real latency.
- **Running pgvector queries without `LIMIT` before `ORDER BY embedding <=>`.** ANN index requires the limit hint. Without it, Postgres falls back to a sequential scan.
- **Assuming `LISTEN/NOTIFY` payloads are larger than 8000 bytes.** They aren't. Use the notify body for IDs/keys, fetch detail in the SSE handler.
- **Writing SQL specific to one backend in `src/services/`.** All SQL goes in `src/storage/{sqlite,postgres}.ts`. Period.
- **Reading from inside `updateHook`.** Re-enters SQLite during a write transaction; deadlocks the event loop. The hook only enqueues; the drain worker reads on a read-only snapshot connection. See rule 13.
- **Forgetting to L2-normalize embeddings before vec0 cosine.** sqlite-vec computes raw cosine distance; if inputs aren't unit length, "distance" is no longer monotonic with similarity. The Embedder normalizes on output; if you swap implementations, normalize there too.
- **`vec0` virtual tables don't update in place.** UPDATE on a base-table row requires DELETE + INSERT inside the trigger to refresh the vec0 row. See `001_init.sql` `tools_au` trigger.
- **`bm25()` in FTS5 is lower-is-better.** Order ASC, not DESC. Easy to miss because every other ranking function in SQL goes the other way.
- **Skills, subagents, and prompts are discovery-only.** `/call` rejects all three with `code: 'kind_not_callable'` — see `src/services/call.ts`. Skills are loaded into agent context, subagents are spawned via the Task tool, prompts are rendered into context. 'prompt' joined the gate in E2 (2026-06-10): a callable prompt could circuit-break and then be skipped forever by reverify's catalog-kind partition — a dead end recovery can never reach. Don't try to forward through the catalog-only-stub.

## Update Triggers

- New feature → check PRD `IS NOT` list, then update PRD, then ARCHITECTURE if it adds a service boundary, then write a plan in `docs/plans/`.
- New gotcha discovered → add to "Common Mistakes" with the date and a one-sentence explanation.
- New non-negotiable → add to "Non-Negotiable Rules" immediately, with a `Why:` line.
- Architecture decision (new dependency, new module, swapped technology) → add an entry in `ARCHITECTURE.md` and a one-line note here pointing to it.
