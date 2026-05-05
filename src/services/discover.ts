// v2 discover — Storage + Embedder via DI. No MongoDB. No Voyage.
//
// Replaces the v1 $vectorSearch / $rankFusion aggregation with storage.runRRF()
// over sqlite-vec (cosine, L2-normalized 768-dim) + FTS5 (BM25).

import type {
  Storage,
  Embedder,
  RrfResult,
  ToolKind,
} from '../types.js';
import {
  RELIABILITY_GATE,
  RANKING_W_VEC,
  RANKING_W_RELIABILITY,
  RRF_DEFAULT_VECTOR_WEIGHT,
  RRF_DEFAULT_TEXT_WEIGHT,
  DEFAULT_NAMESPACE,
} from '../types.js';

export interface DiscoverResult {
  name: string;
  version: string;
  capability_text: string;
  endpoint_stub_name: string;
  reliability_score: number;
  vec_score: number;
  rank_score: number;
  rrf_score: number;
  cost_per_call_usd: number;
  p95_latency_ms: number;
  tool_kind: ToolKind;
}

export interface DiscoverMeta {
  query: string;
  embed_ms: number;
  search_ms: number;
  total_ms: number;
  candidates_after_filter: number;
  embedder: string;
  storage: 'sqlite' | 'postgres';
}

export const DEMO_AGENT_QUERY = 'Extract tables from this financial report PDF';

// Demo queries to pre-warm into the embedder cache at boot. Same set as v1
// (kept to maintain golden-query coverage), minus the rate-limit dance —
// Ollama is local, so cost-of-prewarm is just CPU/VRAM seconds.
export const PREWARM_QUERIES: string[] = [
  // finance / accounting
  DEMO_AGENT_QUERY,
  'extract income statement from 10-K for DCF model',
  'fetch latest 10-K income statement for NVDA',
  'parse UK supplier invoice for accounts payable',
  // code / dev
  'review javascript code for bugs',
  'audit python code for security vulnerabilities OWASP',
  'search npm registry for a package',
  'find a typescript library on github',
  // research / academic
  'search arxiv for papers on state space models',
  'summarise an academic paper abstract',
  'find research papers on transformer architectures',
  // ai / agents / memory
  'find an MCP server for postgres',
  'long-term memory for an AI agent',
  'claude code skill for refactoring',
  'agent framework with tool calling',
  // data / etl
  'sync data from postgres to bigquery',
  'web scraper for product pricing',
  // comms / messaging
  'send a slack message to a channel',
  'translate english to japanese',
  'schedule a meeting in google calendar',
  // docs / writing
  'extract tables from a pdf',
  'convert a docx to markdown',
  // geo / weather
  'geocode an address to lat-lon',
  'fetch current weather for london',
  // media / creative
  'transcribe an audio file with whisper',
  'generate an image from a prompt',
  'compose a poem about the ocean',
  // devops / infra
  'deploy a docker container to fly.io',
  'monitor a kubernetes cluster',
  // security / compliance
  'scan a python repo for hardcoded secrets',
  'check a domain for known CVEs',
];

export async function prewarmDiscover(embedder: Embedder): Promise<void> {
  await embedder.prewarm(PREWARM_QUERIES);
}

export async function discover(
  storage: Storage,
  embedder: Embedder,
  query: string,
  top = 5,
  namespace: string = DEFAULT_NAMESPACE,
  kind?: ToolKind,
): Promise<{ results: DiscoverResult[]; meta: DiscoverMeta }> {
  const tTotal = Date.now();
  const { vec: queryVec, ms: embedMs } = await embedder.cachedEmbed(query);

  const tSearch = Date.now();
  const rrf: RrfResult[] = await storage.runRRF({
    queryEmbedding: queryVec,
    queryText: query,
    topK: top,
    gate: RELIABILITY_GATE,
    weights: { vector: RRF_DEFAULT_VECTOR_WEIGHT, text: RRF_DEFAULT_TEXT_WEIGHT },
    namespace,
    kind,
  });
  const searchMs = Date.now() - tSearch;

  const results: DiscoverResult[] = rrf.map((r) => ({
    name: r.name,
    version: r.version,
    capability_text: r.capability_text,
    endpoint_stub_name: r.endpoint_stub_name,
    reliability_score: r.metadata.reliability_score,
    vec_score: r.vec_score,
    // Composite ranking score that blends vec similarity with reliability,
    // matching the v1 surface. Useful for downstream consumers that aren't
    // RRF-aware.
    rank_score:
      r.vec_score * RANKING_W_VEC +
      r.metadata.reliability_score * RANKING_W_RELIABILITY,
    rrf_score: r.rrf_score,
    cost_per_call_usd: r.metadata.cost_per_call_usd,
    p95_latency_ms: r.metadata.p95_latency_ms,
    tool_kind: r.tool_kind,
  }));

  // Append-only ranking snapshot for the dashboard.
  await storage.insertRanking({
    query_capability_text: query,
    mode: 'hybrid',
    namespace_id: namespace,
    results: results.map((r) => ({
      name: r.name,
      version: r.version,
      rrf_score: r.rrf_score,
      vec_score: r.vec_score,
      reliability_score: r.reliability_score,
    })),
    occurred_at: new Date().toISOString(),
  });

  const stats = await storage.dbStats();
  return {
    results,
    meta: {
      query,
      embed_ms: embedMs,
      search_ms: searchMs,
      total_ms: Date.now() - tTotal,
      candidates_after_filter: results.length,
      embedder: embedder.name(),
      storage: stats.driver,
    },
  };
}
