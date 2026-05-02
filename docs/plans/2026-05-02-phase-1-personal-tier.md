# Phase 1 — Personal Tier (SQLite + Ollama, end-to-end)

**Goal:** The five demo prompts pass end-to-end against a SQLite + sqlite-vec + FTS5 backend with an Ollama embedder, with no Atlas / Voyage code in the call path, **and with quantitative proof the swap doesn't regress retrieval quality**.

**Prerequisites:** Node 24 installed; Ollama installed with `nomic-embed-text` pulled (`ollama pull nomic-embed-text`); empty `feat/v2-personal-tier` branch off `master`.

**Estimated scope:** 14 steps, ~8-10 working days (revised after outside-voice review).

**Why this phase first:** locking the `Storage` and `Embedder` interfaces against a real SQLite backend forces the abstractions to be honest. Once Phase 1 ships, Phase 2 (Postgres + pgvector + pg_search) is a single-driver swap, not a re-architecture.

**Outside-voice review applied:** senior-code-reviewer + /codex (cross-model) flagged 17 issues against the original 12-step plan. All fixes incorporated below. Net effect: +2 steps (Step 0 baseline, Step 6.5 perf, Step 11.5 cross-OS CI), Step 12 dropped, expanded verify criteria on most existing steps.

---

## Step 0: Capture v1 retrieval baseline + golden ranking set

**Files:**
- `tests/fixtures/v1-baseline.json` (new)
- `tests/fixtures/golden-queries.json` (new — 30+ technical near-miss queries)
- `scripts/capture-v1-baseline.ts` (new)

**What:** Before touching any v2 code, freeze v1 retrieval behavior so v2 has a parity bar.

`golden-queries.json` covers: the 5 demo prompts, the 17 prewarm queries from `discover.ts:50-66`, plus 10+ technical near-miss queries that exercise edge cases (e.g. "extract financials" should rank pdf-extractor over invoice-grok; "lint Python for security" should rank security-scanner over pylint-pro).

`capture-v1-baseline.ts` hits the live v1 server (`/discover?q=&top=5&mode=hybrid`) for each golden query and writes `v1-baseline.json` with `{query, top1: name@version, top3: [...], rrf_score_top1, rrf_margin_top1_vs_top2}`.

**Verify:** `v1-baseline.json` contains 30+ entries; sec-edgar-financials@1.0 appears as top-1 for the DCF query; arxiv-paper-search@1.0 appears as top-1 for the literature-review query.

**Commit:** `test(v2): capture v1 retrieval baseline + golden query set for parity bar`

---

## Step 1: Branch and scaffold v2 directory layout

**Files:**
- new dirs `src/storage/{migrations/sqlite/}`, `src/embeddings/`, `src/tools/`, `src/live/`

**What:** Create empty directories with `.gitkeep`. Move existing `src/services/secEdgar.ts` and `src/services/arxivSearch.ts` into `src/tools/` (they're tool stubs, not services). Update imports.

**Verify:** `npm run typecheck` passes; `git diff --stat` shows the move only.

**Commit:** `chore(v2): scaffold storage/embeddings/tools/live directories, move tool stubs`

---

## Step 2: Define the Storage and Embedder interfaces (full surface area)

**Files:**
- `src/types.ts` (extend)
- `src/storage/index.ts` (new)
- `src/embeddings/index.ts` (new)

**What:** Lock interfaces against the **complete** v1 call surface, not just `discover` / `push` / `call`. Includes dashboard reads (flagged in outside-voice review).

```ts
interface Storage {
  init(): Promise<void>;

  // Tool CRUD
  getToolByNameVersion(name: string, version: string, namespace?: string): Promise<Tool | null>;
  upsertTool(spec: ToolSpec, embedding: Float32Array, namespace?: string): Promise<Tool>;
  setStatus(toolId: string, status: ToolStatus): Promise<void>;

  // Retrieval
  runRRF(opts: { queryEmbedding: Float32Array; queryText: string; topK: number; gate: number; weights: { vector: number; text: number }; namespace?: string }): Promise<RrfResult[]>;

  // Logging
  insertViolation(v: ViolationRow): Promise<void>;
  insertUsage(u: UsageRow): Promise<void>;
  insertEvalRun(e: EvalRunRow): Promise<void>;
  insertRanking(r: RankingRow): Promise<void>;

  // Dashboard reads (added per outside-voice issue #2)
  listTools(opts: { status?: ToolStatus; limit?: number; namespace?: string }): Promise<Tool[]>;
  listViolations(limit: number, namespace?: string): Promise<ViolationRow[]>;
  listEvalRuns(limit: number, namespace?: string): Promise<EvalRunRow[]>;
  usageOutcomeCounts(limit: number, namespace?: string): Promise<Record<string, number>>;
  dbStats(): Promise<DbStats>;

  // Live updates
  watchChanges(onChange: (event: ChangeEvent) => void): void;
  close(): Promise<void>;
}

interface Embedder {
  name(): string;
  dim(): number;
  embed(text: string, kind: 'document' | 'query'): Promise<Float32Array>;
  embedBatch(texts: string[], kind: 'document' | 'query'): Promise<Float32Array[]>;
  // Query-cache support (added per outside-voice issue #1)
  prewarm(queries: string[]): Promise<void>;
  cachedEmbed(query: string): Promise<{ vec: Float32Array; cached: boolean; ms: number }>;
}
```

`Tool` type now includes `namespace_id` (default `'default'`) per outside-voice issue #15 (multi-tenant retrofit).

`src/storage/index.ts` and `src/embeddings/index.ts` are factories that read env (`STORAGE_DRIVER=sqlite|postgres`, `EMBEDDER=ollama|transformersjs|voyage`) and return the concrete instance.

**Verify:** `npm run typecheck` passes. No implementations yet, just interfaces — both factories `throw new Error('not yet implemented')` on call.

**Commit:** `feat(v2): lock Storage and Embedder interfaces with full surface area + namespace`

---

## Step 3: SQLite migrations + schema (with vec0 update gymnastics)

**Files:**
- `src/storage/migrations/sqlite/001_init.sql`
- `tests/storage.sqlite.triggers.test.ts` (new)

**What:** Migration creates `tools`, `agents`, `eval_runs`, `usage`, `violations`, `rankings`, `_migrations`. All tables include `namespace_id TEXT NOT NULL DEFAULT 'default'` (outside-voice issue #15).

FTS5 virtual table `tools_fts` mirrors `capability_text`. sqlite-vec virtual table `tools_vec` declared with explicit cosine: `CREATE VIRTUAL TABLE tools_vec USING vec0(capability_embedding float[768] distance_metric=cosine)` (outside-voice issue #4).

Triggers handle the `vec0` no-update-in-place quirk (outside-voice issue #7):

```sql
-- INSERT: mirror to fts and vec
CREATE TRIGGER tools_ai AFTER INSERT ON tools BEGIN
  INSERT INTO tools_fts(rowid, capability_text) VALUES (new.rowid, new.capability_text);
  INSERT INTO tools_vec(rowid, capability_embedding) VALUES (new.rowid, new.capability_embedding);
END;

-- DELETE: cascade
CREATE TRIGGER tools_ad AFTER DELETE ON tools BEGIN
  DELETE FROM tools_fts WHERE rowid = old.rowid;
  DELETE FROM tools_vec WHERE rowid = old.rowid;
END;

-- UPDATE: vec0 doesn't support row update; do DELETE then INSERT inside one trigger
CREATE TRIGGER tools_au AFTER UPDATE ON tools BEGIN
  DELETE FROM tools_fts WHERE rowid = old.rowid;
  INSERT INTO tools_fts(rowid, capability_text) VALUES (new.rowid, new.capability_text);
  DELETE FROM tools_vec WHERE rowid = old.rowid;
  INSERT INTO tools_vec(rowid, capability_embedding) VALUES (new.rowid, new.capability_embedding);
END;
```

Also enables WAL mode + sane busy_timeout in init (outside-voice issue #12):
```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

`tests/storage.sqlite.triggers.test.ts` — real DB, no mocks. Insert tool → fts and vec rows exist. Update tool → fts and vec reflect new content (not stale). Delete tool → fts and vec rows gone.

**Verify:** `npm test -- storage.sqlite.triggers` — 6/6 cases pass; trigger updates verified end-to-end.

**Commit:** `feat(v2): SQLite schema with namespace, cosine vec0, FTS5, WAL mode, sync triggers + tests`

---

## Step 4: SqliteStorage CRUD (no RRF yet) + write queue

**Files:**
- `src/storage/sqlite.ts` (new)
- `src/storage/sqlite-write-queue.ts` (new)
- `package.json` (add `better-sqlite3`, `sqlite-vec`)
- `tests/storage.sqlite.test.ts` (new)

**What:** Implement every `Storage` method except `runRRF()` and the dashboard reads (Step 6 + Step 6 follow-up). Constructor accepts a path; `init()` runs pending migrations.

**Concurrency model (outside-voice issue #12):**
- Single writer connection (better-sqlite3 is sync; one connection serializes writes via `sqlite-write-queue.ts`).
- Multiple read-only connections (one per request, opened with `readonly: true`) — these snapshot WAL state without blocking writes.
- All public methods route writes through the queue; reads use the read-only pool.

`tests/storage.sqlite.test.ts` against `:memory:`: insert, get-by-name-version, set-status, all dashboard list methods (`listTools`, `listViolations`, `listEvalRuns`, `usageOutcomeCounts`, `dbStats`). Real DB.

**Verify:** `npm test -- storage.sqlite` — 12/12 cases pass.

**Commit:** `feat(v2): SqliteStorage CRUD with write queue + read-snapshot pool, real-DB tests`

---

## Step 5: OllamaEmbedder with prewarm + cache

**Files:**
- `src/embeddings/ollama.ts` (new)
- `src/embeddings/cache.ts` (new — shared LRU)
- `tests/embeddings.ollama.test.ts` (new)

**What:** `OllamaEmbedder` calls `POST localhost:11434/api/embeddings` with `{model: 'nomic-embed-text', prompt}`. Returns 768-dim Float32Array, **L2-normalized** (Ollama returns un-normalized; cosine distance via vec0 requires unit-length inputs to work like a similarity).

`embedBatch` does parallel calls capped at concurrency 4. `prewarm(queries)` embeds + caches each query at boot. `cachedEmbed(query)` returns from cache or embeds + writes (outside-voice issue #1).

**Cold-start probe (outside-voice issue #16):** First call after Ollama startup loads the model into VRAM; budget 2-3s. The constructor includes `await this.embed('warmup', 'document')` if `OLLAMA_WARMUP=true` env is set; `setup-personal.ts` (Step 8) sets this.

Test: real Ollama call (skip if `localhost:11434` unreachable), assert dim=768, assert `||v|| ≈ 1.0` after normalization, assert cache hit returns in <1ms.

**Verify:** `npm test -- embeddings.ollama` — 5/5 cases pass.

**Commit:** `feat(v2): OllamaEmbedder with normalization, prewarm cache, warm probe`

---

## Step 6: Implement RRF in SQLite (corrected SQL)

**Files:**
- `src/storage/sqlite.ts` (extend `runRRF()`)
- `src/storage/migrations/sqlite/002_calibrate_gates.sql` (calibrate VEC_RELEVANCE_GATE)
- `tests/storage.sqlite.rrf.test.ts` (new)

**What:** Implement `runRRF()` as a single prepared statement (corrected per outside-voice issue #3, vec0 MATCH syntax + FTS5 BM25 ascending order + outer-JOIN gate):

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

**Note on vec_score (outside-voice issue #4):** Since vec0 is declared `distance_metric=cosine` and embeddings are L2-normalized (Step 5), `vec_score = 1.0 - distance` ranges in [0, 2]. The v1 hard gate `VEC_RELEVANCE_GATE = 0.70` was calibrated against Voyage's L2 + cosine norm; recalibrate against `nomic-embed-text` empirically in Step 6.5 before locking. Until then, gate is OFF in v2.

`tests/storage.sqlite.rrf.test.ts`: 5 hand-crafted tools, 4 query patterns, assert ranking correctness. Test the namespace gate (insert tools in 2 namespaces, query one, assert other-namespace tools are absent).

**Verify:** `npm test -- storage.sqlite.rrf` — 6/6 cases pass.

**Commit:** `feat(v2): RRF in SqliteStorage with corrected vec0 MATCH + FTS5 BM25 + namespace gate`

---

## Step 6.5: 10k-tool synthetic perf benchmark

**Files:**
- `scripts/perf/seed-10k.ts` (new)
- `scripts/perf/benchmark-discover.ts` (new)
- `docs/perf/baseline-10k.md` (new — generated report)

**What:** Generate 10,000 synthetic tool specs with diverse capability text, embed them all (~3-5 min on M-series), then run a 50-query benchmark. Records p50 / p95 / p99 latency for `runRRF`, plus Recall@5 against a hand-graded relevance set of 50 queries.

This addresses outside-voice issue #17 (PRD claims 200ms p95 at 10k tools but Phase 1 had no perf plan) and gives Phase 2 a concrete number to beat.

Tunes FTS5 BM25 (k1, b) + vec HNSW params (M, ef_construction, ef_search) and locks the chosen values in `001_init.sql` follow-up migration.

**Verify:** `docs/perf/baseline-10k.md` exists with: p50/p95/p99 numbers, Recall@5 ≥ 0.85 against relevance grading, FTS5 + HNSW chosen params documented.

**Commit:** `perf(v2): 10k-tool synthetic benchmark, locked FTS5/HNSW params, baseline doc`

---

## Step 7: Wire Storage + Embedder into existing routes; remove mongodb dep

**Files:**
- `src/server/index.ts` (replace direct MongoDB connect with Storage factory)
- `src/server/routes/{discover,push,call,dashboard}.ts` (use Storage interface)
- `src/services/{discover,push,call}.ts` (refactor to take Storage + Embedder via DI)
- `package.json` (move mongodb to optionalDependencies; outside-voice issue #6)
- `.eslintrc` (add `no-restricted-imports: ['mongodb']` for src/services + src/server/routes)
- `tests/routes.discover.test.ts` (new — outside-voice issue #8)

**What:** Remove every direct MongoDB import from `src/server/` and `src/services/`. Routes receive Storage and Embedder via Fastify decorators (`app.decorate('storage', storage)`).

Per outside-voice issue #6: `mongodb` is moved to `optionalDependencies` (not deleted entirely — v1 fixture seed scripts still reference it during transition). ESLint rule prevents accidental re-import in v2 paths.

Per outside-voice issue #8: route-level integration test runs against real SQLite + a stub Embedder returning canned vectors; asserts `/discover?q=...` returns expected JSON shape (not just typecheck).

**Verify:** `npm run typecheck` passes. `grep -r "from 'mongodb'" src/services src/server/routes` returns nothing. `npm test -- routes.discover` — 4/4 cases pass.

**Commit:** `refactor(v2): routes use Storage/Embedder interfaces; mongodb moved to optionalDependencies`

---

## Step 8: Port seed script + setup-personal.ts with hard preflight

**Files:**
- `scripts/seed-fixtures.ts` (rewrite for new interfaces)
- `scripts/setup-personal.ts` (new)

**What:** Seed reads existing 14 hand-crafted + 185 generated specs; calls `embedder.embedBatch()` in chunks of 32; writes via `storage.upsertTool()`. Pre-seeds `eval_runs` from fixture `case_results`.

**Reseed safety (outside-voice issue #16):** seed writes to `~/.2chain/db.sqlite.tmp`, runs migrations + inserts, then atomically renames to `db.sqlite` (via `fs.rename`, single syscall on POSIX, AcquireSRWLockShared on Windows). Avoids file-lock errors on re-seed while server is running.

`scripts/setup-personal.ts` first-run hard checks (outside-voice issue #16):
1. `ollama.ping()` — Ollama reachable?
2. `ollama.show('nomic-embed-text')` — model present?
3. `loadExtension('sqlite-vec')` succeeds?
4. `~/.2chain/` writable?
5. Warm Ollama (one tiny embed call) before timing the seed.

If any check fails, print remediation and exit non-zero.

**Verify:**
```bash
2CHAIN_DB_PATH=/tmp/v2.db npx tsx scripts/seed-fixtures.ts   # under 30s on M-series after warmup
sqlite3 /tmp/v2.db "SELECT COUNT(*) FROM tools WHERE status='active';"   # expect 199
sqlite3 /tmp/v2.db "SELECT COUNT(*) FROM tools_vec;"   # expect 199
sqlite3 /tmp/v2.db "SELECT COUNT(*) FROM tools_fts;"   # expect 199
npx tsx scripts/setup-personal.ts   # all 5 preflight checks pass
```

**Commit:** `feat(v2): seed-fixtures with atomic reseed; setup-personal with hard preflight checks`

---

## Step 9: SQLite update_hook → SSE (concurrency-safe)

**Files:**
- `src/live/sqlite-hook.ts` (new)
- `src/server/index.ts` (wire hook to SSE manager)

**What:** Per outside-voice issue #12, the updateHook itself is **strictly minimal**:

```ts
db.updateHook((op, _db, table, rowid) => {
  // Synchronous, no I/O, no DB reads. Only enqueue.
  changeQueue.push({ op, table, rowid: BigInt(rowid) });
});
```

A separate async worker drains `changeQueue` using a **read-only snapshot connection** (not the writer connection that triggered the hook), fetches the row, and broadcasts via SSE. This prevents re-entry into SQLite during a write transaction.

Map `(op, table)` to event names: `tool_changed`, `tool_invoked`, `violation_logged`. Backpressure handling: if SSE clients are slow, the queue caps at 1000 events per channel and drops oldest.

**Verify:** Open dashboard at `localhost:3030`, run `npm run reset:state`, watch the violations panel clear in real time. Manually `UPDATE tools SET status='circuit_broken' WHERE name='malformed-bot'` via sqlite3 CLI; row turns red within 100ms. Stress: insert 200 tools rapidly; no event-loop block, no SQLite re-entry crash.

**Commit:** `feat(v2): SQLite updateHook with concurrency-safe queue drain + read-snapshot reads`

---

## Step 10: Run five demo prompts + golden ranking regression

**Files:**
- `scripts/smoke/v2-demo-prompts.ts` (new)
- `scripts/smoke/v2-golden-regression.ts` (new — outside-voice issue #5)

**What:** Two smoke tests.

**Smoke 1 — five demo prompts** end-to-end. Asserts:
- Tool routing (e.g. `sec-edgar-financials` wins for DCF, `arxiv-paper-search` for lit review)
- Real-fetch tools return live data with non-zero values
- `malformed-bot` returns 503 + `circuit_broken`

**Smoke 2 — golden ranking regression** (outside-voice issue #5 + #13). Reads `tests/fixtures/v1-baseline.json`. For each query:
- Top-1 must match v1 by name@version
- Top-3 set must overlap v1 by ≥ 2/3
- Top-1 RRF margin (top1_score - top2_score) must be ≥ baseline × 0.9 (no more than 10% margin shrink)

If any threshold fails, dump full ranking diff to `smoke-output.log` and fail CI.

**Verify:** Both scripts pass. Margin shrink stays within 10% across all 30+ golden queries. If margin shrink exceeds threshold, **abort Phase 1** and tune (RRF weights, FTS5 k1/b, prompt embedding model).

**Commit:** `test(v2): five demo prompts + golden ranking regression smoke against SQLite`

---

## Step 11: npm scripts + README quick-start

**Files:**
- `package.json` (add scripts)
- `README.md` (add v2 quick-start section above existing v1 section)

**What:** New scripts:
```json
"dev:v2": "STORAGE_DRIVER=sqlite EMBEDDER=ollama tsx scripts/dev-server.ts",
"seed:v2": "STORAGE_DRIVER=sqlite EMBEDDER=ollama tsx scripts/seed-fixtures.ts",
"setup:personal": "tsx scripts/setup-personal.ts",
"perf:10k": "tsx scripts/perf/seed-10k.ts && tsx scripts/perf/benchmark-discover.ts"
```

README v2 quick-start:
```bash
ollama pull nomic-embed-text
npm i
npm run setup:personal && npm run seed:v2 && npm run dev:v2
open http://localhost:3030
```

**Verify:** Fresh clone in temp dir, follow README from scratch on a clean Node 24 install, dashboard loads with 199 tools. Total time under 5 min excluding `npm i`.

**Commit:** `docs(v2): README quick-start; npm run dev:v2 + perf:10k wired`

---

## Step 11.5: Cross-OS install CI

**Files:**
- `.github/workflows/v2-install-smoke.yml` (new — outside-voice issue #11)

**What:** GitHub Actions matrix on `[ubuntu-latest, macos-14 (arm64), windows-latest]`. Each runs:
```bash
npm install --no-audit --no-fund
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.loadExtension(require('sqlite-vec').getLoadablePath()); db.exec('CREATE VIRTUAL TABLE t USING vec0(e float[768] distance_metric=cosine);'); console.log('OK');"
```

This catches missing prebuilt binaries (CLAUDE.md rule 10: `npm install` must succeed with no native build tools). If Windows or macOS arm64 doesn't have a prebuilt for either dep, **block Phase 1 merge** and surface the issue (either pin a fork that has prebuilts, ship transformers.js as the fallback embedder, or accept the personal tier requires build tools and document it).

**Verify:** GitHub Actions green on all three OSes.

**Commit:** `ci(v2): cross-OS install smoke for better-sqlite3 + sqlite-vec native bindings`

---

## Step 12: Phase 1 retrospective

**Files:**
- `docs/retros/2026-05-XX-phase-1-retro.md` (new — replaces dropped Phase 2 plan)

**What:** 30-minute retro doc covering: what surprised us, where the interface bent and we straightened it, perf numbers from Step 6.5, golden-regression deltas from Step 10, cross-OS install learnings from Step 11.5. Phase 2 plan gets written *after* this retro lands so it's informed by lessons, not pre-locked.

**Verify:** doc exists and has > 200 words across the 5 sections.

**Commit:** `docs(v2): Phase 1 retrospective — what we learned, what changed, Phase 2 inputs`

---

## Phase 1 done when

All 14 commits land on `feat/v2-personal-tier`. CI runs `npm run typecheck`, `npm test`, smoke prompts, golden regression, 10k perf, cross-OS install — all green. Branch is ready to merge to `master` behind a `STORAGE_DRIVER` env flag (default still `mongodb` for the live demo until Phase 2 confirms parity).

**Out of scope for Phase 1 (deferred):**
- Postgres backend (Phase 2)
- pg_search BM25 extension (Phase 2)
- transformers.js fully-embedded embedder (Phase 3)
- Single-binary distribution via `pkg` (Phase 3)
- Voyage / OpenAI optional embedder plug-ins (Phase 3)
- Migration story for users running v1 against Atlas (Phase 4)
- Worker/process isolation for user-supplied stubs (v0.4 — see CLAUDE.md trust boundary)
