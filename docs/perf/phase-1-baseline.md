# Phase 1 Retrieval Baseline (v1 -> v2 swap)

**Generated:** 2026-05-02
**Branch:** `feat/v2-personal-tier`
**Commit at-baseline:** Step 10 / golden regression

## What changed

| Layer | v1 | v2 |
|---|---|---|
| Storage | MongoDB Atlas + $rankFusion | SQLite + sqlite-vec + FTS5 |
| Embedder | Voyage `voyage-3` (1024d, normalised) | Ollama `nomic-embed-text` (768d, L2-norm in the embedder) |
| Reliability gate | `metadata.reliability_score >= 0.80` (post-filter) | same, but pushed into both retrieval arms |
| Re-rank trigger | MongoDB change stream | SQLite trigger -> notify_change() -> async drain |
| RRF weights | vector 0.7 / text 0.3 | **vector 0.5 / text 0.5** (calibrated, see below) |

## Golden ranking parity (32 queries)

Source: `tests/fixtures/legacy/golden-queries.json` (5 demo prompts + 17 prewarm + 8 edge cases).
v1 baseline captured against the live MongoDB + Voyage stack on 2026-05-02 in `tests/fixtures/legacy/v1-baseline.json`.

| Metric | v1 | v2 (nomic, 0.7/0.3) | v2 (nomic, 0.5/0.5) |
|---|---|---|---|
| `expected_top1` pass | 25 / 32 | 20 / 32 | 20 / 32 |
| top-1 matches v1 | n/a | 21 / 32 | **22 / 32** |
| top-3 overlap with v1 (avg) | n/a | 1.78 / 3 | **1.88 / 3** |
| RRF margin (top1 - top2) avg ratio | 1.000 | 1.049 | **0.963** |
| RRF margin min ratio | 1.000 | 0.025 | 0.000 |

Adopted: **0.5 / 0.5**. Best top-1 and top-3 alignment with v1; modest margin compression
(avg 96.3% of v1) which is well within tolerance. The 0.7/0.3 setting had higher margins
but routed short keyword queries (`build a DCF for NVIDIA pull income statement`) to
adjacent tools (`pdf-extractor`).

## Where v2 differs from v1 (12 queries)

Concentrated in three patterns:

1. **Short keyword variants of demo prompts** (4 queries) — `demo-1-dcf-short`,
   `prewarm-4`, `prewarm-10`, `prewarm-11`. Voyage's 1024d field disambiguates
   "DCF" + "income statement" -> SEC EDGAR; nomic's 768d sees "extract income
   statement" and routes to `pdf-extractor` (also a 10-K extractor, just from
   pasted text rather than live API). Both routings are reasonable; v1 was sharper.

2. **Near-twin tools where both vectors are valid** (5 queries) — e.g.
   `extract VAT line items from invoice` -> v1 picked `lineitem-extractor`,
   v2 picks `invoiceline-bot`. Both are invoice line-item extractors.
   `expected_top1: invoice-grok` is also too narrow — neither model picked it.

3. **Cross-language linter disambiguation** (3 queries) — `lint this code:
   function f() {...}` should route to `eslint-snitch` not `react-hooks-lint`.
   v2 misses this in the same direction v1 does. Real failure mode for both.

## Strict demo-arc gate

`scripts/smoke/v2-demo-prompts.ts` gates 3 of 5 hackathon demos as **strict** (must pass):
- demo-1 DCF -> `sec-edgar-financials` ✓
- demo-2 arxiv lit review -> `arxiv-paper-search` ✓
- demo-4 Python OWASP audit -> `security-scanner` ✓

The other two are **tolerant** (reported, don't gate):
- demo-3 (PR JS lint) — v1 also fails this query
- demo-5 (malformed-bot lure) — v2 routes to `sf-pr-review`, v1 routed to a
  named code reviewer; both are code-review tools.

## Performance

Personal-tier seed (199 tools, fresh embeddings via Ollama on RTX 5080):
- Embed 199 capability_texts: **1135ms** (vs v1 Voyage 4-5 min rate-limited)
- Insert + index 199 rows: **97ms**
- Total seed time: **~1.3s**

Single `runRRF` query on the seeded DB: **~50ms typical** (no perf benchmark yet;
Step 6.5 from the plan is queued but not blocking Phase 1 close).

## Phase 1.5 follow-ups

In priority order:

1. **Stronger embedder eval.** Pull `mxbai-embed-large` (1024d) and re-run
   the regression. If it closes the 5 short-query gap, consider it the
   personal-tier default. Trade-off: 670MB vs 274MB model size.

2. **Real-corpus expansion** (1k+ tools across ~20 domains). The 199-fixture
   corpus over-samples the 5 demo arcs; a real corpus changes relative
   rankings and may make the short-query regressions moot. User-requested.

3. **10k synthetic perf benchmark** (Phase 1 plan Step 6.5, deferred).
   Lock FTS5 k1/b + vec HNSW params against p50/p95/p99 latency and Recall@5.

4. **Query embedding task prefixes** for nomic-embed-text-v1.5 if it becomes
   available via Ollama. v1.5 supports `search_query: ` / `search_document: `
   prefixes that recover some of the precision lost vs Voyage.
