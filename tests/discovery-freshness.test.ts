// E5 discovery-freshness tests (plan §5). Real SQLite (:memory:), stub
// embedder with CRAFTED vectors — NO mocks (CLAUDE.md rule 5), no Ollama.
//
// Vec ranks are constructed, not hoped for: every tool's embedding is
// mixVec(queryVec, offAxis, eps) and cosine distance is strictly monotonic
// in eps (proof: f(eps)^2 = (1+eps*c)^2/(1+2*eps*c+eps^2) has derivative
// proportional to eps*(c^2-1) <= 0), so eps order IS vec-rank order.
// Capability texts share no terms with the query, so the FTS arm is empty
// and every candidate is single-arm vec — RRF gaps are exactly the
// adjacent-rank gaps the W_FRESHNESS_RRF calibration is stated against.
//
// Backdating goes through recordEvalOutcome (interface-level, no raw SQL).
// It patches reliability_score AND last_eval_run together — always pass a
// score >= 0.80 or the tool falls below the SQL reliability gate and the
// perturbation test degenerates to a gating test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { registerDiscoverRoute } from '../src/server/routes/discover.js';
import { discover } from '../src/services/discover.js';
import { verificationStreak } from '../src/services/streak.js';
// Side-effect-free formatter module — NEVER import bin/2chain-mcp.mjs here:
// the shim connects the stdio transport at module top level and hangs the
// test runner.
// eslint-disable-next-line import/no-relative-packages
// @ts-ignore — plain .mjs module, outside tsconfig's src include
import { formatDiscoverTools } from '../bin/mcp-format.mjs';
import { hashKey } from '../src/server/auth.js';
import type { Embedder, EvalRunRow, ToolSpecV2 } from '../src/types.js';
import { RELIABILITY_GATE } from '../src/types.js';

// ---- Crafted-vector stub embedder ----------------------------------------

function makeUnitVec(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

function hashTextToSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h % 1000) + 100;
}

/** normalize(a + eps*b): cosine distance to `a` strictly increases with eps. */
function mixVec(a: Float32Array, b: Float32Array, eps: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = a[i] + eps * b[i];
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

const QUERY = 'zorgle blint maximizer';
const QUERY_VEC = makeUnitVec(7);
const OFF_AXIS = makeUnitVec(99);

class StubEmbedder implements Embedder {
  private vecs = new Map<string, Float32Array>([[QUERY, QUERY_VEC]]);
  name() { return 'stub:fixed-vec'; }
  dim() { return 768; }
  async embed(text: string): Promise<Float32Array> {
    return this.vecs.get(text) ?? makeUnitVec(hashTextToSeed(text));
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  async prewarm(): Promise<void> {}
  async cachedEmbed(query: string) {
    return { vec: await this.embed(query), cached: false, ms: 0 };
  }
}

const embedder = new StubEmbedder();
const API_KEY = 'sk_test_key_freshness';

// ---- Harness helpers (pattern from tests/routes.discover.test.ts) --------

async function freshStorage(): Promise<SqliteStorage> {
  const storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
  await storage.upsertAgent({
    id: 'agent-test',
    name: 'test-agent',
    api_key_hash: hashKey(API_KEY),
    role: 'caller',
    created_at: new Date().toISOString(),
  });
  return storage;
}

async function buildApp(storage: SqliteStorage): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerDiscoverRoute(app, storage, embedder);
  await app.ready();
  return app;
}

// Capability texts share NO terms with QUERY — the FTS arm stays empty and
// every candidate is single-arm vec (adjacent-rank gaps as calibrated).
const spec = (name: string): ToolSpecV2 => ({
  name,
  version: '1.0',
  author_agent_id: 'agent-test',
  capability_text: `Processes alpha widgets for the quux pipeline, variant ${name}.`,
  input_contract: { type: 'object', additionalProperties: true },
  output_contract: { type: 'object', additionalProperties: true },
  output_repair_strategy: 'fail-fast',
  endpoint_stub_name: 'catalog-only-stub',
  metadata: { cost_per_call_usd: 0, p95_latency_ms: 100, reliability_score: 0.95 },
  status: 'active',
});

const daysAgoIso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const evalRun = (
  toolId: string,
  toolName: string,
  passRate: number,
  triggeredBy: EvalRunRow['triggered_by'],
  triggeredAt: string,
): EvalRunRow => ({
  tool_id: toolId,
  tool_name: toolName,
  tool_version: '1.0',
  namespace_id: 'default',
  triggered_at: triggeredAt,
  triggered_by: triggeredBy,
  cases: [],
  pass_count: Math.round(passRate * 4),
  total_count: 4,
  pass_rate: passRate,
  duration_ms: 10,
});

// ---- 1. Acceptance: adjacent-rank perturbation (route-level) -------------

test('fresh tool at vec rank 2 overtakes near-tied stale tool at rank 1; both stay present', async () => {
  const storage = await freshStorage();
  try {
    const stale = await storage.upsertTool(spec('stale-near-tie'), QUERY_VEC);
    const fresh = await storage.upsertTool(
      spec('fresh-near-tie'),
      mixVec(QUERY_VEC, OFF_AXIS, 0.05),
    );
    // Backdate the better-matched tool 90 days; freshen the runner-up.
    // score 0.95 >= 0.80 keeps both above the SQL gate (recordEvalOutcome
    // patches reliability_score too — below the gate this degenerates).
    await storage.recordEvalOutcome(stale.id, 0.95, daysAgoIso(90));
    await storage.recordEvalOutcome(fresh.id, 0.95, daysAgoIso(0));

    const app = await buildApp(storage);
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/discover?q=' + encodeURIComponent(QUERY) + '&top=5',
        headers: { 'x-api-key': API_KEY },
      });
      assert.equal(r.statusCode, 200);
      const body = r.json();
      assert.equal(body.results.length, 2, 'freshness must never gate — both tools returned');
      assert.equal(body.results[0].name, 'fresh-near-tie',
        'full freshness delta (~5e-4) must cover the rank-1→2 RRF gap (~1.3e-4)');
      assert.equal(body.results[1].name, 'stale-near-tie');
      // rank_score keeps its pre-E5 definition; final_score is the ordering key.
      assert.ok(body.results[0].final_score > body.results[1].final_score);
    } finally {
      await app.close();
    }
  } finally {
    await storage.close();
  }
});

// ---- 2. Dominance counter-test --------------------------------------------

test('stale tool with a clear retrieval margin stays first — freshness never leapfrogs a better match', async () => {
  const storage = await freshStorage();
  try {
    const stale = await storage.upsertTool(spec('stale-dominant'), QUERY_VEC);
    // Six mid tools fill vec ranks 2-7; the fresh competitor lands at rank 8,
    // where the cumulative RRF gap to rank 1 (~8.4e-4) exceeds the full
    // freshness term (5e-4) — calibration pinned.
    for (let i = 0; i < 6; i++) {
      await storage.upsertTool(
        spec(`mid-${i}`),
        mixVec(QUERY_VEC, OFF_AXIS, 0.02 * (i + 1)),
      );
    }
    const fresh = await storage.upsertTool(
      spec('fresh-distant'),
      mixVec(QUERY_VEC, OFF_AXIS, 0.16),
    );
    await storage.recordEvalOutcome(stale.id, 0.95, daysAgoIso(90));
    await storage.recordEvalOutcome(fresh.id, 0.95, daysAgoIso(0));

    const { results } = await discover(storage, embedder, QUERY, 10);
    assert.equal(results.length, 8);
    assert.equal(results[0].name, 'stale-dominant',
      'rank-8 fresh tool must not leapfrog a meaningfully better-matched stale tool');
  } finally {
    await storage.close();
  }
});

// ---- 3. NaN guard ----------------------------------------------------------

test('missing or unparseable last_eval_run yields freshness 0 and a total, finite ordering', async () => {
  const storage = await freshStorage();
  try {
    await storage.upsertTool(spec('never-evaluated'), QUERY_VEC);
    const garbled = await storage.upsertTool(
      spec('garbled-timestamp'),
      mixVec(QUERY_VEC, OFF_AXIS, 0.05),
    );
    const fresh = await storage.upsertTool(
      spec('fresh-control'),
      mixVec(QUERY_VEC, OFF_AXIS, 0.1),
    );
    await storage.recordEvalOutcome(garbled.id, 0.95, 'not-a-timestamp');
    await storage.recordEvalOutcome(fresh.id, 0.95, daysAgoIso(0));

    const { results } = await discover(storage, embedder, QUERY, 5);
    assert.equal(results.length, 3, 'rank order total — nothing dropped');
    for (const r of results) {
      assert.ok(Number.isFinite(r.final_score), `final_score not finite for ${r.name}`);
      assert.ok(Number.isFinite(r.freshness), `freshness not finite for ${r.name}`);
    }
    const byName = new Map(results.map((r) => [r.name, r]));
    assert.equal(byName.get('never-evaluated')!.freshness, 0);
    assert.equal(byName.get('never-evaluated')!.last_verified_at, null);
    assert.equal(byName.get('garbled-timestamp')!.freshness, 0);
  } finally {
    await storage.close();
  }
});

// ---- 4. Uniform freshness ⇒ order-invariance -------------------------------

test('uniform freshness leaves the order identical to rrf_score order', async () => {
  const storage = await freshStorage();
  try {
    const nowIso = daysAgoIso(0);
    const expectedOrder: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = `uniform-${i}`;
      expectedOrder.push(name);
      const tool = await storage.upsertTool(
        spec(name),
        mixVec(QUERY_VEC, OFF_AXIS, 0.02 * i),
      );
      await storage.recordEvalOutcome(tool.id, 0.95, nowIso);
    }
    const { results } = await discover(storage, embedder, QUERY, 5);
    assert.deepEqual(
      results.map((r) => r.name),
      expectedOrder,
      'an additive constant must shift every score equally (plain stable sort, no secondary key)',
    );
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].rrf_score >= results[i].rrf_score,
        'returned order must match rrf_score order exactly under uniform freshness');
    }
  } finally {
    await storage.close();
  }
});

// ---- 5. Payload + streak semantics on the discover route -------------------

test('payload carries last_verified_at, verification_streak, freshness; clean-fail-clean streak = 1', async () => {
  const storage = await freshStorage();
  try {
    const tool = await storage.upsertTool(spec('streaky-tool'), QUERY_VEC);
    const verifiedAt = daysAgoIso(0);
    await storage.recordEvalOutcome(tool.id, 0.95, verifiedAt);
    // newest-first window: clean (1d) → streak counts; fail (2d) → breaks;
    // clean (3d) → unreached. clean-fail-clean ⇒ 1.
    await storage.insertEvalRun(evalRun(tool.id, 'streaky-tool', 1.0, 'reverify', daysAgoIso(3)));
    await storage.insertEvalRun(evalRun(tool.id, 'streaky-tool', 0.5, 'reverify', daysAgoIso(2)));
    await storage.insertEvalRun(evalRun(tool.id, 'streaky-tool', 1.0, 'reverify', daysAgoIso(1)));

    const app = await buildApp(storage);
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/discover?q=' + encodeURIComponent(QUERY),
        headers: { 'x-api-key': API_KEY },
      });
      assert.equal(r.statusCode, 200);
      const r0 = r.json().results[0];
      assert.equal(r0.name, 'streaky-tool');
      for (const k of ['last_verified_at', 'verification_streak', 'freshness', 'final_score']) {
        assert.ok(k in r0, `missing payload key: ${k}`);
      }
      assert.equal(r0.last_verified_at, verifiedAt);
      assert.equal(r0.verification_streak, 1, 'clean-fail-clean ⇒ 1');
      assert.equal(typeof r0.freshness, 'number');
      assert.equal(typeof r0.final_score, 'number');
    } finally {
      await app.close();
    }
  } finally {
    await storage.close();
  }
});

// ---- 6. MCP formatter (exported, side-effect-free) -------------------------

test('formatDiscoverTools renders final_score + freshness under refreshed (non-Atlas) headers', () => {
  const text = formatDiscoverTools({
    query: QUERY,
    mode: 'hybrid',
    wallMs: 12,
    meta: { embed_ms: 9, search_ms: 3 },
    results: [{
      name: 'fresh-near-tie',
      version: '1.0',
      capability_text: 'Processes alpha widgets.',
      reliability_score: 0.95,
      rrf_score: 0.00806,
      final_score: 0.00857,
      freshness: 0.98,
      last_verified_at: daysAgoIso(0),
      verification_streak: 3,
    }],
  });
  assert.match(text, /final\s+fresh/, 'table header must show the final_score and freshness columns');
  assert.ok(text.includes('0.00857'), 'final_score (the actual ordering key) must render');
  assert.ok(text.includes('0.98'), 'freshness column must render');
  assert.ok(text.includes('SQLite RRF: vector 0.5 + text 0.5'), 'hybrid header must name the real stack');
  assert.ok(text.includes('Ollama nomic-embed-text, 768-dim'), 'embed header must name the real embedder');
  assert.ok(!text.includes('Atlas'), 'stale v1 Atlas copy must be gone');
  assert.ok(!text.includes('Voyage'), 'stale v1 Voyage copy must be gone');
  assert.ok(!text.includes('MongoDB'), 'stale v1 MongoDB copy must be gone');
});

test('formatDiscoverTools is unknown/empty safe', () => {
  const empty = formatDiscoverTools({});
  assert.ok(empty.includes('(no candidates passed the gates)'));
  // Pre-E5 server shape: no final_score/freshness — falls back to rrf_score
  // (rank_score would look mis-sorted post-E5) and renders without throwing.
  const sparse = formatDiscoverTools({
    query: 'q',
    results: [{ name: 'old-server-tool', version: '1.0', rrf_score: 0.0081 }],
  });
  assert.ok(sparse.includes('old-server-tool'));
  assert.ok(sparse.includes('0.00810'), 'falls back to rrf_score when final_score is absent');
  const degenerate = formatDiscoverTools({ results: [{}] });
  assert.ok(degenerate.includes('?'), 'fully unknown result rows render placeholders');
});

// ---- 7. Structural top-K bound ---------------------------------------------

test('top=5 over a 30-tool corpus returns exactly 5 results, each carrying the freshness fields', async () => {
  const storage = await freshStorage();
  try {
    for (let i = 0; i < 30; i++) {
      await storage.upsertTool(
        spec(`corpus-${String(i).padStart(2, '0')}`),
        mixVec(QUERY_VEC, OFF_AXIS, 0.01 * i),
      );
    }
    const { results } = await discover(storage, embedder, QUERY, 5);
    assert.equal(results.length, 5, 'streak/freshness are computed for the returned top-K only');
    for (const r of results) {
      assert.equal(typeof r.freshness, 'number');
      assert.equal(typeof r.verification_streak, 'number');
      assert.ok('last_verified_at' in r);
      assert.ok(Number.isFinite(r.final_score));
    }
  } finally {
    await storage.close();
  }
});

// ---- 8. Backdating determinism: freshness in bands -------------------------

test('freshness decays on the 7-day half-life: bands at 0d/7d/14d', async () => {
  const storage = await freshStorage();
  try {
    const tFresh = await storage.upsertTool(spec('band-fresh'), QUERY_VEC);
    const tHalf = await storage.upsertTool(
      spec('band-half'), mixVec(QUERY_VEC, OFF_AXIS, 0.05));
    const tQuarter = await storage.upsertTool(
      spec('band-quarter'), mixVec(QUERY_VEC, OFF_AXIS, 0.1));
    await storage.recordEvalOutcome(tFresh.id, 0.95, daysAgoIso(0));
    await storage.recordEvalOutcome(tHalf.id, 0.95, daysAgoIso(7));
    await storage.recordEvalOutcome(tQuarter.id, 0.95, daysAgoIso(14));

    const { results } = await discover(storage, embedder, QUERY, 5);
    const byName = new Map(results.map((r) => [r.name, r]));
    // BANDS, not exact floats — the term uses request-time now, so the test's
    // ISO stamps are milliseconds older by the time discover computes age.
    const f0 = byName.get('band-fresh')!.freshness;
    assert.ok(f0 > 0.99 && f0 <= 1.0, `0-day freshness ~1, got ${f0}`);
    const f7 = byName.get('band-half')!.freshness;
    assert.ok(f7 > 0.49 && f7 < 0.51, `7-day freshness ~0.5, got ${f7}`);
    const f14 = byName.get('band-quarter')!.freshness;
    assert.ok(f14 > 0.24 && f14 < 0.26, `14-day freshness ~0.25, got ${f14}`);
  } finally {
    await storage.close();
  }
});

// ---- 10. Streak helper unit matrix (pure — no storage) ----------------------
// (Item 9, the NDCG suite, is tests/v2-eval-ndcg.test.ts — untouched by E5
// and asserted green by the full-suite run.)

test('verificationStreak unit matrix', () => {
  const r = (passRate: number, by: EvalRunRow['triggered_by'], d: number) =>
    evalRun('tool-x', 'tool-x', passRate, by, daysAgoIso(d));

  // 3-clean ⇒ 3
  assert.equal(
    verificationStreak([r(1, 'reverify', 1), r(1, 'reverify', 2), r(0.9, 'reverify', 3)], RELIABILITY_GATE),
    3,
  );
  // clean-fail-clean ⇒ 1
  assert.equal(
    verificationStreak([r(1, 'reverify', 1), r(0.5, 'reverify', 2), r(1, 'reverify', 3)], RELIABILITY_GATE),
    1,
  );
  // interleaved manual runs are skipped, never streak-breaking (the storage
  // query pre-filters via triggeredBy; the helper's skip is defence in depth)
  assert.equal(
    verificationStreak(
      [r(1, 'reverify', 1), r(0, 'manual', 2), r(1, 'reverify', 3), r(0, 'push', 4), r(1, 'reverify', 5)],
      RELIABILITY_GATE,
    ),
    3,
  );
  // empty ⇒ 0
  assert.equal(verificationStreak([], RELIABILITY_GATE), 0);
  // sub-gate newest ⇒ 0
  assert.equal(verificationStreak([r(0.5, 'reverify', 1), r(1, 'reverify', 2)], RELIABILITY_GATE), 0);
});

// ---- Future-date clamp (code-review MED) + snapshot order ------------------

test('future-dated last_eval_run clamps to freshness 1 (never leapfrogs via clock skew)', async () => {
  const storage = await freshStorage();
  try {
    const tool = await storage.upsertTool(spec('time-traveler'), QUERY_VEC);
    // +30 days: unclamped this would be freshness ~19.5 - a term larger
    // than one full RRF arm contribution (the leapfrog invariant breaks).
    await storage.recordEvalOutcome(
      tool.id,
      0.95,
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
    );
    const { results } = await discover(storage, embedder, QUERY, 5);
    const r = results.find((x) => x.name === 'time-traveler');
    assert.ok(r);
    assert.ok(r.freshness <= 1 + 1e-9, `freshness must clamp to 1, got ${r.freshness}`);
    assert.ok(Number.isFinite(r.final_score));
  } finally {
    await storage.close();
  }
});

test('rankings snapshot records the re-sorted order agents actually saw', async () => {
  const storage = await freshStorage();
  try {
    // Same construction as the acceptance test: stale tool at the better
    // vec rank, fresh runner-up adjacent - fresh overtakes in the RETURNED
    // order, and the trending snapshot must record that same order.
    const stale = await storage.upsertTool(spec('snap-stale'), QUERY_VEC);
    const fresh = await storage.upsertTool(spec('snap-fresh'), mixVec(QUERY_VEC, OFF_AXIS, 0.05));
    await storage.recordEvalOutcome(stale.id, 0.95, daysAgoIso(90));
    await storage.recordEvalOutcome(fresh.id, 0.95, daysAgoIso(0));

    const { results } = await discover(storage, embedder, QUERY, 5);
    const returnedOrder = results.map((r) => r.name);
    assert.equal(returnedOrder[0], 'snap-fresh');

    // rankings stores a JSON top-K snapshot per query (001_init.sql), not
    // per-tool rows - parse the newest snapshot's results blob.
    const row = (storage as unknown as {
      db: { prepare: (s: string) => { get: () => { results: string } } };
    }).db
      .prepare(`SELECT results FROM rankings ORDER BY occurred_at DESC LIMIT 1`)
      .get();
    const snapshot = JSON.parse(row.results) as Array<{ name: string }>;
    assert.deepEqual(
      snapshot.map((s) => s.name),
      returnedOrder,
      'trending must aggregate the post-re-sort order',
    );
  } finally {
    await storage.close();
  }
});
