# 10k-Corpus Scale Verification — Episode A2

**Date:** 2026-05-23
**Branch:** `feat/a2-10k-perf-benchmark`
**Status:** **Scale-break detected. A1's gate does NOT hold at 10k corpus size.** Episode shipped as a diagnostic; CI gate intentionally NOT pinned at the degraded numbers.

## Headline

Episode A1's NDCG@3 baseline of **0.7296** (against the 434-tool corpus) **collapses to 0.3139** when the corpus is expanded to 10k synthetic + skill + subagent tools. Single-tool-unambiguous top-1 hit rate drops from 10/14 to **0/14**.

The plan's one-sided floor of NDCG@3 ≥ 0.60 is **not met**. Per the plan: this is "retrieval scaled wrong" territory, not a tolerance to relax. **The 0.3139 baseline is NOT pinned as the new gate.**

## Numbers

| Metric | 434 (A1) | 1k (subset) | 10k (full) |
|---|---|---|---|
| NDCG@3 mean | **0.7296** | 0.0530 | **0.3139** |
| Recall@3 mean | 0.4250 | 0.0267 | 0.1133 |
| MRR mean | 0.7645 | 0.0700 | 0.3283 |
| single-tool top-1 | 10/14 (71%) | 0/14 | 0/14 |
| p50 latency | (unmeasured) | 3–14 ms | **34–56 ms** |
| p95 latency | (unmeasured) | 4–18 ms | **60–87 ms** |
| p99 latency | (unmeasured) | 5–21 ms | **63–93 ms** |
| stddev across N=5 | 0.0000 | 0.0000 | 0.0000 |

(stddev=0 across all metrics — retrieval is deterministic at scale, no flap concern.)

## What the diagnostic queries show

For specific demo-arc queries, retrieval at 10k mixes legitimate tools with skills and synthetic competitors at top-1:

```
Q: "build a DCF for NVIDIA pull income statement"
  0.0164 pdf-extractor               ← top-1 (was sec-edgar at 434)
  0.0161 sec-edgar-financials        ← correct answer drops to top-2

Q: "search npm registry for a package"
  0.0164 publish-repo                ← SKILL, not a tool
  0.0161 search-first                ← SKILL, not a tool
  ... npm-search not in top-5 ...

Q: "transcribe an audio file with whisper"
  0.0160 freeze                      ← SKILL named after process freezing
  0.0125 mcp-gitlab__get_file_contents
  ... whisper-audio-transcribe not in top-5 ...
```

Even with a `kind=tool` filter, synthetic tools (`tempo-router-8k`, `helix-gateway-9a`, `thalia-sense-p0`) outrank the correct real-corpus tools for several queries.

## Root causes (hypothesis)

Two distinct issues, neither solvable by parameter tuning alone:

1. **Skill/subagent contamination.** A1's eval ran against a corpus containing 317 tools + 103 skills + 14 subagents = 434 entries. At that scale the right tool typically won top-1 because the candidate pool was small. At 10k corpus, skills outrank tools for queries whose phrasing (e.g. "search npm", "transcribe audio") matches skill names that talk about the same activity but aren't *tools*. The runner currently doesn't pass `kind: 'tool'` to `runRRF` — and per the probe, even with the filter applied, synthetic tools dilute the top-K.

2. **Synthetic-tool dilution.** The Strategy-A expansion adds ~9,735 synthetic tools whose `capability_text` is `{base_capability} + {vertical} + {geo} + {scenario} + {vendor}` permutations. While the diversity gate (cosine < 0.97 for 100% of 200 pairs) passes, the synthetic tools are STILL embedded in the same neighbourhood as their base capabilities. For a query that targets one of the 47 base templates, the synthetic variants of that template crowd the top-K.

The two mechanisms compound: skills crowd the top-K from above (different `kind`, similar phrasing), synthetic tools crowd it from below (same `kind`, similar capability_text).

## What this episode is NOT doing

Per the rev-4 plan, A2 is **scale verification + latency profile**, not a remediation. Remediation would require restructuring retrieval ranking — at minimum:

- Add a `kind: 'tool'` filter to the default `discover()` for "find me a tool" queries (or expose a `kind=` flag at the API surface). Skills/subagents should rank in their own search namespace, not against tools.
- Re-evaluate RRF weighting at scale (the prior 32-query sweep landed on `{0.5, 0.5}` at small corpus; 10k may want a different mix, but a sweep without the kind-filter fix would chase the wrong tradeoff).
- Consider re-ranking against the `reliability_score` post-RRF, OR seeding RRF with `reliability_score` as a third arm.

These belong in **future episodes** — likely as part of Phase 2 (D) where pgvector's HNSW + filter-pushdown can be tuned alongside.

## CI gate decision

**No CI gate pinned at degraded numbers.** The plan's rev-4 said "if NDCG@3 < 0.60 at 10k, this is a bug not a tolerance" — and the result is 0.31. Pinning a 0.31 floor in CI would normalise the regression. Options preserved for the next episode:

- (preferred) Land a `kind=tool` filter in `discover()`, re-baseline, then pin against the fixed numbers.
- (interim) Pin against the unchanged 434-tool baseline only (A1's gate stays the only CI gate; A2 didn't ship one).
- (rejected) Pin a 0.31 floor with a comment "investigating".

This episode chose **(interim)**: A1's gate (`v2-baseline-native.json`) remains the only retrieval CI gate. `v2-baseline-10k.json` and `v2-baseline-1k.json` are committed as **diagnostic artefacts**, not gating.

## Latency observations (informational, NOT SLOs)

At 10k corpus, single-query latency:
- p50: 34-56ms (mostly the Ollama embed call)
- p95: 60-87ms
- p99: 63-93ms

vec0's brute-force scan over 10k 768-d vectors is well under 100ms per query. Phase 2 (D) with pgvector HNSW should be faster, but vec0's current performance is already adequate for the corpus size 2chain plausibly hosts in the near term.

## What shipped

- `tests/fixtures/v2-corpus-10k-snapshot.json` — 10,167 entries, sha256 `5e77a6e1...`
- `tests/fixtures/v2-stress.json` — 50 stress queries, 5 strata
- `tests/fixtures/v2-baseline-10k.json` — diagnostic baseline (NOT a gate)
- `tests/fixtures/v2-baseline-1k.json` — diagnostic baseline (NOT a gate; alphabetic-first-1k subset is unrepresentative)
- `src/fixtures/generated-expanded.ts` — Strategy A expansion generator (vendor + scenario permutation, deterministic seed)
- `scripts/eval/build-10k-corpus.ts` — builder with diversity gate
- `scripts/eval/build-1k-subset.ts` — deterministic 1k subset extractor
- `scripts/smoke/v2-golden-v2native.ts` — extended with `--corpus-path`, `--include-stress`, `--baseline-out`, `--skip-hash-check` flags (backward-compatible; default `eval:golden` script behavior unchanged)

## Open items (next episodes)

1. **`kind=tool` filter at the discover surface** — **TESTED 2026-05-23: does NOT work as a one-liner.** See "Follow-up investigation" below.
2. **Rerank scoring with `reliability_score`** as a third arm or post-filter.
3. **Phase 2 D (Postgres + pgvector)** picks up the retrieval restructuring with real HNSW tuning capability.

## Follow-up investigation (2026-05-23, post-merge)

**Hypothesis tested:** A2's open item #1 — passing `kind: 'tool'` from the eval runner would filter out skill/subagent contamination and recover NDCG@3 at scale.

**Result: WORSE on both corpora.**

| Metric | 434 (A1 gate) | 10k (A2 baseline) |
|---|---|---|
| Without kind filter | 0.7296 | 0.3139 |
| With `kind=tool` filter | **0.6765** | **0.2472** |

The kind filter trips A1's CI gate (NDCG@3 0.6765 < 0.7296 floor) and *reduces* 10k retrieval quality.

**Why it failed:** `v2-golden.json` has a deliberate `skill-subagent-boundary` stratum (5 queries asking "find me a skill/subagent for X") where the graded relevance map's rel=3 entries are skill names (e.g. `senior-code-reviewer`, `commodity-backtest`, `de-sloppify`). Forcing `kind=tool` makes those queries return zero relevant results — each contributes 0 to NDCG. That penalty outweighs the skill-contamination benefit on the rest of the queries.

**Real remediation requires one of:**
- **Per-query kind expectation** (each `v2-golden.json` entry declares which `kind` it targets; runner passes that to `runRRF`). Lowest blast radius. Probably the right path.
- **Restructure eval to filter the relevance map by kind too** (so skill queries don't penalize tool-filtered retrieval). Doable but couples the eval to the filter logic.
- **Routing layer at the API surface** (`/discover/tools`, `/discover/skills`) instead of a unified `discover()` for all kinds. Bigger product change.
- **Reliability-score post-filter as a third RRF arm** (open item #2). Independent of the kind question; addresses the synthetic-tool dilution half.

The naïve filter is a patch, not a root-cause fix. Per global CLAUDE.md "Root Cause Over Patches": the underlying issue is that the eval graded skill targets alongside tool targets in one unified relevance map, and any kind-restrictive retrieval will inherit that mismatch. The real episode here is **"per-query kind targeting"**, not "kind filter".
