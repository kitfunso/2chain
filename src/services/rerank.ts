// Re-ranker layer. Sits AFTER $rankFusion + reliability gate, BEFORE final top-K.
//
// Two strategies:
//   - 'cohere'    — calls Cohere rerank-english-v3.0 cross-encoder API
//                   (requires COHERE_API_KEY env var; ~50ms latency for ≤50 docs;
//                   1000 free calls/month on Cohere's free tier)
//   - 'heuristic' — pure JS sub-millisecond scoring: query/capability term overlap,
//                   reliability boost, light cost penalty. No external dependency.
//
// Selection: if COHERE_API_KEY is set, default to cohere. Otherwise heuristic.

export interface RerankCandidate {
  name: string;
  version: string;
  capability_text: string;
  reliability_score: number;
  cost_per_call_usd: number;
  rank_score: number;
}

export interface RerankResult<T extends RerankCandidate> {
  results: T[];
  strategy: 'cohere' | 'heuristic' | 'none';
  rerank_ms: number;
  candidates_considered: number;
}

const COHERE_KEY = process.env.COHERE_API_KEY;
const RERANK_STRATEGY: 'cohere' | 'heuristic' = COHERE_KEY ? 'cohere' : 'heuristic';

export function rerankStrategy(): 'cohere' | 'heuristic' {
  return RERANK_STRATEGY;
}

export async function rerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topK: number
): Promise<RerankResult<T>> {
  const t0 = Date.now();
  if (candidates.length === 0) {
    return { results: [], strategy: RERANK_STRATEGY, rerank_ms: 0, candidates_considered: 0 };
  }
  if (RERANK_STRATEGY === 'cohere') {
    try {
      const reranked = await rerankCohere(query, candidates, topK);
      return { results: reranked, strategy: 'cohere', rerank_ms: Date.now() - t0, candidates_considered: candidates.length };
    } catch (err) {
      // Soft fall-through — never break /discover if Cohere is down.
      console.warn(`cohere rerank failed (${(err as Error).message}); falling back to heuristic`);
    }
  }
  const reranked = rerankHeuristic(query, candidates, topK);
  return { results: reranked, strategy: 'heuristic', rerank_ms: Date.now() - t0, candidates_considered: candidates.length };
}

// ── heuristic: query-term overlap + reliability + cost ──────────────────
function rerankHeuristic<T extends RerankCandidate>(query: string, candidates: T[], topK: number): T[] {
  const qTokens = new Set(tokenise(query));
  const scored = candidates.map((c) => {
    const cTokens = new Set(tokenise(c.capability_text));
    let overlap = 0;
    for (const t of qTokens) if (cTokens.has(t)) overlap++;
    const overlapNorm = qTokens.size > 0 ? overlap / qTokens.size : 0;  // 0..1
    const costPenalty = Math.min(c.cost_per_call_usd / 0.02, 1);          // 0..1
    // Composite: rrf already covers semantic, term-overlap covers lexical
    // precision, reliability boost rewards proven tools, cost penalty mild.
    const rerank_score =
      0.45 * c.rank_score * 100 +     // existing rank score (was 0..0.02 via RRF)
      0.30 * overlapNorm +
      0.20 * c.reliability_score +
      0.05 * (1 - costPenalty);
    return { ...c, rerank_score };
  });
  scored.sort((a, b) => b.rerank_score - a.rerank_score);
  return scored.slice(0, topK);
}

function tokenise(s: string): string[] {
  return s.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) ?? [];
}

// ── cohere: cross-encoder via REST API ──────────────────────────────────
async function rerankCohere<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topK: number
): Promise<T[]> {
  const docs = candidates.map((c) => `${c.name}: ${c.capability_text}`);
  const res = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${COHERE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'rerank-english-v3.0',
      query,
      documents: docs,
      top_n: Math.min(topK, candidates.length),
    }),
  });
  if (!res.ok) throw new Error(`cohere ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
  return json.results.map((r) => ({
    ...candidates[r.index],
    rerank_score: r.relevance_score,
  }));
}
