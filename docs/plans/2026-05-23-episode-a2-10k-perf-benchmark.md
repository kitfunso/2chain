# Episode A2 — 10k-corpus scale verification + latency profile (rev 4)

**Status:** Engineering-reviewed (rev 1 FAIL → rev 2 FAIL → rev 3 dropped the RRF sweep; only scale verification + latency profile remain). See `Revision history` at the bottom.

**Goal (final scope):** Generate a 10k-tool synthetic corpus, run the v2-native golden set + 50-query stress set against it with current retrieval defaults, and:

1. **Verify the eval gate scales** — NDCG@3 and Recall@3 floors hold at 10k corpus size; no regression vs A1's 434-tool baseline beyond expected dilution.
2. **Capture latency profile** — p50/p95/p99 at both 1k and 10k, measured. Phase 2 (D) inherits these as targets for pgvector.
3. **1k CI smoke gate** — guards future PRs against retrieval regressions, with measured (not extrapolated) floors.
4. **Phase-2 readiness** — `v2-baseline-10k.json` becomes a portable, content-addressed reference the Postgres backend swap measures against.

**What this episode is NOT doing (and why):**
- ~~FTS5 `k1`/`b` sweep~~ — hardcoded in the FTS5 library; not runtime-tunable in stock SQLite.
- ~~sqlite-vec HNSW sweep~~ — `vec0` 0.1.9 is brute-force flat. **HNSW tuning happens in D where pgvector exposes it.**
- ~~RRF weight sweep~~ — `src/types.ts:354-356` documents that the prior v2 32-query sweep already landed on `{0.5, 0.5}`. A 9-config single-axis sweep at 10k is validation, not discovery, and would require new env-var plumbing through `types.ts` + `discover.ts` + the runner that adds engineering surface for an outcome already known. **If the 10k baseline shows {0.5, 0.5} is wrong, D's pgvector work can sweep RRF alongside HNSW where the engineering cost is shared.**

**Why this scope is the right one:** Plan-eng-critic round 1 killed HNSW + BM25 (stack doesn't expose them). Round 2 killed the RRF sweep mechanism (no override plumbing exists; sweep is validation not discovery anyway). What remains is the load-bearing part: prove the eval gate scales, get latency numbers, ship a CI guard.

**Prerequisites:**
- `feat/a2-10k-perf-benchmark` branch off `master` (Episode A1 merged).
- Ollama running with `nomic-embed-text`.
- `tests/fixtures/v2-golden.json` from A1 (100 queries × graded relevance, stratum strings use hyphens: `single-tool`, `near-miss`, etc.).

**Estimated scope:** 4 steps. One `/dev-framework-rl` episode. **Wallclock budget: 2-3 hours** (10k Ollama embed dominates; sweep removed).

**Non-negotiables enforced:** real DB tests (no mocks); `Storage` interface only; new `scripts/eval/*.ts` use `SqliteStorage` from `src/storage/`, never raw `better-sqlite3`.

---

## Step 1: Generate the 10k synthetic corpus with diversity gate

**Files:**
- `scripts/eval/build-10k-corpus.ts` (new — uses `SqliteStorage`)
- `tests/fixtures/v2-corpus-10k-snapshot.json` (new — content-addressed snapshot)
- `src/fixtures/generated-expanded.ts` (new IF Strategy A's pilot fails)

**Diversity gate (load-bearing — fail loud, don't paper over):**

The existing `generateFixtures` produces ~190 entries from 47 distinct capability templates × 4 vendors. Reaching 10k requires expansion. Two strategies, tried in order:

**Strategy A — vendor + verb permutation of the 47 templates (15 pdf + 13 summarisation + 19 code-review per `src/fixtures/generated.ts`):**
- For each of 47 templates (15 pdf + 13 summarisation + 19 code-review per `src/fixtures/generated.ts`), generate ~220 variants by cross-product with seeded synthetic vendor names + verb/noun augmentations.
- **PILOT on 1k expanded tools FIRST.** Embed with nomic-embed-text. Sample 200 random pairs, measure cosine similarity. **GATE:** ≥80% must have cosine < 0.97.
- If pilot passes, scale to 10k and **re-run the 200-pair gate on the full 10k**. Diversity can degrade non-linearly when scaling (round-2 critic caught this). If 10k fails, fall to Strategy B.
- If pilot fails (1k fails the gate), skip directly to Strategy B without scaling.

**Strategy B — fixture templates + raw MCP server descriptions (corrected from rev 2):**
- `src/import/mcp-registry.ts` has **20 MCP server entries (77 individual tool stubs total)** (round-2 critic verified, NOT the 70 I claimed). Their descriptions are pre-vetted semantically distinct.
- Combine `47 fixture templates + 77 MCP tool stub descriptions = 124 distinct base lines`. Cross-product with synthetic vendor names + augmentation suffixes targeting ~80 permutations each = ~9,920 expanded entries. Tools (77) chosen over servers (20) because tool stubs have richer, more distinguishable capability descriptions; vendor permutation count drops accordingly.
- Same 1k pilot + full-10k gate as Strategy A.

**Strategy C — escalate (if both A and B fail):**
- Synthetic-corpus expansion at this scale is harder than this plan budgets for.
- Document the negative result; propose either growing the real corpus (Episode B1/B2 ingestion) first, OR running the bench at a smaller scale (5k) until expansion infrastructure matures.
- This is a legitimate outcome, not a failure.

**Count tolerance:** Generators are stochastic; final corpus may land at 9,500–10,500. Snapshot records actual count; downstream CI gate is parameterised by the recorded count, not the round "10k" label. Per-template/per-stub permutation counts (220 for Strategy A, ~80 for Strategy B) are *targets*; the diversity gate is the hard constraint, count is opportunistic within the band.

**Verify:**
- DB has 9,500–10,500 entries; demo-arc + v2-golden's `expected_top3` tools all resolve.
- `signCorpus` produces a stable hex hash across two re-runs.
- Strategy used (A / B / C-escalate) recorded in snapshot metadata.
- If A or B: 200-pair cosine check on the **full corpus** (not just pilot) passes 80%/0.97.

**Commit:** `test(perf): generate ~10k synthetic corpus with diversity gate (strategy=A|B)`

---

## Step 2: Author the 50-query stress set

**Files:**
- `tests/fixtures/v2-stress.json` (new — 50 queries; relevance maps `{}` since this is a stress set, not graded)

| Stratum | Count | Purpose |
|---|---|---|
| High-collision (lexical tokens shared with 50+ synthetic candidates) | 15 | Stresses BM25 tie-breaking at scale |
| Long-tail single answer (one correct tool buried in 10k) | 10 | Stresses vec0 brute-force recall |
| Short query (≤4 tokens) | 10 | Thin-signal FTS5 stress |
| Long query (≥25 tokens) | 10 | Query embedding + RRF fusion stress |
| Adversarial (no good answer) | 5 | Should produce low-confidence rankings |

The stress set contributes only to **latency measurements**, NOT to NDCG@3 (no graded relevance). It exercises retrieval paths the 100 v2-golden queries don't cover (long queries, high-collision, etc.).

**Verify:** 50 entries, stratum counts within ±1, every `expected_top3` entry resolves in the 10k corpus.

**Commit:** `test(perf): 50-query stress set for 10k scale latency profile`

---

## Step 3: Measure 10k + 1k baselines (NDCG, Recall, latency)

**Files:**
- `scripts/smoke/v2-golden-v2native.ts` (update — additive: add `--corpus-path <db>` flag (falls back to `TWOCHAIN_DB_PATH` env var when absent, so existing `eval:golden` npm script keeps working unchanged); add `--include-stress` flag (default off — A1's eval:golden never runs stress); add latency percentile capture (off when `--include-stress` is absent so the existing CI run isn't slowed)). Backward compatibility is a hard requirement: `npm run eval:golden` against the 434-corpus must produce byte-identical numbers before/after this update.
- `tests/fixtures/v2-baseline-10k.json` (new — same schema as `v2-baseline-native.json` + p50/p95/p99 fields)
- `tests/fixtures/v2-baseline-1k.json` (new — same shape, 1k corpus subset)
- `src/eval/latency-percentiles.ts` (new tiny lib — p50/p95/p99 over a sorted array; unit-tested)

**1k corpus subset:**

Deterministically take the **first 1k tools by name+version sort** from the 10k corpus (round-2 critic: pick one rule, document the seed). Re-snapshot to `v2-corpus-1k-snapshot.json` with its own content-addressed sha256.

**Baseline runs:**

For each of 1k and 10k:
1. Run the 100 v2-golden queries N=5 times. Compute NDCG@3 mean+stddev, Recall@3 mean+stddev, MRR mean+stddev, single-tool top-1 hit rate (filter on `stratum === "single-tool"` — round-2 critic catch — actual stratum string in the fixture).
2. Run the 50 v2-stress queries N=5 times for latency only. Compute p50/p95/p99 mean+stddev across all 150 queries combined (and separately for golden vs stress).

Persist the baseline JSON with all of these + the corpus_sha256 + the seed used for the 1k subset.

**Note on latency labels:** These are **observed values, NOT contractual SLOs.** PRD doesn't pin a discover-latency target. Future PRs/SLAs may use these as a reference point; nothing here commits the product to them.

**Verify:**
- Both baselines are N=5 with stddev ≤ 0.02 on NDCG@3 (else retrieval is non-deterministic at scale — root-cause before pinning).
- 10k baseline's NDCG@3 mean ≥ 0.60 (one-sided floor — tighter than A1's value × 0.7 to actually catch scale-breaks; large drops are bugs not tolerances) (some dilution expected; large drop means scale broke the retrieval).
- 10k baseline's single-tool top-1 hit rate is recorded (acceptable range documented in the write-up).
- p99 latency at 10k is documented; no hard threshold (round-2 critic: PRD doesn't pin one).

**Commit:** `test(perf): 10k + 1k baselines with NDCG + latency profile`

---

## Step 4: 1k CI smoke gate + write-up

**Files:**
- `.github/workflows/v2-perf-bench.yml` (new — triggers on PRs touching `src/storage/**`, `src/services/discover.ts`, `src/services/call.ts`, RRF defaults in `src/types.ts`, or the baseline JSONs)
- `docs/perf/10k-benchmark.md` (new — one-page write-up)

**CI gate (1k corpus, measured floors):**

GitHub Actions runner builds 1k corpus from deterministic seed, runs `v2-golden-v2native.ts` against it, fails on:
- `NDCG@3 < v2-baseline-1k.json#ndcg3.mean - 2 * stddev` (correctness gate)
- `Recall@3 < v2-baseline-1k.json#recall3.mean * 0.9` (correctness gate)

**Latency is NOT in the CI gate** (round-2 critic correctly flagged that GH shared runner I/O variance routinely exceeds 1.5× and would cause false-positive failures). Latency is measured locally and recorded in the baseline JSON for reference.

**Write-up `docs/perf/10k-benchmark.md` (one page):**

| | 434 (A1) | 1k (A2 CI ref) | 10k (A2 prod ref) |
|---|---|---|---|
| NDCG@3 mean | 0.7296 | ??? | ??? |
| Recall@3 mean | 0.4250 | ??? | ??? |
| MRR mean | 0.7645 | ??? | ??? |
| single-tool top-1 | 10/14 | ??? | ??? |
| p50 latency | (unmeasured) | ??? | ??? |
| p95 latency | (unmeasured) | ??? | ??? |
| p99 latency | (unmeasured) | ??? | ??? |

Plus a paragraph on:
- Strategy used for corpus expansion (A or B).
- Whether NDCG@3 held within tolerance at scale (or where it broke).
- Latency observations and what they suggest for Phase 2 pgvector targets.

**Verify:**
- CI workflow runs to green on a clean PR.
- Intentionally regressed PR (swap RRF to `{0.99, 0.01}`) trips the gate (manual check, not merged).
- Doc < 1 page rendered.

**Commit:** `ci(perf): 1k-corpus regression gate + 10k benchmark write-up`

---

## Critic gates for `/dev-framework-rl`

The orchestrator treats this episode as **done** only when ALL of:

1. `v2-corpus-10k-snapshot.json` has 9,700-10,300 entries with stable content-addressed sha256; strategy (A or B) recorded; full-corpus 80%/0.97 cosine gate passed; demo-arc + v2-golden tools all resolve.
2. `v2-stress.json` has 50 entries, stratum counts within ±1, all references resolve.
3. `v2-baseline-10k.json` AND `v2-baseline-1k.json` exist with N=5 each; stddev ≤ 0.02 on NDCG@3.
4. `v2-baseline-10k.json#ndcg3.mean` within 30% of A1's 0.7296 (else investigate retrieval breakage at scale).
5. `docs/perf/10k-benchmark.md` < 1 page; comparison table populated.
6. CI workflow runs green on a clean PR; intentionally regressed PR trips the gate.
7. `npm run eval:golden` (434 corpus, unchanged defaults) still passes — no A1 regression.
8. `npm run typecheck` clean; `npx tsx --test tests/v2-eval-ndcg.test.ts` 10/10 pass; new `tests/v2-latency-percentiles.test.ts` passes.

---

## Risks the framework should not patch over

- **Synthetic-corpus diversity failure.** Step 1's 80% < 0.97 cosine gate runs on the **full 10k corpus**, not just the 1k pilot — round-2 critic caught the non-linear scaling risk. If both A and B fail, escalate (Strategy C).
- **NDCG@3 < 0.60 at 10k** (one-sided floor, ~18% drop from A1). This is "retrieval scaled wrong" territory, not a tolerance to relax. Root-cause (FTS5 BM25 ranking dilution, RRF saturation, etc.) before pinning a degraded baseline as the new gate. The "30% within A1" floor is intentionally loose; a 50% drop would be a bug.
- **GH runner latency variance.** Step 4 explicitly drops latency from the CI gate. Don't reintroduce it without first measuring runner-class noise envelope. Self-hosted or larger runners are out of scope this episode.
- **No RRF sweep here.** Phase 2 (D) inherits the option to sweep when pgvector adds real HNSW knobs. If A2's 10k baseline shows `{0.5, 0.5}` is wrong, document it in the write-up and let D pick it up.
- **Outside-voice review on this plan before coding.** Already 2 rounds (rev 1: 3 crit, rev 2: 2 crit). Re-run on rev 3 — if it passes, execute; if it fails a third time, the right move is "park A2, the cost-calculus says move to D".

---

## Revision history

**rev 3 → rev 4 (2026-05-23, plan-eng-critic round 3: PASS score 78, 5 advisory items applied inline):**
- Template count corrected to 47 (was 46).
- MCP count corrected to 20 servers / 77 tool stubs (was 21); Strategy B switched to 77-tool-stub base for richer descriptions and dropped per-base perm count to ~80.
- 30% tolerance disambiguated: one-sided floor at NDCG@3 ≥ 0.60 (tighter than A1 × 0.7; intended to catch scale-breaks, not legitimize them).
- Count tolerance widened to 9,500-10,500 (round-3 critic: corrected base counts pushed both strategies over the previous 10,300 ceiling).
- Backward-compat statement added to Step 3: `--corpus-path` and `--include-stress` are additive; `npm run eval:golden` keeps producing byte-identical 434-corpus numbers.

**rev 2 → rev 3 (2026-05-23, plan-eng-critic round 2: FAIL score 52, 2 crit + 5 high):**

The RRF sweep was the source of every round-2 failure. Dropped entirely. Net change:
- Step 3 (RRF sweep): removed.
- Step 4 (Pin winner + Step 4a pre-pin check): removed (no winner to pin).
- Episode collapses from 6 steps to 4: corpus, stress set, baselines (1k + 10k), CI gate + write-up.
- Round-2 crit on `src/types.ts` vs `src/services/discover.ts` location is now moot — no source edit happens.
- Round-2 crit on env-var override mechanism is moot — no runtime override needed.
- Strategy B count corrected (21 MCP servers, not 70; combined with 46 fixture templates = 67 base lines, ~150 perms each → ~10k).
- Strategy A pilot now re-checks diversity on the full 10k (not just 1k pilot).
- 10k tolerance widened to 9700-10300 (round-2 critic: stochastic generators).
- 1k subset rule pinned: first-N by name+version sort, deterministic.
- CI gate dropped p95 latency (GH runner variance).
- Latency labelled observed values, not SLOs.

**rev 1 → rev 2 (2026-05-23, plan-eng-critic round 1: FAIL score 28, 3 crit + 7 high):**

Three crit issues forced a rescope (not a patch):
1. **vec0 has no HNSW** — sqlite-vec 0.1.9 is brute-force flat. HNSW sweep dropped entirely.
2. **FTS5 `bm25()` constants hardcoded** — k1/b not runtime-tunable. BM25 sweep dropped.
3. **`00X_tune_hnsw.sql` migration fictional** — nothing to rebuild.

Other round-1 fixes applied to rev 2:
- Sequencing reversed (Step 4a before 4b).
- Rule 14 conflict resolved (no silent baseline regen).
- 1k baseline measured, not extrapolated.
- Single-tool stratum reference fixed (hyphen, not underscore).
- Latency re-framed as observed values.
- Scripts use SqliteStorage.
- `sqlite-tuning.ts` dropped as fictional dual-backend abstraction.

Both round-2 crits were then introduced BY the rev-2 rewrite — proof that even careful rewrites need outside-voice review.
