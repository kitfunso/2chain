# Proposed CLAUDE.md Rule 14 rewrite (Episode A1 Step 7b)

This is a targeted edit to `CLAUDE.md` Non-Negotiable Rule 14 to reference the v2-native baseline shipped by Episode A1. Per the global `Hand-Maintained Files` rule, surfacing the diff for explicit approval before applying.

## Current Rule 14

```
14. **Embedder swaps require a quantitative parity bar.** Any change to the
    embedding model (Voyage → nomic-embed-text, nomic → bge-large, etc.) must
    show MRR / Recall@5 parity vs `tests/fixtures/v1-baseline.json` golden
    ranking set, with top-1 RRF margin no more than 10% smaller than baseline.
    Why: a model swap that silently degrades retrieval is the easiest way to
    break agent trust, and the only way to catch it is to measure.
```

## Proposed replacement

```
14. **Embedder swaps require a quantitative parity bar.** Any change to the
    embedding model (nomic-embed-text → mxbai-embed-large, → bge-large, etc.)
    must clear all three floors against the v2-native baseline
    (`tests/fixtures/v2-baseline-native.json`):

    - **NDCG@3** ≥ baseline `mean - 2 * stddev`
    - **Recall@3** drop ≤ 10% vs baseline mean
    - **Single-tool-unambiguous top-1 hit rate** ≥ baseline `mean - 2 * stddev`
      (catches "the corpus's canonical answer to a clear query stopped winning"
      regressions)

    NDCG@3 formula is pinned in `src/eval/ndcg.ts` and locked by
    `tests/v2-eval-ndcg.test.ts`: `gain(rel) = 2^rel - 1`,
    `discount(r) = log2(r + 1)` with r starting at 1, stable name+version
    tie-break on equal RRF score. Runner: `scripts/smoke/v2-golden-v2native.ts`.
    Demo-arc 10/10 gate from rev 1-3 is dropped (user directive 2026-05-23).
    The v1-Voyage baseline (`tests/fixtures/legacy/v1-baseline.json`) is
    retained for diagnostic comparison but is no longer the gate. Why: a
    model swap that silently degrades retrieval is the easiest way to break
    agent trust, and the only way to catch it is to measure.
```

## Diff summary

- Voyage → nomic transition example replaced with current-era models
- `v1-baseline.json` → `v2-baseline-native.json`
- Binary "MRR / Recall@5 parity with 10% margin" → graded NDCG@3 + Recall@3 + single-tool top-1 against `mean - 2 * stddev`
- Pin the formula by file path (so a future contributor knows where it lives)
- Explicitly note the demo-arc gate drop (per Keith's directive 2026-05-23)
- v1 baseline moves to `legacy/` (diagnostic, not gate)

## Apply protocol

When approved:
1. Save `.old` backup: `cp CLAUDE.md CLAUDE.md.old.20260523`
2. Targeted `Edit` against the current Rule 14 paragraph
3. Verify `git diff CLAUDE.md` shows only the Rule 14 paragraph changed
4. Commit alongside the file moves in Step 7a (caller migration) as a single PR

Pending Keith's explicit "apply" before any edit lands.
