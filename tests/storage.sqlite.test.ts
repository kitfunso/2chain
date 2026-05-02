// Real-DB tests for SqliteStorage CRUD + dashboard reads.
// Phase 1 plan Step 4 verify criterion. Real :memory: SQLite, no mocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../src/storage/sqlite.js';
import type { ToolSpecV2 } from '../src/types.js';

function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 768; i++) v[i] /= norm;
  return v;
}

function makeSpec(over: Partial<ToolSpecV2> = {}): ToolSpecV2 {
  return {
    name: 'tool-x',
    version: '1.0',
    author_agent_id: 'test-author',
    capability_text: 'extract financial line items from a 10-K filing',
    input_contract: { type: 'object', properties: { ticker: { type: 'string' } } },
    output_contract: { type: 'object', properties: { revenue: { type: 'number' } } },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'sec-edgar-financials-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 1500, reliability_score: 1.0 },
    status: 'active',
    domain: 'finance',
    ...over,
  };
}

async function freshStorage(): Promise<SqliteStorage> {
  const s = new SqliteStorage({ path: ':memory:' });
  await s.init();
  return s;
}

test('init runs migrations idempotently', async () => {
  const s = await freshStorage();
  await s.init(); // second call should be a no-op (migration tracker)
  const stats = await s.dbStats();
  assert.equal(stats.driver, 'sqlite');
  assert.ok(stats.version.includes('sqlite-vec'));
  assert.equal(stats.collection_counts.tools, 0);
  await s.close();
});

test('upsertTool inserts a new tool and returns full record', async () => {
  const s = await freshStorage();
  const spec = makeSpec();
  const tool = await s.upsertTool(spec, makeEmbedding(1));
  assert.equal(tool.name, 'tool-x');
  assert.equal(tool.version, '1.0');
  assert.equal(tool.namespace_id, 'default');
  assert.equal(tool.status, 'active');
  assert.equal(tool.metadata.reliability_score, 1.0);
  assert.ok(tool.id.length > 0);
  await s.close();
});

test('upsertTool with same namespace+name+version updates in place', async () => {
  const s = await freshStorage();
  await s.upsertTool(makeSpec({ capability_text: 'first' }), makeEmbedding(1));
  await s.upsertTool(makeSpec({ capability_text: 'second' }), makeEmbedding(2));
  const tools = await s.listTools({});
  assert.equal(tools.length, 1, 'should be 1 row, upsert not duplicate');
  assert.equal(tools[0].capability_text, 'second');
  await s.close();
});

test('upsertTool in different namespaces creates separate rows', async () => {
  const s = await freshStorage();
  await s.upsertTool(makeSpec(), makeEmbedding(1), 'default');
  await s.upsertTool(makeSpec(), makeEmbedding(2), 'tenant-a');
  assert.equal((await s.listTools({ namespace: 'default' })).length, 1);
  assert.equal((await s.listTools({ namespace: 'tenant-a' })).length, 1);
  await s.close();
});

test('getToolByNameVersion returns null for missing, record for present', async () => {
  const s = await freshStorage();
  assert.equal(await s.getToolByNameVersion('missing', '1.0'), null);
  await s.upsertTool(makeSpec(), makeEmbedding(1));
  const got = await s.getToolByNameVersion('tool-x', '1.0');
  assert.ok(got);
  assert.equal(got!.name, 'tool-x');
  await s.close();
});

test('setStatus changes status and updated_at', async () => {
  const s = await freshStorage();
  const t = await s.upsertTool(makeSpec(), makeEmbedding(1));
  const beforeUpdated = t.updated_at;
  // Briefly wait so updated_at can change at ms resolution
  await new Promise((r) => setTimeout(r, 5));
  await s.setStatus(t.id, 'circuit_broken');
  const refetched = await s.getToolByNameVersion('tool-x', '1.0');
  assert.equal(refetched!.status, 'circuit_broken');
  assert.notEqual(refetched!.updated_at, beforeUpdated);
  await s.close();
});

test('listTools filters by status', async () => {
  const s = await freshStorage();
  await s.upsertTool(makeSpec({ name: 'a', status: 'active' }), makeEmbedding(1));
  await s.upsertTool(makeSpec({ name: 'b', status: 'pending' }), makeEmbedding(2));
  await s.upsertTool(makeSpec({ name: 'c', status: 'circuit_broken' }), makeEmbedding(3));
  assert.equal((await s.listTools({ status: 'active' })).length, 1);
  assert.equal((await s.listTools({ status: 'pending' })).length, 1);
  assert.equal((await s.listTools({ status: 'circuit_broken' })).length, 1);
  assert.equal((await s.listTools({})).length, 3);
  await s.close();
});

test('insertViolation + listViolations roundtrip', async () => {
  const s = await freshStorage();
  const t = await s.upsertTool(makeSpec(), makeEmbedding(1));
  await s.insertViolation({
    tool_id: t.id,
    tool_name: t.name,
    tool_version: t.version,
    namespace_id: 'default',
    agent_id: 'agent-1',
    call_id: 'call-1',
    attempt: 1,
    stage: 'output',
    raw_response: 'malformed prose',
    schema_errors: [{ path: '/root', message: 'must be object' }],
    repaired: false,
    occurred_at: new Date().toISOString(),
  });
  const list = await s.listViolations(10);
  assert.equal(list.length, 1);
  assert.equal(list[0].stage, 'output');
  assert.equal(list[0].schema_errors[0].message, 'must be object');
  await s.close();
});

test('insertUsage + usageOutcomeCounts aggregates correctly', async () => {
  const s = await freshStorage();
  const t = await s.upsertTool(makeSpec(), makeEmbedding(1));
  for (const outcome of ['ok', 'ok', 'ok', 'circuit_broken', 'violation'] as const) {
    await s.insertUsage({
      tool_id: t.id,
      agent_id: 'a',
      namespace_id: 'default',
      call_id: `c-${Math.random()}`,
      outcome,
      latency_ms: 100,
      occurred_at: new Date().toISOString(),
    });
  }
  const counts = await s.usageOutcomeCounts(100);
  assert.equal(counts.ok, 3);
  assert.equal(counts.circuit_broken, 1);
  assert.equal(counts.violation, 1);
  assert.equal(counts.gated, 0);
  await s.close();
});

test('insertEvalRun + listEvalRuns roundtrip', async () => {
  const s = await freshStorage();
  const t = await s.upsertTool(makeSpec(), makeEmbedding(1));
  await s.insertEvalRun({
    tool_id: t.id,
    tool_name: t.name,
    tool_version: t.version,
    namespace_id: 'default',
    triggered_at: new Date().toISOString(),
    triggered_by: 'manual',
    cases: [{ case_id: 'a', pass: true, latency_ms: 10, cost_usd: 0 }],
    pass_count: 1,
    total_count: 1,
    pass_rate: 1.0,
    duration_ms: 10,
  });
  const runs = await s.listEvalRuns(10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cases.length, 1);
  assert.equal(runs[0].cases[0].case_id, 'a');
  await s.close();
});

test('insertRanking persists snapshots for the dashboard', async () => {
  const s = await freshStorage();
  await s.insertRanking({
    query_capability_text: 'extract DCF',
    mode: 'hybrid',
    namespace_id: 'default',
    results: [{ name: 'sec-edgar-financials', score: 1.16 }],
    occurred_at: new Date().toISOString(),
  });
  const stats = await s.dbStats();
  assert.equal(stats.collection_counts.rankings, 1);
  await s.close();
});

test('dbStats reports collection counts and version string', async () => {
  const s = await freshStorage();
  await s.upsertTool(makeSpec({ name: 'a' }), makeEmbedding(1));
  await s.upsertTool(makeSpec({ name: 'b' }), makeEmbedding(2));
  const stats = await s.dbStats();
  assert.equal(stats.collection_counts.tools, 2);
  assert.equal(stats.collection_counts.eval_runs, 0);
  assert.equal(stats.indexes_ready.tools_vec, 'ready');
  await s.close();
});

test('runRRF throws not_implemented (lands in Step 6)', async () => {
  const s = await freshStorage();
  await assert.rejects(
    () =>
      s.runRRF({
        queryEmbedding: makeEmbedding(1),
        queryText: 'test',
        topK: 5,
        gate: 0.8,
        weights: { vector: 0.7, text: 0.3 },
      }),
    /Step 6/,
  );
  await s.close();
});
