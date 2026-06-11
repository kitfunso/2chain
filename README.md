# 2chain

**Live registry: [2chain.dev](https://2chain.dev)**

**A self-hostable tool registry for AI agents — hybrid retrieval, reliability gating, JSON Schema contract enforcement, and a continuous-verification CI layer.** Agents fail silently when tool schemas drift, APIs change, or outputs violate contracts. 2chain catches the rot at the registry, before your agent eats the failure live.

Two ways to run:

- **Personal tier (v2, current)** — SQLite + sqlite-vec + FTS5 + Ollama (`nomic-embed-text`). Zero cloud dependencies. `npm run setup:personal && npm run seed:v2 && npm run dev:v2`. 341 tools (199 demo fixtures + 142 real-corpus catalog) embedded in ~2.6s on local Ollama.
- **Hackathon demo (v1, legacy)** — MongoDB Atlas Vector Search + `$rankFusion` + Voyage AI. The original submission for the MongoDB Agentic Evolution Hackathon, May 2026. See [v1 origin](#v1--the-mongodb-atlas-hackathon-origin-may-2026).

Both run the same agent-facing surface: `/discover` (hybrid retrieval), `/push` (eval + register), `/call` (contract-enforced invocation), MCP server, live SSE dashboard. v2 adds the CI layer on top: scheduled re-verification, contract drift gating, evidence-blended reliability with circuit recovery, a per-tool health surface, and freshness-aware ranking.

🎬 **60-second demo video**: [youtu.be/puINYgtQXdM](https://youtu.be/puINYgtQXdM)

📊 **v1 -> v2 retrieval baseline**: [docs/perf/phase-1-baseline.md](./docs/perf/phase-1-baseline.md)

---

## Quick start (Personal tier, v2)

```bash
# 1. Install Ollama and pull the embedder
curl -fsSL https://ollama.com/install.sh | sh   # or download from ollama.com
ollama pull nomic-embed-text

# 2. Install + preflight + seed + run
npm install
npm run setup:personal     # 5 hard checks: Ollama reachable, model present,
                           # sqlite-vec loadable, ~/.2chain writable, warm probe
npm run seed:v2            # 341 tools (199 demo + 142 real catalog), ~2.6s
npm run dev:v2             # http://localhost:3030

# 3. Verify retrieval quality end-to-end
npm run smoke:v2           # mixed-kind discovery smoke + golden retrieval eval
```

To grow the catalog: edit `src/fixtures/real-corpus.ts` (12 domains pre-seeded with named, real-world tool specs from MCP registry, public APIs, well-known SaaS) and re-run `npm run seed:v2`.

To **disable** the catalog (just the 199 demo fixtures): `INCLUDE_REAL_CORPUS=false npm run seed:v2`.

---

## The CI layer — continuous verification

Most registries score a tool once, at publish time, and never look again. A tool that rots after publish is caught by the first agent unlucky enough to call it. 2chain's CI layer (shipped June 2026) closes that gap with five mechanisms, all behind the `Storage` interface:

### 1. Scheduled re-verification (the CI core)

Every active tool's publish-time eval suite can be re-run on demand (`POST /v1/reverify`, `2chain reverify [--tool name]`) or continuously (`REVERIFY_INTERVAL_MIN=...`, opt-in, off by default). Each run persists to a `verification_runs` time series; failures feed the reliability blend so a broken tool drops below the 0.80 discovery gate without any agent-side change. Rankings refresh once per completed sweep, never mid-sweep.

### 2. Contract drift detection on `/push`

Pushing a new version diffs both contracts against the predecessor baseline and classifies every change per JSON path: **breaking** (removed/retyped fields, narrowed enums, tightened requirements) or **compatible** (additive, optional). Breaking pushes are rejected unless the version takes a major bump (`breaking_contract_requires_major_bump`, exact offending paths in `error.details`). All drift — accepted or rejected, input and output — lands in a `drift_events` table for the health surface.

### 3. Evidence-blended reliability + circuit recovery

`reliability_score` is no longer a one-shot pass rate. It blends an eval leg (weight 0.8, 7-day half-life decay over verification history) with a live usage leg (weight 0.2, ok vs output-violations + timeouts). Caller-fault input violations count nowhere — hostile callers can't tank a good tool. And `circuit_broken` is no longer a dead end: 3 clean re-verification runs spanning at least 60 minutes flip a recovered tool back to active, automatically.

### 4. Tool health surface

One place to answer "can I trust this tool right now": `GET /v1/tools/:name/health` (API), `2chain health <name>` (CLI), and a live dashboard panel (`/health-view/:name`, SSE-refreshed). Reports current score, score history, last-verified timestamp, verification streak, open drift events, and version history.

### 5. Freshness-aware discovery

Discovery results are re-sorted by `final_score = rrf_score + 0.0005 x freshness`, where freshness decays with a 7-day half-life from the last clean verification. Every result surface (HTTP route, SSE feed, dashboard, MCP payload) carries `last_verified_at`, `verification_streak`, `freshness`, and `final_score`, so agents themselves can weigh staleness at selection time. Unverified means stale, by design — fresh imports earn freshness through a sweep, not by existing.

The remaining known gap (importers bypass the drift gate) is tracked as the top item in [ROADMAP.md](./ROADMAP.md).

---

## What it does

```
┌──────────────────┐                                            ┌──────────────┐
│  caller agent    │ ── "Extract tables from PDF" ─────────►   │  /discover   │
└──────────────────┘                                            └──────┬───────┘
                                                                       │
              ┌────────────────────────────────────────────────────────┤
              │ RRF fusion: sqlite-vec (cosine) + FTS5 (BM25), k=60    │
              │ reliability >= 0.80 gate INSIDE both sub-queries       │
              │ freshness re-sort: final = rrf + 0.0005·freshness      │
              │ dedupe by tool name (latest version wins)              │
              └────────────────────────────────────────────────────────┘
                                                                       │
                         ┌───────────────────────────────────────┐     │
   tool author ──────►   │  /push   bounds + drift gate + embed  │  ◄──┘ ranked top-N
                         │          + inline evals + rel score   │      visible to agent
                         └───────────────────────────────────────┘
                                                                       │
                         ┌───────────────────────────────────────┐     │
   caller agent ────►    │  /call   input contract + stub +      │  ◄──┘
                         │          output contract + circuit-   │
                         │          break on violation           │
                         └───────────────┬───────────────────────┘
                                         │
                         ┌───────────────▼───────────────────────┐
                         │  /v1/reverify   re-run eval suites    │
                         │  on schedule; blend scores; recover   │
                         │  circuit-broken tools that healed     │
                         └───────────────────────────────────────┘
```

**How the trust layers stack** (in pipeline order):

1. **Contract bounds at `/push`** — max 256 properties, max depth 8, max 32KB per schema. An unbounded schema is a DoS vector; the registry assumes hostile input even on personal tier.
2. **Drift gate at `/push`** — breaking contract changes require a major version bump; all drift is recorded.
3. **Reliability gate inside the SQL** — `reliability_score >= 0.80` is enforced in both retrieval sub-queries, not filtered after. Bad tools never even score.
4. **Contract enforcement at `/call`** — every input and output is ajv-validated against the tool's JSON Schema. Tools that lie circuit-break (`fail-fast`) and subsequent calls 503 without re-invoking the stub.
5. **Continuous re-verification** — the registry re-tests tools so rot is caught proactively, scores decay toward current evidence, and recovered tools earn their way back.
6. **Freshness at selection** — agents see and prefer recently-verified tools.

---

## Tool kinds

The registry indexes four discriminated kinds of unit, all sharing the same retrieval pipeline (RRF over sqlite-vec + FTS5) and discovery surface (`/discover` returns `tool_kind` on every result):

- **`tool`** — RPC-style endpoints with JSON Schema input/output contracts. Default. The original 2chain unit.
- **`skill`** — Anthropic Claude Code skills (`~/.claude/skills/<slug>/SKILL.md`). Discovery-only; agents load matched skills into context rather than calling them. Imported via `npm run import:skills`.
- **`subagent`** — Claude Code subagents (`~/.claude/agents/*.md`). Discovery-only; agents spawn matched subagents via the Task tool. Imported via `npm run import:subagents`.
- **`prompt`** — Curated parameterised prompt templates with `{{var}}` substitution. Discovery-only; `/call` answers `kind_not_callable` and the agent renders the template into context. Seeded from `src/import/prompts-seed.ts` (12 templates: commit, PR, postmortem, grant impact, etc.). Imported via `npm run import:prompts`.

Schema discriminator is `tools.tool_kind` (CHECK-constrained, default `'tool'`). Filter by kind: `storage.listTools({ kind: 'skill' })`. End-to-end smoke: `npm run smoke:v2:mixed`.

---

## API surface

| Endpoint | Auth | What it does |
|---|---|---|
| `GET /discover?q=...&top=N` | any key | Hybrid retrieval, gated + freshness-ranked, returns `final_score`, `freshness`, `last_verified_at`, `verification_streak` per result |
| `POST /push` | tool_author / admin | Register a tool version: bounds check, drift gate, embed, inline evals, reliability score |
| `POST /call` | any key | Invoke a tool with full input/output contract enforcement |
| `POST /v1/reverify` | admin (tool-filtered: tool_author too) | Trigger a re-verification sweep (whole registry or one tool) |
| `GET /v1/tools/:name/health` | caller / tool_author / admin | Full health report: score history, streak, drift events, versions |
| `GET /health-view/:name` | none (dashboard-scoped) | Same report for the dashboard panel |
| `GET /` + `/events` + `/state` | none | Live dashboard (HTML, SSE stream, snapshot) |

## CLI

```bash
node bin/2chain.mjs push tool.json        # register
node bin/2chain.mjs discover "lint js"    # search (shows final_score + freshness)
node bin/2chain.mjs call <name> <ver> '{...}'
node bin/2chain.mjs reverify [--tool X]   # trigger a CI sweep
node bin/2chain.mjs health <name>         # health report table
```

Env: `2CHAIN_HOST` (default `http://127.0.0.1:3030`), `2CHAIN_API_KEY` (author key), `2CHAIN_AGENT_KEY` (caller key).

---

## Live agent demo (MCP)

2chain ships an MCP server so Claude Code (and any MCP-compatible agent) can use the registry natively. Configure it in your MCP client:

```json
{
  "mcpServers": {
    "2chain": {
      "command": "node",
      "args": ["/path/to/2chain/bin/2chain-mcp.mjs"],
      "env": {
        "TWOCHAIN_HOST": "http://127.0.0.1:3030",
        "TWOCHAIN_API_KEY": "sk_demo_pdf_agent_8f2c4a"
      }
    }
  }
}
```

The MCP server exposes two tools:

- **`discover_tools(query, mode?, top?)`** — search the registry, get a ranked table with reliability scores, freshness, and `final_score` (the actual ordering key). Returns only tools that pass the 0.80 reliability gate. All agent-visible text is sanitised against output-injection (control characters and Unicode line breaks stripped).
- **`call_tool(tool_name, tool_version, input)`** — invoke a tool. Input/output schemas are enforced; bad responses circuit-break the tool automatically.

After configuring the MCP server, prompts like *"extract the line items from this PDF text"* or *"lint this JavaScript for bugs"* trigger Claude to call `discover_tools`, pick the right tool, then call it via `call_tool` — all visible on the dashboard's live call feed in real time.

See [demo/prompts.md](./demo/prompts.md) for ready-to-paste demo prompts covering financial extraction, code review, security scanning, summarisation, contract violations, and live re-ranking.

---

## Project layout

```
src/
├── types.ts                Shared types + the Storage / Embedder interfaces
│                           (source of truth for cross-module contracts)
├── storage/
│   ├── index.ts            Driver selection (STORAGE_DRIVER env var)
│   ├── sqlite.ts           SqliteStorage (better-sqlite3 + sqlite-vec + FTS5)
│   ├── sqlite-write-queue.ts  All writes serialize through here (see CLAUDE.md rule 13)
│   └── migrations/sqlite/  001_init, 002_tool_kind, 003_drift_events
├── embeddings/             Embedder selection: ollama.ts (default) / voyage.ts (v1) + query cache
├── services/
│   ├── discover.ts         RRF orchestrator + reliability gate + freshness re-sort
│   ├── push.ts             bounds -> drift gate -> embed -> evals -> active
│   ├── call.ts             ajv contract enforcement + circuit-break
│   ├── reverify.ts         CI sweep engine (sweep coalescing, post-sweep rerank)
│   ├── contractDiff.ts     Pure breaking/compatible differ (per-JSON-path)
│   ├── scoreLifecycle.ts   Evidence blend + circuit-recovery rules (pure)
│   ├── health.ts           Health report aggregator (read-only)
│   ├── streak.ts           Verification-streak helper (pure)
│   ├── contract-bounds.ts  256-prop / depth-8 / 32KB schema limits
│   ├── runToolEvals.ts     Shared eval runner (push + reverify parity)
│   └── stubs.ts            First-party in-process tool stubs (see CLAUDE.md rule 12)
├── import/                 Catalog importers: MCP registry, npm, PyPI, HF, skills, subagents, prompts
├── eval/ndcg.ts            Locked NDCG@3 formula for the golden retrieval eval
├── fixtures/               Demo fixtures + real-corpus catalog + eval cases
└── server/
    ├── index.ts            buildServer() + SSE wiring + reverify interval
    └── routes/             discover, push, call, reverify, health, dashboard

bin/2chain.mjs              CLI: push | discover | call | reverify | health
bin/2chain-mcp.mjs          MCP stdio server
bin/mcp-format.mjs          Injection-hardened MCP output formatting (no side effects)
scripts/                    Seed, smoke tests, golden eval, importers/scrapers
tests/                      24 real-DB test suites (no mocks), tsx --test
```

---

## NPM scripts (v2)

| Script | Purpose |
|---|---|
| `npm run dev:v2` | Start the v2 server (SQLite + Ollama) on `localhost:3030` |
| `npm run setup:personal` | Preflight: 5 hard environment checks |
| `npm run seed:v2` | Seed 341 tools + agents + eval cases (~2.6s embed on local Ollama) |
| `npm run smoke:v2` | Mixed-kind discovery smoke + golden retrieval eval |
| `npm run eval:golden` | Golden retrieval eval alone (NDCG@3 / Recall@3 / top-1 floors) |
| `npm run test` | Full unit/behavioral suite (`tests/*.test.ts`, real SQLite, no mocks) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run import:skills` / `import:subagents` / `import:prompts` / `import:mcp` | Grow the catalog from real sources |
| `npm run mcp` | Run the MCP stdio server directly |

v1 (Atlas) scripts — `npm run dev`, `seed`, `demo:full`, `smoke:*` — still exist for the legacy tier.

---

## Evals and quality gates

- **Golden retrieval eval** — any embedder or retrieval change must clear three floors against the pinned baseline (`tests/fixtures/v2-baseline-native.json`): NDCG@3 ≥ mean − 2σ, Recall@3 drop ≤ 10%, single-tool-unambiguous top-1 ≥ mean − 2σ. The NDCG formula is locked in `src/eval/ndcg.ts` and guarded by its own test.
- **No mocks, ever** — all tests run against a real SQLite database (CLAUDE.md rule 5).
- **Cross-OS install gate** — `npm install` must succeed on fresh Node with no native build tools on Windows x64, macOS arm64, and Linux x64 (CI: `.github/workflows/v2-install-smoke.yml`).

---

## Roadmap

The curated queue lives in [ROADMAP.md](./ROADMAP.md). Headlines:

1. **Close the import-channel drift bypass** — importers currently call storage directly and skip the `/push` drift gate; the last silent-drift path.
2. **Post-merge polish** — CLI/dashboard coherence items sourced from review.
3. **Postgres + pgvector backend (Phase 2)** — the enterprise tier. The `Storage` interface is the contract; the SQLite driver is the reference implementation.

Out of scope by design (see `docs/PRD.md` IS-NOT list): managed SaaS, tool marketplace/billing, external eval frameworks, telemetry.

---

## v1 — the MongoDB Atlas hackathon origin (May 2026)

2chain started as a submission to the MongoDB Agentic Evolution Hackathon: the same registry architecture on Atlas Vector Search (Voyage `voyage-3`, 1024-dim) + Atlas Search BM25, fused server-side with the `$rankFusion` operator, with change streams driving the live dashboard. The whole hybrid retrieval + reliability gate was six lines of aggregation pipeline.

v2 re-implements that architecture with zero cloud dependencies behind `Storage`/`Embedder` interfaces — the v1 tier still runs (`npm run dev` with `MONGODB_URI` + `VOYAGE_API_KEY` in `.env`), and the cutover is measured in [docs/perf/phase-1-baseline.md](./docs/perf/phase-1-baseline.md).

Historical artifacts (kept as records of the submission, not current docs):

- [DESIGN.md](./DESIGN.md) — the v1 34-decision technical design log (D9 pending-status eval race, D33 vec-score gate, D34 push-always-active)
- [DEMO.md](./DEMO.md) + [STAGE.md](./STAGE.md) + [demo/SCRIPT.md](./demo/SCRIPT.md) — stage scripts and dry-run narrative
- [EVALS.md](./EVALS.md) — the v1 eval plan (the live gates are now `eval:golden` + `tests/`)
- [SUBMISSION.md](./SUBMISSION.md) — video script + shotlist
- Measured v1 latencies (Atlas M10, eu-west-2): `/discover` 30ms warm / 320ms cold, `/push` ~340ms, `/call` ~40ms happy path

Current architecture and product docs live in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and [docs/PRD.md](./docs/PRD.md); per-feature plans in `docs/plans/`.

---

## Author

Keith So · Principal Researcher and Lead Engineer, KITFUNSO LTD · skfskf27@gmail.com
