import type { Db, Document } from 'mongodb';
import { embedOne } from '../embeddings/voyage.js';
import {
  RELIABILITY_GATE,
  RANKING_W_VEC,
  RANKING_W_RELIABILITY,
  VECTOR_INDEX_NAME,
} from '../types.js';

const VEC_RELEVANCE_GATE = 0.70;

export interface DiscoverResult {
  name: string;
  version: string;
  capability_text: string;
  endpoint_stub_name: string;
  reliability_score: number;
  vec_score: number;
  rank_score: number;
  cost_per_call_usd: number;
  p95_latency_ms: number;
}

export interface DiscoverMeta {
  query: string;
  embed_ms: number;
  search_ms: number;
  total_ms: number;
  candidates_after_filter: number;
}

const queryEmbeddingCache = new Map<string, number[]>();

export const DEMO_AGENT_QUERY = 'Extract tables from this financial report PDF';

export async function getQueryEmbedding(query: string): Promise<{ vec: number[]; cached: boolean; ms: number }> {
  const cached = queryEmbeddingCache.get(query);
  if (cached) return { vec: cached, cached: true, ms: 0 };
  const t0 = Date.now();
  const vec = await embedOne(query, 'query');
  queryEmbeddingCache.set(query, vec);
  return { vec, cached: false, ms: Date.now() - t0 };
}

// Demo queries to pre-cache at server boot. Voyage free tier is 3 RPM —
// without these, a live demo can rate-limit. Pre-warming costs 1 minute of
// boot time (with 20s sleep between calls to respect 3 RPM) but eliminates
// any Voyage call during the demo itself.
export const PREWARM_QUERIES: string[] = [
  DEMO_AGENT_QUERY,
  // Prompt 1 variations Claude is likely to issue
  'extract income statement from 10-K for DCF model',
  'extract financial statement line items SEC filing',
  // Prompt 2 — code review
  'review javascript code for bugs',
  'lint javascript for style issues',
  // Prompt 3 — security
  'audit python code for security vulnerabilities OWASP',
  'find security issues in python source code',
  // Prompt 4 — summarisation
  'summarise arxiv paper abstract',
  'summarise article into one paragraph',
  // Prompt 5 — invoice
  'parse UK supplier invoice for accounts payable',
  'extract VAT line items from invoice',
];

export async function prewarmDemoEmbedding(): Promise<void> {
  // Sequential with a short sleep — 3 RPM means 20s gap minimum.
  // For boot speed, we batch them through Voyage's array input (one HTTP call,
  // returns N embeddings, counts as a single rate-limit hit).
  const cached = PREWARM_QUERIES.filter((q) => queryEmbeddingCache.has(q));
  const todo = PREWARM_QUERIES.filter((q) => !queryEmbeddingCache.has(q));
  if (todo.length === 0) return;

  // One batched embed call — Voyage charges this as a single request.
  try {
    const { embedMany } = await import('../embeddings/voyage.js');
    const vecs = await embedMany(todo, 'query');
    for (let i = 0; i < todo.length; i++) {
      queryEmbeddingCache.set(todo[i], vecs[i]);
    }
  } catch (e) {
    // Fall back to sequential cache of just the canonical demo query.
    await getQueryEmbedding(DEMO_AGENT_QUERY).catch(() => {});
  }
}

export async function discover(
  db: Db,
  query: string,
  top: number = 5
): Promise<{ results: DiscoverResult[]; meta: DiscoverMeta }> {
  const tTotal = Date.now();
  const { vec: queryVec, ms: embedMs } = await getQueryEmbedding(query);

  const tSearch = Date.now();
  const docs = await db.collection('tools').aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'capability_embedding',
        queryVector: queryVec,
        numCandidates: 50,
        limit: top * 6,
        filter: {
          status: { $eq: 'active' },
          'metadata.reliability_score': { $gte: RELIABILITY_GATE },
        },
      },
    },
    {
      $project: {
        name: 1,
        version: 1,
        capability_text: 1,
        endpoint_stub_name: 1,
        metadata: 1,
        vec_score: { $meta: 'vectorSearchScore' },
      },
    },
    { $match: { vec_score: { $gte: VEC_RELEVANCE_GATE } } },
    {
      $addFields: {
        rank_score: {
          $add: [
            { $multiply: ['$vec_score', RANKING_W_VEC] },
            { $multiply: ['$metadata.reliability_score', RANKING_W_RELIABILITY] },
          ],
        },
      },
    },
    { $sort: { rank_score: -1 } },
    { $group: { _id: '$name', best: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$best' } },
    { $sort: { rank_score: -1 } },
    { $limit: top },
  ]).toArray();
  const searchMs = Date.now() - tSearch;

  const results: DiscoverResult[] = docs.map((d: Document) => ({
    name: d.name,
    version: d.version,
    capability_text: d.capability_text,
    endpoint_stub_name: d.endpoint_stub_name,
    reliability_score: d.metadata.reliability_score,
    vec_score: d.vec_score,
    rank_score: d.rank_score,
    cost_per_call_usd: d.metadata.cost_per_call_usd,
    p95_latency_ms: d.metadata.p95_latency_ms,
  }));

  return {
    results,
    meta: {
      query,
      embed_ms: embedMs,
      search_ms: searchMs,
      total_ms: Date.now() - tTotal,
      candidates_after_filter: results.length,
    },
  };
}
