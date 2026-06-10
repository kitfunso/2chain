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
  /** The actual ordering key post-E5: rrf_score + W_FRESHNESS_RRF * freshness. */
  final_score: number;
  /** 0.5^(age_days(last_eval_run)/7); 0 when last_eval_run missing/unparseable. */
  freshness: number;
  /** metadata.last_eval_run verbatim, null when the tool was never evaluated. */
  last_verified_at: string | null;
  /** Consecutive most-recent clean reverify-triggered runs (window 20). */
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

  // ----- Freshness re-sort (E5) -------------------------------------------
  // freshness = 0.5^(age_days(last_eval_run)/7), final_score = rrf_score +
  // W_FRESHNESS_RRF * freshness (calibration table beside the constants in
  // types.ts). Reliability gating stayed in SQL (rule 7) — freshness
  // weights, never gates: every runRRF candidate is still returned, only
  // the order can change, and only across NEAR-TIED rrf scores.
  const now = Date.now();
  const scored = rrf.map((r) => {
    const lastEvalRun = r.metadata.last_eval_run ?? null;
    let freshness = 0;
    if (lastEvalRun !== null) {
      const ageDays = (now - Date.parse(lastEvalRun)) / 86_400_000;
      const decayed = Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
      // Unparseable ⇒ NaN (collapses to 0); absurd-past ⇒ ~0. FUTURE dates
      // yield FINITE values > 1 all the way to ~19 years ahead (+30d ≈
      // 19.5 ⇒ a term larger than one full RRF arm — leapfrog invariant
      // broken), so the clamp to 1 is load-bearing, not cosmetic: fresher
      // than "verified right now" does not exist.
      if (Number.isFinite(decayed)) freshness = Math.min(decayed, 1);
    }
    return { r, freshness, final_score: r.rrf_score + W_FRESHNESS_RRF * freshness };
  });
  // PLAIN STABLE sort, NO secondary key: JS sort stability preserves
  // runRRF's tie order, so uniform-freshness corpora are order-invariant BY
  // CONSTRUCTION (an additive constant shifts every score equally). The
  // name+version tie-break in src/eval/ndcg.ts is eval-side normalization,
  // not production behavior — untouched.
  scored.sort((a, b) => b.final_score - a.final_score);

  const results: DiscoverResult[] = [];
  for (const { r, freshness, final_score } of scored) {
    // Streak for the returned top-K only — the route and MCP shim cap
    // top at 20, so this is at most 20 indexed queries per request.
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
      // Composite ranking score that blends vec similarity with reliability,
      // matching the v1 surface. Useful for downstream consumers that aren't
      // RRF-aware. Informational only — final_score is the ordering key.
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
      // The snapshot must be able to explain its own ordering: rows are in
      // final_score order, and rrf_score alone is non-monotonic with it.
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
