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

// Pre-warm at server boot so Beat 1 cold call is sub-100ms.
export async function prewarmDemoEmbedding(): Promise<void> {
  await getQueryEmbedding(DEMO_AGENT_QUERY);
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
