// NDCG@k for the v2-native golden ranking set.
//
// Canonical formula (pinned, see plan rev 4 Step 6 and CLAUDE.md Rule 14):
//
//   gain(rel)    = 2^rel - 1            // exponential gain
//   discount(r)  = log2(r + 1)          // r starts at 1, so rank 1 = log2(2) = 1.0
//   DCG@k        = Σ_{i=1..k} gain(rel_i) / discount(i)
//   IDCG@k       = Σ_{i=1..k} gain(sorted_rel_i) / discount(i)  // ideal order
//   NDCG@k       = DCG@k / IDCG@k    (0 if IDCG == 0)
//
// Tie-break for equal rankings: stable name+version ascending. Documented
// here and pinned by tests/v2-eval-ndcg.test.ts.

export type Relevance = 0 | 1 | 2 | 3;

export interface RankedResult {
  name: string;
  version: string;
  /** Sort key used for tie-breaking (typically RRF score, descending). */
  score: number;
}

/** Gain: 2^rel - 1. */
export function gain(rel: number): number {
  return Math.pow(2, rel) - 1;
}

/** Discount: log2(rank + 1). rank starts at 1. */
export function discount(rank: number): number {
  return Math.log2(rank + 1);
}

/**
 * Apply the canonical tie-break: sort by score desc, then by name+version asc.
 * Returns a new array; does not mutate input.
 */
export function applyTieBreak(results: RankedResult[]): RankedResult[] {
  return [...results].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aKey = a.name + '@' + a.version;
    const bKey = b.name + '@' + b.version;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

/**
 * NDCG@k. `ranked` is the system's ordered list (top-1 first). `relevance`
 * maps `${name}@${version}` to a graded score (0-3). Returns 0 when there is
 * no positive-relevance gold (IDCG would be 0).
 */
export function ndcgAtK(
  ranked: RankedResult[],
  relevance: Record<string, number>,
  k: number,
): number {
  // 1. DCG@k from the system's ordering (after canonical tie-break).
  const ordered = applyTieBreak(ranked).slice(0, k);
  let dcg = 0;
  for (let i = 0; i < ordered.length; i++) {
    const key = ordered[i].name + '@' + ordered[i].version;
    const rel = relevance[key] ?? 0;
    dcg += gain(rel) / discount(i + 1);
  }

  // 2. IDCG@k from the best possible ordering of the relevance map.
  const gold = Object.entries(relevance)
    .map(([_, rel]) => rel)
    .filter((r) => r > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < gold.length; i++) {
    idcg += gain(gold[i]) / discount(i + 1);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

/** Reciprocal rank of the first ideal (relevance=3) hit in the ranked list. */
export function mrrIdeal(ranked: RankedResult[], relevance: Record<string, number>): number {
  const ordered = applyTieBreak(ranked);
  for (let i = 0; i < ordered.length; i++) {
    const key = ordered[i].name + '@' + ordered[i].version;
    if ((relevance[key] ?? 0) === 3) return 1 / (i + 1);
  }
  return 0;
}

/** Fraction of `expected` that appear in the system's top-k. */
export function recallAtK(ranked: RankedResult[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const top = new Set(applyTieBreak(ranked).slice(0, k).map((r) => r.name));
  let hits = 0;
  for (const e of expected) if (top.has(e)) hits++;
  return hits / expected.length;
}
