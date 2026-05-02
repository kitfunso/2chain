import type { ObjectId } from 'mongodb';

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

export const RELIABILITY_GATE = 0.80;
export const CIRCUIT_BREAK_THRESHOLD = 0.80;
export const RANKING_W_VEC = 0.4;
export const RANKING_W_RELIABILITY = 0.6;
export const VOYAGE_EMBEDDING_DIM = 1024;
export const VECTOR_INDEX_NAME = 'tools_capability_idx';
