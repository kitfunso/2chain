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
  FRESHNESS_HALF_LIFE_DAYS,
  W_FRESHNESS_RRF,
  DEFAULT_NAMESPACE,
} from '../types.js';
import { STREAK_WINDOW, verificationStreak } from './streak.js';

export interface DiscoverResult {
  name: string;
  version: string;
  capability_text: string;
  endpoint_stub_name: string;
  reliability_score: number;
  vec_score: number;
  rank_score: number;
  rrf_score: number;
  final_score: number;
  freshness: number;
  last_verified_at: string | null;
  verification_streak: number;
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

export const PREWARM_QUERIES: string[] = [
  DEMO_AGENT_QUERY,
  'extract income statement from 10-K for DCF model',
  'fetch latest 10-K income statement for NVDA',
  'parse UK supplier invoice for accounts payable',
  'review javascript code for bugs',
  'audit python code for security vulnerabilities OWASP',
  'search npm registry for a package',
  'find a typescript library on github',
  'search arxiv for papers on state space models',
  'summarise an academic paper abstract',
  'find research papers on transformer architectures',
  'find an MCP server for postgres',
  'long-term memory for an AI agent',
  'claude code skill for refactoring',
  'agent framework with tool calling',
  'sync data from postgres to bigquery',
  'web scraper for product pricing',
  'send a slack message to a channel',
  'translate english to japanese',
  'schedule a meeting in google calendar',
  'extract tables from a pdf',
  'convert a docx to markdown',
  'geocode an address to lat-lon',
  'fetch current weather for london',
  'transcribe an audio file with whisper',
  'generate an image from a prompt',
  'compose a poem about the ocean',
  'deploy a docker container to fly.io',
  'monitor a kubernetes cluster',
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

  const now = Date.now();
  const scored = rrf.map((r) => {
    const lastEvalRun = r.metadata.last_eval_run ?? null;
    let freshness = 0;
    if (lastEvalRun !== null) {
      const ageDays = (now - Date.parse(lastEvalRun)) / 86_400_000;
      const decayed = Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
      if (Number.isFinite(decayed)) freshness = Math.min(decayed, 1);
    }
    return { r, freshness, final_score: r.rrf_score + W_FRESHNESS_RRF * freshness };
  });
  scored.sort((a, b) => b.final_score - a.final_score);

  const results: DiscoverResult[] = [];
  for (const { r, freshness, final_score } of scored) {
    const reverifyRuns = await storage.listEvalRunsForTool(
      r.id,
      STREAK_WINDOW,
      'reverify',
    );
    results.push({
      name: r.name,
      version: r.version,
      capability_text: r.capability_text,
      endpoint_stub_name: r.endpoint_stub_name,
      reliability_score: r.metadata.reliability_score,
      vec_score: r.vec_score,
      rank_score:
        r.vec_score * RANKING_W_VEC +
        r.metadata.reliability_score * RANKING_W_RELIABILITY,
      rrf_score: r.rrf_score,
      final_score,
      freshness,
      last_verified_at: r.metadata.last_eval_run ?? null,
      verification_streak: verificationStreak(reverifyRuns, RELIABILITY_GATE),
      cost_per_call_usd: r.metadata.cost_per_call_usd,
      p95_latency_ms: r.metadata.p95_latency_ms,
      tool_kind: r.tool_kind,
    });
  }

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
      final_score: r.final_score,
      freshness: r.freshness,
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
