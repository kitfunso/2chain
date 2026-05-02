// mxbai-embed-large parity check (Phase 1.5 deferred follow-up).
//
// Builds a fresh /tmp/v2-mxbai.db with 1024-dim schema, embeds the 199
// fixture corpus + 142 catalog entries with mxbai-embed-large, then
// replays the 32-query golden set and prints v2(nomic) vs v2(mxbai).
//
// Doesn't touch the production /tmp/v2.db. Doesn't change any defaults.
// If mxbai is materially better, we'll lock it in via a follow-up commit.

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { discover } from '../../src/services/discover.js';
import { FIXTURE_TOOLS } from '../../src/fixtures/tools.js';
import { generateFixtures } from '../../src/fixtures/generated.js';
import { REAL_CORPUS } from '../../src/fixtures/real-corpus.js';
import { hashKey } from '../../src/server/auth.js';
import { FIXTURE_AGENTS } from '../../src/fixtures/agents.js';
import type { ToolSpecV2 } from '../../src/types.js';

const DB_PATH = '/tmp/v2-mxbai.db';
const NOMIC_DB_PATH = process.env.NOMIC_DB_PATH ?? '/tmp/v2.db';

// Wipe + rebuild the mxbai DB
for (const ext of ['', '-wal', '-shm']) {
  if (existsSync(DB_PATH + ext)) unlinkSync(DB_PATH + ext);
}

const storage = new SqliteStorage({ path: DB_PATH, embeddingDim: 1024 });
await storage.init();
const embedder = new OllamaEmbedder({ model: 'mxbai-embed-large', dim: 1024, concurrency: 4 });
console.log(`mxbai parity: ${embedder.name()} dim=${embedder.dim()}`);

// 1. Agents
for (const a of FIXTURE_AGENTS) {
  await storage.upsertAgent({
    id: a._id,
    name: a.name,
    api_key_hash: hashKey(a.api_key),
    role: a.role,
    created_at: new Date().toISOString(),
  });
}

// 2. Build the same corpus as production: 199 fixtures + 142 catalog.
const fixtureSpecs = [...FIXTURE_TOOLS, ...generateFixtures()];
const fixtureV2: ToolSpecV2[] = fixtureSpecs.map((s) => ({
  name: s.name,
  version: s.version,
  author_agent_id: s.author_agent_id,
  capability_text: s.capability_text,
  input_contract: s.input_contract,
  output_contract: s.output_contract,
  output_repair_strategy: 'fail-fast',
  endpoint_stub_name: s.endpoint_stub_name,
  metadata: {
    cost_per_call_usd: s.cost_per_call_usd,
    p95_latency_ms: s.p95_latency_ms,
    reliability_score: s.reliability_score,
    last_eval_run: new Date().toISOString(),
  },
  status: 'active',
}));
const all: ToolSpecV2[] = [...fixtureV2, ...REAL_CORPUS];
const texts = all.map((t) => t.capability_text);

console.log(`embedding ${texts.length} capability_texts with mxbai-embed-large...`);
const t0 = Date.now();
const embeddings: Float32Array[] = [];
for (let i = 0; i < texts.length; i += 32) {
  const slice = texts.slice(i, i + 32);
  const vecs = await embedder.embedBatch(slice, 'document');
  embeddings.push(...vecs);
  process.stdout.write(`  ${Math.min(i + 32, texts.length)}/${texts.length}  `);
}
console.log(`\n  embedded in ${Date.now() - t0}ms`);

console.log('inserting tools...');
for (let i = 0; i < all.length; i++) {
  await storage.upsertTool(all[i], embeddings[i]);
}
console.log(`  ${(await storage.dbStats()).collection_counts.tools} tools indexed`);

// 3. Replay the golden set
interface GQ { id: string; q: string; expected_top1?: string; expected_top1_in?: string[] }
interface BL { entries: Array<{ id: string; top1: { name: string }; top3: Array<{ name: string }>; expected_match: boolean | null }> }
const golden = JSON.parse(readFileSync(resolve('tests/fixtures/golden-queries.json'), 'utf-8')) as { queries: GQ[] };
const baseline = JSON.parse(readFileSync(resolve('tests/fixtures/v1-baseline.json'), 'utf-8')) as BL;
const blById = new Map(baseline.entries.map((e) => [e.id, e]));

let pass = 0;
let v1Match = 0;
let overlapSum = 0;
const flips: Array<{ id: string; q: string; mxbai: string; nomic_or_v1: string }> = [];

console.log('\n=== golden set replay (mxbai) ===');
for (const q of golden.queries) {
  const r = await discover(storage, embedder, q.q, 5);
  const top1 = r.results[0]?.name ?? '<none>';
  const top3 = r.results.slice(0, 3).map((x) => x.name);

  const expectOk = q.expected_top1
    ? top1 === q.expected_top1
    : q.expected_top1_in
    ? q.expected_top1_in.includes(top1)
    : null;
  if (expectOk === true) pass++;

  const bl = blById.get(q.id);
  if (bl) {
    if (bl.top1.name === top1) v1Match++;
    const blTop3 = bl.top3.map((x) => x.name);
    overlapSum += top3.filter((n) => blTop3.includes(n)).length;
    if (bl.top1.name !== top1 && bl.expected_match === true) {
      flips.push({ id: q.id, q: q.q, mxbai: top1, nomic_or_v1: bl.top1.name });
    }
  }
}

await storage.close();

console.log(`\n=== summary ===`);
console.log(`mxbai expected_top1 pass:        ${pass}/${golden.queries.length}`);
console.log(`mxbai matches v1 top-1:          ${v1Match}/${golden.queries.length}`);
console.log(`mxbai top-3 overlap with v1:     ${(overlapSum / golden.queries.length).toFixed(2)} / 3`);
console.log(`\nv2(nomic) baseline (from prior run): pass=20/32, v1-match=22/32, overlap=1.88/3`);
console.log(`v1 baseline (Voyage):              pass=25/32`);

if (flips.length > 0) {
  console.log(`\n=== queries where mxbai diverges from v1 (${flips.length}) ===`);
  for (const f of flips.slice(0, 10)) {
    console.log(`  ${f.id}: "${f.q.slice(0, 60)}..."`);
    console.log(`    mxbai: ${f.mxbai}    v1: ${f.nomic_or_v1}`);
  }
}

console.log(`\ndb at ${DB_PATH} (kept for follow-up inspection)`);
console.log(`compare to nomic db: ${NOMIC_DB_PATH}`);
