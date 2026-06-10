// E4 tool health surface tests (plan section 6, 13 pinned items). Real SQLite
// (:memory:), real stubs, real pushes/reverifies — NO mocks (CLAUDE.md rule 5).
// Harness copied from tests/reverify.test.ts (StubEmbedder, freshStorage,
// pushOk, rawDb). spawnSync is used ONLY for the CLI strict-arg rejection
// cases (E2 cli-spawn precedent); route assertions go through Fastify
// app.inject like every sibling route test.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { push, type PushInput } from '../src/services/push.js';
import { reverifyTools } from '../src/services/reverify.js';
import { applyKindEval } from '../src/services/applyKindEval.js';
import {
  toolHealth,
  SCORE_HISTORY_LIMIT,
  DRIFT_EVENTS_LIMIT,
} from '../src/services/health.js';
import { registerHealthRoutes } from '../src/server/routes/health.js';
import { DASHBOARD_HTML } from '../src/server/routes/dashboardHtml.js';
import { hashKey } from '../src/server/auth.js';
import type { Embedder, ToolSpecV2 } from '../src/types.js';
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

class StubEmbedder implements Embedder {
  name() { return 'stub:fixed-vec'; }
  dim() { return 768; }
  async embed(text: string): Promise<Float32Array> {
    return makeUnitVec(hashTextToSeed(text));
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
// tests/reverify.test.ts — rule 1 binds src/services and src/server/routes,
// not tests).
function rawDb(storage: SqliteStorage): { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } {
  return (storage as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseInput = (overrides: Partial<PushInput>): PushInput => ({
  name: 'unset',
  version: '1.0',
  capability_text: 'a capability for testing the health surface',
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

async function seedAgents(storage: SqliteStorage): Promise<{ caller: string; author: string; admin: string }> {
  const keys = { caller: 'sk_test_caller', author: 'sk_test_author', admin: 'sk_test_admin' };
  const roles = { caller: 'caller', author: 'tool_author', admin: 'admin' } as const;
  for (const who of ['caller', 'author', 'admin'] as const) {
    await storage.upsertAgent({
      id: `agent-${who}`,
      name: who,
      api_key_hash: hashKey(keys[who]),
      role: roles[who],
      created_at: new Date().toISOString(),
    });
  }
  return keys;
}

// ---- 1. Healthy multi-version tool -----------------------------------------

// Versions are NEWEST-FIRST: the report caps at HEALTH_VERSIONS_LIMIT and
// must keep the newest, so ordering is part of the contract.
test('multi-version tool: both versions present with scores and last_eval_run', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'multi-ver', version: '1.0' });
    await pushOk(storage, { name: 'multi-ver', version: '2.0' });

    const report = await toolHealth(storage, 'multi-ver');
    assert.ok(report);
    assert.equal(report.name, 'multi-ver');
    assert.equal(report.versions.length, 2);
    assert.deepEqual(report.versions.map((v) => v.version), ['2.0', '1.0']);

    const runs = await storage.listEvalRuns(500);
    for (const v of report.versions) {
      assert.equal(v.status, 'active');
      assert.equal(v.tool_kind, 'tool');
      assert.equal(v.reliability_score, 1.0);
      const pushRun = runs.find(
        (r) => r.tool_name === 'multi-ver' && r.tool_version === v.version,
      )!;
      assert.equal(v.last_eval_run, pushRun.triggered_at, 'newest eval_runs.triggered_at');
      assert.equal(v.score_history.length, 1);
      assert.equal(v.score_history[0].triggered_by, 'push');
      assert.equal(v.score_history[0].pass_rate, 1.0);
      // 7d usage window with no calls: all outcome keys present, all zero.
      assert.deepEqual(v.usage, { ok: 0, circuit_broken: 0, gated: 0, violation: 0, timeout: 0 });
    }
  } finally {
    await storage.close();
  }
});

// ---- 2. Streak semantics ----------------------------------------------------

test('streak: 3 clean reverifies = 3; interleaved manual run filtered not breaking; clean-fail-clean = 1; push-only = 0', async () => {
  const storage = await freshStorage();
  try {
    // (a) 3 clean reverify runs ⇒ streak 3.
    await pushOk(storage, { name: 'streak-3', version: '1.0' });
    for (let i = 0; i < 3; i++) {
      await reverifyTools(storage, { toolName: 'streak-3', toolVersion: '1.0' });
      await sleep(10); // distinct triggered_at (ISO ms precision)
    }
    let report = (await toolHealth(storage, 'streak-3'))!;
    assert.equal(report.versions[0].verification_streak, 3);

    // Interleaved NON-reverify run, failing and NEWEST: it must be FILTERED
    // OUT of the streak window (skipped), never streak-breaking.
    const streak3 = (await storage.getToolByNameVersion('streak-3', '1.0'))!;
    const manualAt = new Date(Date.now() + 1_000).toISOString();
    await storage.insertEvalRun({
      tool_id: streak3.id,
      tool_name: 'streak-3',
      tool_version: '1.0',
      namespace_id: 'default',
      triggered_at: manualAt,
      triggered_by: 'manual',
      cases: [],
      pass_count: 0,
      total_count: 1,
      pass_rate: 0,
      duration_ms: 1,
    });
    report = (await toolHealth(storage, 'streak-3'))!;
    assert.equal(report.versions[0].verification_streak, 3, 'manual run is filtered, not breaking');
    assert.equal(report.versions[0].last_eval_run, manualAt, 'but it IS the newest run overall');

    // (b) clean-fail-clean ⇒ 1 (counts from newest until first sub-gate run).
    await pushOk(storage, { name: 'streak-1', version: '1.0' });
    await reverifyTools(storage, { toolName: 'streak-1', toolVersion: '1.0' });
    await sleep(10);
    rawDb(storage)
      .prepare(`UPDATE tools SET endpoint_stub_name = ? WHERE name = ? AND version = ?`)
      .run('rotten-pdf-v1', 'streak-1', '1.0');
    await reverifyTools(storage, { toolName: 'streak-1', toolVersion: '1.0' });
    await sleep(10);
    rawDb(storage)
      .prepare(`UPDATE tools SET endpoint_stub_name = ? WHERE name = ? AND version = ?`)
      .run('pdf-extractor-v3', 'streak-1', '1.0');
    await reverifyTools(storage, { toolName: 'streak-1', toolVersion: '1.0' });
    report = (await toolHealth(storage, 'streak-1'))!;
    assert.equal(report.versions[0].verification_streak, 1, 'newest clean, then the fail stops the count');

    // (c) push-only history ⇒ 0 (reverify-triggered only).
    await pushOk(storage, { name: 'streak-0', version: '1.0' });
    report = (await toolHealth(storage, 'streak-0'))!;
    assert.equal(report.versions[0].verification_streak, 0);
  } finally {
    await storage.close();
  }
});

// ---- 3. score_history bounded -----------------------------------------------

test('score_history is bounded at 20, newest-first', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'history-cap', version: '1.0' });
    const tool = (await storage.getToolByNameVersion('history-cap', '1.0'))!;
    const base = Date.now() + 60_000; // strictly newer than the push run
    for (let i = 0; i < 25; i++) {
      await storage.insertEvalRun({
        tool_id: tool.id,
        tool_name: 'history-cap',
        tool_version: '1.0',
        namespace_id: 'default',
        triggered_at: new Date(base + i * 1_000).toISOString(),
        triggered_by: 'manual',
        cases: [],
        pass_count: 1,
        total_count: 1,
        pass_rate: 1,
        duration_ms: 1,
      });
    }
    const report = (await toolHealth(storage, 'history-cap'))!;
    const history = report.versions[0].score_history;
    assert.equal(history.length, SCORE_HISTORY_LIMIT);
    assert.equal(history.length, 20);
    assert.equal(history[0].at, new Date(base + 24_000).toISOString(), 'newest first');
    assert.equal(history[19].at, new Date(base + 5_000).toISOString(), 'oldest rows fall off the cap');
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i - 1].at > history[i].at, `descending order at index ${i}`);
    }
  } finally {
    await storage.close();
  }
});

// ---- 4. drift_events: root-level, real E3 push, bounded ----------------------

test('drift_events sit at the report root, populated by a real compatible push, bounded at 10', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'drifty', version: '1.0' });
    // Compatible drift: optional property added to the input contract.
    await pushOk(storage, {
      name: 'drifty',
      version: '1.1',
      input_contract: {
        type: 'object',
        additionalProperties: true,
        properties: { extra: { type: 'string' } },
      },
    });

    let report = (await toolHealth(storage, 'drifty'))!;
    assert.equal(report.drift_events.length, 1, 'one real E3 event from the push');
    const ev = report.drift_events[0];
    assert.deepEqual(
      Object.keys(ev).sort(),
      ['classification', 'created_at', 'direction', 'from_version', 'to_version'],
      'projected fields only',
    );
    assert.equal(ev.from_version, '1.0');
    assert.equal(ev.to_version, '1.1');
    assert.equal(ev.direction, 'input');
    assert.equal(ev.classification, 'compatible');
    assert.equal(typeof ev.created_at, 'string');
    // Root-level, never duplicated per version (E3 stores drift by tool_name).
    for (const v of report.versions) {
      assert.ok(!('drift_events' in v), 'no per-version drift list');
    }

    // Bound: 12 more events ⇒ report caps at 10, newest-first.
    const base = Date.now() + 60_000;
    for (let i = 0; i < 12; i++) {
      await storage.insertDriftEvent({
        namespace_id: 'default',
        tool_name: 'drifty',
        from_version: '1.1',
        to_version: `1.${i + 2}`,
        direction: 'output',
        classification: 'compatible',
        changes: [{ path: 'properties.x', kind: 'property-added-optional', breaking: false, detail: `synthetic ${i}` }],
        author_agent_id: 'agent-author',
        created_at: new Date(base + i * 1_000).toISOString(),
      });
    }
    report = (await toolHealth(storage, 'drifty'))!;
    assert.equal(report.drift_events.length, DRIFT_EVENTS_LIMIT);
    assert.equal(report.drift_events.length, 10);
    assert.equal(report.drift_events[0].created_at, new Date(base + 11_000).toISOString(), 'newest first');
  } finally {
    await storage.close();
  }
});

// ---- 5. Usage window ---------------------------------------------------------

test('usage counts are windowed: rows older than 7 days are excluded', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'usage-win', version: '1.0' });
    const tool = (await storage.getToolByNameVersion('usage-win', '1.0'))!;
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const usageRow = (outcome: 'ok' | 'violation', occurred_at: string, n: number) => ({
      tool_id: tool.id,
      agent_id: 'agent-caller',
      namespace_id: 'default',
      call_id: `call-${outcome}-${occurred_at}-${n}`,
      outcome,
      latency_ms: 10,
      occurred_at,
    });
    await storage.insertUsage(usageRow('ok', nowIso, 1));
    await storage.insertUsage(usageRow('ok', nowIso, 2));
    await storage.insertUsage(usageRow('violation', nowIso, 3));
    await storage.insertUsage(usageRow('ok', oldIso, 4));
    await storage.insertUsage(usageRow('ok', oldIso, 5));
    await storage.insertUsage(usageRow('ok', oldIso, 6));

    const report = (await toolHealth(storage, 'usage-win'))!;
    assert.deepEqual(report.versions[0].usage, {
      ok: 2,
      circuit_broken: 0,
      gated: 0,
      violation: 1,
      timeout: 0,
    }, 'the three 8-day-old ok rows are outside the window');
  } finally {
    await storage.close();
  }
});

// ---- 6. Unknown name ⇒ null ⇒ 404 -------------------------------------------

test('unknown name: service returns null, both routes return the standard 404 envelope', async () => {
  const storage = await freshStorage();
  const app = Fastify({ logger: false });
  try {
    const keys = await seedAgents(storage);
    registerHealthRoutes(app, storage);
    await app.ready();

    assert.equal(await toolHealth(storage, 'no-such-tool'), null);

    const v1 = await app.inject({
      method: 'GET',
      url: '/v1/tools/no-such-tool/health',
      headers: { 'x-api-key': keys.caller },
    });
    assert.equal(v1.statusCode, 404);
    assert.deepEqual(v1.json(), {
      ok: false,
      error: { code: 'tool_not_found', message: "no tool named 'no-such-tool'" },
    });

    const view = await app.inject({ method: 'GET', url: '/health-view/no-such-tool' });
    assert.equal(view.statusCode, 404);
    assert.equal(view.json().error.code, 'tool_not_found');
  } finally {
    await app.close();
    await storage.close();
  }
});

// ---- 7. Route auth -----------------------------------------------------------

test('GET /v1/tools/:name/health: caller role 200, missing key 401', async () => {
  const storage = await freshStorage();
  const app = Fastify({ logger: false });
  try {
    const keys = await seedAgents(storage);
    await pushOk(storage, { name: 'authed-tool', version: '1.0' });
    registerHealthRoutes(app, storage);
    await app.ready();

    const noKey = await app.inject({ method: 'GET', url: '/v1/tools/authed-tool/health' });
    assert.equal(noKey.statusCode, 401);
    assert.equal(noKey.json().error.code, 'auth_missing');

    const asCaller = await app.inject({
      method: 'GET',
      url: '/v1/tools/authed-tool/health',
      headers: { 'x-api-key': keys.caller },
    });
    assert.equal(asCaller.statusCode, 200);
    const body = asCaller.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'authed-tool');
    assert.equal(body.versions.length, 1);
    assert.ok(Array.isArray(body.drift_events));
  } finally {
    await app.close();
    await storage.close();
  }
});

// ---- 8. Dashboard view route -------------------------------------------------

test('GET /health-view/:name: unauthenticated, payload identical to the /v1 route', async () => {
  const storage = await freshStorage();
  const app = Fastify({ logger: false });
  try {
    const keys = await seedAgents(storage);
    await pushOk(storage, { name: 'viewed-tool', version: '1.0' });
    registerHealthRoutes(app, storage);
    await app.ready();

    const v1 = await app.inject({
      method: 'GET',
      url: '/v1/tools/viewed-tool/health',
      headers: { 'x-api-key': keys.caller },
    });
    assert.equal(v1.statusCode, 200);

    const view = await app.inject({ method: 'GET', url: '/health-view/viewed-tool' });
    assert.equal(view.statusCode, 200);
    assert.deepEqual(view.json(), v1.json(), 'same service, same projection');
  } finally {
    await app.close();
    await storage.close();
  }
});

// ---- 9. CLI strict args (spawnSync, no server needed) -------------------------

test('CLI strict args: malformed health invocations die before any fetch', () => {
  // Spawn the REAL bin (E2 cli-spawn precedent). Both rejection paths die
  // before any fetch, so no server is needed. The render path is covered by
  // the route payload tests above — the verb is fetch + format only.
  const bin = resolve('bin/2chain.mjs');
  const cases: Array<{ args: string[]; why: string }> = [
    { args: ['health'], why: 'missing tool name positional' },
    { args: ['health', 'a', 'b'], why: 'extra positional arg' },
  ];
  for (const { args, why } of cases) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf-8' });
    assert.notEqual(r.status, 0, why);
    assert.match(r.stderr, /usage: 2chain health <name>/, why);
  }
});

// ---- 10. Catalog kind (importer-created) --------------------------------------

test('catalog kind via importer path: streak 0, score_history is exactly the manual rubric run', async () => {
  const storage = await freshStorage();
  try {
    // Importer reality (skills-importer.ts): upsertTool + applyKindEval, which
    // inserts a triggered_by='manual' eval run at import time.
    const inserted = await storage.upsertTool(
      directSpec({
        name: 'imported-skill',
        tool_kind: 'skill',
        domain: 'skills',
        capability_text:
          'A skill for brainstorming new ideas. Use this when the user asks if something is worth building. Returns sharp critical feedback grounded in product reality.',
      }),
      makeUnitVec(17),
    );
    const result = await applyKindEval(storage, inserted);
    assert.ok(result, 'skill kind has a rubric');
    assert.equal(result.reliability_score, 1, 'rubric passes for a well-formed skill');

    const report = (await toolHealth(storage, 'imported-skill'))!;
    assert.equal(report.versions.length, 1);
    const v = report.versions[0];
    assert.equal(v.tool_kind, 'skill');
    assert.equal(v.status, 'active');
    assert.equal(v.reliability_score, 1);
    assert.equal(v.verification_streak, 0, 'manual rubric runs never count toward the reverify streak');
    assert.equal(v.score_history.length, 1, 'exactly the import-time rubric run');
    assert.equal(v.score_history[0].triggered_by, 'manual');
    assert.equal(v.score_history[0].pass_rate, 1);
  } finally {
    await storage.close();
  }
});

// ---- 11. Circuit-broken tool ---------------------------------------------------

test('circuit_broken tool: report shows the status and the score (the do-not-trust answer)', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'cb-tool', version: '1.0' });
    await storage.setStatus(pushed.tool_id, 'circuit_broken');

    const report = (await toolHealth(storage, 'cb-tool'))!;
    assert.equal(report.versions[0].status, 'circuit_broken');
    assert.equal(report.versions[0].reliability_score, 1.0, 'score still reported alongside the status');
  } finally {
    await storage.close();
  }
});

// ---- 12. escapeHtml on every health-payload interpolation ----------------------

test('dashboard health renderer: every payload interpolation site is escapeHtml-wrapped', () => {
  const START = '// ---- health panel (E4)';
  const END = '// ---- end health panel (E4)';
  const si = DASHBOARD_HTML.indexOf(START);
  const ei = DASHBOARD_HTML.indexOf(END);
  assert.ok(si > -1, 'start marker must exist in DASHBOARD_HTML');
  assert.ok(ei > si, 'end marker must exist after the start marker');
  const region = DASHBOARD_HTML.slice(si, ei);
  // Tautology guard: an empty or gutted region must fail, not vacuously pass.
  assert.ok(region.length > 500, 'renderer region must be non-trivial');
  assert.ok(region.includes('function renderHealth'), 'renderer must live inside the marked region');

  // Every access to a string-bearing health-payload field inside the region
  // must be the direct argument of escapeHtml( — author-controlled strings
  // (version, drift paths, triggered_by, ...) must never reach innerHTML raw.
  const FIELD_ACCESS = /\b[A-Za-z_$][\w$]*\.(name|version|from_version|to_version|direction|classification|created_at|last_eval_run|triggered_by|at|status)\b/g;
  const WRAP = 'escapeHtml(';
  let sites = 0;
  for (const m of region.matchAll(FIELD_ACCESS)) {
    const idx = m.index!;
    const before = region.slice(Math.max(0, idx - WRAP.length), idx);
    assert.equal(
      before,
      WRAP,
      `unescaped health-payload interpolation: ...${region.slice(Math.max(0, idx - 30), idx + m[0].length + 10)}...`,
    );
    sites += 1;
  }
  assert.ok(sites >= 10, `expected >= 10 escaped interpolation sites, found ${sites} (regex rot guard)`);
});

// ---- 13. Security: changes_json never ships ------------------------------------

test('security: no `changes` key on any drift event in EITHER route payload', async () => {
  const storage = await freshStorage();
  const app = Fastify({ logger: false });
  try {
    const keys = await seedAgents(storage);
    await pushOk(storage, { name: 'leaky', version: '1.0' });
    await pushOk(storage, {
      name: 'leaky',
      version: '1.1',
      input_contract: {
        type: 'object',
        additionalProperties: true,
        properties: { secret_field: { type: 'string' } },
      },
    });
    // A row whose changes payload is unmistakably present in the DB.
    await storage.insertDriftEvent({
      namespace_id: 'default',
      tool_name: 'leaky',
      from_version: '1.1',
      to_version: '1.2',
      direction: 'output',
      classification: 'breaking',
      changes: [{ path: 'properties.internal_token', kind: 'property-removed', breaking: true, detail: 'contract internals that must NOT leave the service' }],
      author_agent_id: 'agent-author',
      created_at: new Date(Date.now() + 1_000).toISOString(),
    });
    registerHealthRoutes(app, storage);
    await app.ready();

    const v1 = await app.inject({
      method: 'GET',
      url: '/v1/tools/leaky/health',
      headers: { 'x-api-key': keys.caller },
    });
    const view = await app.inject({ method: 'GET', url: '/health-view/leaky' });
    assert.equal(v1.statusCode, 200);
    assert.equal(view.statusCode, 200);

    for (const [label, res] of [['v1', v1], ['view', view]] as const) {
      const body = res.json();
      assert.ok(body.drift_events.length >= 2, `${label}: drift events present`);
      for (const ev of body.drift_events) {
        assert.ok(!('changes' in ev), `${label}: no 'changes' key on any drift event`);
        assert.ok(!('changes_json' in ev), `${label}: no 'changes_json' key on any drift event`);
      }
      const raw = res.body;
      assert.ok(!raw.includes('"changes"'), `${label}: serialized payload carries no changes key`);
      assert.ok(!raw.includes('internal_token'), `${label}: contract internals never serialize`);
    }
  } finally {
    await app.close();
    await storage.close();
  }
});
