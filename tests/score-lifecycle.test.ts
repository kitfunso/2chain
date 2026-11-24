import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { push, type PushInput } from '../src/services/push.js';
import { reverifyTools } from '../src/services/reverify.js';
import { discover } from '../src/services/discover.js';
import { call } from '../src/services/call.js';
import {
  EVAL_LEG_WEIGHT,
  USAGE_LEG_WEIGHT,
  blendReliability,
  evaluateRecovery,
  type EvalHistoryPoint,
  type ReverifyRunPoint,
} from '../src/services/scoreLifecycle.js';
import { RELIABILITY_GATE } from '../src/types.js';
import type { Embedder } from '../src/types.js';
import '../src/services/stubs.js';

const EPS = 1e-9;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

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

const HIST_CAPABILITY = 'Parses invoice line items from scanned PDF statements into numeric rows.';
const HIST_QUERY = 'parse invoice line items from a scanned pdf statement';

class StubEmbedder implements Embedder {
  private seeds = new Map<string, number>([
    [HIST_CAPABILITY, 9],
    [HIST_QUERY, 9],
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

function repointStub(storage: SqliteStorage, name: string, stub: string): void {
  rawDb(storage)
    .prepare(`UPDATE tools SET endpoint_stub_name = ? WHERE name = ? AND version = ?`)
    .run(stub, name, '1.0');
}

async function recordBreak(storage: SqliteStorage, toolId: string, minutesAgo: number): Promise<void> {
  await storage.markCircuitBroken(toolId, new Date(Date.now() - minutesAgo * MIN_MS).toISOString());
}

let rejSeq = 0;
function recordRejection(storage: SqliteStorage, toolId: string, minutesAgo: number): void {
  rejSeq += 1;
  rawDb(storage)
    .prepare(
      `INSERT INTO usage (id, tool_id, agent_id, namespace_id, call_id, outcome, latency_ms, occurred_at)
       VALUES (?, ?, 'agent-test', 'default', ?, 'circuit_broken', 5, ?)`,
    )
    .run(`rej-${rejSeq}`, toolId, `call-rej-${rejSeq}`, new Date(Date.now() - minutesAgo * MIN_MS).toISOString());
}

function backdateRun(storage: SqliteStorage, runId: string, minutesAgo: number): void {
  rawDb(storage)
    .prepare(`UPDATE eval_runs SET triggered_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - minutesAgo * MIN_MS).toISOString(), runId);
}

const baseInput = (overrides: Partial<PushInput>): PushInput => ({
  name: 'unset',
  version: '1.0',
  capability_text: 'a capability for score lifecycle testing',
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

async function scoreOf(storage: SqliteStorage, name: string): Promise<number> {
  const tool = await storage.getToolByNameVersion(name, '1.0');
  return tool!.metadata.reliability_score;
}

const NO_USAGE = { ok: 0, output_violations: 0, timeout: 0 };

function point(passRate: number, daysAgo: number, now: Date): EvalHistoryPoint {
  return { pass_rate: passRate, triggered_at: new Date(now.getTime() - daysAgo * DAY_MS).toISOString() };
}

function reverifyRun(passRate: number, minutesAgo: number, now: Date, by = 'reverify'): ReverifyRunPoint {
  return {
    pass_rate: passRate,
    triggered_at: new Date(now.getTime() - minutesAgo * MIN_MS).toISOString(),
    triggered_by: by,
  };
}

test('blend: alternating 0.6/1.0 history sits strictly below an all-1.0 history', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');
  const alternating: EvalHistoryPoint[] = [];
  const clean: EvalHistoryPoint[] = [];
  for (let d = 0; d < 10; d++) {
    alternating.push(point(d % 2 === 0 ? 1.0 : 0.6, d, now));
    clean.push(point(1.0, d, now));
  }
  const a = blendReliability(alternating, NO_USAGE, now);
  const b = blendReliability(clean, NO_USAGE, now);
  assert.ok(Math.abs(b - 1.0) < EPS, `all-clean history blends to 1.0, got ${b}`);
  assert.ok(a < b - EPS, `a point sample becomes a history: ${a} must be strictly below ${b}`);
  assert.ok(a > 0.6 && a < 1.0, `alternating blend lands between the extremes, got ${a}`);
});

test('blend: a failure 30 days ago with clean runs since is within tolerance of clean (but never equal)', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');
  const history: EvalHistoryPoint[] = [point(0.0, 30, now)];
  for (let d = 0; d < 30; d++) history.push(point(1.0, d, now));
  const score = blendReliability(history, NO_USAGE, now);
  assert.ok(score > 0.97, `old failure must have faded, got ${score}`);
  assert.ok(score < 1.0 - EPS, 'history is evidence: the failure never fully disappears');
});

test('blend: empty-evidence fallbacks (eval-only, usage-only, both empty) and the 0.8/0.2 split', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');
  const oneClean = [point(1.0, 0, now)];

  assert.ok(Math.abs(blendReliability(oneClean, NO_USAGE, now) - 1.0) < EPS);

  const usageOnly = blendReliability([], { ok: 3, output_violations: 1, timeout: 0 }, now);
  assert.ok(Math.abs(usageOnly - 0.75) < EPS, `usage-only = ok/(ok+ov+to), got ${usageOnly}`);

  const allBad = blendReliability([], { ok: 0, output_violations: 2, timeout: 1 }, now);
  assert.ok(Math.abs(allBad - 0) < EPS);

  assert.equal(blendReliability([], NO_USAGE, now), 0);

  const both = blendReliability(oneClean, { ok: 1, output_violations: 1, timeout: 0 }, now);
  const expected = EVAL_LEG_WEIGHT * 1.0 + USAGE_LEG_WEIGHT * 0.5;
  assert.ok(Math.abs(both - expected) < EPS, `expected ${expected}, got ${both}`);
});

test('blend: a future-dated run (clock skew) clamps to weight 1 — no weight exceeds 1', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');
  const history = [point(0.0, -1, now), point(1.0, 0, now)];
  const score = blendReliability(history, NO_USAGE, now);
  assert.ok(Math.abs(score - 0.5) < EPS, `clamped blend is 0.5, got ${score}`);
});

test('evaluateRecovery: 3 clean spaced reverify runs recover; spam, gaps, and mixed runs do not', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');
  const gate = RELIABILITY_GATE;
  const broke = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MIN_MS).toISOString();

  assert.equal(
    evaluateRecovery([reverifyRun(1.0, 0, now), reverifyRun(1.0, 45, now), reverifyRun(1.0, 90, now)], gate, broke(200)),
    true,
  );
  assert.equal(
    evaluateRecovery([reverifyRun(1.0, 0, now), reverifyRun(1.0, 90, now)], gate, broke(200)),
    false,
  );
  assert.equal(
    evaluateRecovery(
      [
        reverifyRun(1.0, 0, now), reverifyRun(1.0, 45, now), reverifyRun(1.0, 90, now),
        reverifyRun(0.0, 120, now), reverifyRun(1.0, 150, now),
      ],
      gate,
      broke(200),
    ),
    true,
  );
  assert.equal(
    evaluateRecovery(
      [reverifyRun(1.0, 0, now), reverifyRun(0.4, 45, now), reverifyRun(1.0, 90, now), reverifyRun(1.0, 150, now)],
      gate,
      broke(200),
    ),
    false,
  );
  assert.equal(
    evaluateRecovery([reverifyRun(1.0, 0, now), reverifyRun(1.0, 1, now), reverifyRun(1.0, 2, now)], gate, broke(200)),
    false,
  );
  assert.equal(
    evaluateRecovery([reverifyRun(1.0, 0, now), reverifyRun(1.0, 30, now), reverifyRun(1.0, 60, now)], gate, broke(200)),
    true,
  );
  assert.equal(
    evaluateRecovery(
      [
        reverifyRun(1.0, 0, now, 'push'), reverifyRun(1.0, 30, now, 'push'), reverifyRun(1.0, 60, now, 'manual'),
        reverifyRun(1.0, 90, now), reverifyRun(1.0, 180, now),
      ],
      gate,
      broke(200),
    ),
    false,
  );
  assert.equal(
    evaluateRecovery([reverifyRun(gate, 90, now), reverifyRun(gate, 0, now), reverifyRun(gate, 45, now)], gate, broke(200)),
    true,
  );
  assert.equal(
    evaluateRecovery([reverifyRun(1.0, 120, now), reverifyRun(1.0, 60, now), reverifyRun(1.0, 5, now)], gate, now.toISOString()),
    false,
  );
  assert.equal(
    evaluateRecovery([reverifyRun(1.0, 0, now), reverifyRun(1.0, 45, now), reverifyRun(1.0, 90, now)], gate, null),
    false,
  );
});

test('usage leg: output violations drag the blend; input violations and consequence outcomes move nothing', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, {
      name: 'caller-fault-target',
      input_contract: {
        type: 'object',
        properties: { pdf_text: { type: 'string' } },
        required: ['pdf_text'],
        additionalProperties: true,
      },
    });
    await pushOk(storage, {
      name: 'tool-fault-target',
      input_contract: {
        type: 'object',
        properties: { pdf_text: { type: 'string' } },
        required: ['pdf_text'],
        additionalProperties: true,
      },
      output_contract: {
        type: 'object',
        properties: { rows: { type: 'array' } },
        required: ['rows'],
        additionalProperties: true,
      },
      output_repair_strategy: 'llm',
    });

    for (let i = 0; i < 5; i++) {
      const r = await call(storage, 'agent-spammer', 'caller', {
        tool_name: 'caller-fault-target', tool_version: '1.0', input: {},
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, 'input_contract_violation');
    }

    const okCall = await call(storage, 'agent-user', 'caller', {
      tool_name: 'tool-fault-target', tool_version: '1.0', input: { pdf_text: 'Total: 42.0' },
    });
    assert.equal(okCall.ok, true);

    repointStub(storage, 'tool-fault-target', 'malformed-bot-v1');
    const badCall = await call(storage, 'agent-user', 'caller', {
      tool_name: 'tool-fault-target', tool_version: '1.0', input: { pdf_text: 'anything' },
    });
    assert.equal(badCall.ok, false);
    if (!badCall.ok) assert.equal(badCall.error.code, 'output_contract_violation');
    repointStub(storage, 'tool-fault-target', 'pdf-extractor-v3');

    const sweep1 = await reverifyTools(storage);
    assert.equal(sweep1.executed, 2);

    const spammed = await scoreOf(storage, 'caller-fault-target');
    assert.ok(Math.abs(spammed - 1.0) < EPS, `malformed-input spam must not move the score, got ${spammed}`);

    const dragged = await scoreOf(storage, 'tool-fault-target');
    assert.ok(Math.abs(dragged - 0.9) < 1e-6, `output violation must drag the blend to ≈0.9, got ${dragged}`);
    assert.ok(dragged < spammed - 1e-3, 'tool-fault evidence ranks below caller-fault noise');

    const toolB = await storage.getToolByNameVersion('tool-fault-target', '1.0');
    for (const outcome of ['circuit_broken', 'gated'] as const) {
      for (let i = 0; i < 3; i++) {
        await storage.insertUsage({
          tool_id: toolB!.id, agent_id: 'agent-user', namespace_id: 'default',
          call_id: randomUUID(), outcome, latency_ms: 1,
          occurred_at: new Date().toISOString(),
        });
      }
    }
    const sweep2 = await reverifyTools(storage);
    assert.equal(sweep2.executed, 2);
    const afterConsequences = await scoreOf(storage, 'tool-fault-target');
    assert.ok(
      Math.abs(afterConsequences - 0.9) < 1e-6,
      `circuit_broken/gated outcomes are consequences, not evidence: expected ≈0.9, got ${afterConsequences}`,
    );
  } finally {
    await storage.close();
  }
});

test('recovery e2e: rot, circuit-break, restore, 3 spaced clean sweeps → active with a blended (not 1.0) score', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'phoenix' });

    repointStub(storage, 'phoenix', 'rotten-pdf-v1');
    const rotSweep = await reverifyTools(storage);
    assert.deepEqual(rotSweep.gate_dropped, ['phoenix@1.0']);

    await recordBreak(storage, pushed.tool_id, 23 * 60);

    repointStub(storage, 'phoenix', 'pdf-extractor-v3');

    const s1 = await reverifyTools(storage);
    assert.deepEqual(s1.recovered, []);
    assert.equal((await storage.getToolByNameVersion('phoenix', '1.0'))!.status, 'circuit_broken');

    const s2 = await reverifyTools(storage);
    assert.deepEqual(s2.recovered, []);
    assert.equal((await storage.getToolByNameVersion('phoenix', '1.0'))!.status, 'circuit_broken');

    const runs = await storage.listEvalRunsForTool(pushed.tool_id, 10);
    const pushRun = runs.find((r) => r.triggered_by === 'push')!;
    const rotRun = runs.find((r) => r.triggered_by === 'reverify' && r.pass_rate < RELIABILITY_GATE)!;
    const cleanRuns = runs
      .filter((r) => r.triggered_by === 'reverify' && r.pass_rate >= RELIABILITY_GATE)
      .sort((a, b) => a.triggered_at.localeCompare(b.triggered_at));
    backdateRun(storage, pushRun.id!, 2 * 24 * 60);
    backdateRun(storage, rotRun.id!, 24 * 60);
    backdateRun(storage, cleanRuns[0].id!, 90);

    const s3 = await reverifyTools(storage);
    assert.deepEqual(s3.recovered, ['phoenix@1.0']);

    const recovered = await storage.getToolByNameVersion('phoenix', '1.0');
    assert.equal(recovered!.status, 'active', 'circuit_broken -> active is the ONE flip reverify may make');
    assert.ok(
      recovered!.metadata.reliability_score < 1.0 - EPS,
      `recovered score must be blended, got ${recovered!.metadata.reliability_score}`,
    );
    assert.ok(recovered!.metadata.reliability_score > 0.5, 'three cleans outweigh one rot run');
  } finally {
    await storage.close();
  }
});

test('recovery: never fires while the tool is still rotten, even with spacing', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'zombie' });
    repointStub(storage, 'zombie', 'rotten-pdf-v1');
    await recordBreak(storage, pushed.tool_id, 240);

    await reverifyTools(storage);
    await reverifyTools(storage);
    const runs = await storage.listEvalRunsForTool(pushed.tool_id, 10);
    const dirty = runs
      .filter((r) => r.triggered_by === 'reverify')
      .sort((a, b) => a.triggered_at.localeCompare(b.triggered_at));
    backdateRun(storage, dirty[0].id!, 180);
    backdateRun(storage, dirty[1].id!, 90);
    const s3 = await reverifyTools(storage);

    assert.deepEqual(s3.recovered, []);
    assert.equal((await storage.getToolByNameVersion('zombie', '1.0'))!.status, 'circuit_broken');
  } finally {
    await storage.close();
  }
});

test('recovery: 3 back-to-back clean sweeps do NOT recover (no 60min span); spacing then unlocks it', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'sprinter' });
    await recordBreak(storage, pushed.tool_id, 240);

    await reverifyTools(storage);
    await reverifyTools(storage);
    const s3 = await reverifyTools(storage);
    assert.deepEqual(s3.recovered, [], 'back-to-back cleans carry the evidence of one sweep');
    assert.equal((await storage.getToolByNameVersion('sprinter', '1.0'))!.status, 'circuit_broken');

    const runs = await storage.listEvalRunsForTool(pushed.tool_id, 10);
    const cleans = runs
      .filter((r) => r.triggered_by === 'reverify')
      .sort((a, b) => a.triggered_at.localeCompare(b.triggered_at));
    backdateRun(storage, cleans[0].id!, 180);
    backdateRun(storage, cleans[1].id!, 120);
    backdateRun(storage, cleans[2].id!, 90);
    const s4 = await reverifyTools(storage);
    assert.deepEqual(s4.recovered, ['sprinter@1.0']);
    assert.equal((await storage.getToolByNameVersion('sprinter', '1.0'))!.status, 'active');
  } finally {
    await storage.close();
  }
});

test('recovery: filtered requests refresh scores but NEVER flip status; the unfiltered sweep does', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'gatekeeper' });
    await recordBreak(storage, pushed.tool_id, 240);

    await reverifyTools(storage);
    await reverifyTools(storage);
    await reverifyTools(storage);
    const runs = await storage.listEvalRunsForTool(pushed.tool_id, 10);
    const cleans = runs
      .filter((r) => r.triggered_by === 'reverify')
      .sort((a, b) => a.triggered_at.localeCompare(b.triggered_at));
    backdateRun(storage, cleans[0].id!, 180);
    backdateRun(storage, cleans[1].id!, 120);
    backdateRun(storage, cleans[2].id!, 90);

    const filtered = await reverifyTools(storage, { toolName: 'gatekeeper', toolVersion: '1.0' });
    assert.equal(filtered.executed, 1);
    assert.deepEqual(filtered.recovered, []);
    assert.equal(
      (await storage.getToolByNameVersion('gatekeeper', '1.0'))!.status,
      'circuit_broken',
      'filtered path can re-score but never flips status',
    );

    const unfiltered = await reverifyTools(storage);
    assert.deepEqual(unfiltered.recovered, ['gatekeeper@1.0']);
    assert.equal((await storage.getToolByNameVersion('gatekeeper', '1.0'))!.status, 'active');
  } finally {
    await storage.close();
  }
});

test('recovery direction guards: pending is never touched; active tools never get recovery writes', async () => {
  const storage = await freshStorage();
  try {
    await storage.upsertTool(
      {
        name: 'limbo', version: '1.0', author_agent_id: 'agent-author',
        capability_text: 'a half-published tool',
        input_contract: { type: 'object', additionalProperties: true },
        output_contract: { type: 'object', additionalProperties: true },
        output_repair_strategy: 'fail-fast',
        endpoint_stub_name: 'pdf-extractor-v3',
        metadata: { cost_per_call_usd: 0, p95_latency_ms: 100, reliability_score: 0 },
        status: 'pending',
      },
      makeUnitVec(21),
    );
    const limbo = await storage.getToolByNameVersion('limbo', '1.0');
    for (const minutesAgo of [180, 120, 90]) {
      await storage.insertEvalRun({
        tool_id: limbo!.id, tool_name: 'limbo', tool_version: '1.0',
        namespace_id: 'default',
        triggered_at: new Date(Date.now() - minutesAgo * MIN_MS).toISOString(),
        triggered_by: 'reverify', cases: [], pass_count: 5, total_count: 5,
        pass_rate: 1.0, duration_ms: 1,
      });
    }

    const steady = await pushOk(storage, { name: 'steady' });
    await reverifyTools(storage);
    await reverifyTools(storage);
    const steadyRuns = await storage.listEvalRunsForTool(steady.tool_id, 10);
    const steadyCleans = steadyRuns
      .filter((r) => r.triggered_by === 'reverify')
      .sort((a, b) => a.triggered_at.localeCompare(b.triggered_at));
    backdateRun(storage, steadyCleans[0].id!, 90);

    const sweep = await reverifyTools(storage);
    assert.deepEqual(sweep.recovered, [], 'no recovery writes for pending or active tools');
    assert.ok(
      sweep.skipped.some((s) => s.name === 'limbo' && s.reason === 'pending-status'),
      'pending stays behind the pending-status partition',
    );
    assert.equal((await storage.getToolByNameVersion('limbo', '1.0'))!.status, 'pending');
    assert.equal((await storage.getToolByNameVersion('steady', '1.0'))!.status, 'active');
  } finally {
    await storage.close();
  }
});

test('reverify score is blended: prior bad runs hold a clean latest run below its pass_rate and out of discover', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'historian', capability_text: HIST_CAPABILITY });
    const found = await discover(storage, embedder, HIST_QUERY, 5);
    assert.ok(found.results.some((r) => r.name === 'historian'), 'healthy tool starts discoverable');

    repointStub(storage, 'historian', 'rotten-pdf-v1');
    await reverifyTools(storage);
    const afterRot = await scoreOf(storage, 'historian');
    assert.ok(Math.abs(afterRot - 0.5) < 1e-3, `rot blend ≈ 0.5, got ${afterRot}`);

    repointStub(storage, 'historian', 'pdf-extractor-v3');
    const restoreSweep = await reverifyTools(storage);
    assert.equal(restoreSweep.passed, 1, 'the raw restore run is clean');

    const afterRestore = await scoreOf(storage, 'historian');
    assert.ok(Math.abs(afterRestore - 2 / 3) < 1e-3, `restore blend ≈ 0.667, got ${afterRestore}`);
    assert.ok(afterRestore < 1.0 - EPS);

    const gated = await discover(storage, embedder, HIST_QUERY, 5);
    assert.ok(
      !gated.results.some((r) => r.name === 'historian'),
      'blended score below 0.80 must keep the tool out of discover',
    );
  } finally {
    await storage.close();
  }
});

test('summary: a run can be passed yet gate_dropped (clean run, history still bad)', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'sleeper' });
    for (const minutesAgo of [30, 20, 10]) {
      await storage.insertEvalRun({
        tool_id: pushed.tool_id, tool_name: 'sleeper', tool_version: '1.0',
        namespace_id: 'default',
        triggered_at: new Date(Date.now() - minutesAgo * MIN_MS).toISOString(),
        triggered_by: 'reverify', cases: [], pass_count: 0, total_count: 5,
        pass_rate: 0, duration_ms: 1,
      });
    }
    assert.ok(Math.abs(await scoreOf(storage, 'sleeper') - 1.0) < EPS, 'materialized score still 1.0 pre-sweep');

    const sweep = await reverifyTools(storage);
    assert.equal(sweep.passed, 1, 'the raw run itself is clean');
    assert.equal(sweep.failed, 0);
    assert.deepEqual(sweep.gate_dropped, ['sleeper@1.0'], 'but the blend crossed the gate downward');
    const score = await scoreOf(storage, 'sleeper');
    assert.ok(Math.abs(score - 0.4) < 1e-3, `expected ≈0.4, got ${score}`);
  } finally {
    await storage.close();
  }
});

test('summary: a run can fail without gate_dropped (deep clean history keeps the blend above gate)', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'veteran' });
    for (let i = 1; i <= 20; i++) {
      await storage.insertEvalRun({
        tool_id: pushed.tool_id, tool_name: 'veteran', tool_version: '1.0',
        namespace_id: 'default',
        triggered_at: new Date(Date.now() - i * 180 * MIN_MS).toISOString(),
        triggered_by: 'reverify', cases: [], pass_count: 5, total_count: 5,
        pass_rate: 1.0, duration_ms: 1,
      });
    }

    repointStub(storage, 'veteran', 'rotten-pdf-v1');
    const sweep = await reverifyTools(storage);
    assert.equal(sweep.failed, 1, 'the raw run fails');
    assert.deepEqual(sweep.gate_dropped, [], 'one bad run cannot zero months of clean evidence');
    const score = await scoreOf(storage, 'veteran');
    assert.ok(score >= RELIABILITY_GATE, `blend stays above the gate, got ${score}`);
    assert.ok(score < 1.0 - EPS, 'the failure still registers as evidence');
  } finally {
    await storage.close();
  }
});

test('errored entries carry {tool, error} diagnostics and the sweep continues', async () => {
  const storage = await freshStorage();
  try {
    await pushOk(storage, { name: 'doomed-a' });
    await pushOk(storage, { name: 'doomed-b' });

    rawDb(storage).prepare(`ALTER TABLE eval_runs RENAME TO eval_runs_hidden`).run();

    const summary = await reverifyTools(storage);
    assert.equal(summary.executed, 0);
    assert.equal(summary.errored.length, 2, 'per-tool containment: both fail, the sweep survives');
    const tools = summary.errored.map((e) => e.tool).sort();
    assert.deepEqual(tools, ['doomed-a@1.0', 'doomed-b@1.0']);
    for (const e of summary.errored) {
      assert.equal(typeof e.error, 'string');
      assert.ok(e.error.length > 0, 'the diagnostic message must surface');
      assert.match(e.error, /eval_runs/, 'the real failure cause is visible');
    }
  } finally {
    await storage.close();
  }
});

test('recovery: a clean PRE-break history never recovers a live-broken tool', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'sleeper' });

    await reverifyTools(storage);
    await reverifyTools(storage);
    await reverifyTools(storage);
    const runs = await storage.listEvalRunsForTool(pushed.tool_id, 10);
    const cleans = runs
      .filter((r) => r.triggered_by === 'reverify')
      .sort((a, b) => (a.triggered_at < b.triggered_at ? -1 : 1));
    backdateRun(storage, cleans[0].id!, 180);
    backdateRun(storage, cleans[1].id!, 120);
    backdateRun(storage, cleans[2].id!, 90);

    await recordBreak(storage, pushed.tool_id, 30);

    const s = await reverifyTools(storage);
    assert.deepEqual(s.recovered, [], 'pre-break evidence must never recover a tool');
    assert.equal((await storage.getToolByNameVersion('sleeper', '1.0'))!.status, 'circuit_broken');
  } finally {
    await storage.close();
  }
});

test('recovery: no recorded break evidence fails CLOSED', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'ghost' });
    await storage.setStatus(pushed.tool_id, 'circuit_broken');

    await reverifyTools(storage);
    await reverifyTools(storage);
    await reverifyTools(storage);
    const runs = await storage.listEvalRunsForTool(pushed.tool_id, 10);
    const cleans = runs
      .filter((r) => r.triggered_by === 'reverify')
      .sort((a, b) => (a.triggered_at < b.triggered_at ? -1 : 1));
    backdateRun(storage, cleans[0].id!, 180);
    backdateRun(storage, cleans[1].id!, 120);
    backdateRun(storage, cleans[2].id!, 90);

    const s = await reverifyTools(storage);
    assert.deepEqual(s.recovered, [], 'no break timestamp -> recovery never guesses');
    assert.equal((await storage.getToolByNameVersion('ghost', '1.0'))!.status, 'circuit_broken');
  } finally {
    await storage.close();
  }
});

test('recovery: post-break 503 rejections never advance the watermark (liveness)', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'retried' });
    await recordBreak(storage, pushed.tool_id, 300);

    await reverifyTools(storage);
    await reverifyTools(storage);
    await reverifyTools(storage);
    const runs = await storage.listEvalRunsForTool(pushed.tool_id, 10);
    const cleans = runs
      .filter((r) => r.triggered_by === 'reverify')
      .sort((a, b) => (a.triggered_at < b.triggered_at ? -1 : 1));
    backdateRun(storage, cleans[0].id!, 180);
    backdateRun(storage, cleans[1].id!, 120);
    backdateRun(storage, cleans[2].id!, 90);

    recordRejection(storage, pushed.tool_id, 150);
    recordRejection(storage, pushed.tool_id, 60);
    recordRejection(storage, pushed.tool_id, 5);

    const s = await reverifyTools(storage);
    assert.deepEqual(s.recovered, ['retried@1.0'], 'rejections carry no health evidence and must not block recovery');
    assert.equal((await storage.getToolByNameVersion('retried', '1.0'))!.status, 'active');
  } finally {
    await storage.close();
  }
});

test('markCircuitBroken: the transition winner stamps broken_at; losers are no-ops', async () => {
  const storage = await freshStorage();
  try {
    const pushed = await pushOk(storage, { name: 'contested' });
    const first = new Date(Date.now() - 120 * MIN_MS).toISOString();
    const second = new Date(Date.now() - 5 * MIN_MS).toISOString();

    await storage.markCircuitBroken(pushed.tool_id, first);
    await storage.markCircuitBroken(pushed.tool_id, second);

    const tool = await storage.getToolByNameVersion('contested', '1.0');
    assert.equal(tool!.status, 'circuit_broken');
    assert.equal(tool!.metadata.broken_at, first, 'losing concurrent flip must not advance the watermark');
  } finally {
    await storage.close();
  }
});
