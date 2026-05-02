// SqliteChangeHook integration test. Real :memory: SQLite + real triggers.
// Phase 1 plan Step 9 verify criterion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../src/storage/sqlite.js';
import type { ChangeEvent, ToolSpecV2 } from '../src/types.js';

function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

function makeSpec(over: Partial<ToolSpecV2> = {}): ToolSpecV2 {
  return {
    name: 'test-tool',
    version: '1.0',
    author_agent_id: 'test',
    capability_text: 'do a thing',
    input_contract: { type: 'object' },
    output_contract: { type: 'object' },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'stub',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 100, reliability_score: 1.0 },
    status: 'active',
    ...over,
  };
}

async function fresh(): Promise<SqliteStorage> {
  const s = new SqliteStorage({ path: ':memory:' });
  await s.init();
  return s;
}

test('upsertTool fires a tool_changed event', async () => {
  const s = await fresh();
  const events: ChangeEvent[] = [];
  s.watchChanges((e) => events.push(e));

  await s.upsertTool(makeSpec({ name: 'a' }), makeEmbedding(1));
  // Event drains on next tick — wait one microtask cycle
  await new Promise((r) => setImmediate(r));

  assert.ok(events.length >= 1, 'should have at least one event');
  const toolEvent = events.find((e) => e.table === 'tools');
  assert.ok(toolEvent, 'tools event should exist');
  assert.equal(toolEvent!.type, 'tool_changed');
  await s.close();
});

test('insertUsage fires a tool_invoked event', async () => {
  const s = await fresh();
  const t = await s.upsertTool(makeSpec(), makeEmbedding(1));
  const events: ChangeEvent[] = [];
  s.watchChanges((e) => {
    if (e.table === 'usage') events.push(e);
  });

  await s.insertUsage({
    tool_id: t.id,
    agent_id: 'a',
    namespace_id: 'default',
    call_id: 'c1',
    outcome: 'ok',
    latency_ms: 10,
    occurred_at: new Date().toISOString(),
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_invoked');
  assert.equal(events[0].table, 'usage');
  await s.close();
});

test('insertViolation fires a violation_logged event', async () => {
  const s = await fresh();
  const t = await s.upsertTool(makeSpec(), makeEmbedding(1));
  const events: ChangeEvent[] = [];
  s.watchChanges((e) => {
    if (e.table === 'violations') events.push(e);
  });

  await s.insertViolation({
    tool_id: t.id,
    tool_name: t.name,
    tool_version: t.version,
    namespace_id: 'default',
    agent_id: 'a',
    call_id: 'c1',
    attempt: 1,
    stage: 'output',
    raw_response: 'malformed',
    schema_errors: [{ path: '/', message: 'must be object' }],
    repaired: false,
    occurred_at: new Date().toISOString(),
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'violation_logged');
  await s.close();
});

test('listener errors do not stop the drain', async () => {
  const s = await fresh();
  let goodCount = 0;
  s.watchChanges(() => {
    throw new Error('boom');
  });
  s.watchChanges((_e) => {
    goodCount++;
  });

  await s.upsertTool(makeSpec({ name: 'a' }), makeEmbedding(1));
  await s.upsertTool(makeSpec({ name: 'b' }), makeEmbedding(2));
  await new Promise((r) => setImmediate(r));

  assert.ok(goodCount >= 2, `good listener should fire even if other throws (${goodCount})`);
  await s.close();
});

test('rapid writes do not block or crash (200 inserts)', async () => {
  const s = await fresh();
  let count = 0;
  s.watchChanges((e) => {
    if (e.table === 'tools') count++;
  });

  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    await s.upsertTool(makeSpec({ name: `t-${i}` }), makeEmbedding(i + 1));
  }
  const elapsed = Date.now() - t0;
  await new Promise((r) => setImmediate(r));
  s.flushChanges();

  // Should complete fast — write queue is sync per row, hook is push-only.
  assert.ok(elapsed < 5000, `200 inserts should be under 5s, got ${elapsed}ms`);
  assert.equal(count, 200, `should see 200 tool events, got ${count}`);
  await s.close();
});

test('change events deliver after the writer transaction commits (no re-entry)', async () => {
  const s = await fresh();
  let listenerSawCount = -1;
  s.watchChanges(async (e) => {
    if (e.table === 'tools' && e.type === 'tool_changed') {
      // If the hook ran inside the write tx, this read would see 0 rows.
      // After commit, it sees the row that just landed.
      const tools = await s.listTools({});
      listenerSawCount = tools.length;
    }
  });

  await s.upsertTool(makeSpec({ name: 'unique' }), makeEmbedding(1));
  // Yield to setImmediate so drain runs
  await new Promise((r) => setImmediate(r));

  assert.equal(listenerSawCount, 1, 'listener must see committed row, not 0');
  await s.close();
});
