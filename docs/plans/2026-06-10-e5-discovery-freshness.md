# Episode E5 — Freshness in agent-facing discovery

**Status:** Implemented on `feat/e5-discovery-freshness` (plan-eng reviewed over three rounds, 52 → 63 → 84; v1 failed because it built on the wrong sort key — results are ordered by `rrf_score` inside `runRRF` and never re-sorted downstream). Baseline 197/197 green; 207/207 with this episode's 10 tests.

**Goal:** discover ranks by RRF fusion (vec + BM25 arms) with reliability gated in SQL. A tool verified an hour ago and one last evaluated in March ordered identically — staleness was invisible exactly where agents choose tools.

**Non-negotiables enforced:** no driver imports in services (storage via the `Storage` interface only); real SQLite tests, no mocks; the rule 7 reliability gate stays in SQL — freshness weights, never gates; TS strict, ESM `.js` import suffixes.

---

## 1. THE ordering mechanism: post-RRF re-sort in discover

In `discover()`, after `runRRF` returns the top-K candidates and BEFORE the `insertRanking` snapshot (so trending aggregates the order agents actually saw), compute per result:

```
freshness   = 0.5 ^ (age_days(metadata.last_eval_run) / FRESHNESS_HALF_LIFE_DAYS)   // 7d
final_score = rrf_score + W_FRESHNESS_RRF * freshness
```

and re-sort the K results by `final_score` desc with a PLAIN STABLE sort — NO secondary key: JS sort stability preserves runRRF's tie order, so uniform-fresh corpora are order-invariant BY CONSTRUCTION. (The name+version tie-break in `src/eval/ndcg.ts` is eval-side normalization, not production behavior — untouched.) The route and MCP shim inherit the new order untouched.

**Weight calibration on the RRF scale** (0.05 would dominate retrieval):
- One RRF arm contributes `w/(60+rank)`; with arm weight 0.5 the max is ≈ 0.0082, and ADJACENT-rank gaps are ≈ 1.3e-4 (rank 1→2) shrinking with depth.
- `W_FRESHNESS_RRF = 0.0005`: a full freshness delta covers ~3-4 adjacent-rank gaps at shallow ranks — a fresh tool climbs past NEAR-tied stale neighbours — but is an order of magnitude below one arm contribution, so it can never leapfrog a meaningfully better-matched tool (cumulative gap rank 10→1 ≈ 1.1e-3 > 2× the full term). Constants in `src/types.ts` beside the RRF weights, calibration table as the comment.
- Missing/unparseable `last_eval_run` ⇒ freshness 0 + `Number.isFinite` guard (NaN in a sort key silently disorders — E2's lesson).
- `rank_score` keeps its informational definition; `final_score` is the ordering key and ships in the payload.
- Rule 7 untouched: gating stays reliability-only in SQL.

## 2. Payload additions (additive, both surfaces)

`DiscoverResult` gains `last_verified_at: string | null` (= `metadata.last_eval_run ?? null`), `verification_streak: number`, `freshness: number`, `final_score: number`.

- Streak: pinned E4 semantics — consecutive most-recent reverify-triggered runs ≥ gate, window 20 — computed for the returned top-K only; **K ≤ 20** (route and shim cap `Math.min(20, ...)`, default 5; worst case 20 indexed queries per request).
- Streak helper home: NEW pure module `src/services/streak.ts` (no collision — E4's parked branch computes streak inline in health.ts; the post-merge follow-up refactors health.ts onto streak.ts, named in the backlog).
- MCP shim: the discover_tools formatter moved to the SIDE-EFFECT-FREE module `bin/mcp-format.mjs` (the shim connects the stdio transport at module top level, so importing IT from a test hangs the runner; the shim imports the module, tests import the module). The rendered table shows `final_score` (the actual ordering key) with `freshness` as its own column — `rank_score ?? rrf_score` as 'score' would look mis-sorted post-E5. The same pass refreshed the stale v1 header copy ('Atlas $rankFusion: vector 0.7 + text 0.3', 'Voyage voyage-3, 1024-dim', 'MongoDB pipeline') to the real stack (SQLite RRF 0.5/0.5, Ollama nomic-embed-text 768-dim) — the new column must not sit under provably false trace text.

## 3. Storage — third signature-identical addition (merge-resolver note)

`listEvalRunsForTool(toolId: string, limit: number, triggeredBy?: string)` byte-identical to the E2 (PR #8) and E4 (PR #9) branches — filter-before-limit, parameterized, `mapEvalRun` helper extracted with that exact name — all three resolve trivially whichever merges first.

## 4. Verification gates (two tiers, honestly scoped)

- **CI/executable gate:** the §5 StubEmbedder ordering tests pin the re-sort behavior deterministically without Ollama.
- **Local manual gate (pre-merge):** `scripts/smoke/v2-golden-v2native.ts` needs live Ollama + a corpus_sha256-matched DB. Run at ship stage if Ollama is up (probe first); otherwise DISCLOSE at the deploy gate.
- **Corpus-freshness premise:** the default seeded corpus was MIXED — fixtures got `last_eval_run = nowIso` but REAL_CORPUS entries carried none, which would create a full freshness delta between the populations on every golden query. This episode backfills `last_eval_run: nowIso` at the real-corpus seed site — golden-corpus normalization for eval comparability, NOT importer-mirroring (runKindEval returns null for tool-kind and the scrape importer never sets last_eval_run; the seed corpus is an eval artifact and uniform freshness keeps the floors measuring retrieval, not seed metadata). OWNED CONSEQUENCE: real catalog imports carry freshness 0 BY DESIGN until a reverify sweep scores them — unverified means stale, stated in PRD/ARCHITECTURE.
- `tests/v2-eval-ndcg.test.ts` (formula-only, no embedder) stays green — it pins the tie-break the eval side reuses.

## 5. Tests (`tests/discovery-freshness.test.ts`, 10 — real SQLite, StubEmbedder, crafted vectors)

1. Acceptance (adjacent-rank perturbation, route-level): stale tool at vec rank 1, fresh tool at rank 2, near-tied single-arm rrf scores; backdate via `recordEvalOutcome` with score ≥ 0.80 (it patches reliability too — below 0.80 the tool falls out of the SQL gate and the test degenerates) ⇒ fresh overtakes stale in the RETURNED order; both still present (no gating).
2. Dominance counter-test: stale rank-1 tool with a clear margin (fresh competitor at rank 8) stays first.
3. NaN guard: missing + unparseable `last_eval_run` ⇒ freshness 0, rank order total, `Number.isFinite` asserted on every returned `final_score`.
4. Uniform freshness ⇒ order identical to rrf_score order.
5. Payload fields + streak semantics (clean-fail-clean ⇒ 1) on the discover route.
6. MCP formatter (exported module): renders the new fields; refreshed headers; unknown/empty safe (2 tests).
7. Structural top-K bound: 30-tool corpus, top=5 ⇒ exactly 5 results carry streak/freshness fields (no timing assertions).
8. Backdating determinism: freshness asserted in BANDS at 0d/7d/14d (the term uses request-time now; no exact floats).
9. NDCG suite green (untouched formula + tie-break) — asserted by the full-suite run.
10. Streak helper unit matrix (pure): 3-clean ⇒ 3, clean-fail-clean ⇒ 1, interleaved-manual skipped (never streak-breaking), empty ⇒ 0.

## Out of scope (named cuts)

- Freshness inside SQL gating or the RRF arms (post-RRF re-sort only).
- Re-tuning RRF arm weights or W_VEC/W_RELIABILITY.
- Streak materialization; non-top-K streaks.
- Dashboard rendering of the new fields (E4's panel owns that surface).
- **Re-sort pool = the returned top-K only (owned limitation):** a fresh tool at RRF rank K+1 never enters the results; with default top=5 the freshness window is narrow. Widening the pool (fetch K+m, re-sort, trim) is a follow-up if the narrow window proves limiting in practice.

## Backlog handed forward

- Post-merge: refactor E4's health.ts inline streak onto `src/services/streak.ts`.
- Golden eval (`npm run eval:golden`) re-run with live Ollama before merge, or disclosed at the deploy gate.
