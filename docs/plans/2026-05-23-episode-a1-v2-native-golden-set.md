# Episode A1 — Hand-graded v2-native golden ranking set (rev 4)

**Status:** Engineering-reviewed (rev 1 → rev 2 closed 9 must-fix items; rev 3 inline-patched 2 high + 1 med advisory items; rev 4 drops the demo-arc gate per Keith's directive 2026-05-23). See `Revision history` at the bottom.

**Goal:** Replace the v1-Voyage-calibrated `golden-queries.json` + `v1-baseline.json` parity bar with a **v2-native** ground truth: 100 queries × top-3 expected, each grade earned against the actual v2 seeded corpus (199 fixture + 142 catalog + 77 MCP = 418 tools). Every downstream embedder swap, retrieval-weight tune, and Phase 2 driver swap measures against this set instead of inheriting v1/Voyage quirks.

**Why this episode first:** The Phase 1 retro notes that the current golden set is v1-calibrated, so "lower v1 alignment" does not mean "worse retrieval" — it just means semantic field differs from Voyage. mxbai-embed-large lost 5 of 32 queries this way despite higher MTEB ratings. Until we have v2-native ground truth, every future model/param decision is calibrated against artefacts of the model 2chain has already removed.

**Prerequisites:**
- v2 SQLite DB built and seeded: `TWOCHAIN_DB_PATH=/tmp/v2.db npx tsx scripts/seed/v2-seed.ts` (or current seed entry-point).
- Ollama running with `nomic-embed-text` AND `mxbai-embed-large` pulled (both needed for the multi-embedder candidate pool — mxbai is already in repo as opt-in per Phase 1 retro).
- `master` branch up to date; new branch `feat/v2-native-golden`.

**Estimated scope:** 8 steps. One `/dev-framework-rl` episode. ~2 working days with the multi-source candidate pool + two-judge ensemble + spot-check pattern.

**Non-negotiables enforced:** real DB tests (no mocks); writes go through `Storage` interface; no `pg`/`better-sqlite3` imports outside `src/storage/`.

---

## Step 0: ~~Pre-flight demo-arc gate~~ — DROPPED (rev 4, 2026-05-23)

Per Keith's directive: "we don't need to demo it anymore." The demo-arc 10/10 strict gate is removed from this episode. Implications:

- **Why this is OK structurally:** the Step 0 preflight had already exposed the demo arc as a Voyage-era artefact (7/10 strict against current `master` even after seed + MCP import). Three failures: DCF-short routes to `pdf-extractor` (Phase 1 retro called this out); the JS-lint cluster has fractured across `eslint-snitch`, `eslint-stylecheck`, `code-review-mini`, and `malformed-bot`. Pinning a 10/10 strict gate on top of a cluster the corpus no longer treats as canonical was the failure mode this episode existed to detect; the preflight surfaced it before any judge grading was paid for.
- **What happens to the 10 demo-arc queries in the stratum table:** redistributed in Step 2 below (rebalanced to: pre-warmed 17, single-tool unambiguous 28, near-miss 23, ambiguous 14, multi-tool 10, skill/subagent 5, adversarial 3, total 100).
- **What happens to CLAUDE.md Rule 8 ("Never break the demo"):** flagged for Keith's separate decision. Rule 8 references the same five demo prompts and CI obligations that this gate enforced. If Keith confirms Rule 8 is also dropped, that edit goes through the Hand-Maintained Files protocol (show content, explicit apply, .old backup) — not silently. **The plan does not assume Rule 8 is dropped; it only stops gating Episode A1's eval on demo-arc strict.**
- **Preflight script** (`scripts/eval/preflight-demo-arc.ts`) is retained on the branch as a diagnostic (not a gate). It documents the 7/10 baseline against current `master` so future regressions are visible. Not run in CI.

Steps renumbered: old Step 1 → Step 1, etc. (no shift; Step 0 was the only insert above old Step 1).

---

## Step 1: Snapshot the corpus + prewarm list with content-addressed signatures

**Files:**
- `scripts/eval/dump-corpus.ts` (new)
- `tests/fixtures/v2-corpus-snapshot.json` (new)
- `tests/fixtures/v2-prewarm-snapshot.json` (new)
- `src/eval/corpus-signature.ts` (new — shared library: canonical projection + hash)

**What:**

`v2-corpus-snapshot.json` enumerates every tool via `Storage.listTools({})` and writes a stable per-tool record. The signature (`corpus_sha256`) is computed over a **canonicalised projection**, NOT the raw dump:

```ts
// src/eval/corpus-signature.ts
interface CanonicalToolEntry {
  name: string;
  version: string;
  namespace: string;
  kind: 'tool' | 'skill' | 'subagent';
  capability_text_sha256: string;  // hex
  schema_summary_sha256: string;   // hex
}
function signCorpus(tools: CanonicalToolEntry[]): string {
  const sorted = [...tools].sort((a, b) =>
    (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version),
  );
  return sha256(JSON.stringify(sorted));  // no whitespace, sorted keys per JCS-lite
}
```

This excludes ephemeral fields (`id` UUIDs, `rowid`-derived ordering, `created_at`, `updated_at`) so:
1. A re-seed of `/tmp/v2.db` with the same logical corpus produces the same hash.
2. Phase 2's Postgres backend swap produces the same hash if `{name, version, namespace, kind, capability_text, schema_summary}` are the same — which the `Storage` interface guarantees (rule 7 in `CLAUDE.md`).

`v2-prewarm-snapshot.json` snapshots the contents of `PREWARM_QUERIES` (exported const at `src/services/discover.ts:50`) at signing time. Hash = sha256 of the sorted query list. Runner cross-checks this hash in Step 6 the same way as `corpus_sha256`.

**Verify:**
- `v2-corpus-snapshot.json` has ≥400 entries; demo-arc tools present (`sec-edgar-financials`, `arxiv-paper-search`, `eslint-snitch`, `security-scanner`, malformed-bot canary).
- `corpus_sha256` is computed and printed at the end of `dump-corpus.ts`; running the script twice in a row on the same DB produces the same hash.
- `kind=tool` count > `kind=skill|subagent` count.
- `v2-prewarm-snapshot.json` has the same number of entries as `PREWARM_QUERIES.length`, and `prewarm_sha256` is printed.

**Commit:** `test(eval): snapshot v2 corpus + prewarm with content-addressed signatures (Phase-2-portable)`

---

## Step 2: Stratify + draft 100 queries (no grades yet)

**Files:**
- `tests/fixtures/v2-golden.json` (new — queries + expected fields only, no relevance map at this step)
- `tests/schemas/v2-golden.schema.json` (new — ajv schema, used by runner in Step 6)

**Stratification (rev 4, demo-arc bucket removed; prewarm count corrected to actual 31):**

| Stratum | Count | Purpose |
|---|---|---|
| Pre-warmed common queries | 31 | Match `PREWARM_QUERIES` in `v2-prewarm-snapshot.json` (actual current count, not the stale 17 the rev-2 plan assumed) |
| Single-tool unambiguous | 18 | Should be top-1 100% across reasonable embedders |
| Near-miss / disambiguation pair | 19 | Two plausible tools, only one correct |
| Ambiguous on purpose | 14 | Acceptance via `expected_top1_in: [...]` (includes the ESLint cluster + similar genuinely-tied groups) |
| Multi-tool ("which N tools would chain") | 10 | Tests top-3 set membership |
| Skill/subagent boundary | 5 | Appear in `discover`, rejected by `call` with `kind_not_callable` |
| Adversarial / capability mis-match | 3 | Should return low-confidence (RRF margin near zero) |
| **TOTAL** | **100** | |

Schema for `v2-golden.json` (machine-checked against `tests/schemas/v2-golden.schema.json` by the Step 6 runner):

```json
{
  "version": 2,
  "corpus_sha256": "<hex from Step 1; required>",
  "prewarm_sha256": "<hex from Step 1; required>",
  "ndcg_formula": "exp_gain_log2_rank1",
  "queries": [
    {
      "id": "demo-1-dcf",
      "stratum": "demo-arc",
      "q": "build a DCF for NVIDIA pull income statement",
      "expected_top1": "sec-edgar-financials",
      "expected_top3": ["sec-edgar-financials", "pdf-extractor", "yahoo-finance-fundamentals"],
      "relevance": {}
    }
  ]
}
```

`relevance` is `{}` at this step. Steps 3-5 populate it.

`expected_top1_in` (alternative to `expected_top1`) is used by the "ambiguous on purpose" stratum.

**Verify:**
- 100 entries in `queries[]`; stratum counts match table within ±1.
- Every `expected_top1` and every entry of `expected_top3` resolves to a tool in `v2-corpus-snapshot.json`.
- No duplicate `id`s.
- Prewarm-stratum queries are exactly the 17 strings from `v2-prewarm-snapshot.json` (lint-checked by ajv schema).

**Commit:** `test(eval): stratify 100 v2-native queries (queries only, no grades)`

---

## Step 3: Build embedder-independent candidate pool per query

**Files:**
- `scripts/eval/build-candidate-pool.ts` (new)
- `tests/fixtures/v2-golden-candidates.json` (new — per-query candidate set, before grading)

**What:** For each of the 100 queries, the candidate pool is the **union** of five embedder-independent sources, deduplicated, capped at 50 distinct candidates per query:

1. **BM25 top-20** — FTS5 only, no vector. The strongest non-embedder retrieval signal in the system.
2. **nomic-embed-text top-10** — current production embedder.
3. **mxbai-embed-large top-10** — opt-in embedder already in repo. Different semantic field per Phase 1 retro.
4. **Random control top-10** — uniform random sample of 10 tools from the full corpus (seeded RNG, query-id deterministic). Ensures tools no retrieval path likes can still be judged "ideal" if they're the right answer.
5. **Author-asserted top-3** — tools listed in `expected_top3` for that query.

Cap: 50 per query (binds the grading bill; 100 × 50 × 2 judges = 10k LLM calls max).

Output `v2-golden-candidates.json` per query: `{id, candidates: [{name, version, sources: ["bm25", "nomic", "mxbai", "random", "author"]}]}`. The `sources` array is the audit trail — Step 4 reasoning checks read it.

**Why this matters:** the rev-1 critic identified that "top-10 from current discover.ts" is the calibration trap one layer downstream — judges only see what the current embedder surfaces, so the eval can never reveal "embedder missed the right tool". The five-source union breaks that closed loop: BM25 finds lexical matches the vector misses, multi-embedder catches semantic differences, random sample catches tools no path likes.

**Verify:**
- Every query has ≥5 distinct candidates and ≤50.
- Every candidate's `sources` array is non-empty.
- For ≥80% of queries, ≥3 of the 5 sources contributed at least one candidate (sanity-check that the sources are pulling in different sets, not all returning the same 10 tools).
- BM25 source returns ≥3 candidates per query (else FTS5 is misconfigured — root-cause, not patch).

**Commit:** `test(eval): build embedder-independent candidate pool (5-source union, cap 50)`

---

## Step 4: Two-judge LLM ensemble grading with banded disagreement actions

**Files:**
- `scripts/eval/grade-llm-judge.ts` (new)
- `tests/fixtures/v2-golden-judge-raw.json` (new — per-judge per-query-candidate grades)
- `tests/schemas/v2-golden-judge-raw.schema.json` (new — ajv schema)
- `tests/fixtures/v2-golden-disagreements.json` (new — queries routed to Keith adjudication)

**What:** Two judges (Claude 4.7 + Codex GPT-5.5 via the configured Codex lane) each score every `(query, candidate)` pair from Step 3. Each judge outputs `{relevance: 0|1|2|3, rationale: <1 sentence>}` per pair on the graded scale:

- `3` = ideal (this is what the query is asking for)
- `2` = acceptable (works, partial credit)
- `1` = related (same domain, wrong specific tool)
- `0` = wrong

`v2-golden-judge-raw.json` records both judges' outputs verbatim per pair. Schema lints: every query has grades from both judges covering exactly the candidate pool from Step 3 (`v2-golden-candidates.json`).

**Disagreement bands (each with a distinct action):**

| Disagreement rate | Action |
|---|---|
| <10% (judges agreed too closely) | Swap one judge for a different model family (Gemini 2.x or DeepSeek), re-grade. Agreement-into-corner check. The closely-agreed grades stay; only the swap-impacted queries are re-evaluated against the third opinion. |
| 10-25% | Route disagreements to Keith adjudication (Step 5). The interesting band — judges disagree on real edge cases, human attention is the right resource. |
| >25% | Queries themselves are ambiguous; rephrase the affected queries in Step 2 before re-grading. Widening the candidate pool doesn't fix prompt clarity. |

Disagreement = `|claude_score - codex_score| >= 2` per pair. Query-level disagreement = ≥1 such pair on any of its candidates.

**Verify:**
- Both judges produced grades for every pair in `v2-golden-candidates.json` (count match).
- Disagreement rate lands in one of the three bands, the corresponding action was taken, and the action is recorded in a `grading-actions.log` file in the trajectory.
- Demo-arc strata have zero disagreements after action (else the queries themselves are ambiguous, not the grades — rephrase).
- `tests/fixtures/v2-golden-disagreements.json` has between 10 and 25 entries (the routed-for-adjudication band).

**Commit:** `test(eval): two-judge ensemble grading with banded disagreement actions`

---

## Step 5: Human adjudication with machine-checkable schema

**Files:**
- `tests/fixtures/v2-golden.json` (update — fill in adjudicated `relevance` maps)
- `tests/schemas/v2-golden-adjudication.schema.json` (new — runner lints this in Step 6)
- `docs/plans/2026-05-23-episode-a1-grading-notes.md` (new — per-query rationale, prose only)

**What:** Keith reviews `v2-golden-disagreements.json`. For each disputed pair, picks the correct grade and (optionally) records a one-sentence rationale.

**Adjudication schema (load-bearing, machine-checked):**

Every query in `v2-golden.json` must have a `relevance` map covering exactly the union of `{expected_top3 entries} ∪ {all candidates either judge graded ≥1}`. If the runner finds a relevance map missing any of these names, it refuses to start (exit 2). This stops the failure mode where some queries have rich relevance maps (8 tools) and others sparse (3 tools), which silently changes per-query NDCG ceilings.

```json
// tests/schemas/v2-golden-adjudication.schema.json
{
  "type": "object",
  "properties": {
    "queries": {
      "type": "array",
      "items": {
        "required": ["id", "relevance"],
        "properties": {
          "relevance": {
            "type": "object",
            "minProperties": 3,
            "additionalProperties": {"type": "integer", "minimum": 0, "maximum": 3}
          }
        }
      }
    }
  }
}
```

Rationale prose lives in the `grading-notes.md` appendix, not in `v2-golden.json`. The JSON is the lintable contract; the notes are the audit trail.

**Verify:**
- Every query in `v2-golden.json` has a `relevance` map covering the union (runner pre-flight passes).
- `v2-golden-disagreements.json` has zero open entries.
- `corpus_sha256` and `prewarm_sha256` fields in `v2-golden.json` match the snapshots committed in Step 1 (else the corpus drifted mid-grading — abort, redo from Step 1).

**Commit:** `test(eval): finalize hand-graded v2-native golden set (100 queries, adjudicated)`

---

## Step 6: Regression runner + canonical NDCG@3 formula + baseline variance

**Files:**
- `scripts/smoke/v2-golden-v2native.ts` (new)
- `src/eval/ndcg.ts` (new — formula library, also unit-tested)
- `tests/v2-eval-ndcg.test.ts` (new — unit test pinning the formula)
- `tests/fixtures/v2-baseline-native.json` (new — current-embedder baseline, mean + stddev over N=5)

**Canonical NDCG@3 formula (pinned, no ambiguity):**

```
gain(rel) = 2^rel - 1                  // exponential gain, rewards "ideal" vs "acceptable" sharply
discount(rank) = log2(rank + 1)        // rank starts at 1, so position 1 = log2(2) = 1.0
DCG@3 = Σ_{i=1..3} gain(rel_i) / discount(i)
IDCG@3 = Σ_{i=1..3} gain(sorted_rel_i) / discount(i)   // ideal: relevance map sorted desc
NDCG@3 = DCG@3 / IDCG@3
```

Tie-break: when two candidates tie on RRF score, **stable name+version ascending sort**. Documented in `src/eval/ndcg.ts` header and pinned by the unit test.

`v2-golden.json#ndcg_formula` field must equal the string `"exp_gain_log2_rank1"`. The runner refuses to run on a fixture that names a different formula version (forward-compat for a future tunable, but no silent swaps).

**Unit test (`tests/v2-eval-ndcg.test.ts`):** hand-computed example. Three candidates returned, relevance map `{A: 3, B: 2, C: 1}`, RRF order `[A, B, C]`. Expected NDCG@3 = 1.0 exactly. Second case: order `[C, A, B]`. Hand-computed DCG = `(2^1-1)/log2(2) + (2^3-1)/log2(3) + (2^2-1)/log2(4) = 1 + 4.416 + 1.5 = 6.916`; IDCG = `7 + 1.893 + 0.5 = 9.393`; NDCG ≈ `0.7363`. Test asserts within 1e-9.

**Runner metrics:**
- **NDCG@3** per query and macro-averaged (primary).
- **MRR of first ideal-grade (rel=3) hit** (secondary).
- **Recall@3** — fraction of `expected_top3` tools in v2 top-5 (sanity).
- **Single-tool unambiguous top-1 hit rate** — replaces the demo-arc strict gate. Across the 28 single-tool-unambiguous queries, top-1 identity must match. Soft floor: ≥25/28 across all N=5 baseline runs (mean - 2*stddev). This catches the same regression class the old demo-arc gate caught (a tool the corpus says is the canonical answer to a clear query) without the v1-Voyage demo-prompt pin.

`v2-baseline-native.json` schema:

```json
{
  "embedder": "nomic-embed-text",
  "rrf_weights": {"vector": 0.5, "text": 0.5},
  "corpus_sha256": "<from Step 1>",
  "prewarm_sha256": "<from Step 1>",
  "ndcg_formula": "exp_gain_log2_rank1",
  "runs": 5,
  "ndcg3": {"mean": <num>, "stddev": <num>, "min": <num>, "max": <num>},
  "mrr": {"mean": <num>, "stddev": <num>},
  "recall3": {"mean": <num>, "stddev": <num>},
  "single_tool_top1": [<5 ints, count of single-tool unambiguous top-1 hits per run>],
  "captured_at": "<ISO timestamp>"
}
```

The CI gate floor (Step 7) is `mean - 2 * stddev`, NOT the single observed mean. Documented in the file.

**Runner pre-flight checks (executed in order — structural first, semantic second; all must pass):**
1. ajv lint against `tests/schemas/v2-golden.schema.json` AND `tests/schemas/v2-golden-adjudication.schema.json` (clear schema error if a field is missing)
2. `v2-golden.json#ndcg_formula === "exp_gain_log2_rank1"` (forward-compat string check)
3. `v2-golden.json#corpus_sha256` matches current DB's signature (semantic guard)
4. `v2-golden.json#prewarm_sha256` matches current `PREWARM_QUERIES`

Any pre-flight failure: exit 2 with a message naming the failed check, do NOT run queries.

Old `scripts/smoke/v2-golden-regression.ts` and `tests/fixtures/v1-baseline.json` move under `tests/fixtures/legacy/` (and `scripts/smoke/legacy/`). Not deleted — v1 alignment can still be a useful diagnostic, just no longer a gate.

**Verify:**
- Unit test passes.
- Runner exits 0 against current `master` build; demo-arc strict gate 10/10.
- `v2-baseline-native.json` records 5 runs; stddev is computed; stddev ≤ 0.02 (else retrieval is non-deterministic enough that the gate will flap — root-cause before pinning, do not patch).
- `mean(NDCG@3) >= 0.70` (else either Step 2 query distribution is too adversarial or current retrieval has a regression — investigate before this episode closes).

**Commit:** `test(eval): v2-native NDCG@3 runner + canonical formula + 5-run baseline`

---

## Step 7: CI gate + caller-surface migration + CLAUDE.md Rule 14 update

**Files:**
- `.github/workflows/v2-golden-native.yml` (new) OR extension of existing `v2-install-smoke.yml`
- `package.json` (update — new npm script `eval:golden`, remove old script if it referenced v2-golden-regression)
- `CLAUDE.md` (update — Rule 14 wording)
- `docs/plans/2026-05-02-phase-1-personal-tier.md` (update — note Step 0/Step 10 v1 calibration is superseded by Episode A1)
- `docs/retros/2026-05-02-phase-1-retro.md` (update — add forward-pointer to v2-baseline-native.json under "What's queued")
- Any other file matched by `grep -rIn "v2-golden-regression\|v1-baseline\|golden-queries" --include='*.{ts,js,json,yml,yaml,md,sh,toml}'`

**Step 7a — Caller-surface enumeration (mandatory before commit):**

```bash
# Run this and pipe to a checklist before commits land
grep -rIn "v2-golden-regression\|tests/fixtures/v1-baseline\|tests/fixtures/golden-queries" \
  --include='*.ts' --include='*.js' --include='*.json' \
  --include='*.yml' --include='*.yaml' --include='*.md' \
  --include='*.sh' --include='*.toml' \
  -- C:/Users/skf_s/2chain
```

Known callers (commit must touch all):
- `package.json#scripts` (any reference)
- `.github/workflows/v2-install-smoke.yml`
- `CLAUDE.md` Non-Negotiable Rule 14
- `docs/plans/2026-05-02-phase-1-personal-tier.md`
- `docs/retros/2026-05-02-phase-1-retro.md`
- `scripts/capture-v1-baseline.ts` (creates `v1-baseline.json` — moves to `scripts/legacy/`)
- `scripts/smoke/tune-rrf-weights.ts` (reads both v1-baseline + golden-queries — moves to `scripts/smoke/legacy/`)
- `scripts/smoke/v2-mxbai-parity.ts` (reads both — moves to `scripts/smoke/legacy/`)
- `scripts/smoke/v2-demo-prompts.ts` (reads golden-queries — orphaned by Step 0's new preflight script; moves to `scripts/smoke/legacy/`)
- `docs/perf/phase-1-baseline.md` (text references — update wording, no path change needed)

Any caller surfaced by grep beyond this list is added to the same PR — no separate "follow-up" commit.

**Step 7b — CLAUDE.md Rule 14 rewrite:**

Old:
> **Embedder swaps require a quantitative parity bar.** Any change to the embedding model (Voyage → nomic-embed-text, nomic → bge-large, etc.) must show MRR / Recall@5 parity vs `tests/fixtures/v1-baseline.json` golden ranking set, with top-1 RRF margin no more than 10% smaller than baseline. Why: a model swap that silently degrades retrieval is the easiest way to break agent trust, and the only way to catch it is to measure.

New:
> **Embedder swaps require a quantitative parity bar.** Any change to the embedding model (nomic-embed-text → mxbai-embed-large, → bge-large, etc.) must clear:
> - Mean NDCG@3 ≥ baseline `mean - 2 * stddev` (per `tests/fixtures/v2-baseline-native.json`)
> - Single-tool-unambiguous top-1 hit rate ≥ baseline `mean - 2 * stddev` (catches "the corpus's canonical answer to a clear query stopped winning" regressions)
> - Recall@3 drop ≤ 10% vs baseline mean
>
> NDCG@3 formula is pinned: `(2^rel - 1) / log2(rank + 1)`, rank starting at 1, stable name+version tie-break on equal RRF. See `src/eval/ndcg.ts` and the unit test in `tests/v2-eval-ndcg.test.ts`. Why: a model swap that silently degrades retrieval is the easiest way to break agent trust, and the only way to catch it is to measure. The v1-Voyage baseline (`tests/fixtures/legacy/v1-baseline.json`) is retained for diagnostic comparison but is no longer the gate.

**Step 7c — CI workflow:**

`.github/workflows/v2-golden-native.yml` runs on every PR to `master`:
- Seeds the v2 DB.
- Runs `npm run eval:golden` which invokes `scripts/smoke/v2-golden-v2native.ts`.
- Fails on:
  - `NDCG@3 < baseline.ndcg3.mean - 2 * baseline.ndcg3.stddev`
  - `single_tool_top1 < baseline.single_tool_top1.mean - 2 * baseline.single_tool_top1.stddev`
  - `Recall@3 < baseline.recall3.mean * 0.90`
- Posts a single-line PR comment summarising the three numbers vs baseline. (Comment is informational, not gating.)

**Verify:**
- Workflow runs to green on `feat/v2-native-golden`.
- Intentionally regressed PR (e.g. swap weights to 0.9/0.1) trips the gate (manual check, not merged).
- `grep` of `v2-golden-regression` and `v1-baseline` returns ONLY hits in `tests/fixtures/legacy/`, `docs/retros/`, and the now-updated `CLAUDE.md`. Any hit elsewhere = unfinished caller migration.
- CLAUDE.md Rule 14 reads the new wording. The diff is shown to Keith before merge per `Hand-Maintained Files (CRITICAL)` global rule.

**Commit:** `ci(eval): gate PRs on v2-native NDCG@3 + demo arc + migrate Rule 14 + caller surface`

---

## Critic gates for `/dev-framework-rl`

The orchestrator treats this episode as **done** only when ALL of:

1. (Demo-arc preflight gate dropped per rev 4; replaced by Step 6 `single_tool_top1` floor.)
2. `tests/fixtures/v2-golden.json` has 100 graded queries with stratum counts matching Step 2's table within ±1.
3. `v2-golden.json#corpus_sha256` matches `v2-corpus-snapshot.json` content-addressed signature; `#prewarm_sha256` matches `v2-prewarm-snapshot.json`.
4. `v2-golden.json#ndcg_formula` is `"exp_gain_log2_rank1"`; unit test `tests/v2-eval-ndcg.test.ts` passes.
5. `v2-golden.json#queries[].relevance` covers the union schema per Step 5 (ajv lint passes).
6. `scripts/smoke/v2-golden-v2native.ts` exits 0 against current `master`.
7. `tests/fixtures/v2-baseline-native.json` records N=5 runs with mean + stddev for NDCG@3, MRR, Recall@3.
8. `CLAUDE.md` Non-Negotiable Rule 14 references `v2-baseline-native.json` and the NDCG@3 formula, with the v1 file moved under `tests/fixtures/legacy/`.
9. `grep` of `v2-golden-regression` / `v1-baseline` returns only legacy + retro hits.
10. CI workflow runs green on the PR; required GitHub checks all green.
11. Phase 1 retro item "Hand-graded v2 golden set" struck through with the PR link.

---

## Risks the framework should not patch over

- **LLM-judge bias.** Two judges from related model families share blind spots. Mitigation is the 5-source candidate pool + disagreement-band actions + Keith adjudication. If the <10% band fires repeatedly, the ensemble has agreed itself into a corner; swap the third judge, do not silently widen pools.
- **Stratum gaming.** Easy to write 100 queries that all look like the demo arc. The stratum table is the load-bearing artefact; if the orchestrator collapses a stratum to zero, this is a Lazy-Smart patch, not a feature.
- **Corpus drift mid-grading.** Adding tools between Step 1 and Step 5 invalidates earlier grades. Step 6's `corpus_sha256` content-addressed check is the guard rail; if it trips, redo from Step 1, not patch around it. Phase-2 portability is by design (canonicalised projection).
- **Variance handwaving.** If Step 6 stddev > 0.02, retrieval is non-deterministic enough that the CI gate will flap. Root-cause (FTS5 schema rebuild order, RRF tie-break) before pinning the gate, do not raise the tolerance.
- **Replacing the demo-arc gate with the single-tool-unambiguous floor.** The 28-query single-tool-unambiguous stratum now plays the same role: catches "canonical answer stopped winning" regressions without inheriting v1-Voyage demo-prompt pins. If this stratum's top-1 hit rate drops below baseline `mean - 2*stddev` in CI, root-cause before relaxing.
- **Outside-voice review on this plan before coding.** Global CLAUDE.md mandates `/plan-eng-review` or `/codex` on non-trivial plans before implementation. Already run for rev 1 (this is rev 2); re-run on rev 2 if dev-framework-rl's plan-eng-critic flags new issues.

---

## Known follow-ups (rev 2 critic flagged, accepted into execute)

These rev-2 plan-eng-critic findings were judged advisory (non-crit, verdict pass) and applied either inline above or as execute-time decisions:

- **Applied inline:** known-caller list extended (Step 7a); pre-flight reordered ajv-first (Step 6); demo-arc gate semantics over N=5 made explicit (Step 6 + Step 7c).
- **Carried into execute:** Step 3 candidate-pool floor raise to ≥15 distinct (mandate in `build-candidate-pool.ts` verify); Step 4 verify rephrased in query-routing-count rather than per-pair rate; LLM-call budget envelope recorded in trajectory (~10k calls cap; third-judge swap may double impacted slice).

## Revision history

**rev 3 → rev 4 (2026-05-23, user directive "we don't need to demo it anymore"):**
- Step 0 demo-arc preflight gate dropped. Preflight script kept as diagnostic only (not CI-gated).
- Step 2 stratum table rebalanced: 10 demo-arc queries reallocated to single-tool (+3), near-miss (+3), ambiguous (+4); 100-query total unchanged.
- Step 6 baseline schema field `demo_arc_strict` renamed to `single_tool_top1`; same role.
- Step 7b Rule 14 rewrite: "demo-arc strict gate 10/10" line replaced with "single-tool-unambiguous top-1 hit rate ≥ baseline mean - 2*stddev".
- Step 7c CI gate updated to match.
- CLAUDE.md Rule 8 ("Never break the demo") is **flagged for Keith's separate decision**; this revision does not touch it. If Rule 8 also goes, that edit is a separate Hand-Maintained Files protocol turn (show content + explicit apply + .old backup).

**rev 2 → rev 3 (2026-05-23, inline patches after plan-eng-critic round 2 pass score 84):** addressed 2 high + 1 med findings inline (callers, demo-arc N=5 semantics, pre-flight order); 4 advisory items recorded under "Known follow-ups" above.

**rev 1 → rev 2 (2026-05-23):** Addressed plan-eng-critic round-1 verdict (score 62, fail, 2 crit + 7 high + 3 med/low):

1. **crit:** Calibration-trap regression in judge candidate pool → Step 3 rebuilt as 5-source embedder-independent union (BM25 top-20, nomic top-10, mxbai top-10, random control top-10, author top-3; dedup, cap 50).
2. **crit:** CLAUDE.md Rule 14 contradiction → new Step 7b explicitly rewrites Rule 14 with new wording in this same PR.
3. **high:** NDCG@3 formula unspecified → canonical formula pinned in Step 6 (`(2^rel - 1) / log2(rank+1)`, tie-break name+version asc), unit test in `tests/v2-eval-ndcg.test.ts`, `#ndcg_formula` enum on the fixture.
4. **high:** corpus_sha256 ephemeral-field leak + Phase-2 portability → redefined as canonicalised projection in Step 1 (shared lib `src/eval/corpus-signature.ts`).
5. **high:** Prewarm line-pin → new `v2-prewarm-snapshot.json` + `prewarm_sha256` cross-check.
6. **high:** Disagreement gate non-discriminating → Step 4 banded actions: <10% swap-judge, 10-25% human adjudication, >25% rephrase queries.
7. **high:** Baseline variance unmeasured → Step 6 mandates N=5 runs, CI floor = `mean - 2*stddev`, stddev cap 0.02 root-cause not raised.
8. **med:** Caller-surface incompleteness → new Step 7a grep + enumerated known callers, all in same PR.
9. **med:** Adjudication schema absent → new `tests/schemas/v2-golden-adjudication.schema.json`, runner lints per-query relevance map covers union.
10. **med:** Demo-arc 10/10 unproven → new Step 0 preflight gates the rest of the episode.
11. **low:** `corpus_snapshot` relative-path field → field dropped; `corpus_sha256` is content-addressed and sufficient.
