// Quick RRF weight sweep against the golden set. Reports which weight pair
// best matches v1 baseline. Read-only; doesn't mutate anything.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { RELIABILITY_GATE } from '../../src/types.js';

interface GQ { id: string; q: string; expected_top1?: string; expected_top1_in?: string[] }
interface BL { entries: Array<{ id: string; top1: { name: string }; top3: Array<{ name: string }> }> }

const golden = JSON.parse(readFileSync(resolve('tests/fixtures/golden-queries.json'), 'utf-8')) as { queries: GQ[] };
const baseline = JSON.parse(readFileSync(resolve('tests/fixtures/v1-baseline.json'), 'utf-8')) as BL;
const blById = new Map(baseline.entries.map((e) => [e.id, e]));

const dbPath = process.env.TWOCHAIN_DB_PATH ?? '/tmp/v2.db';
const s = new SqliteStorage({ path: dbPath });
await s.init();
const e = new OllamaEmbedder();

// Embed every query once, reuse across weight sweep.
const cache = new Map<string, Float32Array>();
for (const q of golden.queries) cache.set(q.id, await e.embed(q.q, 'query'));

const sweep = [
  { v: 0.7, t: 0.3 },
  { v: 0.6, t: 0.4 },
  { v: 0.5, t: 0.5 },
  { v: 0.4, t: 0.6 },
  { v: 0.3, t: 0.7 },
];

console.log(`weight sweep: ${sweep.length} pairs x ${golden.queries.length} queries\n`);
console.log('| vec | text | expected_pass | v1_top1_match | top3_overlap_avg |');
console.log('|-----|------|---------------|---------------|------------------|');

for (const w of sweep) {
  let pass = 0;
  let v1match = 0;
  let overlapSum = 0;
  for (const q of golden.queries) {
    const vec = cache.get(q.id)!;
    const r = await s.runRRF({
      queryEmbedding: vec,
      queryText: q.q,
      topK: 5,
      gate: RELIABILITY_GATE,
      weights: { vector: w.v, text: w.t },
    });
    const top1 = r[0]?.name ?? '<none>';
    const top3 = r.slice(0, 3).map((x) => x.name);
    const exp = q.expected_top1
      ? top1 === q.expected_top1
      : q.expected_top1_in
      ? q.expected_top1_in.includes(top1)
      : null;
    if (exp === true) pass++;
    const bl = blById.get(q.id);
    if (bl && bl.top1.name === top1) v1match++;
    if (bl) {
      const blTop3 = bl.top3.map((x) => x.name);
      overlapSum += top3.filter((n) => blTop3.includes(n)).length;
    }
  }
  console.log(
    `| ${w.v.toFixed(2)} | ${w.t.toFixed(2)} | ${String(pass).padStart(13)} | ${String(v1match).padStart(13)} | ${(overlapSum / golden.queries.length).toFixed(2).padStart(16)} |`,
  );
}

await s.close();
