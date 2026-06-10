// v2 push — Storage + Embedder via DI. No MongoDB. No Voyage.

import type {
  Storage,
  Embedder,
  ToolSpecV2,
  ToolKind,
  ToolV2,
  ContractDiff,
} from '../types.js';
import { DEFAULT_NAMESPACE } from '../types.js';
import { diffContracts, compareVersions, majorOf } from './contractDiff.js';
import { runEvals } from './evalRunner.js';
import { runKindEval } from './kindEvalRunner.js';
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

/** Contract drift vs the latest prior version of the same name (E3).
 *  Present on PushResult whenever a prior version existed. */
export interface DriftSummary {
  from_version: string;
  input: ContractDiff;
  output: ContractDiff;
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
  drift?: DriftSummary;
}

export type PushError =
  | { ok: false; code: 'duplicate_version'; message: string }
  | { ok: false; code: 'name_owned_by_other'; message: string }
  | { ok: false; code: 'unknown_stub'; message: string }
  | { ok: false; code: 'contract_too_large'; message: string }
  | { ok: false; code: 'embed_failed'; message: string }
  | { ok: false; code: 'invalid_tool_kind'; message: string }
  | {
      ok: false;
      code: 'breaking_contract_requires_major_bump';
      message: string;
      details?: Record<string, unknown>;
    };

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

  // Pre-checks. listToolsByName is an indexed exact-match with no list cap —
  // the previous listTools({ limit: 5_000 }) scan would silently miss rows
  // beyond 5k tools and fail open on both ownership and drift.
  const existing = await storage.getToolByNameVersion(body.name, body.version, namespace);
  if (existing) {
    return { ok: false, code: 'duplicate_version', message: `tool ${body.name}@${body.version} already exists` };
  }
  const sameName = await storage.listToolsByName(body.name, namespace);
  const conflict = sameName.find((t) => t.author_agent_id !== authorAgentId);
  if (conflict) {
    return { ok: false, code: 'name_owned_by_other', message: `tool ${body.name} is owned by another author` };
  }

  // Contract drift check (E3) — after ownership, BEFORE embed (fail fast, no
  // wasted embed cost). Drift is exactly: new version vs the latest prior
  // version of the same name, same author.
  let prior: ToolV2 | null = null;
  for (const t of sameName) {
    if (!prior || compareVersions(t.version, prior.version) > 0) prior = t;
  }
  let drift: DriftSummary | undefined;
  if (prior) {
    const inputDiff = diffContracts(prior.input_contract, body.input_contract, 'input');
    const outputDiff = diffContracts(prior.output_contract, body.output_contract, 'output');
    const isBreaking =
      inputDiff.classification === 'breaking' || outputDiff.classification === 'breaking';
    if (isBreaking) {
      const details: Record<string, unknown> = {
        from_version: prior.version,
        to_version: body.version,
        input: inputDiff,
        output: outputDiff,
      };
      const breakingPaths = [
        ...inputDiff.changes.filter((c) => c.breaking).map((c) => `input:${c.path}`),
        ...outputDiff.changes.filter((c) => c.breaking).map((c) => `output:${c.path}`),
      ];
      const newMajor = majorOf(body.version);
      const priorMajor = majorOf(prior.version);
      if (newMajor === null || priorMajor === null) {
        // Unordered versions + breaking change: fail loud, never fail open.
        return {
          ok: false,
          code: 'breaking_contract_requires_major_bump',
          message:
            `breaking contract change from ${prior.version} to ${body.version}, but the ` +
            `version is not numerically ordered (no leading integer) so a major bump ` +
            `cannot be verified. ${breakingPaths.length} breaking change(s): ` +
            breakingPaths.slice(0, 3).join(', '),
          details,
        };
      }
      if (newMajor <= priorMajor) {
        return {
          ok: false,
          code: 'breaking_contract_requires_major_bump',
          message:
            `breaking contract change from ${prior.version} to ${body.version} requires a ` +
            `major version bump (major ${newMajor} is not greater than ${priorMajor}). ` +
            `${breakingPaths.length} breaking change(s): ` +
            breakingPaths.slice(0, 3).join(', ') +
            (breakingPaths.length > 3 ? ', ...' : ''),
          details,
        };
      }
    }
    drift = { from_version: prior.version, input: inputDiff, output: outputDiff };
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

  // Persist drift events AFTER upsertTool succeeds (the table records what
  // the registry ACCEPTED; pushes that fail embed/insert write nothing).
  // FAIL-SOFT (pinned execute decision): the tool is already registered, so
  // an event-write failure logs and the push still succeeds — a registered
  // tool's push must never 500 on a post-commit side effect.
  if (drift) {
    // Per-direction try/catch: an input-event write failure must not abort
    // the output event — the audit trail degrades per-row, not wholesale.
    for (const [direction, diff] of [
      ['input', drift.input],
      ['output', drift.output],
    ] as const) {
      if (diff.classification === 'identical') continue;
      try {
        await storage.insertDriftEvent({
          namespace_id: namespace,
          tool_name: body.name,
          from_version: drift.from_version,
          to_version: body.version,
          direction,
          classification: diff.classification,
          changes: diff.changes,
          author_agent_id: authorAgentId,
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(
          `[push] ${direction} drift event write failed for ${body.name}@${body.version} (push still ok): ${(err as Error).message}`,
        );
      }
    }
  }

  // Skills, subagents, and prompts run the per-kind rubric instead of the
  // fixture eval harness. Pass-rate becomes reliability_score so the trust
  // signal is honest (entries with sparse capability_text or missing
  // metadata land below the 0.80 RRF gate and don't pollute discover).
  if (NON_EVAL_KINDS.has(kind)) {
    const tEval = Date.now();
    const kindResult = runKindEval(inserted);
    const evalMs = Date.now() - tEval;
    if (kindResult) {
      await storage.insertEvalRun({
        tool_id: inserted.id,
        tool_name: body.name,
        tool_version: body.version,
        namespace_id: namespace,
        triggered_at: now,
        triggered_by: 'push',
        cases: kindResult.cases,
        pass_count: kindResult.pass_count,
        total_count: kindResult.total_count,
        pass_rate: kindResult.pass_rate,
        duration_ms: kindResult.duration_ms,
      });
      await storage.updateToolAfterEval(
        inserted.id,
        {
          ...pendingSpec.metadata,
          reliability_score: kindResult.pass_rate,
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
        reliability_score: kindResult.pass_rate,
        pass_rate: kindResult.pass_rate,
        pass_count: kindResult.pass_count,
        total_count: kindResult.total_count,
        cases: kindResult.cases.map((c) => ({ case_id: c.case_id, pass: c.pass, error: c.error })),
        push_ms: Date.now() - tStart,
        embed_ms: embedMs,
        eval_ms: evalMs,
        ...(drift ? { drift } : {}),
      };
    }
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
    ...(drift ? { drift } : {}),
  };
}
