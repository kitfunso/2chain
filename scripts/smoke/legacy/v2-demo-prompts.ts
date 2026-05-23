// The hackathon demo prompts. CLAUDE.md rule 8 gate.
// Three demos are STRICT (must pass): 1 DCF, 2 arxiv, 4 security.
// These are the unambiguous routing cases the on-stage demo arc depends on.
// Demos 3 and 5 are TOLERANT — the v1 baseline embeds the same trade-offs,
// and v2's near-misses route to legitimately reasonable alternatives.
// Source of truth: tests/fixtures/golden-queries.json (category=demo-prompt).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { discover } from '../../src/services/discover.js';

interface GQ {
  id: string;
  category: string;
  q: string;
  expected_top1?: string;
  expected_top1_in?: string[];
}

const golden = JSON.parse(
  readFileSync(resolve('tests/fixtures/golden-queries.json'), 'utf-8'),
) as { queries: GQ[] };

// Strict gate: these MUST pass for Phase 1 to ship.
const STRICT_DEMO_IDS = new Set(['demo-1-dcf', 'demo-2-arxiv', 'demo-4-security']);

const demos = golden.queries.filter((q) => q.category === 'demo-prompt');

const dbPath = process.env.TWOCHAIN_DB_PATH ?? '/tmp/v2.db';
const s = new SqliteStorage({ path: dbPath });
await s.init();
const e = new OllamaEmbedder();

console.log(`v2 demo prompts: ${demos.length} cases against ${dbPath}`);
console.log(`strict gate: ${STRICT_DEMO_IDS.size} demos (1-DCF, 2-arxiv, 4-security)\n`);

let strictPass = 0;
let tolerantPass = 0;
const strictFailures: Array<{ id: string; q: string; expected: string; got: string }> = [];

for (const d of demos) {
  const r = await discover(s, e, d.q, 5);
  const top1 = r.results[0]?.name ?? '<none>';
  const top3 = r.results.slice(0, 3).map((x) => x.name);

  const expectedDesc = d.expected_top1
    ? d.expected_top1
    : d.expected_top1_in
    ? `{${d.expected_top1_in.join('|')}}`
    : '*';
  const ok = d.expected_top1
    ? top1 === d.expected_top1
    : d.expected_top1_in
    ? d.expected_top1_in.includes(top1)
    : true;

  const isStrict = STRICT_DEMO_IDS.has(d.id);
  if (ok) {
    if (isStrict) strictPass++;
    else tolerantPass++;
    const tag = isStrict ? 'PASS' : 'pass';
    console.log(`  ${tag}  ${d.id}`);
    console.log(`        top1=${top1}  rrf=${r.results[0]!.rrf_score.toFixed(4)}`);
  } else {
    if (isStrict) {
      strictFailures.push({ id: d.id, q: d.q, expected: expectedDesc, got: top1 });
      console.log(`  FAIL  ${d.id}  (STRICT)`);
    } else {
      console.log(`  miss  ${d.id}  (tolerant — does not gate)`);
    }
    console.log(`        expected=${expectedDesc}  got=${top1}`);
    console.log(`        top3=${top3.join(', ')}`);
  }
}

await s.close();

console.log(`\n=== strict ${strictPass}/${STRICT_DEMO_IDS.size} | tolerant ${tolerantPass}/${demos.length - STRICT_DEMO_IDS.size} ===`);
if (strictFailures.length > 0) {
  console.error('\nDEMO REGRESSION — strict-gated demos failed.');
  process.exit(1);
}
console.log('Strict demos pass. Phase 1 demo gate green.');
