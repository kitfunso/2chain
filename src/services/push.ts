import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { embedOne } from '../embeddings/voyage.js';
import { runEvals } from './evalRunner.js';

export interface PushInput {
  name: string;
  version: string;
  capability_text: string;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  output_repair_strategy: 'llm' | 'fail-fast';
  endpoint_stub_name: string;
  metadata: { cost_per_call_usd: number; p95_latency_ms: number };
}

export interface PushResult {
  ok: true;
  tool_id: string;
  name: string;
  version: string;
  status: 'active';
  reliability_score: number;
  pass_rate: number;
  pass_count: number;
  total_count: number;
  cases: Array<{ case_id: string; pass: boolean; error?: string }>;
  push_ms: number;
  embed_ms: number;
  eval_ms: number;
}

export type PushError =
  | { ok: false; code: 'duplicate_version'; message: string }
  | { ok: false; code: 'name_owned_by_other'; message: string }
  | { ok: false; code: 'unknown_stub'; message: string }
  | { ok: false; code: 'embed_failed'; message: string };

export async function push(
  db: Db,
  authorAgentId: string,
  body: PushInput
): Promise<PushResult | PushError> {
  const tStart = Date.now();
  const now = new Date();

  // Pre-checks
  const existing = await db.collection('tools').findOne({ name: body.name, version: body.version });
  if (existing) {
    return { ok: false, code: 'duplicate_version', message: `tool ${body.name}@${body.version} already exists` };
  }
  const sameName = await db.collection('tools').findOne({ name: body.name });
  if (sameName && sameName.author_agent_id !== authorAgentId) {
    return { ok: false, code: 'name_owned_by_other', message: `tool ${body.name} is owned by another author` };
  }

  // Embed
  const tEmbed = Date.now();
  let embedding: number[];
  try {
    embedding = await embedOne(body.capability_text, 'document');
  } catch (e) {
    return { ok: false, code: 'embed_failed', message: (e as Error).message };
  }
  const embedMs = Date.now() - tEmbed;

  // Insert with status='pending', reliability=0 (D9 invariant)
  const evalRunId = new ObjectId();
  const insert = await db.collection('tools').insertOne({
    name: body.name,
    version: body.version,
    author_agent_id: authorAgentId,
    capability_text: body.capability_text,
    capability_embedding: embedding,
    input_contract: body.input_contract,
    output_contract: body.output_contract,
    output_repair_strategy: body.output_repair_strategy,
    endpoint_stub_name: body.endpoint_stub_name,
    metadata: {
      cost_per_call_usd: body.metadata.cost_per_call_usd,
      p95_latency_ms: body.metadata.p95_latency_ms,
      reliability_score: 0,
      last_eval_run: now,
      last_eval_run_id: evalRunId,
    },
    status: 'pending',
    created_at: now,
    updated_at: now,
  });

  // Run evals (D34: status always flips to 'active', reliability does the gating)
  const tEval = Date.now();
  const isMalformedBot = body.endpoint_stub_name === 'malformed-bot-v1';
  const evalResult = await runEvals({
    endpoint_stub_name: body.endpoint_stub_name,
    cost_per_call_usd: body.metadata.cost_per_call_usd,
    malformed_bot_lenient_override: isMalformedBot,
  });
  const evalMs = Date.now() - tEval;

  // Persist eval_run
  await db.collection('eval_runs').insertOne({
    _id: evalRunId,
    tool_id: insert.insertedId,
    tool_name: body.name,
    tool_version: body.version,
    triggered_at: now,
    triggered_by: 'push',
    cases: evalResult.cases,
    pass_count: evalResult.pass_count,
    total_count: evalResult.total_count,
    pass_rate: evalResult.pass_rate,
    duration_ms: evalResult.duration_ms,
  });

  // D34: always flip to 'active' when evals complete; reliability does the gate.
  await db.collection('tools').updateOne(
    { _id: insert.insertedId },
    {
      $set: {
        'metadata.reliability_score': evalResult.pass_rate,
        'metadata.last_eval_run': now,
        'metadata.last_eval_run_id': evalRunId,
        status: 'active',
        updated_at: now,
      },
    }
  );

  return {
    ok: true,
    tool_id: insert.insertedId.toString(),
    name: body.name,
    version: body.version,
    status: 'active',
    reliability_score: evalResult.pass_rate,
    pass_rate: evalResult.pass_rate,
    pass_count: evalResult.pass_count,
    total_count: evalResult.total_count,
    cases: evalResult.cases.map((c) => ({ case_id: c.case_id, pass: c.pass, error: c.error })),
    push_ms: Date.now() - tStart,
    embed_ms: embedMs,
    eval_ms: evalMs,
  };
}
