// Route-level test: /discover JSON shape includes tool_kind on every result,
// and the kind survives the full route -> service -> storage round trip.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { registerDiscoverRoute } from '../src/server/routes/discover.js';
import type { Embedder, ToolSpecV2 } from '../src/types.js';
import { hashKey } from '../src/server/auth.js';
import { LruEmbeddingCache } from '../src/embeddings/cache.js';

function makeUnitVec(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

class StubEmbedder implements Embedder {
  private cache = new LruEmbeddingCache(64);
  name() { return 'stub:tool-kind'; }
  dim() { return 768; }
  async embed(_t: string): Promise<Float32Array> { return makeUnitVec(1); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, i) => makeUnitVec(i + 1));
  }
  async prewarm(qs: string[]) { for (const q of qs) await this.cachedEmbed(q); }
  async cachedEmbed(q: string) {
    const hit = this.cache.get(q);
    if (hit) return { vec: hit.vec, cached: true, ms: 0 };
    const vec = makeUnitVec(2);
    this.cache.set(q, { vec, ms: 0, insertedAt: Date.now() });
    return { vec, cached: false, ms: 0 };
  }
}

const API_KEY = 'sk_test_key_kind';
let app: FastifyInstance;
let storage: SqliteStorage;
const embedder = new StubEmbedder();

const specs: ToolSpecV2[] = [
  {
    name: 'plain-tool', version: '1.0', author_agent_id: 'a',
    capability_text: 'a normal callable tool that does a thing',
    input_contract: { type: 'object' }, output_contract: { type: 'object' },
    output_repair_strategy: 'fail-fast', endpoint_stub_name: 'catalog-only-stub',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 100, reliability_score: 0.95 },
    status: 'active',
  },
  {
    name: 'office-hours-skill', version: '1.0', author_agent_id: 'a',
    capability_text: 'brainstorming new ideas validate something is worth building',
    input_contract: { type: 'object' }, output_contract: { type: 'object' },
    output_repair_strategy: 'fail-fast', endpoint_stub_name: 'catalog-only-stub',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.95 },
    status: 'active', tool_kind: 'skill',
  },
  {
    name: 'debugger-subagent', version: '1.0', author_agent_id: 'a',
    capability_text: 'debugging specialist for errors and unexpected behavior',
    input_contract: { type: 'object' }, output_contract: { type: 'object' },
    output_repair_strategy: 'fail-fast', endpoint_stub_name: 'catalog-only-stub',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.95 },
    status: 'active', tool_kind: 'subagent',
  },
  {
    name: 'commit-prompt', version: '1.0', author_agent_id: 'a',
    capability_text: 'conventional commit message from a diff',
    input_contract: { type: 'object' }, output_contract: { type: 'object' },
    output_repair_strategy: 'fail-fast', endpoint_stub_name: 'prompt-template-stub',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 1, reliability_score: 0.95 },
    status: 'active', tool_kind: 'prompt',
  },
];

before(async () => {
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
  await storage.upsertAgent({
    id: 'agent-test',
    name: 'test',
    api_key_hash: hashKey(API_KEY),
    role: 'caller',
    created_at: new Date().toISOString(),
  });
  for (let i = 0; i < specs.length; i++) {
    await storage.upsertTool(specs[i], makeUnitVec(i + 10));
  }
  app = Fastify({ logger: false });
  registerDiscoverRoute(app, storage, embedder);
  await app.ready();
});

after(async () => {
  await app.close();
  await storage.close();
});

test('GET /discover returns tool_kind on every result', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=anything&top=10',
    headers: { 'x-api-key': API_KEY },
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(Array.isArray(body.results));
  assert.ok(body.results.length > 0);
  for (const result of body.results) {
    assert.ok(
      ['tool', 'skill', 'subagent', 'prompt'].includes(result.tool_kind),
      `result missing valid tool_kind: ${JSON.stringify(result)}`,
    );
  }
});

test('GET /discover returns at least one of each kind across the corpus', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=anything&top=10',
    headers: { 'x-api-key': API_KEY },
  });
  const body = r.json();
  const kinds = new Set(body.results.map((x: { tool_kind: string }) => x.tool_kind));
  // top-K=10 against 4 inserted rows means we should see all of them
  assert.deepEqual(
    [...kinds].sort(),
    ['prompt', 'skill', 'subagent', 'tool'],
  );
});

test('plain-tool result still emits tool_kind="tool" (default backfill)', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=normal callable tool&top=10',
    headers: { 'x-api-key': API_KEY },
  });
  const body = r.json();
  const plain = body.results.find((x: { name: string }) => x.name === 'plain-tool');
  assert.ok(plain, 'plain-tool not in results');
  assert.equal(plain.tool_kind, 'tool');
});

test('GET /discover?kind=skill returns only skill rows', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=anything&top=10&kind=skill',
    headers: { 'x-api-key': API_KEY },
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.ok(body.results.length > 0, 'should return at least one skill');
  for (const result of body.results) {
    assert.equal(result.tool_kind, 'skill', `expected skill, got ${result.tool_kind}`);
  }
});

test('GET /discover?kind=prompt returns only prompt rows', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=anything&top=10&kind=prompt',
    headers: { 'x-api-key': API_KEY },
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  for (const result of body.results) {
    assert.equal(result.tool_kind, 'prompt');
  }
});

test('GET /discover?kind=BOGUS returns 400 bad_request', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=anything&kind=BOGUS',
    headers: { 'x-api-key': API_KEY },
  });
  assert.equal(r.statusCode, 400);
  const body = r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /tool\|skill\|subagent\|prompt/);
});
