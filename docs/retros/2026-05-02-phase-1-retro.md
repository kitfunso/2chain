# Phase 1 Retrospective — Personal-Tier (SQLite + Ollama)

**Date:** 2026-05-02
**Branch:** `feat/v2-personal-tier`
**Scope:** Steps 0–10 of the Phase 1 plan + Phase 1.5 corpus + MCP importer
**Status:** Shippable. Strict demo gate 3/3, golden regression green at tolerance, real subprocess MCP bridge end-to-end.

## What surprised us

1. **better-sqlite3 has no `updateHook`.** The Phase 1 plan was written assuming `db.updateHook((op, _db, table, rowid) => {...})` was available. It is not — the standard better-sqlite3 idiom is registering a SQL function and calling it from AFTER triggers. Live-update wiring went from "1-line hook" to "register notify_change(), add 6 triggers, drain via setImmediate". The flush-after-commit semantics are actually cleaner because the JS callback runs *after* the writer transaction commits, not inside it — so listener reads see the committed state without re-entry.

2. **vec0 cosine + L2 norm invariant has to be enforced at the embedder boundary.** sqlite-vec computes raw cosine distance from input vectors; if inputs aren't unit length, "distance" is no longer monotonic with similarity. We L2-normalise inside the `OllamaEmbedder` before returning. This isn't a comment-on-the-PRAGMA thing, it's a runtime contract: any Embedder we plug in must normalise before handing off, or we redesign the gate.

3. **FTS5 external-content tables need the `'delete'` command.** `DELETE FROM tools_fts WHERE rowid = old.rowid` does *not* remove the indexed terms — it only removes the docsize entry. The fix is `INSERT INTO tools_fts(tools_fts, rowid, capability_text) VALUES('delete', old.rowid, old.capability_text)`. Discovered when the trigger test caught stale content surviving an UPDATE.

4. **Embedder swap costs ~5 of 32 golden queries.** Voyage 1024d disambiguates `"build a DCF for NVIDIA pull income statement"` → SEC EDGAR. nomic 768d sees `extract income statement` and routes to `pdf-extractor` (also a 10-K extractor, just from pasted text). Both are reasonable; v1 was sharper. Tuning RRF weights from 0.7/0.3 → 0.5/0.5 recovered ~1 query of margin and improved top-3 overlap from 1.78 to 1.88. The other ~4 are model-bound and queued for Phase 1.5 mxbai-embed-large evaluation.

5. **Catalog mocks are anti-product.** First pass at "growing the registry" was 142+360 hand-written ToolSpecV2 entries pointing at a `catalog-only-stub`. The user (rightly) called this out: spec entries with no runnable code are anti-marketplace. Pivot to MCP-importer happened mid-session; the 142 catalog entries stayed only as a retrieval-scale test fixture, the production registry is now MCP-bridged subprocesses.

## Where the interface bent and we straightened it

- **`StubFn` signature** gained a `ctx?` parameter so bridges (mcp-bridge, future others) can derive routing from `tool_name` instead of forcing callers to wrap args in an envelope. Before: `{ __mcp_server, __mcp_tool, args: { a, b } }`. After: caller sends `{ a, b }` directly, exact MCP-advertised schema. One-line edit to `call.ts`, removed an entire schema-wrapping abstraction at the importer.

- **`Storage` gained `getAgentByKeyHash`, `upsertAgent`, `updateToolAfterEval`.** Auth used to fetch `agents.findOne` directly off the Mongo handle; v2 routes auth through `Storage` like everything else, which made the cross-OS install gate possible (no mongodb in any v2 path).

- **RRF default weights moved 0.7/0.3 → 0.5/0.5** with calibration note in `src/types.ts`. The earlier value was inherited from the v1 Voyage configuration; nomic-embed-text has narrower semantic field, so the BM25 arm needs a stronger vote.

## Performance

| Op | v1 (Mongo + Voyage) | v2 (SQLite + Ollama) |
|---|---|---|
| Seed 199 fixture tools | 4–5 min (Voyage 3 RPM) | **1.1s** (local Ollama) |
| Seed 341 (with catalog) | n/a | **2.6s** |
| Insert + index 199 rows | n/a | **97ms** |
| Single `runRRF` query | ~50–100ms (Atlas hop) | **~50ms** (local) |
| 200 rapid inserts (event-loop block test) | n/a | **25ms** with 200 events delivered |

Step 6.5 (10k synthetic perf) is **deferred** — the same-day priority shifted to MCP importer + corpus expansion. Will run when we know whether mxbai-embed-large is the embedder we're tuning for.

## Golden regression

`tests/fixtures/v1-baseline.json` (32 queries from `golden-queries.json`) replayed against v2.

| Metric | v1 | v2 (nomic, 0.5/0.5) |
|---|---|---|
| `expected_top1` pass | 25 / 32 | **20 / 32** |
| top-1 matches v1 | n/a | **22 / 32** |
| top-3 overlap (avg) | n/a | **1.88 / 3** |
| RRF margin avg ratio | 1.000 | **0.963** |

Tolerant gates in `scripts/smoke/v2-golden-regression.ts`: pass ≥ 18, overlap ≥ 1.5, margin ratio avg ≥ 0.7. All green. Strict demo-arc gate (`scripts/smoke/v2-demo-prompts.ts`): **3/3** for the unambiguous demos (DCF, arxiv, Python OWASP).

After Phase 1.5 corpus expansion (199 fixture + 142 catalog + 77 MCP = 418 tools), regression remains green at tolerance and demo arc holds.

## Cross-OS install

`npm install --no-audit --no-fund` succeeds on Windows x64 locally. macOS arm64 and Linux x64 verified via the new `.github/workflows/v2-install-smoke.yml` matrix (ubuntu-latest, macos-14, windows-latest). Each runner: `npm install`, load `better-sqlite3` + `sqlite-vec`, create a vec0 table, run typecheck + tests + lint:no-mongodb.

## mxbai-embed-large parity check (resolved)

Pulled `mxbai-embed-large` (670MB, 1024d) and re-ran the golden set. Counter-intuitive result: mxbai is *worse* than nomic on v1 alignment.

| Metric | v1 (Voyage) | v2 (nomic 768d) | v2 (mxbai 1024d) |
|---|---|---|---|
| `expected_top1` pass | 25/32 | 20/32 | **18/32** |
| matches v1 top-1 | n/a | 22/32 | **15/32** |
| top-3 overlap with v1 | n/a | 1.88/3 | **1.44/3** |
| Embed time, 341 docs | ~5 min (rate-limited) | 2.6s | **4.5s** |

Reading the diff queries: mxbai picks reasonable-but-different alternatives. `"build a DCF for NVIDIA pull income statement"` routes to `pdf-extractor` (still a 10-K extractor). `"latest annual report for NVDA ticker"` goes to `yahoo-finance-fundamentals` (also valid). `pylint-lint` vs `pylint-pro` for `"lint javascript for style"` — both Python-flavored, neither correct.

**Honest interpretation:** The golden set is v1-calibrated, so "lower v1 alignment" doesn't necessarily mean worse retrieval. It means mxbai's semantic field is *further from Voyage's* than nomic's is, despite mxbai being generally rated higher on MTEB. To get a verdict on which model is actually better for 2chain users, we need a hand-graded v2-native ground-truth set — calibrating against v1 selects for v1 quirks.

**Decision:** Keep nomic-embed-text as the personal-tier default. mxbai stays as an opt-in via `OLLAMA_EMBED_MODEL=mxbai-embed-large` for users who want to experiment. The mxbai DB is at `/tmp/v2-mxbai.db` (1024d schema) for follow-up inspection.

## What's queued for Phase 1.5 / 2

In priority order:

1. **Hand-graded v2 golden set.** 100 queries × top-3 expected, graded by domain expert against the actual seeded corpus. Removes the v1 bias from embedder evaluation.
2. **10k synthetic perf benchmark** (Step 6.5). Lock FTS5 k1/b + vec HNSW params. Generates a 10k-corpus, 50-query benchmark, measures p50/p95/p99 and Recall@5 against a hand-graded relevance set.
3. **Frontend rebuild.** The current dashboard is a static HTML string; the user wants "mind-blowing". Per the workflow rule: 2–4 visual references locked first, then implement section by section against the chosen direction.
4. **More MCP servers in the registry.** Awesome-mcp-servers has hundreds. The current 20 are the official Anthropic + best-known community. A scheduled crawler that pulls new entries from `awesome-mcp-servers` and re-runs `--verify` against each is the natural next ingestion source.
5. **npm registry browse** for tools that ship a documented MCP server. Secondary source after MCP registry.
6. **Phase 2: Postgres + pgvector + pg_search** driver. Single env-var swap (`STORAGE_DRIVER=postgres`) once the Storage interface holds (it does).

## What worked

- **Real-DB tests, no mocks** kept the interface honest. Every refactor caught contract violations the moment they happened. Three days of work, zero "passes-on-mocks-fails-in-prod" cycles.
- **Outside-voice review on the plan** (codex + senior-code-reviewer) caught 17 issues before any code was written. The two we'd have shipped without it: vec0-doesn't-update-in-place (Step 3), FTS5-needs-'delete'-command (Step 3). Both would have surfaced as "stale search results" bugs in the demo.
- **Strict / tolerant gate split.** Locking the demo arc strictly while accepting embedder-bound regressions on edge cases let us ship Phase 1 honestly without papering over the tradeoffs.
- **Architecture interfaces locked in Step 2 didn't bend.** The Storage and Embedder shapes from Step 2 carried through Steps 3–10 + Phase 1.5 + MCP importer with only additive changes. That's a sign the surface was right.
