// E3 contract drift tests — real SQLite :memory:, no mocks, push-level where
// possible. The rule table in docs/plans/2026-06-10-e3-contract-drift.md is
// the single normative spec; the matrix test below mirrors it cell by cell.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { push, type PushInput } from '../src/services/push.js';
import {
  diffContracts,
  compareVersions,
  majorOf,
  MAX_DIFF_DEPTH,
} from '../src/services/contractDiff.js';
import { FIXTURE_TOOLS } from '../src/fixtures/tools.js';
import type { DriftDirection, DriftClassification, Embedder, Storage } from '../src/types.js';
import '../src/services/stubs.js';

class StubEmbedder implements Embedder {
  name() { return 'stub:zero'; }
  dim() { return 768; }
  async embed(): Promise<Float32Array> { return makeUnitVec(1); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, i) => makeUnitVec(i + 1));
  }
  async prewarm() {}
  async cachedEmbed() { return { vec: makeUnitVec(1), cached: false, ms: 0 }; }
}

function makeUnitVec(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

let storage: SqliteStorage;
const embedder = new StubEmbedder();

before(async () => {
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
});

after(async () => {
  await storage.close();
});

// ---- helpers ----------------------------------------------------------------

type Schema = Record<string, unknown>;

const schema = (props: Record<string, unknown>, extra: Schema = {}): Schema => ({
  type: 'object',
  properties: props,
  ...extra,
});

const str = { type: 'string' };
const num = { type: 'number' };

async function pushVersion(
  name: string,
  version: string,
  input_contract: Schema,
  output_contract: Schema,
  author = 'drift-author',
) {
  const body: PushInput = {
    name,
    version,
    capability_text: 'a capability used by contract drift tests',
    input_contract,
    output_contract,
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'pdf-extractor-v3',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 100 },
  };
  return push(storage, embedder, author, body);
}

function deepSchema(depth: number, leafType: string): Schema {
  let node: Schema = { type: leafType };
  for (let i = 0; i < depth; i++) node = { type: 'object', properties: { a: node } };
  return node;
}

// ---- 13. differ unit table-test over the full rule matrix --------------------

test('differ rule matrix: every rule-table cell, both directions', () => {
  const cases: Array<{
    name: string;
    prev: Schema;
    next: Schema;
    direction: DriftDirection;
    expected: DriftClassification;
    kind?: string;
  }> = [
    // identical under key/required reorder (canonical comparison, set semantics)
    { name: 'reordered keys + required set', direction: 'input', expected: 'identical',
      prev: { type: 'object', properties: { a: str, b: str }, required: ['a', 'b'] },
      next: { required: ['b', 'a'], properties: { b: str, a: str }, type: 'object' } },
    // property added (optional): compatible / compatible
    { name: 'optional prop added', direction: 'input', expected: 'compatible', kind: 'property-added-optional',
      prev: schema({ a: str }, { required: ['a'] }), next: schema({ a: str, b: str }, { required: ['a'] }) },
    { name: 'optional prop added', direction: 'output', expected: 'compatible',
      prev: schema({ a: str }, { required: ['a'] }), next: schema({ a: str, b: str }, { required: ['a'] }) },
    // property added (required): breaking input / compatible output
    { name: 'required prop added', direction: 'input', expected: 'breaking', kind: 'property-added-required',
      prev: schema({ a: str }, { required: ['a'] }), next: schema({ a: str, b: str }, { required: ['a', 'b'] }) },
    { name: 'required prop added', direction: 'output', expected: 'compatible',
      prev: schema({ a: str }, { required: ['a'] }), next: schema({ a: str, b: str }, { required: ['a', 'b'] }) },
    // PINNED: removed input prop + new-AP false => breaking
    { name: 'prop removed, new AP false', direction: 'input', expected: 'breaking', kind: 'property-removed',
      prev: schema({ a: str, b: str }, { additionalProperties: false }),
      next: schema({ a: str }, { additionalProperties: false }) },
    // PINNED: removed input prop + new-AP true => compatible
    { name: 'prop removed, new AP true', direction: 'input', expected: 'compatible', kind: 'property-removed',
      prev: schema({ a: str, b: str }, { additionalProperties: true }),
      next: schema({ a: str }, { additionalProperties: true }) },
    // removed input prop + new-AP ABSENT (absent = true) => compatible
    { name: 'prop removed, new AP absent', direction: 'input', expected: 'compatible',
      prev: schema({ a: str, b: str }), next: schema({ a: str }) },
    // PINNED combo: prior-AP false -> new-AP true + prop removed => compatible
    { name: 'combo AP false->true + prop removed', direction: 'input', expected: 'compatible',
      prev: schema({ a: str, b: str }, { additionalProperties: false }),
      next: schema({ a: str }, { additionalProperties: true }) },
    // property removed on output: always breaking
    { name: 'prop removed', direction: 'output', expected: 'breaking', kind: 'property-removed',
      prev: schema({ a: str, b: str }, { additionalProperties: true }),
      next: schema({ a: str }, { additionalProperties: true }) },
    // retyped: breaking both directions
    { name: 'prop retyped', direction: 'input', expected: 'breaking', kind: 'type-changed',
      prev: schema({ a: str }), next: schema({ a: num }) },
    { name: 'prop retyped', direction: 'output', expected: 'breaking', kind: 'type-changed',
      prev: schema({ a: str }), next: schema({ a: num }) },
    // enum narrowed: breaking input / compatible output
    { name: 'enum narrowed', direction: 'input', expected: 'breaking', kind: 'enum-narrowed',
      prev: schema({ a: { type: 'string', enum: ['x', 'y', 'z'] } }),
      next: schema({ a: { type: 'string', enum: ['x', 'y'] } }) },
    { name: 'enum narrowed', direction: 'output', expected: 'compatible', kind: 'enum-narrowed',
      prev: schema({ a: { type: 'string', enum: ['x', 'y', 'z'] } }),
      next: schema({ a: { type: 'string', enum: ['x', 'y'] } }) },
    // enum widened: compatible input / breaking output
    { name: 'enum widened', direction: 'input', expected: 'compatible', kind: 'enum-widened',
      prev: schema({ a: { type: 'string', enum: ['x', 'y'] } }),
      next: schema({ a: { type: 'string', enum: ['x', 'y', 'z'] } }) },
    { name: 'enum widened', direction: 'output', expected: 'breaking', kind: 'enum-widened',
      prev: schema({ a: { type: 'string', enum: ['x', 'y'] } }),
      next: schema({ a: { type: 'string', enum: ['x', 'y', 'z'] } }) },
    // enum constraint added (narrowed from unconstrained) / removed (widened)
    { name: 'enum added', direction: 'input', expected: 'breaking', kind: 'enum-narrowed',
      prev: schema({ a: str }), next: schema({ a: { type: 'string', enum: ['x'] } }) },
    { name: 'enum removed', direction: 'input', expected: 'compatible', kind: 'enum-widened',
      prev: schema({ a: { type: 'string', enum: ['x'] } }), next: schema({ a: str }) },
    { name: 'enum removed', direction: 'output', expected: 'breaking', kind: 'enum-widened',
      prev: schema({ a: { type: 'string', enum: ['x'] } }), next: schema({ a: str }) },
    // required added on existing prop: breaking input / compatible output
    { name: 'required added on existing', direction: 'input', expected: 'breaking', kind: 'required-added',
      prev: schema({ a: str, b: str }, { required: ['a'] }),
      next: schema({ a: str, b: str }, { required: ['a', 'b'] }) },
    { name: 'required added on existing', direction: 'output', expected: 'compatible',
      prev: schema({ a: str, b: str }, { required: ['a'] }),
      next: schema({ a: str, b: str }, { required: ['a', 'b'] }) },
    // required removed (prop kept): compatible input / breaking output
    { name: 'required removed', direction: 'input', expected: 'compatible', kind: 'required-removed',
      prev: schema({ a: str, b: str }, { required: ['a', 'b'] }),
      next: schema({ a: str, b: str }, { required: ['a'] }) },
    { name: 'required removed', direction: 'output', expected: 'breaking', kind: 'required-removed',
      prev: schema({ a: str, b: str }, { required: ['a', 'b'] }),
      next: schema({ a: str, b: str }, { required: ['a'] }) },
    // additionalProperties true->false: breaking input / compatible output
    { name: 'AP true->false', direction: 'input', expected: 'breaking', kind: 'additional-properties-restricted',
      prev: schema({ a: str }, { additionalProperties: true }),
      next: schema({ a: str }, { additionalProperties: false }) },
    { name: 'AP true->false', direction: 'output', expected: 'compatible',
      prev: schema({ a: str }, { additionalProperties: true }),
      next: schema({ a: str }, { additionalProperties: false }) },
    // AP absent (= true) -> false: breaking input
    { name: 'AP absent->false', direction: 'input', expected: 'breaking', kind: 'additional-properties-restricted',
      prev: schema({ a: str }), next: schema({ a: str }, { additionalProperties: false }) },
    // additionalProperties false->true: compatible input / breaking output
    { name: 'AP false->true', direction: 'input', expected: 'compatible',
      prev: schema({ a: str }, { additionalProperties: false }),
      next: schema({ a: str }, { additionalProperties: true }) },
    { name: 'AP false->true', direction: 'output', expected: 'breaking', kind: 'additional-properties-relaxed',
      prev: schema({ a: str }, { additionalProperties: false }),
      next: schema({ a: str }, { additionalProperties: true }) },
    // unmodeled constructs: conservative breaking, both directions
    { name: 'pattern changed', direction: 'input', expected: 'breaking', kind: 'unknown-construct-changed',
      prev: schema({ a: { type: 'string', pattern: '^a' } }), next: schema({ a: { type: 'string', pattern: '^b' } }) },
    { name: 'pattern changed', direction: 'output', expected: 'breaking', kind: 'unknown-construct-changed',
      prev: schema({ a: { type: 'string', pattern: '^a' } }), next: schema({ a: { type: 'string', pattern: '^b' } }) },
    { name: 'minimum changed', direction: 'input', expected: 'breaking', kind: 'unknown-construct-changed',
      prev: schema({ a: { type: 'number', minimum: 0 } }), next: schema({ a: { type: 'number', minimum: 1 } }) },
    { name: 'oneOf changed at root', direction: 'output', expected: 'breaking', kind: 'unknown-construct-changed',
      prev: { oneOf: [{ type: 'string' }] }, next: { oneOf: [{ type: 'number' }] } },
    // items tuple form: unmodeled
    { name: 'items tuple form', direction: 'input', expected: 'breaking', kind: 'unknown-construct-changed',
      prev: schema({ list: { type: 'array', items: [str] } }),
      next: schema({ list: { type: 'array', items: [num] } }) },
    // depth cap: conservative breaking
    { name: 'depth exceeded', direction: 'input', expected: 'breaking', kind: 'depth-exceeded',
      prev: deepSchema(MAX_DIFF_DEPTH + 4, 'string'), next: deepSchema(MAX_DIFF_DEPTH + 4, 'number') },
  ];

  for (const c of cases) {
    const d = diffContracts(c.prev, c.next, c.direction);
    assert.equal(d.classification, c.expected, `${c.name} [${c.direction}]: got ${JSON.stringify(d.changes)}`);
    if (c.kind) {
      assert.ok(
        d.changes.some((ch) => ch.kind === c.kind),
        `${c.name} [${c.direction}]: expected a ${c.kind} change, got ${JSON.stringify(d.changes)}`,
      );
    }
  }
});

test('differ recurses single-schema items and reports the exact path', () => {
  const prev = schema({ list: { type: 'array', items: schema({ x: num }) } });
  const next = schema({ list: { type: 'array', items: schema({ x: str }) } });
  const d = diffContracts(prev, next, 'output');
  assert.equal(d.classification, 'breaking');
  assert.equal(d.changes.length, 1);
  assert.equal(d.changes[0]!.path, 'properties.list.items.properties.x.type');
  assert.equal(d.changes[0]!.kind, 'type-changed');
});

test('compareVersions and majorOf: loose numeric segment ordering', () => {
  assert.ok(compareVersions('1.9', '1.10') < 0, '1.9 < 1.10');
  assert.ok(compareVersions('1.10', '1.9') > 0, '1.10 > 1.9');
  assert.equal(compareVersions('1.2', '1.2.0'), 0, 'missing segments = 0');
  assert.ok(compareVersions('2.0', '1.99') > 0, '2.0 > 1.99');
  assert.ok(compareVersions('1.0a', '1.0b') < 0, 'string remainder compares after numeric prefix');
  assert.equal(majorOf('3.1'), 3);
  assert.equal(majorOf('10.2.3'), 10);
  assert.equal(majorOf('3a.1'), 3);
  assert.equal(majorOf('v3'), null);
  assert.equal(majorOf('beta'), null);
});

// ---- push-level: the breaking gate -------------------------------------------

const IN_BASE = schema({ q: str }, { required: ['q'], additionalProperties: true });
const OUT_BASE = schema({ value: num }, { required: ['value'], additionalProperties: false });

test('1. retyped output field on minor bump is rejected, message names the path', async () => {
  assert.equal((await pushVersion('drift-retype-minor', '1.0', IN_BASE, OUT_BASE)).ok, true);
  const r = await pushVersion('drift-retype-minor', '1.1', IN_BASE,
    schema({ value: str }, { required: ['value'], additionalProperties: false }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'breaking_contract_requires_major_bump');
  assert.match(r.message, /properties\.value/);
  assert.ok(r.details, 'error carries the full diff in details');
  const output = r.details['output'] as { classification: string };
  assert.equal(output.classification, 'breaking');
});

test('2. same retype on MAJOR bump is accepted, breaking event recorded with path', async () => {
  assert.equal((await pushVersion('drift-retype-major', '1.0', IN_BASE, OUT_BASE)).ok, true);
  const r = await pushVersion('drift-retype-major', '2.0', IN_BASE,
    schema({ value: str }, { required: ['value'], additionalProperties: false }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.drift?.from_version, '1.0');
  assert.equal(r.drift?.output.classification, 'breaking');
  const events = await storage.listDriftEvents('drift-retype-major');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.direction, 'output');
  assert.equal(events[0]!.classification, 'breaking');
  assert.ok(events[0]!.changes.some((c) => c.path === 'properties.value.type' && c.kind === 'type-changed'));
});

test('3. additive optional input prop: compatible, accepted, event recorded', async () => {
  assert.equal((await pushVersion('drift-add-optional', '1.0', IN_BASE, OUT_BASE)).ok, true);
  const r = await pushVersion('drift-add-optional', '1.1',
    schema({ q: str, verbose: { type: 'boolean' } }, { required: ['q'], additionalProperties: true }),
    OUT_BASE);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.drift?.input.classification, 'compatible');
  assert.equal(r.drift?.output.classification, 'identical');
  const events = await storage.listDriftEvents('drift-add-optional');
  assert.equal(events.length, 1, 'identical output direction writes no event');
  assert.equal(events[0]!.direction, 'input');
  assert.equal(events[0]!.classification, 'compatible');
});

test('4. new REQUIRED input prop on minor bump is rejected', async () => {
  assert.equal((await pushVersion('drift-add-required', '1.0', IN_BASE, OUT_BASE)).ok, true);
  const r = await pushVersion('drift-add-required', '1.1',
    schema({ q: str, lang: str }, { required: ['q', 'lang'], additionalProperties: true }),
    OUT_BASE);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'breaking_contract_requires_major_bump');
});

test('5. input enum narrowed rejected; output enum narrowed accepted as compatible', async () => {
  const inEnum = (values: string[]) =>
    schema({ mode: { type: 'string', enum: values } }, { additionalProperties: true });
  assert.equal((await pushVersion('drift-enum-in', '1.0', inEnum(['fast', 'slow', 'auto']), OUT_BASE)).ok, true);
  const rejected = await pushVersion('drift-enum-in', '1.1', inEnum(['fast', 'slow']), OUT_BASE);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'breaking_contract_requires_major_bump');

  const outEnum = (values: string[]) =>
    schema({ status: { type: 'string', enum: values } }, { additionalProperties: false });
  assert.equal((await pushVersion('drift-enum-out', '1.0', IN_BASE, outEnum(['ok', 'error', 'partial'])).then((r) => r.ok)), true);
  const accepted = await pushVersion('drift-enum-out', '1.1', IN_BASE, outEnum(['ok', 'error']));
  assert.equal(accepted.ok, true);
  const events = await storage.listDriftEvents('drift-enum-out');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.classification, 'compatible');
  assert.ok(events[0]!.changes.some((c) => c.kind === 'enum-narrowed'));
});

test('6. output enum widened on minor bump is rejected', async () => {
  const outEnum = (values: string[]) =>
    schema({ status: { type: 'string', enum: values } }, { additionalProperties: false });
  assert.equal((await pushVersion('drift-enum-widen', '1.0', IN_BASE, outEnum(['ok', 'error']))).ok, true);
  const r = await pushVersion('drift-enum-widen', '1.1', IN_BASE, outEnum(['ok', 'error', 'partial']));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'breaking_contract_requires_major_bump');
});

test('7. input additionalProperties true->false on minor bump is rejected', async () => {
  assert.equal((await pushVersion('drift-ap', '1.0', IN_BASE, OUT_BASE)).ok, true);
  const r = await pushVersion('drift-ap', '1.1',
    schema({ q: str }, { required: ['q'], additionalProperties: false }), OUT_BASE);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'breaking_contract_requires_major_bump');
  assert.match(r.message, /additionalProperties/);
});

test('8. removed output property on minor bump is rejected', async () => {
  const outTwo = schema({ value: num, unit: str }, { required: ['value'], additionalProperties: false });
  assert.equal((await pushVersion('drift-remove-out', '1.0', IN_BASE, outTwo)).ok, true);
  const r = await pushVersion('drift-remove-out', '1.1', IN_BASE, OUT_BASE);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'breaking_contract_requires_major_bump');
  assert.match(r.message, /properties\.unit/);
});

test('9. identical contracts: accepted, drift reported identical, NO event rows', async () => {
  assert.equal((await pushVersion('drift-identical', '1.0', IN_BASE, OUT_BASE)).ok, true);
  // Same contracts with reordered keys — canonical comparison must see through it.
  const reorderedIn = { additionalProperties: true, required: ['q'], properties: { q: str }, type: 'object' };
  const r = await pushVersion('drift-identical', '1.1', reorderedIn, OUT_BASE);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.drift?.input.classification, 'identical');
  assert.equal(r.drift?.output.classification, 'identical');
  const events = await storage.listDriftEvents('drift-identical');
  assert.equal(events.length, 0);
});

test('10. first version: no drift check, no drift field, no events', async () => {
  const r = await pushVersion('drift-first', '1.0', IN_BASE, OUT_BASE);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.drift, undefined);
  const events = await storage.listDriftEvents('drift-first');
  assert.equal(events.length, 0);
});

test('11. unknown construct (pattern changed) on minor bump is rejected', async () => {
  const inPattern = (p: string) =>
    schema({ q: { type: 'string', pattern: p } }, { required: ['q'], additionalProperties: true });
  assert.equal((await pushVersion('drift-pattern', '1.0', inPattern('^a'), OUT_BASE)).ok, true);
  const r = await pushVersion('drift-pattern', '1.1', inPattern('^b'), OUT_BASE);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'breaking_contract_requires_major_bump');
  assert.match(r.message, /pattern/);
});

test('12a. prior version picked by numeric order: 1.10 beats 1.9', async () => {
  const inWithExtra = (extraType: Schema) =>
    schema({ q: str, extra: extraType }, { required: ['q'], additionalProperties: true });
  assert.equal((await pushVersion('drift-order', '1.9', IN_BASE, OUT_BASE)).ok, true);
  assert.equal((await pushVersion('drift-order', '1.10', inWithExtra(str), OUT_BASE)).ok, true);
  // vs 1.10 this retypes `extra` (breaking); vs 1.9 it would merely ADD an
  // optional prop (compatible) — so a rejection proves the prior was 1.10.
  const r = await pushVersion('drift-order', '1.11', inWithExtra(num), OUT_BASE);
  assert.equal(r.ok, false, 'lexical max 1.9 would have let this through');
  if (r.ok) return;
  assert.equal(r.code, 'breaking_contract_requires_major_bump');
  assert.ok(r.details);
  assert.equal(r.details['from_version'], '1.10');
});

test('12b. unparseable version + breaking change rejects fail-loud', async () => {
  assert.equal((await pushVersion('drift-unparseable', '1.0', IN_BASE, OUT_BASE)).ok, true);
  const r = await pushVersion('drift-unparseable', 'two.0', IN_BASE,
    schema({ value: str }, { required: ['value'], additionalProperties: false }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'breaking_contract_requires_major_bump');
  assert.match(r.message, /not numerically ordered/);
});

// ---- demo regression (CLAUDE.md rule 8: never break the demo) ----------------

test('demo regression: seeded 3.0 -> demo 3.1 classifies identical/identical', async () => {
  const seed = FIXTURE_TOOLS.find((t) => t.name === 'pdf-extractor' && t.version === '3.0');
  assert.ok(seed, 'seeded pdf-extractor@3.0 fixture exists');
  const r30 = await push(storage, embedder, seed.author_agent_id, {
    name: seed.name,
    version: seed.version,
    capability_text: seed.capability_text,
    input_contract: seed.input_contract,
    output_contract: seed.output_contract,
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: seed.endpoint_stub_name,
    metadata: { cost_per_call_usd: seed.cost_per_call_usd, p95_latency_ms: seed.p95_latency_ms },
  });
  assert.equal(r30.ok, true, 'seed 3.0 push succeeds');

  const demoPath = fileURLToPath(new URL('../demo/pdf-extractor-3.1.json', import.meta.url));
  const demo31 = JSON.parse(readFileSync(demoPath, 'utf-8')) as PushInput;
  const r31 = await push(storage, embedder, seed.author_agent_id, demo31);
  assert.equal(r31.ok, true, 'demo Beat 2 push must succeed (rule 8)');
  if (!r31.ok) return;
  assert.equal(r31.drift?.from_version, '3.0');
  assert.equal(r31.drift?.input.classification, 'identical');
  assert.equal(r31.drift?.output.classification, 'identical');
  const events = await storage.listDriftEvents('pdf-extractor');
  assert.equal(events.length, 0, 'identical drift writes no events');
});

// ---- fail-soft event write (pinned execute decision) --------------------------

test('drift event write failure is fail-soft: push still succeeds', async () => {
  assert.equal((await pushVersion('drift-failsoft', '1.0', IN_BASE, OUT_BASE)).ok, true);
  // Failure injection on the NEW write path only — everything else is the
  // real SQLite storage (this is not a DB mock; the insert genuinely throws).
  const failing = new Proxy(storage as Storage, {
    get(target, prop, receiver) {
      if (prop === 'insertDriftEvent') {
        return async () => {
          throw new Error('injected drift write failure');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const body: PushInput = {
    name: 'drift-failsoft',
    version: '1.1',
    capability_text: 'a capability used by contract drift tests',
    input_contract: schema({ q: str, verbose: { type: 'boolean' } }, { required: ['q'], additionalProperties: true }),
    output_contract: OUT_BASE,
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'pdf-extractor-v3',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 100 },
  };
  const r = await push(failing, embedder, 'drift-author', body);
  assert.equal(r.ok, true, 'push must not fail on a drift event write error');
  const events = await storage.listDriftEvents('drift-failsoft');
  assert.equal(events.length, 0, 'the injected failure prevented the event write');
});

// ---- Fail-open hole regression (code-review HIGH) -------------------------
// Identically-malformed guard shapes (`required` as a string, `properties` as
// an array) used to early-return WITHOUT diffing the structure beneath, so a
// breaking change under them classified `identical` and bypassed the gate.
// Malformed-but-equal pieces are now treated as empty and the diff continues.

test('differ: identically-malformed required does not mask a retype beneath', () => {
  const prevSchema = {
    type: 'object',
    required: 'not-an-array',
    properties: { amount: { type: 'number' } },
  } as Record<string, unknown>;
  const nextSchema = {
    type: 'object',
    required: 'not-an-array',
    properties: { amount: { type: 'string' } },
  } as Record<string, unknown>;
  const diff = diffContracts(prevSchema, nextSchema, 'output');
  assert.equal(diff.classification, 'breaking', 'retype under malformed required must still classify breaking');
  assert.ok(
    diff.changes.some((c) => c.kind === 'type-changed' && c.path.includes('amount')),
    'the retyped property is named',
  );
});

test('differ: identically-malformed properties does not mask a required change', () => {
  const prevSchema = {
    type: 'object',
    properties: ['bogus'],
    required: ['a'],
  } as Record<string, unknown>;
  const nextSchema = {
    type: 'object',
    properties: ['bogus'],
    required: [],
  } as Record<string, unknown>;
  // required 'a' removed on OUTPUT = breaking (field may now be absent).
  const diff = diffContracts(prevSchema, nextSchema, 'output');
  assert.equal(diff.classification, 'breaking', 'required change under malformed properties must still classify');
});

// ---- Baseline selection (codex P2-1 + independent MED, convergent) --------
// Prior = the predecessor in the version line (greatest version BELOW the
// push), not the global max. Global-max selection both rejected legitimate
// backports AND failed open: 1.1 matching 2.0's contract bypassed the gate
// while breaking 1.0 callers.

test('baseline: lower-line push diffs against its predecessor, not the global max', async () => {
  const OUT_NUM = schema({ v: num }, { required: ['v'], additionalProperties: false });
  const OUT_STR = schema({ v: str }, { required: ['v'], additionalProperties: false });

  // 1.0 returns a number; 2.0 legitimately retyped to string via major bump.
  assert.equal((await pushVersion('line-tool', '1.0', IN_BASE, OUT_NUM)).ok, true);
  assert.equal((await pushVersion('line-tool', '2.0', IN_BASE, OUT_STR)).ok, true);

  // Pushing 1.1 with the STRING contract matches 2.0 but breaks the 1.x
  // line - must be rejected against predecessor 1.0, not global max 2.0.
  const sneaky = await pushVersion('line-tool', '1.1', IN_BASE, OUT_STR);
  assert.equal(sneaky.ok, false, 'gate must compare 1.1 against 1.0, not 2.0');
  if (sneaky.ok) return;
  assert.equal(sneaky.code, 'breaking_contract_requires_major_bump');
  assert.ok(sneaky.details);
  assert.equal(sneaky.details['from_version'], '1.0');

  // A backport compatible with ITS line is allowed (was a false positive
  // under global-max selection: 1.1 vs 2.0 demanded major > 2).
  const backport = await pushVersion('line-tool', '1.1', IN_BASE, OUT_NUM);
  assert.equal(backport.ok, true, 'line-compatible backport must be allowed');
});

test('differ: type-array reorder is not a change', () => {
  const prevSchema = { type: 'object', properties: { v: { type: ['string', 'null'] } } } as Record<string, unknown>;
  const nextSchema = { type: 'object', properties: { v: { type: ['null', 'string'] } } } as Record<string, unknown>;
  const diff = diffContracts(prevSchema, nextSchema, 'input');
  assert.equal(diff.classification, 'identical', 'pure type-array reorder is the same contract');
});

// ---- Version-alias bypass (codex P2, round 3) -----------------------------
// '1.0' and '1.0.0' compare equal (missing segments = 0). Skipping equal-by-
// compare versions left prior = null, bypassing the gate entirely for alias
// pushes. Equal-compare versions are now the baseline: breaking-vs-alias
// demands major > major, which never holds.

test('baseline: version alias (1.0 vs 1.0.0) cannot bypass the gate', async () => {
  const OUT_NUM = schema({ v: num }, { required: ['v'], additionalProperties: false });
  const OUT_STR = schema({ v: str }, { required: ['v'], additionalProperties: false });

  assert.equal((await pushVersion('alias-tool', '1.0', IN_BASE, OUT_NUM)).ok, true);

  // Breaking contract under an alias version string: must be rejected
  // against the equal-compare baseline, never silently accepted.
  const sneaky = await pushVersion('alias-tool', '1.0.0', IN_BASE, OUT_STR);
  assert.equal(sneaky.ok, false, 'alias version must not bypass the drift gate');
  if (sneaky.ok) return;
  assert.equal(sneaky.code, 'breaking_contract_requires_major_bump');
  assert.equal(sneaky.details?.['from_version'], '1.0');

  // A contract-identical alias push remains allowed (new unique version string).
  const benign = await pushVersion('alias-tool', '1.0.1', IN_BASE, OUT_NUM);
  assert.equal(benign.ok, true);
});
