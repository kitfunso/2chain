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

## Follow-up: reliability arm as third RRF signal (2026-05-23, negative)

**Hypothesis tested:** A2 open item #2 — adding `reliability_score` as a third RRF arm (alongside vector + text) might surface high-quality real-corpus tools above noisy synthetic ones at 10k scale.

**Distribution context** (from a probe of `metadata.reliability_score` per corpus):
- 434 corpus: 99.5% above 0.80 gate, mean 0.946 — clustered near 1.0, low discrimination signal
- 10k corpus: 80.4% above 0.80 gate, mean 0.843, p10/p50/p90 = 0.60/0.85/1.00 — broader distribution

**Sweep result** (`scripts/eval/sweep-reliability-arm.ts`, vec=0.5 text=0.5 fixed, reliability arm top-N=50):

| Weight | 434 NDCG@3 | 10k NDCG@3 |
|---|---|---|
| 0.00 (baseline) | **0.7296** | **0.3139** |
| 0.10 | 0.7178 | **0.3142** (marginal) |
| 0.25 | 0.6691 | 0.3135 |
| 0.50 | 0.5767 | 0.3005 |
| 1.00 | 0.2101 | 0.1139 |

**Negative on both corpora.** 434 has too little reliability discrimination (mean 0.946) for the arm to differentiate; any non-zero weight injects noise. 10k has more spread but `reliability_score` is **uncorrelated with query relevance** — a tool with reliability 1.0 isn't more likely to be the right answer for query Q than a tool with reliability 0.85, since both are already above the gate. The arm is signal-free for the eval's purpose.

## The three-strikes finding

Three simple remediations attempted, all negative:

| Remediation | 434 vs A1 baseline | 10k vs A2 baseline |
|---|---|---|
| 1. Global `kind=tool` filter | 0.6765 ❌ | 0.2472 ❌ |
| 2. Per-query kind targeting | 0.7062 ❌ | 0.2844 ❌ |
| 3. Reliability arm (best weight) | 0.7296 ❌ tied | 0.3142 ❌ marginal |

**Pattern:** A1's relevance maps were graded for the small-corpus surface with unfiltered RRF retrieval. Any single-axis change moves away from that calibration. The maps include cross-kind incidental hits (#1, #2 break those); reliability is uncorrelated with the eval's query semantics (#3 has no signal).

**The remaining real fix paths are non-trivial:**
- **Re-grade relevance maps at scale.** Run the judge ensemble against the 10k corpus with kind-restricted candidate pools, producing v2-golden-10k.json with relevance specifically calibrated for the larger corpus. Expensive (LLM calls roughly proportional to 10k×~50-candidate pool).
- **Cross-encoder re-ranking.** After RRF top-K, re-rank with a more expensive query-aware scorer (e.g., LLM scoring of the top-20 candidates). Adds latency but could recover quality at scale.
- **Hybrid query routing.** Different query types (e.g., "find me an MCP server for X" vs "transcribe an audio file") may need different retrieval strategies. Plan a routing layer.
- **Phase 2 D (Postgres + pgvector).** HNSW + filter pushdown gives real tuning surface that vec0 brute-force doesn't. Combined with one of the above remediations.

**What we know for sure now:** the eval gate (`v2-baseline-native.json`, 0.7296) is calibrated to 434-corpus retrieval. It's a useful **regression guard** for the small corpus but cannot be used to verify retrieval quality at production scale without one of the harder fixes above.

## Follow-up: per-query kind targeting (2026-05-23, infrastructure shipped, NDCG still drops)

**Implemented:** `expected_kind` field added to every `v2-golden.json` query (90 `tool`, 4 `skill`, 3 `subagent`, 3 no-kind for adversarial). Schema enum extended. Runner passes `q.expected_kind` to `discover()`.

**Result: per-query targeting beats global kind filter but still drops both baselines.**

| Approach | 434 NDCG@3 | 10k NDCG@3 |
|---|---|---|
| No kind filter (A1/A2 baselines) | **0.7296** | **0.3139** |
| Global `kind=tool` | 0.6765 | 0.2472 |
| Per-query kind targeting | 0.7062 | 0.2844 |

**Why it still drops:** A1's relevance maps were constructed without kind awareness. Some queries' relevance maps include skills/subagents at rel=1 or rel=2 (judges graded cross-kind candidates as "related" or "acceptable"). Any kind filter excludes those incidental hits and loses NDCG points.

**Net effect of this episode:** the infrastructure is correct and ships (schema field, runner support); it just doesn't recover NDCG by itself. To make per-query kind targeting a positive remediation, the relevance maps must be re-graded with kind-restricted candidate pools — each query's relevance map should only contain entries of `expected_kind`. That's a separate, larger episode (re-running the judge ensemble with kind-aware candidate sourcing).

**Alternative paths preserved:**
- **Reliability-score post-filter or third RRF arm** (open item #2 from A2). Independent of kind question; addresses the synthetic-tool dilution half. Likely the cheaper next experiment.
- Phase 2 D (Postgres + pgvector) with proper HNSW + filter-pushdown.

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
