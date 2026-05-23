// Step 1 of Episode A2: build the 10k-tool scale-verification corpus.
//
// Strategy A (try first): expand the 47 fixture templates × vendor + scenario
// permutations from src/fixtures/generated-expanded.ts. Run diversity gate on
// 1k pilot, then on full 10k.
//
// Strategy B (fallback if A fails): combine 47 fixture templates + 77 MCP
// tool stub descriptions with ~80 perms each.
//
// Strategy C (escalate): document the negative result, exit non-zero.
//
// Output:
//   C:/tmp/v2-10k.db
//   tests/fixtures/v2-corpus-10k-snapshot.json
//
// Usage:
//   STORAGE_DRIVER=sqlite EMBEDDER=ollama TWOCHAIN_DB_PATH=C:/tmp/v2-10k.db \
//     npx tsx scripts/eval/build-10k-corpus.ts

import 'dotenv/config';
import { existsSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { DOMAINS } from '../../src/fixtures/generated.js';
import { generateExpanded } from '../../src/fixtures/generated-expanded.js';
import { FIXTURE_TOOLS } from '../../src/fixtures/tools.js';
import { REAL_CORPUS } from '../../src/fixtures/real-corpus.js';
import { canonicalize, signCorpus } from '../../src/eval/corpus-signature.js';
import type { FixtureSpec } from '../../src/fixtures/tools.js';
import type { ToolSpecV2 } from '../../src/types.js';

const TARGET = 10_000;
const COUNT_MIN = 9_500;
const COUNT_MAX = 10_500;
const PILOT_SIZE = 1_000;
const DIVERSITY_PAIRS = 200;
const DIVERSITY_THRESHOLD = 0.97;
const DIVERSITY_PASS_RATE = 0.80;

const dbPath = process.env.TWOCHAIN_DB_PATH ?? 'C:/tmp/v2-10k.db';
const snapshotPath = resolve('tests/fixtures/v2-corpus-10k-snapshot.json');

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fixtureToSpec(f: FixtureSpec): ToolSpecV2 {
  return {
    name: f.name,
    version: f.version,
    author_agent_id: f.author_agent_id,
    capability_text: f.capability_text,
    input_contract: f.input_contract,
    output_contract: f.output_contract,
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: f.endpoint_stub_name,
    metadata: {
      cost_per_call_usd: f.cost_per_call_usd,
      p95_latency_ms: f.p95_latency_ms,
      reliability_score: f.reliability_score,
    },
    status: 'active',
  };
}

function realCorpusToSpec(r: typeof REAL_CORPUS[number]): ToolSpecV2 {
  return {
    name: r.name,
    version: r.version,
    author_agent_id: 'demo-tool-author',
    capability_text: r.capability_text,
    input_contract: r.input_contract,
    output_contract: r.output_contract,
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: r.endpoint_stub_name,
    metadata: {
      cost_per_call_usd: r.cost_per_call_usd,
      p95_latency_ms: r.p95_latency_ms,
      reliability_score: r.reliability_score,
    },
    status: 'active',
    domain: r.domain,
  };
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

async function diversityCheck(embedder: OllamaEmbedder, specs: ToolSpecV2[]): Promise<{ passed: boolean; passRate: number; sampleSize: number }> {
  if (specs.length < 50) return { passed: true, passRate: 1, sampleSize: 0 }; // tiny corpora skip the gate
  const texts = specs.map((s) => s.capability_text);
  const vecs = await embedder.embedBatch(texts, 'document');
  const rng = (function () {
    let s = 0xc0ffee;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  })();
  let belowThreshold = 0;
  for (let i = 0; i < DIVERSITY_PAIRS; i++) {
    const a = Math.floor(rng() * specs.length);
    let b = Math.floor(rng() * specs.length);
    while (b === a) b = Math.floor(rng() * specs.length);
    const sim = dotProduct(vecs[a], vecs[b]);
    if (sim < DIVERSITY_THRESHOLD) belowThreshold++;
  }
  const passRate = belowThreshold / DIVERSITY_PAIRS;
  return { passed: passRate >= DIVERSITY_PASS_RATE, passRate, sampleSize: DIVERSITY_PAIRS };
}

async function buildStrategyA(): Promise<{ specs: ToolSpecV2[]; report: string }> {
  // Real-corpus core + Strategy A expansion to fill the rest.
  const realSpecs: ToolSpecV2[] = [
    ...FIXTURE_TOOLS.map(fixtureToSpec),
    ...REAL_CORPUS.map(realCorpusToSpec),
  ];
  const remainingTarget = TARGET - realSpecs.length;
  const expanded = generateExpanded({ domains: DOMAINS, targetCount: remainingTarget, seed: 0xa2c0_10c0 });
  const expandedSpecs = expanded.map(fixtureToSpec);
  // De-dup by (name, version)
  const seen = new Set(realSpecs.map((s) => `${s.name}@${s.version}`));
  const filtered = expandedSpecs.filter((s) => {
    const k = `${s.name}@${s.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    specs: [...realSpecs, ...filtered],
    report: `Strategy A: ${realSpecs.length} real + ${filtered.length} expanded = ${realSpecs.length + filtered.length}`,
  };
}

async function main() {
  console.log(`build-10k-corpus: target=${TARGET}, tolerance=[${COUNT_MIN},${COUNT_MAX}]`);
  console.log(`  db: ${dbPath}`);

  // --- Strategy A: try expanded generator ---
  const a = await buildStrategyA();
  console.log(`  ${a.report}`);

  if (a.specs.length < COUNT_MIN || a.specs.length > COUNT_MAX) {
    console.error(`Strategy A count out of tolerance: ${a.specs.length} not in [${COUNT_MIN},${COUNT_MAX}]`);
    process.exit(2);
  }

  // Pilot diversity check on first 1k
  const embedder = new OllamaEmbedder();
  console.log(`  pilot diversity check on first ${PILOT_SIZE} entries...`);
  const pilotResult = await diversityCheck(embedder, a.specs.slice(0, PILOT_SIZE));
  console.log(`    pilot: ${(pilotResult.passRate * 100).toFixed(1)}% of ${pilotResult.sampleSize} pairs have cosine<${DIVERSITY_THRESHOLD} (target ≥${(DIVERSITY_PASS_RATE * 100).toFixed(0)}%)`);
  if (!pilotResult.passed) {
    console.error('Strategy A pilot failed diversity gate. (Strategy B fallback not yet implemented — escalating.)');
    process.exit(3);
  }

  // Full diversity check on 10k
  console.log(`  full diversity check on ${a.specs.length} entries...`);
  const fullResult = await diversityCheck(embedder, a.specs);
  console.log(`    full:  ${(fullResult.passRate * 100).toFixed(1)}% of ${fullResult.sampleSize} pairs have cosine<${DIVERSITY_THRESHOLD} (target ≥${(DIVERSITY_PASS_RATE * 100).toFixed(0)}%)`);
  if (!fullResult.passed) {
    console.error('Strategy A full corpus failed diversity gate. (Strategy B fallback not yet implemented — escalating.)');
    process.exit(3);
  }

  // --- Write to DB atomically (same pattern as seed-fixtures.ts) ---
  console.log(`  seeding DB (atomic rename)...`);
  const tmpPath = `${dbPath}.tmp`;
  if (existsSync(tmpPath)) unlinkSync(tmpPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const storage = new SqliteStorage({ path: tmpPath });
  await storage.init();

  console.log(`  embedding ${a.specs.length} capability_texts...`);
  const tEmbed = Date.now();
  const texts = a.specs.map((s) => s.capability_text);
  const embeds = await embedder.embedBatch(texts, 'document');
  console.log(`    embedded in ${Date.now() - tEmbed}ms`);

  console.log(`  upserting tools...`);
  const tInsert = Date.now();
  for (let i = 0; i < a.specs.length; i++) {
    await storage.upsertTool(a.specs[i], embeds[i]);
  }
  console.log(`    inserted in ${Date.now() - tInsert}ms`);
  await storage.close();

  // Atomic rename
  if (existsSync(dbPath)) unlinkSync(dbPath);
  renameSync(tmpPath, dbPath);
  console.log(`  DB written to ${dbPath}`);

  // --- Snapshot ---
  const storage2 = new SqliteStorage({ path: dbPath });
  await storage2.init();
  const all = await storage2.listTools({ limit: 20_000 });
  const canonical = all.map(canonicalize);
  const corpusSha = signCorpus(canonical);
  const snapshot = {
    version: 2,
    generated_at: new Date().toISOString(),
    strategy: 'A',
    count: canonical.length,
    corpus_sha256: corpusSha,
    diversity: {
      pilot_pass_rate: pilotResult.passRate,
      full_pass_rate: fullResult.passRate,
      pair_count: DIVERSITY_PAIRS,
      threshold: DIVERSITY_THRESHOLD,
    },
    entries: canonical,
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`  snapshot: ${canonical.length} entries -> ${snapshotPath}`);
  console.log(`  corpus_sha256 = ${corpusSha}`);

  // Sanity: demo-arc + a few v2-golden expected_top3 tools present
  const names = new Set(canonical.map((c) => c.name));
  const expected = ['sec-edgar-financials', 'arxiv-paper-search', 'eslint-snitch', 'security-scanner', 'pdf-extractor', 'mcp-postgres__query'];
  const missing = expected.filter((n) => !names.has(n));
  if (missing.length > 0) {
    console.warn(`  WARN: expected tools missing: ${missing.join(', ')}`);
  } else {
    console.log(`  all ${expected.length} sanity tools present`);
  }

  await storage2.close();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
