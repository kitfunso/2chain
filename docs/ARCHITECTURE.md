# 2chain v2 — Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        MCP client (Claude Code, Cursor, etc.)        │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │  stdio (MCP protocol)
                                   ▼
                          ┌─────────────────┐
                          │  2chain MCP     │      bin/2chain-mcp.mjs
                          │  shim           │
                          └────────┬────────┘
                                   │  HTTP localhost
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Fastify API server                           │
│                                                                      │
│  ┌────────────────┐   ┌──────────────┐   ┌──────────────────────┐    │
│  │ /discover      │   │  /push       │   │  /call               │    │
│  │ hybrid retrieve│   │  embed+evals │   │  ajv contract        │    │
│  │ +rerank        │   │  +status flip│   │  +circuit-break      │    │
│  └───────┬────────┘   └──────┬───────┘   └─────────┬────────────┘    │
│          │                   │                     │                 │
│          ▼                   ▼                     ▼                 │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │             Storage interface (src/storage/index.ts)       │      │
│  │   ┌─────────────────────┐    ┌─────────────────────────┐   │      │
│  │   │  SqliteStorage      │ OR │  PostgresStorage        │   │      │
│  │   │  + sqlite-vec       │    │  + pgvector + tsvector  │   │      │
│  │   │  (personal)         │    │  (enterprise)           │   │      │
│  │   └─────────────────────┘    └─────────────────────────┘   │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │           Embedder interface (src/embeddings/index.ts)     │      │
│  │   ┌──────────┐   ┌──────────────────┐   ┌──────────────┐   │      │
│  │   │ Ollama   │   │ transformers.js  │   │ Voyage/OpenAI│   │      │
│  │   │ (default)│   │ (fully embedded) │   │ (optional)   │   │      │
│  │   └──────────┘   └──────────────────┘   └──────────────┘   │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌────────────────┐                                                  │
│  │  /events (SSE) │ ◄── LISTEN/NOTIFY (Postgres) or update_hook (SQLite)│
│  └────────────────┘                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Runtime | Node 24, TypeScript 5.6, ESM | Reuse v1 code, modern ESM-native |
| HTTP | Fastify 5 | Reused from v1, fast, schema-aware |
| Validation | ajv 8 | Reused from v1, JSON Schema canonical |
| MCP server | `@modelcontextprotocol/sdk` | Reused from v1, only client-facing surface |
| **Database (enterprise)** | **Postgres 16 + pgvector 0.7+** | Most ops teams already run Postgres; pgvector matches Atlas perf <5M tools |
| **Database (personal)** | **SQLite 3.44+ via better-sqlite3 + sqlite-vec 0.1+** | Zero install, in-process, ships in single binary |
| **Lexical (enterprise)** | Postgres `tsvector` + GIN index, `ts_rank_cd` | Built into Postgres, no extension needed |
| **Lexical (personal)** | SQLite FTS5 with BM25 ranking | Built into SQLite, BM25-correct |
| **Embedding (default)** | Ollama running `nomic-embed-text` (768d) | Free, local, no API key, ~50ms latency on M-series |
| **Embedding (embedded)** | `@xenova/transformers` running `gte-small` (384d) | Pure JS, ships in binary, no Ollama dependency |
| **Embedding (optional)** | Voyage AI, OpenAI, Cohere via plug-in | If user has keys, swap in for higher quality |
| Live updates (enterprise) | Postgres `LISTEN/NOTIFY` | Built-in pub/sub, no Redis |
| Live updates (personal) | better-sqlite3 `updateHook` | Synchronous in-process callback on row change |
| SSE transport | Fastify SSE + native EventSource | Reused from v1 |
| Eval runner | Node worker threads, 5s case timeout | Reused from v1 |
| Distribution (personal) | `npm i -g 2chain` + `pkg` single binary | One-line install for non-Docker users |
| Distribution (enterprise) | `docker compose up` (Postgres + 2chain) | Standard ops pattern |

## Repository Structure

```
2chain/
├── package.json                    # MIT license, deps locked, no Atlas/Voyage required
├── docker-compose.yml              # Enterprise tier: Postgres + 2chain server
├── docs/
│   ├── PRD.md                      # Product scope; sacred document
│   ├── ARCHITECTURE.md             # This file
│   └── plans/                      # Phase plans (one per work block)
├── CLAUDE.md                       # Non-negotiable AI session rules
├── src/
│   ├── types.ts                    # Shared types: Tool, EvalResult, Storage iface, Embedder iface
│   ├── server/
│   │   ├── index.ts                # buildServer(), wires routes + storage + embedder + live-updates
│   │   ├── auth.ts                 # API key middleware (sha256-hashed lookup)
│   │   ├── sse.ts                  # SSE broadcast manager
│   │   └── routes/
│   │       ├── discover.ts         # GET /discover -> storage.discoverHybrid()
│   │       ├── push.ts             # POST /push -> embed + evals + storage.upsert()
│   │       ├── call.ts             # POST /call -> ajv validation + tool stub + circuit-break
│   │       ├── reverify.ts         # POST /v1/reverify -> services/reverify.ts (sweep admin-only)
│   │       └── dashboard.ts        # GET / (HTML), /events (SSE), /state (snapshot)
│   ├── storage/
│   │   ├── index.ts                # Storage interface; selects driver via env
│   │   ├── sqlite.ts               # SqliteStorage: better-sqlite3 + sqlite-vec
│   │   ├── postgres.ts             # PostgresStorage: node-postgres + pgvector
│   │   ├── migrations/             # SQL files run on first connect
│   │   │   ├── sqlite/             # SQLite-flavored DDL
│   │   │   └── postgres/           # Postgres-flavored DDL
│   │   └── rrf.sql                 # Reciprocal-rank-fusion CTEs (one per backend)
│   ├── embeddings/
│   │   ├── index.ts                # Embedder interface; selects driver via env
│   │   ├── ollama.ts               # OllamaEmbedder (localhost:11434/api/embeddings)
│   │   ├── transformersjs.ts       # TransformersJsEmbedder (Xenova/gte-small)
│   │   ├── voyage.ts               # Optional VoyageEmbedder (existing v1 code, salvaged)
│   │   └── openai.ts               # Optional OpenAIEmbedder
│   ├── services/
│   │   ├── discover.ts             # Hybrid retrieve: storage.runRRF() -> rerank()
│   │   ├── push.ts                 # Drift gate -> embed -> evalRunner -> storage.upsert()
│   │   ├── contractDiff.ts         # Pure JSON Schema differ + version ordering (E3, no storage)
│   │   ├── call.ts                 # ajv input -> tool stub -> ajv output -> circuit-break
│   │   ├── evalRunner.ts           # Run case fixtures -> reliability score
│   │   ├── runToolEvals.ts         # Shared push/reverify eval invocation (grader-policy parity)
│   │   ├── reverify.ts             # Re-run publish-time evals over the fleet; re-score, gate-drop rot
│   │   ├── graders.ts              # numeric_tolerance, regex, length, json_schema_array
│   │   └── rerank.ts               # Heuristic re-rank: term overlap x reliability x cost
│   ├── tools/                      # Bundled tool stubs (real-fetch + canned)
│   │   ├── secEdgar.ts             # Real SEC EDGAR XBRL client (preserved from v1)
│   │   ├── arxivSearch.ts          # Real arxiv Atom feed (preserved from v1)
│   │   ├── pdfExtractor.ts         # Stub from v1
│   │   ├── linter.ts               # Stub from v1
│   │   └── malformedBot.ts         # Stub from v1 (still returns prose)
│   ├── fixtures/
│   │   ├── tools.ts                # 14 hand-crafted specs (preserved)
│   │   ├── generated.ts            # 185 generated specs (preserved)
│   │   ├── cases.ts                # 15 eval cases (preserved)
│   │   └── agents.ts               # 3 demo agents (preserved)
│   └── live/
│       ├── postgres-listen.ts      # LISTEN tools_changed, push to SSE
│       └── sqlite-hook.ts          # updateHook callback, push to SSE
├── bin/
│   ├── 2chain.mjs                  # CLI: 2chain push|discover|call|reset
│   └── 2chain-mcp.mjs              # MCP stdio shim (preserved from v1)
├── scripts/
│   ├── seed-fixtures.ts            # Seeds 199 tools using selected embedder
│   ├── reset-demo-state.ts         # Wipes violations/usage, un-breaks circuit-broken
│   ├── setup-personal.ts           # First-run for SQLite tier (creates DB, runs migrations)
│   └── smoke/                      # Per-component smoke tests (real DB, no mocks)
└── public/
    └── dashboard.html              # Single-file dashboard, no build step
```

## Data Model

### Common across both backends

**Table: `tools`**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `namespace_id` | text NOT NULL DEFAULT `'default'` | Multi-tenant pre-wire — see Trust Boundaries below |
| `source_registry_id` | text NULL | For future federation (NULL = local registry) |
| `name` | text | |
| `version` | text | |
| `author_agent_id` | text | FK -> agents.id |
| `capability_text` | text | What we embed and search |
| `capability_embedding` | `vector(768)` (PG) / `BLOB` (SQLite via sqlite-vec) | Cosine-normalised, L2-unit-length |
| `input_contract` | jsonb (PG) / text (SQLite) | JSON Schema, depth + size capped at /push |
| `output_contract` | jsonb / text | JSON Schema, same caps |
| `output_repair_strategy` | text | `'fail-fast'` only in v2 |
| `endpoint_stub_name` | text | Maps to src/tools/*.ts |
| `metadata` | jsonb / text | `{cost_per_call_usd, p95_latency_ms, reliability_score}` |
| `status` | text | `'pending' \| 'active' \| 'circuit_broken'` |
| `domain` | text | For eval suite selection |
| `created_at`, `updated_at` | timestamptz | |
| **Unique** | `(namespace_id, name, version)` | |

`namespace_id` and `source_registry_id` are present from day 1 even though Phase 1 only uses `'default'`. Adding them later requires backfilling every dependent table; adding them now costs one column + one default. Same fields propagate to `eval_runs`, `usage`, `violations`, `rankings`.

**Indexes:**
- Postgres: HNSW on `capability_embedding` (m=16, ef_construction=200), GIN on `to_tsvector('english', capability_text)`, btree on `status`, btree on `metadata->>'reliability_score'`
- SQLite: sqlite-vec index on `capability_embedding`, FTS5 virtual table on `capability_text`, btree on `status`

**Table: `agents`** — `id, name, api_key_hash, role, created_at`. Same in both.

**Table: `eval_runs`** — `id, tool_id, triggered_at, triggered_by, cases (jsonb/text), pass_count, total_count, pass_rate, duration_ms`.

**Table: `usage`** — `id, tool_id, agent_id, call_id, query_capability_text, outcome, latency_ms, occurred_at`.

**Table: `violations`** — `id, tool_id, agent_id, call_id, attempt, stage, raw_response (jsonb/text), schema_errors (jsonb/text), repaired (bool), occurred_at`.

**Table: `rankings`** — append-only log of /discover results for the dashboard live ranking panel. `id, query_capability_text, mode, results (jsonb/text), occurred_at`.

### Backend differences

- Postgres uses `jsonb` everywhere SQLite uses `text` (JSON.stringify on write, JSON.parse on read).
- Postgres has `LISTEN/NOTIFY` channels: `tools_changed`, `usage_changed`, `violations_changed`, `rankings_changed`. Triggers on each table fire `NOTIFY`.
- SQLite uses `better-sqlite3.updateHook((op, db, table, rowid) => ...)` as the equivalent. Less granular but adequate.

## API Design

Unchanged from v1 — the whole point is wire-level compatibility.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | none | Liveness probe |
| `/discover` | GET | x-api-key | Hybrid retrieval, returns top-K |
| `/push` | POST | x-api-key (admin) | Register a new tool version |
| `/call` | POST | x-api-key | Invoke a tool with contract validation |
| `/v1/reverify` | POST | x-api-key (admin for full sweep; tool_author for single-tool) | Re-run publish-time evals, re-score reliability |
| `/state` | GET | none (read-only) | Snapshot for dashboard |
| `/events` | GET | none | SSE: `discover_ran`, `tool_invoked`, `tool_changed`, `eval_completed`, `violation_logged` |
| `/atlas-stats` | GET | none | Renamed `/db-stats` for v2; backend-agnostic stats |

MCP surface (stdio):
- `discover_tools(query, mode?, top?)` — wraps `/discover`
- `call_tool(tool_name, tool_version, input)` — wraps `/call`

## Service Boundaries

| Concern | Lives in | Does NOT touch |
|---|---|---|
| Hybrid retrieval (RRF) | `src/storage/{sqlite,postgres}.ts` | Anything HTTP, anything user-facing |
| Embedding | `src/embeddings/*.ts` | Storage layer, contract validation |
| Contract validation | `src/services/call.ts` (uses ajv) | Database driver internals |
| Re-verification | `src/services/reverify.ts` (shares `runToolEvals.ts` with push so grader policy cannot fork) | Status transitions (only `call.ts` flips `circuit_broken`), tools without an eval suite |
| Contract drift detection | `src/services/contractDiff.ts` (pure differ + version ordering); gate + event writes in `src/services/push.ts` | Storage, embeddings, HTTP — the differ is a pure module with no imports beyond shared types |
| Live updates | `src/live/*.ts` | HTTP handlers (only emits events; routes subscribe via SSE manager) |
| Tool stubs | `src/tools/*.ts` | Storage, embeddings, MCP — they're pure functions |
| MCP shim | `bin/2chain-mcp.mjs` | Storage directly (talks via HTTP only) |

**Hard rule:** `src/services/*` calls `src/storage/*` only through the `Storage` interface. No service file imports `pg` or `better-sqlite3` directly.

## Data Flow (primary use case: agent calls discover_tools then call_tool)

1. MCP client sends `discover_tools({query: "DCF for NVIDIA"})` over stdio.
2. `bin/2chain-mcp.mjs` translates to `GET /discover?q=...` against `localhost:3030`.
3. Fastify route `routes/discover.ts` calls `services/discover.ts`.
4. `discover.ts` calls `embedder.embed(query)` → 768-dim vector.
5. `discover.ts` calls `storage.runRRF(vec, query, topK=20, gate=0.80)`.
6. Storage executes one SQL CTE that combines vector ANN, FTS5/tsvector BM25, and reciprocal rank fusion server-side. Reliability gate is in the WHERE clause of both arms.
7. `discover.ts` runs in-memory rerank (term overlap + reliability boost + cost penalty) on the 20 candidates, returns top-5.
8. Response goes back through MCP shim to agent.
9. Agent picks tool, sends `call_tool({tool_name, version, input})`.
10. MCP shim → `POST /call` → `routes/call.ts` → `services/call.ts`.
11. `call.ts` reads tool record from `storage.getToolByNameVersion()`, validates input with ajv, calls `tools/{stub}.ts`, validates output with ajv.
12. On output violation: storage flips status to `circuit_broken` in same transaction that writes the violation row. Trigger fires `NOTIFY` (or updateHook), SSE pushes `tool_changed` to dashboard. Future `/discover` and `/call` see the new status.
13. On success: storage writes `usage` row, SSE pushes `tool_invoked`, dashboard flashes the row.

## Reciprocal Rank Fusion in SQL

The single most consequential difference from v1. Both backends use a CTE that joins a vector arm + text arm via `UNION ALL`, then sums `weight / (60 + rank)` and orders descending. The reliability gate goes into both arms before scoring, never after.

### SQLite flavor (canonical, written first because it's tighter)

```sql
WITH vec AS (
  SELECT v.rowid AS id,
         (1.0 - v.distance) AS vec_score,
         ROW_NUMBER() OVER (ORDER BY v.distance ASC) AS rank
  FROM tools_vec v
  JOIN tools t ON t.rowid = v.rowid
  WHERE v.embedding MATCH ? AND k = 50
    AND t.status = 'active'
    AND json_extract(t.metadata, '$.reliability_score') >= ?
    AND t.namespace_id = ?
),
txt AS (
  SELECT f.rowid AS id,
         ROW_NUMBER() OVER (ORDER BY bm25(tools_fts) ASC) AS rank
  FROM tools_fts f
  JOIN tools t ON t.rowid = f.rowid
  WHERE tools_fts MATCH ?
    AND t.status = 'active'
    AND json_extract(t.metadata, '$.reliability_score') >= ?
    AND t.namespace_id = ?
  LIMIT 50
),
fused AS (
  SELECT id, SUM(weight / (60.0 + rank)) AS rrf
  FROM (
    SELECT id, rank, ?vector_weight AS weight FROM vec
    UNION ALL
    SELECT id, rank, ?text_weight AS weight FROM txt
  ) x
  GROUP BY id
)
SELECT t.*, f.rrf, COALESCE(v.vec_score, 0) AS vec_score
FROM fused f
JOIN tools t ON t.rowid = f.id
LEFT JOIN vec v ON v.id = f.id
ORDER BY f.rrf DESC
LIMIT ?;
```

Notes:
- `vec0 MATCH` is the only acceptable predicate inside the vec subquery besides `k` and `rowid`. Reliability gate must live on the JOINed `tools` table, not the `vec0` virtual table.
- FTS5 `bm25()` is **lower-is-better**, so `ORDER BY bm25(tools_fts) ASC` is correct.
- `vec0` is declared `distance_metric=cosine`; combined with L2-normalized embeddings, `vec_score = 1.0 - distance` lands in [0, 2] and is monotonic with cosine similarity. The v1 hard relevance gate (`vec_score >= 0.70`) is recalibrated empirically per embedder during Phase 1 Step 6.5.

### Postgres flavor (Phase 2)

```sql
WITH
  vec AS (
    SELECT id,
           1.0 - (capability_embedding <=> $1) AS vec_score,
           ROW_NUMBER() OVER (ORDER BY capability_embedding <=> $1) AS rank
    FROM tools
    WHERE status = 'active'
      AND (metadata->>'reliability_score')::float >= $gate
      AND namespace_id = $namespace
    ORDER BY capability_embedding <=> $1
    LIMIT 50
  ),
  txt AS (
    SELECT id,
           ROW_NUMBER() OVER (ORDER BY paradedb.score(id) DESC) AS rank
    FROM tools
    WHERE status = 'active'
      AND (metadata->>'reliability_score')::float >= $gate
      AND namespace_id = $namespace
      AND id @@@ paradedb.match('capability_text', $2)
    LIMIT 50
  ),
  fused AS (
    SELECT id, SUM(weight / (60.0 + rank)) AS rrf
    FROM (
      SELECT id, rank, $vector_weight AS weight FROM vec
      UNION ALL
      SELECT id, rank, $text_weight AS weight FROM txt
    ) x
    GROUP BY id
  )
SELECT t.*, f.rrf, COALESCE(v.vec_score, 0) AS vec_score
FROM fused f
JOIN tools t USING (id)
LEFT JOIN vec v USING (id)
ORDER BY f.rrf DESC
LIMIT $top_k;
```

Postgres uses `pg_search` (ParadeDB BM25) instead of `tsvector + ts_rank_cd` — true BM25 puts retrieval quality at parity with v1. `paradedb.match` and `paradedb.score` are pg_search functions; `@@@` is its match operator.

Both queries are wrapped in `storage.runRRF()` so services never see SQL.

## Deployment

### Personal tier

```bash
npm i -g 2chain
2chain init           # Creates ~/.2chain/db.sqlite, runs migrations, prompts for embedder choice
2chain serve          # Starts Fastify on localhost:3030
```

Behind the scenes: better-sqlite3 + sqlite-vec ships in the npm package. First run downloads `nomic-embed-text` via Ollama (or `gte-small` via transformers.js if `--embedded` flag).

Single-binary distribution (post-MVP): `pkg` builds `2chain-mac-arm64`, `2chain-linux-x64`, `2chain-win-x64.exe`. ~120MB each (transformers.js + sqlite-vec + node).

### Enterprise tier

```yaml
# docker-compose.yml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: twochain
      POSTGRES_USER: twochain
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: [pgdata:/var/lib/postgresql/data]
  ollama:
    image: ollama/ollama:latest
    volumes: [ollama:/root/.ollama]
    command: ["sh", "-c", "ollama serve & sleep 2 && ollama pull nomic-embed-text && wait"]
  twochain:
    build: .
    environment:
      DATABASE_URL: postgres://twochain:${POSTGRES_PASSWORD}@postgres:5432/twochain
      EMBEDDER: ollama
      OLLAMA_HOST: http://ollama:11434
    depends_on: [postgres, ollama]
    ports: ["3030:3030"]
volumes:
  pgdata:
  ollama:
```

`docker compose up` is the entire install. First boot pulls the embedding model (~270MB). Migrations run automatically.

## Concurrency and write contention (SQLite)

SQLite is single-writer; `better-sqlite3` is synchronous. Without care, the combination of route handlers, the seed script, the eval runner, the change-stream-equivalent `updateHook`, and the SSE broadcaster all on one Node process turns into a classic re-entrancy / event-loop trap.

The model:
- **WAL mode + `busy_timeout = 5000`** declared in init migration. Multiple readers don't block the writer; readers see a consistent snapshot.
- **Single writer connection.** All writes route through `sqlite-write-queue.ts`, a sync queue. Routes `await` enqueue + drain.
- **Read-only snapshot connections.** Each route handler opens (or borrows from a pool) a connection with `readonly: true` for reads. Reads never wait on the writer.
- **`updateHook` is strictly minimal.** It only enqueues `{op, table, rowid}` to an in-memory queue. **No DB reads, no SSE broadcast inside the hook.** A separate async worker drains the queue using a read-only connection, fetches the row, and pushes to SSE.
- **SSE backpressure.** Per-channel queues cap at 1000 events. Slow clients get oldest-dropped, never block the writer.

This pattern is in `src/storage/sqlite-write-queue.ts` and `src/live/sqlite-hook.ts` from Phase 1 Step 4 + 9.

## Trust Boundaries

The v2 architecture treats the registry's contents as **first-party only**:
- Tool stubs (`src/tools/*.ts`) are bundled, code-reviewed, and shipped with the binary. They are not user-supplied at runtime.
- JSON Schemas in tool records are validated at `/push` time against size + depth limits (max 256 properties, max depth 8, max contract size 32KB) before being accepted into the registry.
- ajv is configured `allErrors: false` for any schema not authored by `author_agent_id` with role `admin`; admin-authored schemas may use `allErrors: true` for richer error reporting.
- Schema compile cache is LRU-bounded (1000 entries) to prevent unbounded memory growth.

These limits are non-negotiable in v2 (see `CLAUDE.md`).

What v2 explicitly does NOT support:
- **Untrusted user-supplied stubs.** Anyone wanting to publish their own stub forks the repo and rebuilds the binary. No upload-and-execute.
- **Cross-tenant leakage.** Even with `namespace_id` pre-wired, no cross-namespace queries are exposed in v2. Federation comes in v0.4+.
- **Network egress sandboxing.** When a stub like `sec-edgar-financials` calls SEC EDGAR, 2chain does not interpose a proxy; the network call goes out as the host process. Operator's responsibility to run 2chain inside whatever egress controls they want.

## Open architectural questions for v0.3+

- Multi-tenant enterprise mode (per-team registries with shared base) — `namespace_id` plumbed in v2; queries scope to it; cross-namespace policy in v0.3.
- Tool sandboxing — running user-supplied stubs in `worker_threads` or `child_process` with explicit network/fs allowlists. Out of scope for v2; trust boundary above documents the gap.
- Cross-registry federation — `source_registry_id` pre-wired; federation broker design + reputation propagation in v0.4.
