import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { push, type PushInput } from '../src/services/push.js';
import { isSweepInFlight, reverifyTools } from '../src/services/reverify.js';
import { discover } from '../src/services/discover.js';
import { registerReverifyRoute } from '../src/server/routes/reverify.js';
import { hashKey } from '../src/server/auth.js';
import type { Embedder, EvalRunRow, ToolSpecV2 } from '../src/types.js';
import '../src/services/stubs.js';

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

const ROT_CAPABILITY = 'Extracts financial tables from PDF reports into labelled numeric rows.';
const ROT_QUERY = 'extract financial tables from a pdf report';

class StubEmbedder implements Embedder {
  private seeds = new Map<string, number>([
    [ROT_CAPABILITY, 7],
    [ROT_QUERY, 7],
  ]);
  name() { return 'stub:fixed-vec'; }
  dim() { return 768; }
  async embed(text: string): Promise<Float32Array> {
    return makeUnitVec(this.seeds.get(text) ?? hashTextToSeed(text));
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

async function freshStorage(): Promise<SqliteStorage> {
  const storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
  return storage;
}

function rawDb(storage: SqliteStorage): { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } {
  return (storage as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
}

const baseInput = (overrides: Partial<PushInput>): PushInput => ({
  name: 'unset',
  version: '1.0',
  capability_text: 'a capability for testing reverify',
  input_contract: { type: 'object', additionalProperties: true },
  output_contract: { type: 'object', additionalProperties: true },
  output_repair_strategy: 'fail-fast',
  endpoint_stub_name: 'pdf-extractor-v3',
  metadata: { cost_per_call_usd: 0, p95_latency_ms: 100 },
  ...overrides,
});

async function pushOk(storage: SqliteStorage, overrides: Partial<PushInput>) {
  const r = await push(storage, embedder, 'agent-author', baseInput(overrides));
  assert.equal(r.ok, true, `push failed: ${JSON.stringify(r)}`);
  if (!r.ok) throw new Error('unreachable');
  return r;
}

async function evalRunsFor(storage: SqliteStorage, toolName: string): Promise<EvalRunRow[]> {
  const runs = await storage.listEvalRuns(500);
  return runs.filter((r) => r.tool_name === toolName);
}

const directSpec = (overrides: Partial<ToolSpecV2>): ToolSpecV2 => ({
  name: 'unset',
  version: '1.0',
  author_agent_id: 'agent-author',
  capability_text: 'a directly-seeded catalog entry',
  input_contract: { type: 'object', additionalProperties: true },
  output_contract: { type: 'object', additionalProperties: true },
  output_repair_strategy: 'fail-fast',
  endpoint_stub_name: 'catalog-only-stub',
  metadata: { cost_per_call_usd: 0, p95_latency_ms: 100, reliability_score: 0.95 },
  status: 'active',
  ...overrides,
});

test('happy path: reverify re-runs the suite, records triggered_by=reverify, score stays >= gate', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'pdf-extractor', version: '3.0' });
    assert.equal(pushed.reliability_score, 1.0);

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 1);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.gate_dropped, []);

    const runs = await evalRunsFor(storage, 'pdf-extractor');
    assert.equal(runs.length, 2, 'push run + reverify run');
    const reverifyRuns = runs.filter((r) => r.triggered_by === 'reverify');
    assert.equal(reverifyRuns.length, 1);
    assert.equal(reverifyRuns[0].pass_rate, 1.0);
    assert.ok(reverifyRuns[0].total_count > 0);

    const tool = await storage.getToolByNameVersion('pdf-extractor', '3.0');
    assert.equal(tool!.metadata.reliability_score, 1.0);
    assert.equal(tool!.status, 'active');
  } finally {
    await storage.close();
  }
});

test('rot + restore under the blend: gate-drop is a blend crossing; K=4 clean sweeps re-cross the gate', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'rot-target', version: '1.0', capability_text: ROT_CAPABILITY });

    const before = await discover(storage, embedder, ROT_QUERY, 5);
    assert.ok(
      before.results.some((r) => r.name === 'rot-target'),
      'healthy tool must be discoverable before rot',
    );

    rawDb(storage)
      .prepare(`UPDATE tools SET endpoint_stub_name = ? WHERE name = ? AND version = ?`)
      .run('rotten-pdf-v1', 'rot-target', '1.0');

    const rotted = await storage.getToolByNameVersion('rot-target', '1.0');
    assert.equal(rotted!.status, 'active', 'status must still be active after re-point');
    assert.equal(rotted!.endpoint_stub_name, 'rotten-pdf-v1');
    assert.equal(rotted!.metadata.reliability_score, 1.0, 'score untouched until reverify runs');

    const rotSummary = await reverifyTools(storage);
    assert.equal(rotSummary.executed, 1);
    assert.equal(rotSummary.failed, 1);
    assert.deepEqual(rotSummary.gate_dropped, ['rot-target@1.0']);

    const afterRot = await storage.getToolByNameVersion('rot-target', '1.0');
    assert.ok(
      Math.abs(afterRot!.metadata.reliability_score - 0.5) < 1e-3,
      `rot blend should be ≈0.5, got ${afterRot!.metadata.reliability_score}`,
    );
    assert.equal(afterRot!.status, 'active', 'reverify never flips active status (D34)');

    const rotRuns = (await evalRunsFor(storage, 'rot-target')).filter((r) => r.triggered_by === 'reverify');
    assert.equal(rotRuns.length, 1);
    assert.equal(rotRuns[0].pass_count, 0);
    assert.ok(rotRuns[0].total_count > 0);
    assert.ok(
      rotRuns[0].cases.every((c) => !c.pass && typeof c.error === 'string' && c.error.length > 0),
      'eval_runs row must record the per-case failures',
    );

    const during = await discover(storage, embedder, ROT_QUERY, 5);
    assert.ok(
      !during.results.some((r) => r.name === 'rot-target'),
      'gate-dropped tool must be absent from discover',
    );

    const dayMs = 86_400_000;
    rawDb(storage)
      .prepare(`UPDATE eval_runs SET triggered_at = ? WHERE tool_name = 'rot-target' AND triggered_by = 'push'`)
      .run(new Date(Date.now() - 28 * dayMs).toISOString());
    rawDb(storage)
      .prepare(`UPDATE eval_runs SET triggered_at = ? WHERE tool_name = 'rot-target' AND triggered_by = 'reverify'`)
      .run(new Date(Date.now() - 1 * dayMs).toISOString());

    rawDb(storage)
      .prepare(`UPDATE tools SET endpoint_stub_name = ? WHERE name = ? AND version = ?`)
      .run('pdf-extractor-v3', 'rot-target', '1.0');

    for (let k = 1; k <= 3; k++) {
      const s = await reverifyTools(storage);
      assert.equal(s.passed, 1, `clean sweep ${k}: raw run passes`);
      assert.deepEqual(s.gate_dropped, [], `clean sweep ${k}: prev score already below gate — no crossing`);
    }
    const afterThree = await storage.getToolByNameVersion('rot-target', '1.0');
    assert.ok(
      afterThree!.metadata.reliability_score < 0.80,
      `3 cleans must still be below the gate, got ${afterThree!.metadata.reliability_score}`,
    );
    assert.ok(
      Math.abs(afterThree!.metadata.reliability_score - 0.7718) < 2e-3,
      `3-clean blend ≈ 0.7718, got ${afterThree!.metadata.reliability_score}`,
    );
    const stillOut = await discover(storage, embedder, ROT_QUERY, 5);
    assert.ok(
      !stillOut.results.some((r) => r.name === 'rot-target'),
      'below-gate blend must keep the tool out of discover at 3 cleans',
    );

    const fourth = await reverifyTools(storage);
    assert.equal(fourth.passed, 1);
    const afterFour = await storage.getToolByNameVersion('rot-target', '1.0');
    assert.ok(
      afterFour!.metadata.reliability_score >= 0.80,
      `4 cleans must re-cross the gate, got ${afterFour!.metadata.reliability_score}`,
    );
    assert.ok(
      Math.abs(afterFour!.metadata.reliability_score - 0.8177) < 2e-3,
      `4-clean blend ≈ 0.8177, got ${afterFour!.metadata.reliability_score}`,
    );
    assert.ok(
      afterFour!.metadata.reliability_score < 1.0 - 1e-9,
      'restored tool carries its history — never a clean-slate 1.0',
    );

    const after = await discover(storage, embedder, ROT_QUERY, 5);
    assert.ok(
      after.results.some((r) => r.name === 'rot-target'),
      'tool re-enters discover after K=4 clean sweeps',
    );
  } finally {
    await storage.close();
  }
});

test('tool-kind row with no eval suite is skipped: score unchanged, no eval_runs row', async () => {
  const storage = await freshStorage();
  try {
    await storage.upsertTool(
      directSpec({ name: 'scraped-tool', metadata: { cost_per_call_usd: 0, p95_latency_ms: 100, reliability_score: 0.95 } }),
      makeUnitVec(11),
    );

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 0);
    assert.deepEqual(summary.skipped, [
      { name: 'scraped-tool', version: '1.0', reason: 'no-eval-suite' },
    ]);

    const tool = await storage.getToolByNameVersion('scraped-tool', '1.0');
    assert.equal(tool!.metadata.reliability_score, 0.95, 'score must be UNCHANGED — the zero-rate trap');
    assert.equal((await evalRunsFor(storage, 'scraped-tool')).length, 0, 'no empty eval run inserted');
  } finally {
    await storage.close();
  }
});

test('catalog kind (skill) is skipped: catalog-kind, untouched', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, {
      name: 'a-skill',
      tool_kind: 'skill',
      endpoint_stub_name: 'catalog-only-stub',
      capability_text:
        'A skill for brainstorming new ideas. Use this when the user asks if something is worth building. Returns sharp critical feedback grounded in product reality.',
    });
    const scoreAfterPush = pushed.reliability_score;
    const runsAfterPush = (await evalRunsFor(storage, 'a-skill')).length;

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 0);
    assert.deepEqual(summary.skipped, [{ name: 'a-skill', version: '1.0', reason: 'catalog-kind' }]);

    const tool = await storage.getToolByNameVersion('a-skill', '1.0');
    assert.equal(tool!.metadata.reliability_score, scoreAfterPush);
    assert.equal((await evalRunsFor(storage, 'a-skill')).length, runsAfterPush, 'no new eval run');
  } finally {
    await storage.close();
  }
});

test('toolName/toolVersion filter reverifies exactly one tool', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'tool-a' });
    await pushOk(storage, { name: 'tool-b' });

    const summary = await reverifyTools(storage, { toolName: 'tool-a', toolVersion: '1.0' });
    assert.equal(summary.executed, 1);
    assert.equal((await evalRunsFor(storage, 'tool-a')).length, 2, 'push + reverify');
    assert.equal((await evalRunsFor(storage, 'tool-b')).length, 1, 'push only — filtered out');

    const wrongVersion = await reverifyTools(storage, { toolName: 'tool-a', toolVersion: '9.9' });
    assert.equal(wrongVersion.executed, 0, 'version mismatch matches nothing');
  } finally {
    await storage.close();
  }
});

test('circuit_broken tool: evals run and are recorded, status stays circuit_broken', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'broken-tool' });
    await storage.setStatus(pushed.tool_id, 'circuit_broken');

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 1, 'circuit_broken still gets its evals run (feeds recovery evidence)');

    const reverifyRuns = (await evalRunsFor(storage, 'broken-tool')).filter((r) => r.triggered_by === 'reverify');
    assert.equal(reverifyRuns.length, 1);

    const tool = await storage.getToolByNameVersion('broken-tool', '1.0');
    assert.equal(
      tool!.status,
      'circuit_broken',
      'one clean reverify run is NOT recovery (needs 3 spanning >= 60min — see scoreLifecycle.ts)',
    );
    assert.deepEqual(summary.recovered, []);
    assert.equal(tool!.metadata.reliability_score, 1.0, 'score still updates (blend of all-clean history)');
  } finally {
    await storage.close();
  }
});

test('POST /v1/reverify: unfiltered is admin-only, filtered accepts tool_author, shape matches summary', async () => {
  const storage = await freshStorage();
  const app = Fastify({ logger: false });
  try {
    const keys = { admin: 'sk_test_admin', author: 'sk_test_author', caller: 'sk_test_caller' } as const;
    const roles = { admin: 'admin', author: 'tool_author', caller: 'caller' } as const;
    for (const who of ['admin', 'author', 'caller'] as const) {
      await storage.upsertAgent({
        id: `agent-${who}`,
        name: who,
        api_key_hash: hashKey(keys[who]),
        role: roles[who],
        created_at: new Date().toISOString(),
      });
    }
    await pushOk(storage, { name: 'routed-tool' });

    registerReverifyRoute(app, storage);
    await app.ready();

    const noKey = await app.inject({ method: 'POST', url: '/v1/reverify', payload: {} });
    assert.equal(noKey.statusCode, 401);

    const authorSweep = await app.inject({
      method: 'POST', url: '/v1/reverify', payload: {},
      headers: { 'x-api-key': keys.author },
    });
    assert.equal(authorSweep.statusCode, 403);
    const callerSweep = await app.inject({
      method: 'POST', url: '/v1/reverify', payload: {},
      headers: { 'x-api-key': keys.caller },
    });
    assert.equal(callerSweep.statusCode, 403);

    const adminSweep = await app.inject({
      method: 'POST', url: '/v1/reverify', payload: {},
      headers: { 'x-api-key': keys.admin },
    });
    assert.equal(adminSweep.statusCode, 200);
    const body = adminSweep.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.executed, 'number');
    assert.equal(typeof body.passed, 'number');
    assert.equal(typeof body.failed, 'number');
    assert.ok(Array.isArray(body.skipped));
    assert.ok(Array.isArray(body.gate_dropped));
    assert.equal(body.executed, 1);

    const authorFiltered = await app.inject({
      method: 'POST', url: '/v1/reverify',
      payload: { tool_name: 'routed-tool', tool_version: '1.0' },
      headers: { 'x-api-key': keys.author },
    });
    assert.equal(authorFiltered.statusCode, 200);
    assert.equal(authorFiltered.json().executed, 1);

    const callerFiltered = await app.inject({
      method: 'POST', url: '/v1/reverify',
      payload: { tool_name: 'routed-tool' },
      headers: { 'x-api-key': keys.caller },
    });
    assert.equal(callerFiltered.statusCode, 403);
  } finally {
    await app.close();
    await storage.close();
  }
});

test('grader parity: push and reverify grade malformed-bot with the same policy (raw-run parity within epsilon)', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'malformed-bot', endpoint_stub_name: 'malformed-bot-v1' });
    const scoreAtPublish = (await storage.getToolByNameVersion('malformed-bot', '1.0'))!
      .metadata.reliability_score;
    assert.equal(scoreAtPublish, pushed.reliability_score);

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 1);
    assert.deepEqual(summary.gate_dropped, [], 'a sweep must not strict-grade and gate-drop the demo bot');

    const runs = await evalRunsFor(storage, 'malformed-bot');
    const pushRun = runs.find((r) => r.triggered_by === 'push')!;
    const reverifyRun = runs.find((r) => r.triggered_by === 'reverify')!;
    assert.ok(
      Math.abs(reverifyRun.pass_rate - pushRun.pass_rate) < 1e-9,
      `lenient override must travel with the shared helper: ${pushRun.pass_rate} vs ${reverifyRun.pass_rate}`,
    );
    assert.equal(reverifyRun.total_count, pushRun.total_count);

    const scoreAfterSweep = (await storage.getToolByNameVersion('malformed-bot', '1.0'))!
      .metadata.reliability_score;
    assert.ok(
      Math.abs(scoreAfterSweep - scoreAtPublish) < 1e-9,
      `blend of equal evidence stays put: ${scoreAtPublish} vs ${scoreAfterSweep}`,
    );
  } finally {
    await storage.close();
  }
});

test('pending tool is skipped: pending-status, untouched', async () => {
  const storage = await freshStorage();
  try {
    await storage.upsertTool(
      directSpec({
        name: 'half-published',
        endpoint_stub_name: 'pdf-extractor-v3',
        status: 'pending',
        metadata: { cost_per_call_usd: 0, p95_latency_ms: 100, reliability_score: 0 },
      }),
      makeUnitVec(13),
    );

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 0);
    assert.deepEqual(summary.skipped, [
      { name: 'half-published', version: '1.0', reason: 'pending-status' },
    ]);

    const tool = await storage.getToolByNameVersion('half-published', '1.0');
    assert.equal(tool!.status, 'pending', 'sweep must not promote a pending row');
    assert.equal(tool!.metadata.reliability_score, 0);
    assert.equal((await evalRunsFor(storage, 'half-published')).length, 0);
  } finally {
    await storage.close();
  }
});

test('push parity: factored eval helper preserves publish-time scores and run shape', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'buggy-pdf', endpoint_stub_name: 'pdf-extractor-v3-1' });
    assert.equal(pushed.pass_rate, 0.6);
    assert.equal(pushed.pass_count, 3);
    assert.equal(pushed.total_count, 5);
    assert.equal(pushed.reliability_score, 0.6);
    assert.equal(pushed.status, 'active');
    assert.equal(pushed.cases.length, 5);

    const runs = await evalRunsFor(storage, 'buggy-pdf');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].triggered_by, 'push');
    assert.equal(runs[0].pass_rate, 0.6);
  } finally {
    await storage.close();
  }
});

test('recordEvalOutcome never writes status: circuit_broken survives the eval write', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'race-target', version: '1.0' });
    const tool = await storage.getToolByNameVersion('race-target', '1.0');
    assert.ok(tool);

    await storage.setStatus(tool.id, 'circuit_broken');
    await storage.recordEvalOutcome(tool.id, 0.95, new Date().toISOString());

    const after = await storage.getToolByNameVersion('race-target', '1.0');
    assert.equal(after?.status, 'circuit_broken', 'eval write must not resurrect a circuit-broken tool');
    assert.equal(after?.metadata.reliability_score, 0.95, 'score patch still lands');
  } finally {
    await storage.close?.();
  }
});

test('recordEvalOutcome patches only eval fields: concurrent metadata writes survive', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'meta-target', version: '1.0' });
    const tool = await storage.getToolByNameVersion('meta-target', '1.0');
    assert.ok(tool);

    const db = rawDb(storage as SqliteStorage);
    db.prepare(
      `UPDATE tools SET metadata = json_set(metadata, '$.cost_per_call_usd', 9.99) WHERE id = ?`,
    ).run(tool.id);

    await storage.recordEvalOutcome(tool.id, 0.9, new Date().toISOString());

    const after = await storage.getToolByNameVersion('meta-target', '1.0');
    assert.equal(after?.metadata.cost_per_call_usd, 9.99, 'concurrent metadata write must survive the eval patch');
    assert.equal(after?.metadata.reliability_score, 0.9);
  } finally {
    await storage.close?.();
  }
});

test('CLI strict args: malformed reverify invocations die instead of widening into a fleet sweep', () => {
  const bin = resolve('bin/2chain.mjs');
  const cases: Array<{ args: string[]; why: string }> = [
    { args: ['reverify', 'pdf-extractor@3.0'], why: 'forgotten --tool must not become an unfiltered sweep' },
    { args: ['reverify', '--tool'], why: 'missing spec after --tool' },
    { args: ['reverify', '--tool', 'name@'], why: 'trailing @ (empty version) must not widen to every version' },
    { args: ['reverify', '--tool', 'a@1.0', 'extra'], why: 'extra positional arg' },
  ];
  for (const { args, why } of cases) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf-8' });
    assert.notEqual(r.status, 0, why);
    assert.match(r.stderr, /usage: 2chain reverify|version is empty/, why);
  }
});

test('isSweepInFlight: raised for the duration of an unfiltered sweep only (watcher rerank suppression)', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'flag-probe', version: '1.0' });

    assert.equal(isSweepInFlight(), false, 'idle before the sweep');
    const sweep = reverifyTools(storage);
    assert.equal(isSweepInFlight(), true, 'flag must be up while the sweep runs');
    await sweep;
    assert.equal(isSweepInFlight(), false, 'flag must drop when the sweep completes');

    const filtered = reverifyTools(storage, { toolName: 'flag-probe', toolVersion: '1.0' });
    assert.equal(isSweepInFlight(), false, 'filtered path never raises the flag');
    await filtered;
  } finally {
    await storage.close();
  }
});

test('route fires afterSweep exactly once per unfiltered sweep and never for filtered requests', async () => {
  const storage = await freshStorage();
  const app = Fastify({ logger: false });
  try {
    await storage.upsertAgent({
      id: 'agent-admin-rerank',
      name: 'admin',
      api_key_hash: hashKey('sk_test_admin_rerank'),
      role: 'admin',
      created_at: new Date().toISOString(),
    });
    await pushOk(storage, { name: 'rerank-probe', version: '1.0' });

    let fired = 0;
    registerReverifyRoute(app, storage, async () => { fired += 1; });
    await app.ready();
    const headers = { 'x-api-key': 'sk_test_admin_rerank' };

    const sweep1 = await app.inject({ method: 'POST', url: '/v1/reverify', payload: {}, headers });
    assert.equal(sweep1.statusCode, 200);
    assert.equal(fired, 1, 'one unfiltered sweep = exactly one post-sweep rerank');

    const filtered = await app.inject({
      method: 'POST', url: '/v1/reverify',
      payload: { tool_name: 'rerank-probe', tool_version: '1.0' }, headers,
    });
    assert.equal(filtered.statusCode, 200);
    assert.equal(fired, 1, 'filtered requests never fire the coalesced rerank');

    const sweep2 = await app.inject({ method: 'POST', url: '/v1/reverify', payload: {}, headers });
    assert.equal(sweep2.statusCode, 200);
    assert.equal(fired, 2, 'each completed unfiltered sweep fires exactly once');
  } finally {
    await app.close();
    await storage.close();
  }
});

test('concurrent unfiltered sweeps: second throws SweepInFlightError', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'sweep-guard', version: '1.0' });
    const results = await Promise.allSettled([
      reverifyTools(storage),
      reverifyTools(storage),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one sweep runs');
    assert.equal(rejected.length, 1, 'the overlapping sweep is rejected');
    assert.equal(
      (rejected[0] as PromiseRejectedResult).reason?.code,
      'sweep_in_flight',
    );
    const again = await reverifyTools(storage);
    assert.equal(again.executed >= 1, true);
  } finally {
    await storage.close?.();
  }
});
