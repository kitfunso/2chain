// services/call gate test: catalog kinds (skill/subagent/prompt) are
// discovery-only and must be refused with kind_not_callable instead of
// falling through to a stub payload. 'prompt' joined the gate in E2
// (plan §4c): a callable prompt could circuit-break and then be skipped
// forever by reverify's catalog-kind partition — a dead end recovery could
// never reach.

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

test('call rejects tool_kind=prompt with kind_not_callable (E2: prompts are discovery-only)', async () => {
  // REVERSES the E1-era assertion that prompts pass the gate. A prompt that
  // reaches the stub can circuit-break (e.g. unregistered template), and
  // reverify's catalog-kind partition would then skip it forever — recovery
  // could never flip it back. Discovery-only is the root fix.
  const r = await call(storage, 'agent-1', 'caller', {
    tool_name: 'commit-prompt',
    tool_version: '1.0',
    input: { vars: {} },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'kind_not_callable');
  assert.match(r.error.message, /prompt/);
  assert.match(r.error.message, /Render the prompt template into agent context/);
});

test('a circuit-broken catalog kind answers kind_not_callable, not circuit_broken (pre-E2 dead-end rows)', async () => {
  // The kind gate sits ABOVE the status checks: a prompt circuit-broken
  // BEFORE E2 closed the gate must get the truthful discovery-only error
  // forever, not 503 circuit_broken (reverify skips catalog kinds, so
  // recovery can never reach it - the dead end is answered, not hidden).
  const row = (storage as unknown as {
    db: { prepare: (s: string) => { get: (...a: unknown[]) => { id: string } } };
  }).db
    .prepare(`SELECT id FROM tools WHERE name = ? AND version = ?`)
    .get('commit-prompt', '1.0');
  await storage.setStatus(row.id, 'circuit_broken');

  const r = await call(storage, 'agent-1', 'caller', {
    tool_name: 'commit-prompt',
    tool_version: '1.0',
    input: { vars: {} },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 400, 'kind gate fires before the circuit_broken 503');
  assert.equal(r.error.code, 'kind_not_callable');
});
