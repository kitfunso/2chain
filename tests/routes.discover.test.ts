// Route-level integration test for /discover.
// Real SQLite + a stub Embedder returning canned vectors so we don't depend
// on Ollama in CI. Exercises the full Fastify route -> service -> storage
// path and asserts the JSON wire shape, not just types.
//
// Phase 1 plan Step 7 verify criterion (outside-voice issue #8).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { registerDiscoverRoute } from '../src/server/routes/discover.js';
import { registerPushRoute } from '../src/server/routes/push.js';
import { registerCallRoute } from '../src/server/routes/call.js';
import type { Embedder, ToolSpecV2 } from '../src/types.js';
import { hashKey } from '../src/server/auth.js';
import { LruEmbeddingCache } from '../src/embeddings/cache.js';
import '../src/services/stubs.js';

// ---- Deterministic stub embedder (no Ollama dependency) ----
function makeVec(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

class StubEmbedder implements Embedder {
  private cache = new LruEmbeddingCache(64);
  // Map specific text to seeds so similar queries route to similar tools.
  private seeds = new Map<string, number>([
    ['extract financial line items from a 10-K filing', 1],
    ['extract income statement from 10-K for DCF model', 1],
    ['fetch latest 10-K income statement for NVDA', 1],
    ['Extract tables from this financial report PDF', 1],
    ['search arxiv papers Mamba state space', 2],
    ['fetch arxiv state space papers', 2],
    ['lint javascript bugs', 3],
  ]);
  name() { return 'stub:fixed-vec'; }
  dim() { return 768; }
  async embed(text: string): Promise<Float32Array> {
    return makeVec(this.seeds.get(text) ?? hashTextToSeed(text));
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t, 'document')));
  }
  async prewarm(queries: string[]): Promise<void> {
    for (const q of queries) await this.cachedEmbed(q);
  }
  async cachedEmbed(query: string) {
    const hit = this.cache.get(query);
    if (hit) return { vec: hit.vec, cached: true, ms: 0 };
    const t0 = Date.now();
    const vec = await this.embed(query, 'query');
    this.cache.set(query, { vec, ms: Date.now() - t0, insertedAt: t0 });
    return { vec, cached: false, ms: Date.now() - t0 };
  }
}

function hashTextToSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h % 1000) + 100;
}

let app: FastifyInstance;
let storage: SqliteStorage;
const embedder = new StubEmbedder();
const API_KEY = 'sk_test_key_routes';

before(async () => {
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();

  // Seed an agent
  await storage.upsertAgent({
    id: 'agent-test',
    name: 'test-agent',
    api_key_hash: hashKey(API_KEY),
    role: 'caller',
    created_at: new Date().toISOString(),
  });

  // Seed tools
  const specs: Array<[string, ToolSpecV2]> = [
    ['extract financial line items from a 10-K filing', {
      name: 'sec-edgar-financials',
      version: '1.0',
      author_agent_id: 'agent-test',
      capability_text: 'Fetches the latest 10-K income statement from SEC EDGAR for any US ticker. Live data via data.sec.gov XBRL companyfacts API. DCF, equity research, financial statement extraction.',
      input_contract: { type: 'object', properties: { ticker: { type: 'string' } } },
      output_contract: { type: 'object', properties: { revenue: { type: 'number' } } },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'sec-edgar-financials-v1',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 1500, reliability_score: 1.0 },
      status: 'active',
      domain: 'finance',
    }],
    ['search arxiv papers Mamba state space', {
      name: 'arxiv-paper-search',
      version: '1.0',
      author_agent_id: 'agent-test',
      capability_text: 'Searches arxiv.org for academic papers. Live fetch from export.arxiv.org Atom feed.',
      input_contract: { type: 'object', properties: { query: { type: 'string' } } },
      output_contract: { type: 'object', properties: { papers: { type: 'array' } } },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'arxiv-paper-search-v1',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 1200, reliability_score: 1.0 },
      status: 'active',
      domain: 'research',
    }],
    ['lint javascript bugs', {
      name: 'code-review-mini',
      version: '1.0',
      author_agent_id: 'agent-test',
      capability_text: 'Lightweight JavaScript code reviewer. Spots common bugs, missing null checks, unhandled errors.',
      input_contract: { type: 'object', properties: { code: { type: 'string' } } },
      output_contract: { type: 'object', properties: { issues: { type: 'array' } } },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'code-review-mini-v1',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 800, reliability_score: 1.0 },
      status: 'active',
      domain: 'code',
    }],
  ];
  for (const [seedText, spec] of specs) {
    const v = await embedder.embed(seedText, 'document');
    await storage.upsertTool(spec, v);
  }

  app = Fastify({ logger: false });
  registerDiscoverRoute(app, storage, embedder);
  registerPushRoute(app, storage, embedder);
  registerCallRoute(app, storage);
  await app.ready();
});

after(async () => {
  await app.close();
  await storage.close();
});

test('GET /discover requires auth', async () => {
  const r = await app.inject({ method: 'GET', url: '/discover?q=foo' });
  assert.equal(r.statusCode, 401);
  const body = r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'auth_missing');
});

test('GET /discover with bad key returns 401', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=foo',
    headers: { 'x-api-key': 'sk_wrong' },
  });
  assert.equal(r.statusCode, 401);
});

test('GET /discover without ?q returns 400', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover',
    headers: { 'x-api-key': API_KEY },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error.code, 'bad_request');
});

test('GET /discover for finance query routes sec-edgar to top-1', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=' + encodeURIComponent('extract income statement from 10-K for DCF model'),
    headers: { 'x-api-key': API_KEY },
  });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'hybrid');
  assert.ok(Array.isArray(body.results), 'results must be an array');
  assert.ok(body.results.length > 0, 'should return at least one result');
  assert.equal(body.results[0].name, 'sec-edgar-financials',
    `expected sec-edgar-financials top-1, got ${body.results[0].name}`);

  // Wire-shape contract
  const r0 = body.results[0];
  for (const k of ['name', 'version', 'capability_text', 'endpoint_stub_name',
                   'reliability_score', 'vec_score', 'rank_score', 'rrf_score',
                   'cost_per_call_usd', 'p95_latency_ms']) {
    assert.ok(k in r0, `missing key: ${k}`);
  }

  // Meta shape
  for (const k of ['query', 'embed_ms', 'search_ms', 'total_ms',
                   'candidates_after_filter', 'embedder', 'storage']) {
    assert.ok(k in body.meta, `missing meta key: ${k}`);
  }
  assert.equal(body.meta.storage, 'sqlite');
});

test('GET /discover for arxiv query routes arxiv-paper-search to top-1', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/discover?q=' + encodeURIComponent('fetch arxiv state space papers'),
    headers: { 'x-api-key': API_KEY },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().results[0].name, 'arxiv-paper-search');
});

test('GET /discover persists ranking snapshot for the dashboard', async () => {
  const before = (await storage.dbStats()).collection_counts.rankings;
  await app.inject({
    method: 'GET',
    url: '/discover?q=' + encodeURIComponent('lint javascript bugs'),
    headers: { 'x-api-key': API_KEY },
  });
  const after = (await storage.dbStats()).collection_counts.rankings;
  assert.equal(after, before + 1, 'rankings table should grow by 1 per discover');
});
