// Storage layer tests for the tool_kind discriminator (migration 002).
// Real :memory: SQLite, no mocks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../src/storage/sqlite.js';
import type { ToolSpecV2 } from '../src/types.js';

let storage: SqliteStorage;

function makeUnitVec(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

function specOf(name: string, kind?: ToolSpecV2['tool_kind']): ToolSpecV2 {
  return {
    name,
    version: '1.0',
    author_agent_id: 'test',
    capability_text: `${name} capability text`,
    input_contract: { type: 'object' },
    output_contract: { type: 'object' },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: kind === 'prompt' ? 'prompt-template-stub' : 'catalog-only-stub',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.9 },
    status: 'active',
    tool_kind: kind,
  };
}

before(async () => {
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
});

after(async () => {
  await storage.close();
});

test('upsertTool defaults tool_kind to "tool" when omitted', async () => {
  const t = await storage.upsertTool(specOf('plain-tool'), makeUnitVec(1));
  assert.equal(t.tool_kind, 'tool');
});

test('upsertTool persists tool_kind=skill', async () => {
  const t = await storage.upsertTool(specOf('a-skill', 'skill'), makeUnitVec(2));
  assert.equal(t.tool_kind, 'skill');
});

test('upsertTool persists tool_kind=subagent', async () => {
  const t = await storage.upsertTool(specOf('a-subagent', 'subagent'), makeUnitVec(3));
  assert.equal(t.tool_kind, 'subagent');
});

test('upsertTool persists tool_kind=prompt', async () => {
  const t = await storage.upsertTool(specOf('a-prompt', 'prompt'), makeUnitVec(4));
  assert.equal(t.tool_kind, 'prompt');
});

test('listTools filters by kind', async () => {
  const onlySkills = await storage.listTools({ kind: 'skill' });
  assert.ok(onlySkills.every((t) => t.tool_kind === 'skill'));
  assert.ok(onlySkills.length >= 1);

  const onlyPlain = await storage.listTools({ kind: 'tool' });
  assert.ok(onlyPlain.every((t) => t.tool_kind === 'tool'));
  assert.ok(onlyPlain.length >= 1);

  const mixed = await storage.listTools({});
  // contains all four kinds
  const kinds = new Set(mixed.map((t) => t.tool_kind));
  assert.deepEqual(
    [...kinds].sort(),
    ['prompt', 'skill', 'subagent', 'tool'],
  );
});

test('runRRF returns tool_kind on every result', async () => {
  const rrf = await storage.runRRF({
    queryEmbedding: makeUnitVec(1),
    queryText: 'capability text',
    topK: 10,
    gate: 0,
    weights: { vector: 0.5, text: 0.5 },
  });
  assert.ok(rrf.length > 0);
  for (const r of rrf) {
    assert.ok(
      ['tool', 'skill', 'subagent', 'prompt'].includes(r.tool_kind),
      `tool_kind missing on result: ${JSON.stringify(r)}`,
    );
  }
});

test('CHECK constraint rejects an unknown tool_kind value', async () => {
  // Direct SQL bypasses TypeScript narrowing — confirm the DB-level check.
  const db = (storage as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO tools (id, namespace_id, name, version, author_agent_id, capability_text, capability_embedding, input_contract, output_contract, output_repair_strategy, endpoint_stub_name, metadata, status, tool_kind, created_at, updated_at)
           VALUES ('x','default','badkind','1.0','t','txt',x'00','{}','{}','fail-fast','catalog-only-stub','{}','active','BOGUS', '2026-01-01','2026-01-01')`,
        )
        .run(),
    /CHECK constraint failed/,
  );
});
