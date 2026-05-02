// v2 call — Storage via DI. No MongoDB. ajv contracts enforced on every call.
// LRU-bounded schema cache per CLAUDE.md rule 11.

import * as ajvNs from 'ajv';
import type { AnySchemaObject, ValidateFunction } from 'ajv';
type AjvInstance = { compile: (schema: unknown) => ValidateFunction };
const AjvCtor = ((ajvNs as unknown as { default?: unknown }).default ?? ajvNs) as unknown as new (
  opts?: unknown,
) => AjvInstance;
import { randomUUID, createHash } from 'node:crypto';
import { callStub } from './stubs.js';
import type { Storage, ToolV2 } from '../types.js';
import { RELIABILITY_GATE, DEFAULT_NAMESPACE } from '../types.js';

export const CALL_TIMEOUT_MS = 5000;
const SCHEMA_CACHE_MAX = 1000;

const ajv = new AjvCtor({ allErrors: false, strictSchema: false });
const schemaCache = new Map<string, ValidateFunction>();

function compileCached(schema: AnySchemaObject): ValidateFunction {
  const key = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  let v = schemaCache.get(key);
  if (v) {
    // LRU touch: re-insert to mark as most recently used.
    schemaCache.delete(key);
    schemaCache.set(key, v);
    return v;
  }
  v = ajv.compile(schema);
  schemaCache.set(key, v);
  if (schemaCache.size > SCHEMA_CACHE_MAX) {
    const oldest = schemaCache.keys().next().value;
    if (oldest) schemaCache.delete(oldest);
  }
  return v;
}

function ajvErrors(errs: unknown): Array<{ path: string; message: string }> {
  if (!Array.isArray(errs)) return [];
  return errs.map((e: unknown) => {
    const x = e as { instancePath?: string; schemaPath?: string; message?: string };
    return { path: x.instancePath || x.schemaPath || '', message: x.message ?? 'invalid' };
  });
}

export interface CallInput {
  tool_name: string;
  tool_version: string;
  case_id?: string;
  input: Record<string, unknown>;
}

export type CallResponse =
  | { ok: true; result: unknown; latency_ms: number; call_id: string }
  | { ok: false; status: number; error: { code: string; message: string; details?: unknown } };

export async function call(
  storage: Storage,
  agentId: string,
  agentRole: 'caller' | 'tool_author' | 'admin',
  input: CallInput,
  bypassGate = false,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<CallResponse> {
  const t0 = Date.now();
  const callId = randomUUID();

  const tool = await storage.getToolByNameVersion(input.tool_name, input.tool_version, namespace);
  if (!tool) {
    return { ok: false, status: 404, error: { code: 'tool_not_found', message: `${input.tool_name}@${input.tool_version} not found` } };
  }

  if (tool.status === 'pending') {
    await logUsage(storage, tool, agentId, callId, 'gated', Date.now() - t0, namespace);
    return { ok: false, status: 403, error: { code: 'tool_pending', message: 'tool eval not yet complete' } };
  }
  if (tool.status === 'circuit_broken') {
    await logUsage(storage, tool, agentId, callId, 'circuit_broken', Date.now() - t0, namespace);
    return { ok: false, status: 503, error: { code: 'circuit_broken', message: `tool ${input.tool_name}@${input.tool_version} is circuit-broken` } };
  }

  const score = tool.metadata.reliability_score ?? 0;
  if (score < RELIABILITY_GATE) {
    if (!(bypassGate && agentRole === 'admin')) {
      await logUsage(storage, tool, agentId, callId, 'gated', Date.now() - t0, namespace);
      return {
        ok: false,
        status: 403,
        error: {
          code: 'reliability_gate',
          message: `Tool reliability_score (${score}) below gate (${RELIABILITY_GATE})`,
          details: { tool_name: input.tool_name, version: input.tool_version, score, gate: RELIABILITY_GATE },
        },
      };
    }
  }

  // Validate input
  const inputValidator = compileCached(tool.input_contract as AnySchemaObject);
  if (!inputValidator(input.input)) {
    const errs = ajvErrors(inputValidator.errors);
    await logViolation(storage, tool, agentId, callId, 1, 'input', undefined, errs, namespace);
    await logUsage(storage, tool, agentId, callId, 'violation', Date.now() - t0, namespace);
    return { ok: false, status: 400, error: { code: 'input_contract_violation', message: 'input failed schema validation', details: { schema_errors: errs } } };
  }

  // Forward to stub
  let raw: unknown;
  try {
    raw = await Promise.race([
      Promise.resolve(callStub(tool.endpoint_stub_name, input.input, input.case_id)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`stub timeout > ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)),
    ]);
  } catch (e) {
    await logUsage(storage, tool, agentId, callId, 'timeout', Date.now() - t0, namespace);
    return { ok: false, status: 504, error: { code: 'stub_timeout', message: (e as Error).message } };
  }

  // Validate output
  const outputValidator = compileCached(tool.output_contract as AnySchemaObject);
  if (!outputValidator(raw)) {
    const errs = ajvErrors(outputValidator.errors);
    await logViolation(storage, tool, agentId, callId, 1, 'output', raw, errs, namespace);

    // fail-fast: circuit-break immediately (D34: only place that flips to circuit_broken)
    if (tool.output_repair_strategy === 'fail-fast') {
      await storage.setStatus(tool.id, 'circuit_broken');
      await logUsage(storage, tool, agentId, callId, 'circuit_broken', Date.now() - t0, namespace);
      return {
        ok: false,
        status: 503,
        error: {
          code: 'output_contract_violation_circuit_break',
          message: `Tool ${input.tool_name}@${input.tool_version} returned a malformed response and was circuit-broken`,
          details: { schema_errors: errs, raw_preview: typeof raw === 'string' ? (raw as string).slice(0, 200) : raw },
        },
      };
    }

    await logUsage(storage, tool, agentId, callId, 'violation', Date.now() - t0, namespace);
    return {
      ok: false,
      status: 503,
      error: {
        code: 'output_contract_violation',
        message: 'output failed schema validation; LLM repair not implemented in v0.1',
        details: { schema_errors: errs },
      },
    };
  }

  await logUsage(storage, tool, agentId, callId, 'ok', Date.now() - t0, namespace);
  return { ok: true, result: raw, latency_ms: Date.now() - t0, call_id: callId };
}

async function logViolation(
  storage: Storage,
  tool: ToolV2,
  agentId: string,
  callId: string,
  attempt: number,
  stage: 'input' | 'output',
  raw: unknown,
  errs: Array<{ path: string; message: string }>,
  namespace: string,
): Promise<void> {
  await storage.insertViolation({
    tool_id: tool.id,
    tool_name: tool.name,
    tool_version: tool.version,
    namespace_id: namespace,
    agent_id: agentId,
    call_id: callId,
    attempt,
    stage,
    raw_response: raw === undefined ? null : raw,
    schema_errors: errs,
    repaired: false,
    occurred_at: new Date().toISOString(),
  });
}

async function logUsage(
  storage: Storage,
  tool: ToolV2,
  agentId: string,
  callId: string,
  outcome: 'ok' | 'circuit_broken' | 'violation' | 'timeout' | 'gated',
  latencyMs: number,
  namespace: string,
): Promise<void> {
  await storage.insertUsage({
    tool_id: tool.id,
    agent_id: agentId,
    namespace_id: namespace,
    call_id: callId,
    outcome,
    latency_ms: latencyMs,
    occurred_at: new Date().toISOString(),
  });
}
