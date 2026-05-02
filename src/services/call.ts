import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import * as ajvNs from 'ajv';
import type { AnySchemaObject, ValidateFunction } from 'ajv';
type AjvInstance = { compile: (schema: unknown) => ValidateFunction };
// ESM compat: ajv ships a CJS module; the constructor is on .default at runtime.
const AjvCtor = ((ajvNs as any).default ?? ajvNs) as new (opts?: unknown) => AjvInstance;
import { randomUUID, createHash } from 'node:crypto';
import { callStub } from './stubs.js';
import { RELIABILITY_GATE } from '../types.js';

export const CALL_TIMEOUT_MS = 5000;

const ajv = new AjvCtor({ allErrors: true, strictSchema: false });
const schemaCache = new Map<string, ValidateFunction>();

function compileCached(schema: AnySchemaObject): ValidateFunction {
  const key = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  let v = schemaCache.get(key);
  if (!v) { v = ajv.compile(schema); schemaCache.set(key, v); }
  return v;
}

function ajvErrors(errs: unknown): Array<{ path: string; message: string }> {
  if (!Array.isArray(errs)) return [];
  return errs.map((e: any) => ({ path: e.instancePath || e.schemaPath || '', message: e.message ?? 'invalid' }));
}

export interface CallInput {
  tool_name: string;
  tool_version: string;
  case_id?: string;        // demo helper: lets the stub return case-keyed output
  input: Record<string, unknown>;
}

export type CallResponse =
  | { ok: true; result: unknown; latency_ms: number; call_id: string }
  | { ok: false; status: number; error: { code: string; message: string; details?: unknown } };

export async function call(
  db: Db,
  agentId: string,
  agentRole: 'caller' | 'tool_author' | 'admin',
  input: CallInput,
  bypassGate = false
): Promise<CallResponse> {
  const t0 = Date.now();
  const callId = randomUUID();

  const tool = await db.collection('tools').findOne({ name: input.tool_name, version: input.tool_version });
  if (!tool) {
    return { ok: false, status: 404, error: { code: 'tool_not_found', message: `${input.tool_name}@${input.tool_version} not found` } };
  }

  if (tool.status === 'pending') {
    await logUsage(db, tool._id, agentId, callId, undefined, 'gated', Date.now() - t0);
    return { ok: false, status: 403, error: { code: 'tool_pending', message: 'tool eval not yet complete' } };
  }
  if (tool.status === 'circuit_broken') {
    await logUsage(db, tool._id, agentId, callId, undefined, 'circuit_broken', Date.now() - t0);
    return { ok: false, status: 503, error: { code: 'circuit_broken', message: `tool ${input.tool_name}@${input.tool_version} is circuit-broken` } };
  }

  const score = tool.metadata?.reliability_score ?? 0;
  if (score < RELIABILITY_GATE) {
    if (!(bypassGate && agentRole === 'admin')) {
      await logUsage(db, tool._id, agentId, callId, undefined, 'gated', Date.now() - t0);
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
  const inputValidator = compileCached(tool.input_contract);
  if (!inputValidator(input.input)) {
    const errs = ajvErrors(inputValidator.errors);
    await logViolation(db, tool, agentId, callId, 1, 'input', undefined, errs);
    await logUsage(db, tool._id, agentId, callId, undefined, 'violation', Date.now() - t0);
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
    await logUsage(db, tool._id, agentId, callId, undefined, 'timeout', Date.now() - t0);
    return { ok: false, status: 504, error: { code: 'stub_timeout', message: (e as Error).message } };
  }

  // Validate output
  const outputValidator = compileCached(tool.output_contract);
  if (!outputValidator(raw)) {
    const errs = ajvErrors(outputValidator.errors);
    await logViolation(db, tool, agentId, callId, 1, 'output', raw, errs);

    // fail-fast: circuit-break immediately (D34: only place that flips to circuit_broken)
    if (tool.output_repair_strategy === 'fail-fast') {
      await db.collection('tools').updateOne(
        { _id: tool._id },
        { $set: { status: 'circuit_broken', updated_at: new Date() } }
      );
      await logUsage(db, tool._id, agentId, callId, undefined, 'circuit_broken', Date.now() - t0);
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

    // llm strategy is v0.2 — for now treat same as fail-fast
    await logUsage(db, tool._id, agentId, callId, undefined, 'violation', Date.now() - t0);
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

  // Success
  await logUsage(db, tool._id, agentId, callId, undefined, 'ok', Date.now() - t0);
  return { ok: true, result: raw, latency_ms: Date.now() - t0, call_id: callId };
}

async function logViolation(
  db: Db,
  tool: any,
  agentId: string,
  callId: string,
  attempt: number,
  stage: 'input' | 'output',
  raw: unknown,
  errs: Array<{ path: string; message: string }>
): Promise<void> {
  await db.collection('violations').insertOne({
    tool_id: tool._id,
    tool_name: tool.name,
    tool_version: tool.version,
    agent_id: agentId,
    call_id: callId,
    attempt,
    stage,
    raw_response: raw === undefined ? null : raw,
    schema_errors: errs,
    repaired: false,
    occurred_at: new Date(),
  });
}

async function logUsage(
  db: Db,
  toolId: ObjectId,
  agentId: string,
  callId: string,
  queryText: string | undefined,
  outcome: 'ok' | 'circuit_broken' | 'violation' | 'timeout' | 'gated',
  latencyMs: number
): Promise<void> {
  await db.collection('usage').insertOne({
    tool_id: toolId,
    agent_id: agentId,
    call_id: callId,
    query_capability_text: queryText,
    outcome,
    latency_ms: latencyMs,
    occurred_at: new Date(),
  });
}
