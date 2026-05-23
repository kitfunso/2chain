// v2-native NDCG@3 regression runner. Replaces v2-golden-regression.ts.
//
// Reads tests/fixtures/v2-golden.json (hand-graded), replays each query
// through discover(), computes NDCG@3 + MRR + Recall@3, and (if invoked
// with --baseline N) writes tests/fixtures/v2-baseline-native.json by
// averaging across N=5 runs and reporting stddev.
//
// Pre-flight (refuses to run any pre-flight fail):
//   1. ajv lint v2-golden.json AND adjudication completeness
//   2. ndcg_formula === "exp_gain_log2_rank1"
//   3. corpus_sha256 matches current DB
//   4. prewarm_sha256 matches current PREWARM_QUERIES
//
// Usage:
//   TWOCHAIN_DB_PATH=C:/tmp/v2.db npx tsx scripts/smoke/v2-golden-v2native.ts
//   ...                                              --baseline 5
//
// Exit codes: 0 ok / 1 NDCG below baseline / 2 pre-flight or schema fail.

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { discover } from '../../src/services/discover.js';
import { ndcgAtK, mrrIdeal, recallAtK } from '../../src/eval/ndcg.js';
import { canonicalize, signCorpus, signPrewarm } from '../../src/eval/corpus-signature.js';
import { PREWARM_QUERIES } from '../../src/services/discover.js';

interface GoldenQuery {
  id: string;
  stratum: string;
  q: string;
  expected_top1?: string;
  expected_top1_in?: string[];
  expected_top3: string[];
  relevance: Record<string, number>;
}
interface Golden {
  version: number;
  corpus_sha256: string;
  prewarm_sha256: string;
  ndcg_formula: string;
  queries: GoldenQuery[];
}

const goldenPath = resolve('tests/fixtures/v2-golden.json');
const goldenSchemaPath = resolve('tests/schemas/v2-golden.schema.json');
const adjSchemaPath = resolve('tests/schemas/v2-golden-adjudication.schema.json');
const baselinePath = resolve('tests/fixtures/v2-baseline-native.json');

const baselineN = (() => {
  const idx = process.argv.indexOf('--baseline');
  return idx >= 0 ? parseInt(process.argv[idx + 1] ?? '5', 10) : 0;
})();

const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as Golden;

// ---- Pre-flight 1: ajv schema lint ----
const ajv = new Ajv2020({ allErrors: true, strict: false });
const goldenSchema = JSON.parse(readFileSync(goldenSchemaPath, 'utf-8'));
const adjSchema = JSON.parse(readFileSync(adjSchemaPath, 'utf-8'));
const validateGolden = ajv.compile(goldenSchema);
const validateAdj = ajv.compile(adjSchema);
if (!validateGolden(golden)) {
  console.error('PRE-FLIGHT FAIL: v2-golden.json schema lint');
  console.error(JSON.stringify(validateGolden.errors, null, 2));
  process.exit(2);
}
if (!validateAdj(golden)) {
  console.error('PRE-FLIGHT FAIL: v2-golden adjudication lint (relevance map < 3 entries somewhere)');
  console.error(JSON.stringify(validateAdj.errors, null, 2));
  process.exit(2);
}

// ---- Pre-flight 2: NDCG formula version ----
if (golden.ndcg_formula !== 'exp_gain_log2_rank1') {
  console.error(`PRE-FLIGHT FAIL: ndcg_formula must be "exp_gain_log2_rank1", got "${golden.ndcg_formula}"`);
  process.exit(2);
}

// ---- Pre-flight 3+4: corpus + prewarm hash match ----
const dbPath = process.env.TWOCHAIN_DB_PATH ?? 'C:/tmp/v2.db';
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const allTools = await storage.listTools({ limit: 10_000 });
const corpus_sha256 = signCorpus(allTools.map(canonicalize));
const prewarm_sha256 = signPrewarm(PREWARM_QUERIES);
if (corpus_sha256 !== golden.corpus_sha256) {
  console.error(`PRE-FLIGHT FAIL: corpus_sha256 mismatch.\n  expected ${golden.corpus_sha256}\n  got      ${corpus_sha256}`);
  process.exit(2);
}
if (prewarm_sha256 !== golden.prewarm_sha256) {
  console.error(`PRE-FLIGHT FAIL: prewarm_sha256 mismatch.\n  expected ${golden.prewarm_sha256}\n  got      ${prewarm_sha256}`);
  process.exit(2);
}

// ---- Run the eval ----
const embedder = new OllamaEmbedder();

async function runOnce(): Promise<{ ndcg3: number; mrr: number; recall3: number; singleTopHits: number; singleTotal: number }> {
  let sumN = 0;
  let sumM = 0;
  let sumR = 0;
  let singleHits = 0;
  let singleTotal = 0;

  for (const q of golden.queries) {
    const out = await discover(storage, embedder, q.q, 10);
    const ranked = out.results.map((r) => ({ name: r.name, version: r.version, score: r.rrf_score }));
    sumN += ndcgAtK(ranked, q.relevance, 3);
    sumM += mrrIdeal(ranked, q.relevance);
    sumR += recallAtK(ranked, q.expected_top3, 3);
    if (q.stratum === 'single-tool' && q.expected_top1) {
      singleTotal++;
      if (ranked[0]?.name === q.expected_top1) singleHits++;
    }
  }
  const n = golden.queries.length;
  return {
    ndcg3: sumN / n,
    mrr: sumM / n,
    recall3: sumR / n,
    singleTopHits: singleHits,
    singleTotal,
  };
}

if (baselineN > 0) {
  // Baseline mode: run N times, write v2-baseline-native.json
  console.log(`baseline mode: ${baselineN} runs of ${golden.queries.length} queries`);
  const runs: Array<Awaited<ReturnType<typeof runOnce>>> = [];
  for (let i = 0; i < baselineN; i++) {
    const t = Date.now();
    const r = await runOnce();
    console.log(`  run ${i + 1}/${baselineN}: NDCG@3=${r.ndcg3.toFixed(4)} MRR=${r.mrr.toFixed(4)} R@3=${r.recall3.toFixed(4)} single=${r.singleTopHits}/${r.singleTotal} (${Date.now() - t}ms)`);
    runs.push(r);
  }
  function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
  function stddev(xs: number[]) {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
  }
  const ndcgs = runs.map((r) => r.ndcg3);
  const mrrs = runs.map((r) => r.mrr);
  const recalls = runs.map((r) => r.recall3);
  const singles = runs.map((r) => r.singleTopHits);

  const baseline = {
    embedder: embedder.name(),
    rrf_weights: { vector: 0.5, text: 0.5 },
    corpus_sha256: golden.corpus_sha256,
    prewarm_sha256: golden.prewarm_sha256,
    ndcg_formula: golden.ndcg_formula,
    runs: baselineN,
    ndcg3: { mean: mean(ndcgs), stddev: stddev(ndcgs), min: Math.min(...ndcgs), max: Math.max(...ndcgs) },
    mrr: { mean: mean(mrrs), stddev: stddev(mrrs) },
    recall3: { mean: mean(recalls), stddev: stddev(recalls) },
    single_tool_top1: { mean: mean(singles), stddev: stddev(singles), min: Math.min(...singles), max: Math.max(...singles), total: runs[0].singleTotal },
    captured_at: new Date().toISOString(),
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nwrote ${baselinePath}`);
  console.log(`  NDCG@3 mean=${baseline.ndcg3.mean.toFixed(4)} stddev=${baseline.ndcg3.stddev.toFixed(4)}`);
  if (baseline.ndcg3.stddev > 0.02) {
    console.error(`WARN: stddev > 0.02 — retrieval may be non-deterministic enough to flap the gate. Root-cause before pinning.`);
  }
  await storage.close();
  process.exit(0);
}

// ---- Single-run gate mode ----
const t = Date.now();
const r = await runOnce();
console.log(`run: NDCG@3=${r.ndcg3.toFixed(4)} MRR=${r.mrr.toFixed(4)} R@3=${r.recall3.toFixed(4)} single=${r.singleTopHits}/${r.singleTotal} (${Date.now() - t}ms)`);

if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const ndcgFloor = baseline.ndcg3.mean - 2 * baseline.ndcg3.stddev;
  const recallFloor = baseline.recall3.mean * 0.9;
  const singleFloor = baseline.single_tool_top1.mean - 2 * baseline.single_tool_top1.stddev;
  let bad = 0;
  if (r.ndcg3 < ndcgFloor) {
    console.error(`FAIL: NDCG@3 ${r.ndcg3.toFixed(4)} < floor ${ndcgFloor.toFixed(4)} (baseline mean ${baseline.ndcg3.mean.toFixed(4)} - 2*stddev)`);
    bad++;
  }
  if (r.recall3 < recallFloor) {
    console.error(`FAIL: Recall@3 ${r.recall3.toFixed(4)} < floor ${recallFloor.toFixed(4)} (90% of baseline mean)`);
    bad++;
  }
  if (r.singleTopHits < singleFloor) {
    console.error(`FAIL: single-tool top-1 ${r.singleTopHits}/${r.singleTotal} < floor ${singleFloor.toFixed(2)}`);
    bad++;
  }
  if (bad > 0) process.exit(1);
}

await storage.close();
process.exit(0);
