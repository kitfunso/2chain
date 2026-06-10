// v1 types (MongoDB-flavored) preserved for backwards compat during transition.
// v2 types (storage-agnostic) added below the v1 section.

import type { ObjectId } from 'mongodb';

// ====================================================================
// v1 TYPES — used by remaining MongoDB code paths during the v2 cutover
// ====================================================================

export type ToolStatus = 'pending' | 'active' | 'circuit_broken';
export type RepairStrategy = 'llm' | 'fail-fast';

export interface ToolDoc {
  _id?: ObjectId;
  name: string;
  version: string;
  author_agent_id: string;
  capability_text: string;
  capability_embedding: number[];
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  output_repair_strategy: RepairStrategy;
  endpoint_stub_name: string;
  metadata: {
    cost_per_call_usd: number;
    p95_latency_ms: number;
    reliability_score: number;
    last_eval_run?: Date;
    last_eval_run_id?: ObjectId;
  };
  status: ToolStatus;
  created_at: Date;
  updated_at: Date;
}

export interface EvalCaseResult {
  case_id: string;
  pass: boolean;
  error?: string;
  latency_ms: number;
  cost_usd: number;
}

export interface EvalRun {
  _id?: ObjectId;
  tool_id: ObjectId;
  tool_name: string;
  tool_version: string;
  triggered_at: Date;
  triggered_by: 'push' | 'manual' | 'scheduled';
  cases: EvalCaseResult[];
  pass_count: number;
  total_count: number;
  pass_rate: number;
  duration_ms: number;
}

export interface Violation {
  _id?: ObjectId;
  tool_id: ObjectId;
  tool_name: string;
  tool_version: string;
  agent_id: string;
  call_id: string;
  attempt: number;
  stage: 'input' | 'output';
  raw_response?: unknown;
  schema_errors: Array<{ path: string; message: string }>;
  repaired: boolean;
  occurred_at: Date;
}

export interface Usage {
  _id?: ObjectId;
  tool_id: ObjectId;
  agent_id: string;
  call_id: string;
  query_capability_text?: string;
  outcome: 'ok' | 'circuit_broken' | 'violation' | 'timeout' | 'gated';
  latency_ms: number;
  occurred_at: Date;
}

export interface Agent {
  _id: string;
  name: string;
  api_key_hash: string;
  role: 'caller' | 'tool_author' | 'admin';
  created_at: Date;
}

// ====================================================================
// v2 TYPES — storage-agnostic
// ====================================================================

export const DEFAULT_NAMESPACE = 'default';

export type ToolKind = 'tool' | 'skill' | 'subagent' | 'prompt';

export interface ToolSpecV2 {
  name: string;
  version: string;
  author_agent_id: string;
  capability_text: string;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  output_repair_strategy: RepairStrategy;
  endpoint_stub_name: string;
  metadata: {
    cost_per_call_usd: number;
    p95_latency_ms: number;
    reliability_score: number;
    last_eval_run?: string; // ISO timestamp in v2 (no MongoDB Date)
    last_eval_run_id?: string;
  };
  status: ToolStatus;
  domain?: string;
  namespace_id?: string;
  source_registry_id?: string | null;
  tool_kind?: ToolKind; // defaults to 'tool' on insert
}

export interface ToolV2 extends ToolSpecV2 {
  id: string;                 // uuid
  namespace_id: string;       // always set after upsert
  source_registry_id: string | null;
  tool_kind: ToolKind;        // always set after upsert
  created_at: string;         // ISO
  updated_at: string;         // ISO
}

export interface EvalCaseResultV2 {
  case_id: string;
  pass: boolean;
  error?: string;
  latency_ms: number;
  cost_usd: number;
}

export interface EvalRunRow {
  id?: string;
  tool_id: string;
  tool_name: string;
  tool_version: string;
  namespace_id: string;
  triggered_at: string;
  triggered_by: 'push' | 'manual' | 'scheduled' | 'reverify';
  cases: EvalCaseResultV2[];
  pass_count: number;
  total_count: number;
  pass_rate: number;
  duration_ms: number;
}

export interface ViolationRow {
  id?: string;
  tool_id: string;
  tool_name: string;
  tool_version: string;
  namespace_id: string;
  agent_id: string;
  call_id: string;
  attempt: number;
  stage: 'input' | 'output';
  raw_response?: unknown;
  schema_errors: Array<{ path: string; message: string }>;
  repaired: boolean;
  occurred_at: string;
}

export interface UsageRow {
  id?: string;
  tool_id: string;
  agent_id: string;
  namespace_id: string;
  call_id: string;
  query_capability_text?: string;
  outcome: 'ok' | 'circuit_broken' | 'violation' | 'timeout' | 'gated';
  latency_ms: number;
  occurred_at: string;
}

export interface RankingRow {
  id?: string;
  query_capability_text: string;
  mode: 'vector' | 'hybrid';
  namespace_id: string;
  results: unknown;           // top-K snapshot
  occurred_at: string;
}

export interface ChangeEvent {
  type:
    | 'tool_changed'
    | 'tool_invoked'
    | 'violation_logged'
    | 'eval_completed'
    | 'discover_ran'
    | 'pipeline_ran';
  table: 'tools' | 'usage' | 'violations' | 'eval_runs' | 'rankings';
  rowid?: number | bigint;
  payload?: Record<string, unknown>;
}

export interface DbStats {
  driver: 'sqlite' | 'postgres';
  version: string;
  database: string;
  total_docs: number;
  data_size_bytes: number;
  index_size_bytes: number;
  collection_counts: Record<string, number>;
  indexes_ready: Record<string, 'ready' | 'building' | 'missing'>;
}

export interface AgentRow {
  id: string;
  name: string;
  api_key_hash: string;
  role: 'caller' | 'tool_author' | 'admin';
  created_at: string;
}

export interface RrfResult {
  id: string;
  name: string;
  version: string;
  capability_text: string;
  endpoint_stub_name: string;
  metadata: ToolSpecV2['metadata'];
  status: ToolStatus;
  tool_kind: ToolKind;
  rrf_score: number;
  vec_score: number;
  text_rank?: number;
  vec_rank?: number;
}

// ====================================================================
// Storage interface — single point of contact for the database
// ====================================================================

export interface Storage {
  init(): Promise<void>;

  // Tool CRUD
  getToolByNameVersion(
    name: string,
    version: string,
    namespace?: string,
  ): Promise<ToolV2 | null>;
  upsertTool(
    spec: ToolSpecV2,
    embedding: Float32Array,
    namespace?: string,
  ): Promise<ToolV2>;
  setStatus(toolId: string, status: ToolStatus): Promise<void>;
  updateToolAfterEval(
    toolId: string,
    metadata: ToolSpecV2['metadata'],
    status: ToolStatus,
  ): Promise<void>;
  /** Atomic patch of ONLY reliability_score + last_eval_run; never writes
   *  status and never replaces whole metadata — safe for sweeps whose
   *  read-time snapshot may be stale by write time (reverify TOCTOU). */
  recordEvalOutcome(
    toolId: string,
    reliabilityScore: number,
    lastEvalRun: string,
  ): Promise<void>;

  // Agent auth (used by /push, /call, /discover guards)
  getAgentByKeyHash(hash: string): Promise<AgentRow | null>;
  upsertAgent(agent: AgentRow): Promise<void>;

  // Retrieval (the heart of /discover)
  runRRF(opts: {
    queryEmbedding: Float32Array;
    queryText: string;
    topK: number;
    gate: number;
    weights: { vector: number; text: number };
    namespace?: string;
    kind?: ToolKind;
  }): Promise<RrfResult[]>;

  // Logging (write paths from /push, /call, /discover)
  insertViolation(v: ViolationRow): Promise<void>;
  insertUsage(u: UsageRow): Promise<void>;
  insertEvalRun(e: EvalRunRow): Promise<void>;
  insertRanking(r: RankingRow): Promise<void>;

  // Dashboard reads (the surface /state, /atlas-stats, dashboardHtml use)
  listTools(opts: {
    status?: ToolStatus;
    limit?: number;
    namespace?: string;
    kind?: ToolKind;
  }): Promise<ToolV2[]>;
  listViolations(limit: number, namespace?: string): Promise<ViolationRow[]>;
  listEvalRuns(limit: number, namespace?: string): Promise<EvalRunRow[]>;
  usageOutcomeCounts(
    limit: number,
    namespace?: string,
  ): Promise<Record<string, number>>;
  /** Tools that appeared most often in /discover top-K rankings within the
   *  last `daysBack` days. Aggregated from the `rankings` snapshot table. */
  getTrending(
    daysBack: number,
    limit: number,
    namespace?: string,
  ): Promise<Array<{ name: string; version: string; hits: number }>>;
  dbStats(): Promise<DbStats>;

  // Live updates (change-stream equivalent)
  watchChanges(onChange: (event: ChangeEvent) => void): void;

  // Lifecycle
  close(): Promise<void>;
}

// ====================================================================
// Embedder interface — single point of contact for the embedding model
// ====================================================================

export interface EmbedResult {
  vec: Float32Array;
  cached: boolean;
  ms: number;
}

export interface Embedder {
  name(): string;
  dim(): number;
  embed(text: string, kind: 'document' | 'query'): Promise<Float32Array>;
  embedBatch(
    texts: string[],
    kind: 'document' | 'query',
  ): Promise<Float32Array[]>;

  // Query-cache contract (per outside-voice review issue #1)
  prewarm(queries: string[]): Promise<void>;
  cachedEmbed(query: string): Promise<EmbedResult>;
}

// ====================================================================
// Constants
// ====================================================================

// v1 (preserved for transition; remove after Phase 2 ships)
export const RELIABILITY_GATE = 0.80;
export const CIRCUIT_BREAK_THRESHOLD = 0.80;
export const RANKING_W_VEC = 0.4;
export const RANKING_W_RELIABILITY = 0.6;
export const VOYAGE_EMBEDDING_DIM = 1024;
export const VECTOR_INDEX_NAME = 'tools_capability_idx';

// v2
export const NOMIC_EMBEDDING_DIM = 768;
export const RRF_K_CONSTANT = 60;
// Calibrated against the 32-query golden set (Step 10 sweep, 2026-05-02).
// 0.5/0.5 gave the best v1-top1 match (22/32) and top-3 overlap (1.88/3)
// for nomic-embed-text vs Voyage. v1 default of 0.7/0.3 leaned too hard on
// vector for nomic's narrower semantic field. See docs/perf/.
export const RRF_DEFAULT_VECTOR_WEIGHT = 0.5;
export const RRF_DEFAULT_TEXT_WEIGHT = 0.5;
// VEC_RELEVANCE_GATE intentionally not set in v2 until Step 6.5 perf tuning
// recalibrates against nomic-embed-text. v1 used 0.70 against Voyage cosine.
