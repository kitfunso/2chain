// E1 re-verification engine tests (plan section 5). Real SQLite (:memory:),
// real stubs, real graders — NO mocks (CLAUDE.md rule 5). Rot is constructed
// with a real state change: a healthy tool's endpoint_stub_name is re-pointed
// at the deterministically-failing first-party stub 'rotten-pdf-v1' via a
// direct test-side SQL UPDATE (rule 1 binds src/services and src/server/routes,
// not tests), so status/metadata stay untouched — a naive re-upsert through
// push's pending spec would reset status to 'pending' and trip reverify's
// pending-skip, silently invalidating the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { push, type PushInput } from '../src/services/push.js';
import { reverifyTools } from '../src/services/reverify.js';
import { discover } from '../src/services/discover.js';
import { registerReverifyRoute } from '../src/server/routes/reverify.js';
import { hashKey } from '../src/server/auth.js';
import type { Embedder, EvalRunRow, ToolSpecV2 } from '../src/types.js';
import '../src/services/stubs.js';

// ---- Deterministic stub embedder (no Ollama dependency) ----
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
  // Route the rot-test query and the rot-target capability to the same vector
  // so the vec arm of discover deterministically finds the tool.
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

// Test-side raw handle for constructing rot (same precedent as
// tests/storage.sqlite.tool-kind.test.ts).
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

// ---- 1. Happy path -------------------------------------------------------

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

// ---- 2. Broken-tool acceptance (both legs) -------------------------------

test('rot leg + restore leg: gate-drop on rot, absent from discover, recovers on restore', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'rot-target', version: '1.0', capability_text: ROT_CAPABILITY });

    // Healthy: discoverable above the gate.
    const before = await discover(storage, embedder, ROT_QUERY, 5);
    assert.ok(
      before.results.some((r) => r.name === 'rot-target'),
      'healthy tool must be discoverable before rot',
    );

    // Simulate upstream rot with a REAL storage write: re-point the stub via
    // direct SQL so status and metadata are preserved (see file header).
    rawDb(storage)
      .prepare(`UPDATE tools SET endpoint_stub_name = ? WHERE name = ? AND version = ?`)
      .run('rotten-pdf-v1', 'rot-target', '1.0');

    // The re-point must NOT have touched status — otherwise reverify's
    // pending-skip would silently invalidate this test.
    const rotted = await storage.getToolByNameVersion('rot-target', '1.0');
    assert.equal(rotted!.status, 'active', 'status must still be active after re-point');
    assert.equal(rotted!.endpoint_stub_name, 'rotten-pdf-v1');
    assert.equal(rotted!.metadata.reliability_score, 1.0, 'score untouched until reverify runs');

    // Leg 1: reverify catches the rot and gate-drops.
    const rotSummary = await reverifyTools(storage);
    assert.equal(rotSummary.executed, 1);
    assert.equal(rotSummary.failed, 1);
    assert.deepEqual(rotSummary.gate_dropped, ['rot-target']);

    const afterRot = await storage.getToolByNameVersion('rot-target', '1.0');
    assert.equal(afterRot!.metadata.reliability_score, 0, 'rotten stub fails every case');
    assert.equal(afterRot!.status, 'active', 'reverify never flips status (D34)');

    const rotRuns = (await evalRunsFor(storage, 'rot-target')).filter((r) => r.triggered_by === 'reverify');
    assert.equal(rotRuns.length, 1);
    assert.equal(rotRuns[0].pass_count, 0);
    assert.ok(rotRuns[0].total_count > 0);
    assert.ok(
      rotRuns[0].cases.every((c) => !c.pass && typeof c.error === 'string' && c.error.length > 0),
      'eval_runs row must record the per-case failures',
    );

    // Gate enforced in SQL: the rotted tool is gone from discover.
    const during = await discover(storage, embedder, ROT_QUERY, 5);
    assert.ok(
      !during.results.some((r) => r.name === 'rot-target'),
      'gate-dropped tool must be absent from discover',
    );

    // Leg 2: upstream recovers — restore the healthy stub, reverify clean.
    rawDb(storage)
      .prepare(`UPDATE tools SET endpoint_stub_name = ? WHERE name = ? AND version = ?`)
      .run('pdf-extractor-v3', 'rot-target', '1.0');

    const restoreSummary = await reverifyTools(storage);
    assert.equal(restoreSummary.executed, 1);
    assert.equal(restoreSummary.passed, 1);
    assert.deepEqual(restoreSummary.gate_dropped, []);

    const recovered = await storage.getToolByNameVersion('rot-target', '1.0');
    assert.equal(recovered!.metadata.reliability_score, 1.0, 'score recovers on restore');

    const after = await discover(storage, embedder, ROT_QUERY, 5);
    assert.ok(
      after.results.some((r) => r.name === 'rot-target'),
      'recovered tool must be discoverable again',
    );
  } finally {
    await storage.close();
  }
});

// ---- 3. Zero-rate trap lock ----------------------------------------------

test('tool-kind row with no eval suite is skipped: score unchanged, no eval_runs row', async () => {
  const storage = await freshStorage();
  try {
    // Importer reality: scraped catalog tools are upserted directly with
    // endpoint_stub_name=catalog-only-stub (registered, but NOT in STUB_DOMAIN).
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

// ---- 4. Catalog kind ------------------------------------------------------

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

// ---- 5. --tool filter -----------------------------------------------------

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

// ---- 6. circuit_broken pass-through ----------------------------------------

test('circuit_broken tool: evals run and are recorded, status stays circuit_broken', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'broken-tool' });
    await storage.setStatus(pushed.tool_id, 'circuit_broken');

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 1, 'circuit_broken still gets its evals run (feeds E2 recovery)');

    const reverifyRuns = (await evalRunsFor(storage, 'broken-tool')).filter((r) => r.triggered_by === 'reverify');
    assert.equal(reverifyRuns.length, 1);

    const tool = await storage.getToolByNameVersion('broken-tool', '1.0');
    assert.equal(tool!.status, 'circuit_broken', 'only call.ts flips circuit state; recovery is E2');
    assert.equal(tool!.metadata.reliability_score, 1.0, 'score still updates');
  } finally {
    await storage.close();
  }
});

// ---- 7. Route auth + summary contract --------------------------------------

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

    // No key → 401.
    const noKey = await app.inject({ method: 'POST', url: '/v1/reverify', payload: {} });
    assert.equal(noKey.statusCode, 401);

    // Unfiltered sweep: tool_author and caller rejected, admin accepted.
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

    // Filtered single-tool reverify: tool_author accepted, caller rejected.
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

// ---- 8. Grader-policy parity (malformed-bot) --------------------------------

test('grader parity: malformed-bot score is byte-identical before and after a sweep', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'malformed-bot', endpoint_stub_name: 'malformed-bot-v1' });
    const scoreAtPublish = (await storage.getToolByNameVersion('malformed-bot', '1.0'))!
      .metadata.reliability_score;
    assert.equal(scoreAtPublish, pushed.reliability_score);

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 1);
    assert.deepEqual(summary.gate_dropped, [], 'a sweep must not strict-grade and gate-drop the demo bot');

    const scoreAfterSweep = (await storage.getToolByNameVersion('malformed-bot', '1.0'))!
      .metadata.reliability_score;
    assert.ok(
      Object.is(scoreAtPublish, scoreAfterSweep),
      `lenient override must travel with the shared helper: ${scoreAtPublish} !== ${scoreAfterSweep}`,
    );

    const runs = await evalRunsFor(storage, 'malformed-bot');
    const pushRun = runs.find((r) => r.triggered_by === 'push')!;
    const reverifyRun = runs.find((r) => r.triggered_by === 'reverify')!;
    assert.equal(reverifyRun.pass_rate, pushRun.pass_rate);
    assert.equal(reverifyRun.total_count, pushRun.total_count);
  } finally {
    await storage.close();
  }
});

// ---- 9. Pending status ------------------------------------------------------

test('pending tool is skipped: pending-status, untouched', async () => {
  const storage = await freshStorage();
  try {
    // A lingering pending row = incomplete publish. Stub HAS an eval suite,
    // proving the pending-skip wins over the suite check.
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

// ---- 10. Push-behavior parity (cheap lock on the factored helper) -----------

test('push parity: factored eval helper preserves publish-time scores and run shape', async () => {
  const storage = await freshStorage();
  try {
    // pdf-extractor-v3-1's known fixture outcome: 3/5 cases pass = 0.6.
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
