import type { Db, Document } from 'mongodb';
import { getQueryEmbedding } from './discover.js';
import {
  RELIABILITY_GATE,
  VECTOR_INDEX_NAME,
} from '../types.js';
import type { DiscoverResult, DiscoverMeta } from './discover.js';

const TEXT_INDEX_NAME = 'tools_text_idx';

export interface HybridResult extends DiscoverResult {
  rrf_score: number;
}

export interface HybridMeta extends DiscoverMeta {
  mode: 'hybrid_rankfusion';
  weights: { vector: number; text: number };
  pipelines_in: number;
  pipelines_out: number;
}

const VEC_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

export async function discoverHybrid(
  db: Db,
  query: string,
  top: number = 5
): Promise<{ results: HybridResult[]; meta: HybridMeta }> {
  const tTotal = Date.now();
  const { vec: queryVec, ms: embedMs } = await getQueryEmbedding(query);

  const tSearch = Date.now();
  const docs = await db.collection('tools').aggregate([
    {
      $rankFusion: {
        input: {
          pipelines: {
            // Vector arm: semantic similarity with hard filters
            vector: [
              {
                $vectorSearch: {
                  index: VECTOR_INDEX_NAME,
                  path: 'capability_embedding',
                  queryVector: queryVec,
                  numCandidates: 50,
                  limit: 20,
                  filter: {
                    status: { $eq: 'active' },
                    'metadata.reliability_score': { $gte: RELIABILITY_GATE },
                  },
                },
              },
            ],
            // Lexical arm: keyword text search via Atlas Search
            text: [
              {
                $search: {
                  index: TEXT_INDEX_NAME,
                  text: { query, path: 'capability_text' },
                },
              },
              // Apply reliability + status gate post-search since $search doesn't take filter
              {
                $match: {
                  status: 'active',
                  'metadata.reliability_score': { $gte: RELIABILITY_GATE },
                },
              },
              { $limit: 20 },
            ],
          },
        },
        combination: { weights: { vector: VEC_WEIGHT, text: TEXT_WEIGHT } },
        scoreDetails: true,
      },
    },
    {
      $project: {
        name: 1,
        version: 1,
        capability_text: 1,
        endpoint_stub_name: 1,
        metadata: 1,
        rrf_score: { $meta: 'score' },
      },
    },
    // Dedupe by tool name — keep highest RRF score per name
    { $sort: { rrf_score: -1 } },
    { $group: { _id: '$name', best: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$best' } },
    { $sort: { rrf_score: -1 } },
    { $limit: top },
  ]).toArray();
  const searchMs = Date.now() - tSearch;

  const results: HybridResult[] = docs.map((d: Document) => ({
    name: d.name,
    version: d.version,
    capability_text: d.capability_text,
    endpoint_stub_name: d.endpoint_stub_name,
    reliability_score: d.metadata.reliability_score,
    vec_score: 0,        // not directly available from rankFusion output
    rank_score: d.rrf_score,
    rrf_score: d.rrf_score,
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
      mode: 'hybrid_rankfusion',
      weights: { vector: VEC_WEIGHT, text: TEXT_WEIGHT },
      pipelines_in: 2,
      pipelines_out: results.length,
    },
  };
}
