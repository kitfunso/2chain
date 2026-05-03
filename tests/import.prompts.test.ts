// Prompts importer integration test.
// Real SQLite, real seed list, deterministic stub embedder.
// Also exercises the prompt-template-stub via callStub to confirm
// substitution works end-to-end.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../src/storage/sqlite.js';
import {
  importPrompts,
  _resetPromptRegistryForTests,
  getRegisteredPromptTemplate,
} from '../src/import/prompts-importer.js';
import { PROMPT_SEEDS } from '../src/import/prompts-seed.js';
import { callStub } from '../src/services/stubs.js';
import type { Embedder } from '../src/types.js';

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

before(async () => {
  _resetPromptRegistryForTests();
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
});

after(async () => {
  await storage.close();
});

test('curated seed list contains >= 10 entries', () => {
  assert.ok(PROMPT_SEEDS.length >= 10, `expected >=10, got ${PROMPT_SEEDS.length}`);
  for (const s of PROMPT_SEEDS) {
    assert.ok(s.slug.length > 0, `slug missing: ${JSON.stringify(s)}`);
    assert.ok(s.description.length > 0, `description missing for ${s.slug}`);
    assert.ok(s.template.length > 0, `template missing for ${s.slug}`);
  }
});

test('importPrompts upserts one row per seed with tool_kind=prompt', async () => {
  const embedder = new StubEmbedder();
  const result = await importPrompts(storage, embedder);
  assert.equal(result.prompts_imported, PROMPT_SEEDS.length);

  const all = await storage.listTools({ kind: 'prompt', limit: 100 });
  assert.equal(all.length, PROMPT_SEEDS.length);
  for (const t of all) {
    assert.equal(t.tool_kind, 'prompt');
    assert.equal(t.endpoint_stub_name, 'prompt-template-stub');
    assert.equal(t.status, 'active');
  }
});

test('prompt-template-stub substitutes {{vars}} when called via callStub', async () => {
  // Pick a seed with known vars and exercise the stub through call.ts's path.
  const seed = PROMPT_SEEDS.find((s) => s.slug === 'pr-description');
  assert.ok(seed, 'pr-description seed missing');

  const out = await callStub(
    'prompt-template-stub',
    { vars: { context: 'fix login bug', commits: '- a\n- b' } },
    undefined,
    { tool_name: seed!.slug, tool_version: '1.0' },
  );
  assert.ok(out && typeof out === 'object', 'stub returned non-object');
  const rendered = (out as { rendered: string }).rendered;
  assert.match(rendered, /fix login bug/);
  assert.match(rendered, /- a\n- b/);
  // Unsubstituted vars must not crash; not used by this seed but verify shape.
  assert.ok(!/\{\{context\}\}/.test(rendered), 'context should be substituted');
});

test('prompt-template-stub leaves unknown placeholders intact', async () => {
  const seed = PROMPT_SEEDS.find((s) => s.slug === 'bug-report');
  assert.ok(seed);
  const out = await callStub(
    'prompt-template-stub',
    { vars: { title: 'login 500', severity: 'P1' } },
    undefined,
    { tool_name: seed!.slug, tool_version: '1.0' },
  );
  const rendered = (out as { rendered: string }).rendered;
  assert.match(rendered, /login 500/);
  assert.match(rendered, /\{\{steps\}\}/, 'unsubstituted vars stay literal');
});

test('getRegisteredPromptTemplate returns the seeded template', () => {
  const tmpl = getRegisteredPromptTemplate('conventional-commit');
  assert.ok(tmpl, 'template missing for conventional-commit');
  assert.match(tmpl!, /Conventional Commit/);
});
