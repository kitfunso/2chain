// services/call gate test: skills + subagents are discovery-only and must
// be refused with kind_not_callable instead of falling through to the
// catalog-only-stub payload.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { call } from '../src/services/call.js';
import type { ToolSpecV2 } from '../src/types.js';

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

before(async () => {
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();

  const specs: ToolSpecV2[] = [
    {
      name: 'office-hours', version: '1.0', author_agent_id: 't',
      capability_text: 'brainstorming new ideas',
      input_contract: { type: 'object', additionalProperties: true },
      output_contract: { type: 'object', additionalProperties: true },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'catalog-only-stub',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.95 },
      status: 'active', tool_kind: 'skill',
    },
    {
      name: 'debugger-agent', version: '1.0', author_agent_id: 't',
      capability_text: 'debugging specialist',
      input_contract: { type: 'object', additionalProperties: true },
      output_contract: { type: 'object', additionalProperties: true },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'catalog-only-stub',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.95 },
      status: 'active', tool_kind: 'subagent',
    },
    {
      name: 'commit-prompt', version: '1.0', author_agent_id: 't',
      capability_text: 'conventional commit',
      input_contract: { type: 'object', additionalProperties: true },
      output_contract: { type: 'object', properties: { rendered: { type: 'string' } }, required: ['rendered'] },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'prompt-template-stub',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 1, reliability_score: 0.95 },
      status: 'active', tool_kind: 'prompt',
    },
  ];
  for (let i = 0; i < specs.length; i++) {
    await storage.upsertTool(specs[i], makeUnitVec(i + 1));
  }
});

after(async () => {
  await storage.close();
});

test('call rejects tool_kind=skill with kind_not_callable', async () => {
  const r = await call(storage, 'agent-1', 'caller', {
    tool_name: 'office-hours',
    tool_version: '1.0',
    input: {},
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'kind_not_callable');
  assert.match(r.error.message, /skill/);
  assert.match(r.error.message, /Load the skill into agent context/);
});

test('call rejects tool_kind=subagent with kind_not_callable', async () => {
  const r = await call(storage, 'agent-1', 'caller', {
    tool_name: 'debugger-agent',
    tool_version: '1.0',
    input: {},
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'kind_not_callable');
  assert.match(r.error.message, /subagent/);
  assert.match(r.error.message, /Spawn the subagent/);
});

test('call allows tool_kind=prompt (still callable via prompt-template-stub)', async () => {
  // Prompt template needs to be in the runtime registry. Importing the seed
  // file isn't enough — only importPrompts populates PROMPT_TEMPLATES. So
  // we just assert that the gate doesn't fire; the stub will fail later
  // because no template was registered, which is a different error.
  const r = await call(storage, 'agent-1', 'caller', {
    tool_name: 'commit-prompt',
    tool_version: '1.0',
    input: { vars: {} },
  });
  // Either ok=true (if a template happens to be registered) or ok=false
  // with code=stub_timeout — but NOT kind_not_callable.
  if (!r.ok) {
    assert.notEqual(r.error.code, 'kind_not_callable', 'prompts must not be gated');
  }
});
