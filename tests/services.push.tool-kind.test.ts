// services/push tool_kind test: external authors can register skill/subagent/
// prompt entries via /push, eval is skipped for non-tool kinds, kind is
// validated, default is 'tool' for back-compat.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { push, type PushInput } from '../src/services/push.js';
import type { Embedder } from '../src/types.js';
import '../src/services/stubs.js';

class StubEmbedder implements Embedder {
  name() { return 'stub:zero'; }
  dim() { return 768; }
  async embed(): Promise<Float32Array> { return makeUnitVec(1); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, i) => makeUnitVec(i + 1));
  }
  async prewarm() {}
  async cachedEmbed() { return { vec: makeUnitVec(1), cached: false, ms: 0 }; }
}

function makeUnitVec(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

let storage: SqliteStorage;
const embedder = new StubEmbedder();

const baseInput = (overrides: Partial<PushInput>): PushInput => ({
  name: 'unset',
  version: '1.0',
  capability_text: 'a capability',
  input_contract: { type: 'object', additionalProperties: true },
  output_contract: { type: 'object', additionalProperties: true },
  output_repair_strategy: 'fail-fast',
  endpoint_stub_name: 'catalog-only-stub',
  metadata: { cost_per_call_usd: 0, p95_latency_ms: 100 },
  ...overrides,
});

before(async () => {
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
});

after(async () => {
  await storage.close();
});

test('push without tool_kind defaults to "tool" (back-compat)', async () => {
  const r = await push(storage, embedder, 'agent-1', baseInput({
    name: 'plain-tool',
    endpoint_stub_name: 'pdf-extractor-v3',
  }));
  assert.equal(r.ok, true);
  const tool = await storage.getToolByNameVersion('plain-tool', '1.0');
  assert.ok(tool);
  assert.equal(tool!.tool_kind, 'tool');
});

test('push with tool_kind=skill persists kind and runs kind eval', async () => {
  const r = await push(storage, embedder, 'agent-1', baseInput({
    name: 'pushed-skill',
    tool_kind: 'skill',
    domain: 'skills',
    capability_text: 'A skill for brainstorming new ideas. Use this when the user asks if something is worth building. Returns sharp critical feedback grounded in product reality.',
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Per-kind eval runs (deterministic, microseconds).
  assert.ok(r.total_count > 0, 'kind eval should produce cases');
  assert.equal(r.cases.length, r.total_count);
  // Status flipped to active. Reliability is now derived from the rubric.
  assert.equal(r.status, 'active');
  assert.ok(r.reliability_score > 0.7, 'a complete skill spec should clear the gate');

  const tool = await storage.getToolByNameVersion('pushed-skill', '1.0');
  assert.ok(tool);
  assert.equal(tool!.tool_kind, 'skill');
  assert.equal(tool!.status, 'active');
});

test('push with tool_kind=subagent runs subagent rubric', async () => {
  const r = await push(storage, embedder, 'agent-1', baseInput({
    name: 'pushed-subagent',
    tool_kind: 'subagent',
    domain: 'subagents',
    capability_text: 'Use this debugger agent when tests fail. The specialist agent inspects stack traces and proposes specific fixes per file:line.',
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.total_count > 0);
  const tool = await storage.getToolByNameVersion('pushed-subagent', '1.0');
  assert.equal(tool!.tool_kind, 'subagent');
});

test('push with tool_kind=prompt runs prompt rubric', async () => {
  const r = await push(storage, embedder, 'agent-1', baseInput({
    name: 'pushed-prompt',
    tool_kind: 'prompt',
    domain: 'code',
    capability_text: 'A prompt that generates a conventional commit message from a unified diff. Use when you want a Conventional Commit.',
    endpoint_stub_name: 'prompt-template-stub',
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.total_count > 0);
  // No template registered for 'pushed-prompt' so template-registered fails.
  // That's expected behaviour; reliability comes in below 1.0.
  const tool = await storage.getToolByNameVersion('pushed-prompt', '1.0');
  assert.equal(tool!.tool_kind, 'prompt');
});

test('push with bogus tool_kind returns invalid_tool_kind', async () => {
  const r = await push(storage, embedder, 'agent-1', baseInput({
    name: 'pushed-bogus',
    tool_kind: 'WIDGET' as 'tool',
  }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'invalid_tool_kind');
  assert.match(r.message, /tool\|skill\|subagent\|prompt/);
});

test('push with tool_kind=tool still runs evals (eval_ms > 0)', async () => {
  const r = await push(storage, embedder, 'agent-1', baseInput({
    name: 'pushed-explicit-tool',
    tool_kind: 'tool',
    endpoint_stub_name: 'pdf-extractor-v3',
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Real eval ran — total_count > 0 means the eval harness produced cases.
  assert.ok(r.total_count > 0, 'tool kind must run evals');
});
