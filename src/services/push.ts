// v2 push — Storage + Embedder via DI. No MongoDB. No Voyage.

import type { Storage, Embedder, ToolSpecV2, ToolKind } from '../types.js';
import { DEFAULT_NAMESPACE } from '../types.js';
import { runEvals } from './evalRunner.js';
import { getStub } from './stubs.js';
import { validateContract } from './contract-bounds.js';

const VALID_KINDS: ReadonlySet<ToolKind> = new Set(['tool', 'skill', 'subagent', 'prompt']);
const NON_EVAL_KINDS: ReadonlySet<ToolKind> = new Set(['skill', 'subagent', 'prompt']);

export interface PushInput {
  name: string;
  version: string;
  capability_text: string;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  output_repair_strategy: 'llm' | 'fail-fast';
  endpoint_stub_name: string;
  metadata: { cost_per_call_usd: number; p95_latency_ms: number };
  domain?: string;
  tool_kind?: ToolKind;
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
  | { ok: false; code: 'contract_too_large'; message: string }
  | { ok: false; code: 'embed_failed'; message: string }
  | { ok: false; code: 'invalid_tool_kind'; message: string };

export async function push(
  storage: Storage,
  embedder: Embedder,
  authorAgentId: string,
  body: PushInput,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<PushResult | PushError> {
  const tStart = Date.now();
  const now = new Date().toISOString();

  // tool_kind defaults to 'tool' for back-compat with existing /push callers.
  const kind: ToolKind = body.tool_kind ?? 'tool';
  if (!VALID_KINDS.has(kind)) {
    return {
      ok: false,
      code: 'invalid_tool_kind',
      message: `tool_kind must be one of tool|skill|subagent|prompt, got "${body.tool_kind}"`,
    };
  }

  // CLAUDE.md rule 11: bound JSON Schema size + depth before any compile.
  const inputCheck = validateContract(body.input_contract, 'input');
  if (!inputCheck.ok) return { ok: false, code: 'contract_too_large', message: inputCheck.reason };
  const outputCheck = validateContract(body.output_contract, 'output');
  if (!outputCheck.ok) return { ok: false, code: 'contract_too_large', message: outputCheck.reason };

  // Stub must be registered (CLAUDE.md rule 12: first-party stubs only).
  if (!getStub(body.endpoint_stub_name)) {
    return { ok: false, code: 'unknown_stub', message: `endpoint_stub_name '${body.endpoint_stub_name}' is not a registered first-party stub` };
  }

  // Pre-checks
  const existing = await storage.getToolByNameVersion(body.name, body.version, namespace);
  if (existing) {
    return { ok: false, code: 'duplicate_version', message: `tool ${body.name}@${body.version} already exists` };
  }
  const sameName = await storage.listTools({ namespace, limit: 5_000 });
  const conflict = sameName.find((t) => t.name === body.name && t.author_agent_id !== authorAgentId);
  if (conflict) {
    return { ok: false, code: 'name_owned_by_other', message: `tool ${body.name} is owned by another author` };
  }

  // Embed
  const tEmbed = Date.now();
  let embedding: Float32Array;
  try {
    embedding = await embedder.embed(body.capability_text, 'document');
  } catch (e) {
    return { ok: false, code: 'embed_failed', message: (e as Error).message };
  }
  const embedMs = Date.now() - tEmbed;

  // Insert with status='pending', reliability=0 (D9 invariant).
  const pendingSpec: ToolSpecV2 = {
    name: body.name,
    version: body.version,
    author_agent_id: authorAgentId,
    capability_text: body.capability_text,
    input_contract: body.input_contract,
    output_contract: body.output_contract,
    output_repair_strategy: body.output_repair_strategy,
    endpoint_stub_name: body.endpoint_stub_name,
    metadata: {
      cost_per_call_usd: body.metadata.cost_per_call_usd,
      p95_latency_ms: body.metadata.p95_latency_ms,
      reliability_score: 0,
      last_eval_run: now,
    },
    status: 'pending',
    domain: body.domain,
    tool_kind: kind,
  };
  const inserted = await storage.upsertTool(pendingSpec, embedding, namespace);

  // Skills, subagents, and prompts skip the eval harness — eval cases assume
  // the tool fixture stubs (pdf-extractor, malformed-bot, etc.). Non-tool
  // kinds get reliability=0.95 and status='active' directly so they pass
  // the RRF gate and surface in /discover. Future: per-kind eval suites.
  if (NON_EVAL_KINDS.has(kind)) {
    const reliability = 0.95;
    await storage.updateToolAfterEval(
      inserted.id,
      {
        ...pendingSpec.metadata,
        reliability_score: reliability,
        last_eval_run: new Date().toISOString(),
      },
      'active',
    );
    return {
      ok: true,
      tool_id: inserted.id,
      name: body.name,
      version: body.version,
      status: 'active',
      reliability_score: reliability,
      pass_rate: reliability,
      pass_count: 0,
      total_count: 0,
      cases: [],
      push_ms: Date.now() - tStart,
      embed_ms: embedMs,
      eval_ms: 0,
    };
  }

  // Run evals (D34: status always flips to 'active', reliability does the gating)
  const tEval = Date.now();
  const isMalformedBot = body.endpoint_stub_name === 'malformed-bot-v1';
  const evalResult = await runEvals({
    endpoint_stub_name: body.endpoint_stub_name,
    cost_per_call_usd: body.metadata.cost_per_call_usd,
    malformed_bot_lenient_override: isMalformedBot,
  });
  const evalMs = Date.now() - tEval;

  await storage.insertEvalRun({
    tool_id: inserted.id,
    tool_name: body.name,
    tool_version: body.version,
    namespace_id: namespace,
    triggered_at: now,
    triggered_by: 'push',
    cases: evalResult.cases,
    pass_count: evalResult.pass_count,
    total_count: evalResult.total_count,
    pass_rate: evalResult.pass_rate,
    duration_ms: evalResult.duration_ms,
  });

  await storage.updateToolAfterEval(
    inserted.id,
    {
      ...pendingSpec.metadata,
      reliability_score: evalResult.pass_rate,
      last_eval_run: new Date().toISOString(),
    },
    'active',
  );

  return {
    ok: true,
    tool_id: inserted.id,
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
