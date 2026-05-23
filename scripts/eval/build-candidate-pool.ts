// Step 3 of Episode A1: build embedder-independent candidate pool per query.
//
// For each of the 100 queries in tests/fixtures/v2-golden.json, collect a
// union of candidates from 5 sources:
//   1. BM25-only top-20  (FTS5; no vector — lexical baseline)
//   2. nomic top-10      (current production embedder, vector-only)
//   3. mxbai top-10      (opt-in embedder; in-JS cosine since mxbai vectors
//                         are not in the SQLite vec0 table)
//   4. random control 10 (deterministic from query-id hash)
//   5. author top-3      (expected_top3 in v2-golden.json)
//
// Dedup by name@version, cap at 50 per query. Output:
//   tests/fixtures/v2-golden-candidates.json
//
// Usage:
//   TWOCHAIN_DB_PATH=C:/tmp/v2.db STORAGE_DRIVER=sqlite EMBEDDER=ollama \
//     npx tsx scripts/eval/build-candidate-pool.ts

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';

interface Query {
  id: string;
  stratum: string;
  q: string;
  expected_top1?: string;
  expected_top1_in?: string[];
  expected_top3: string[];
}
interface Candidate {
  name: string;
  version: string;
  sources: string[];
}

const CAP_PER_QUERY = 50;
const RELIABILITY_GATE = 0.8;
const NAMESPACE = 'default';

const dbPath = process.env.TWOCHAIN_DB_PATH ?? 'C:/tmp/v2.db';
const goldenPath = resolve('tests/fixtures/v2-golden.json');
const outPath = resolve('tests/fixtures/v2-golden-candidates.json');

const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as { queries: Query[] };

const storage = new SqliteStorage({ path: dbPath });
await storage.init();

const nomic = new OllamaEmbedder({ model: 'nomic-embed-text' });
const mxbai = new OllamaEmbedder({ model: 'mxbai-embed-large' });

// Load all tools with their capability_text for mxbai precompute + random sample.
const allTools = await storage.listTools({ limit: 10_000 });
console.log(`loaded ${allTools.length} tools`);

// ---- Precompute mxbai embeddings for the whole corpus (one-time) ----
console.log(`precomputing mxbai embeddings for ${allTools.length} capability_texts...`);
const tStart = Date.now();
const capTexts = allTools.map((t) => t.capability_text ?? '');
const mxbaiToolVecs = await mxbai.embedBatch(capTexts, 'document');
console.log(`mxbai precompute: ${Date.now() - tStart}ms`);

function cosine(a: Float32Array, b: Float32Array): number {
  // Both should already be L2-normalised by OllamaEmbedder; dot product = cosine.
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function topKByMxbai(queryVec: Float32Array, k: number): number[] {
  const scored: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < mxbaiToolVecs.length; i++) {
    scored.push({ idx: i, score: cosine(queryVec, mxbaiToolVecs[i]) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.idx);
}

function randomSampleForQuery(qid: string, k: number): number[] {
  // Deterministic seed from query id.
  const h = createHash('sha256').update(qid).digest();
  let seed = h.readUInt32BE(0);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const indices = Array.from({ length: allTools.length }, (_, i) => i);
  // Fisher-Yates partial shuffle
  for (let i = 0; i < k && i < indices.length; i++) {
    const j = i + Math.floor(rand() * (indices.length - i));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, k);
}

function mergeCandidate(map: Map<string, Candidate>, key: string, name: string, version: string, source: string) {
  const existing = map.get(key);
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
  } else {
    map.set(key, { name, version, sources: [source] });
  }
}

const nameByIdx = (i: number) => allTools[i].name;
const versionByIdx = (i: number) => allTools[i].version;
const findByName = (name: string) => allTools.find((t) => t.name === name);

const out: { generated_at: string; corpus_sha256: string; cap_per_query: number; queries: Array<{ id: string; candidate_count: number; source_distribution: Record<string, number>; candidates: Candidate[] }> } = {
  generated_at: new Date().toISOString(),
  corpus_sha256: '',
  cap_per_query: CAP_PER_QUERY,
  queries: [],
};

// Get corpus_sha256 from snapshot to record alongside (so the candidate file
// stays paired with the corpus that generated it).
const corpusSnap = JSON.parse(readFileSync(resolve('tests/fixtures/v2-corpus-snapshot.json'), 'utf-8'));
out.corpus_sha256 = corpusSnap.corpus_sha256;

let qIdx = 0;
for (const q of golden.queries) {
  qIdx++;
  const cands = new Map<string, Candidate>();

  // 1. BM25-only top-20  (text dominates; vector arm weight effectively zero)
  const dummyVec = await nomic.cachedEmbed(q.q);
  const bm25Hits = await storage.runRRF({
    queryEmbedding: dummyVec.vec,
    queryText: q.q,
    topK: 25,
    gate: RELIABILITY_GATE,
    weights: { vector: 0.0001, text: 1.0 },
    namespace: NAMESPACE,
  });
  // Filter to items with a text_rank (BM25 actually contributed) and take top 20 by text_rank.
  const bm25Only = bm25Hits
    .filter((r) => r.text_rank !== undefined)
    .sort((a, b) => (a.text_rank! - b.text_rank!))
    .slice(0, 20);
  for (const r of bm25Only) {
    mergeCandidate(cands, `${r.name}@${r.version}`, r.name, r.version, 'bm25');
  }

  // 2. nomic top-10  (vector dominates)
  const nomicHits = await storage.runRRF({
    queryEmbedding: dummyVec.vec,
    queryText: q.q,
    topK: 15,
    gate: RELIABILITY_GATE,
    weights: { vector: 1.0, text: 0.0001 },
    namespace: NAMESPACE,
  });
  const nomicOnly = nomicHits
    .filter((r) => r.vec_rank !== undefined)
    .sort((a, b) => (a.vec_rank! - b.vec_rank!))
    .slice(0, 10);
  for (const r of nomicOnly) {
    mergeCandidate(cands, `${r.name}@${r.version}`, r.name, r.version, 'nomic');
  }

  // 3. mxbai top-10  (in-JS cosine vs precomputed)
  const mxbaiQ = await mxbai.embed(q.q, 'query');
  const mxbaiIdx = topKByMxbai(mxbaiQ, 10);
  for (const idx of mxbaiIdx) {
    const t = allTools[idx];
    mergeCandidate(cands, `${t.name}@${t.version}`, t.name, t.version, 'mxbai');
  }

  // 4. random control 10
  const randIdx = randomSampleForQuery(q.id, 10);
  for (const idx of randIdx) {
    const t = allTools[idx];
    mergeCandidate(cands, `${t.name}@${t.version}`, t.name, t.version, 'random');
  }

  // 5. author top-3 (from expected_top3)
  for (const name of q.expected_top3 ?? []) {
    const t = findByName(name);
    if (t) {
      mergeCandidate(cands, `${t.name}@${t.version}`, t.name, t.version, 'author');
    }
  }

  // Cap at 50 — prefer keeping items with more sources (cross-validated).
  const list = Array.from(cands.values()).sort((a, b) => b.sources.length - a.sources.length);
  const capped = list.slice(0, CAP_PER_QUERY);

  // Source distribution for verify reporting
  const srcCounts: Record<string, number> = { bm25: 0, nomic: 0, mxbai: 0, random: 0, author: 0 };
  for (const c of capped) {
    for (const s of c.sources) srcCounts[s] = (srcCounts[s] ?? 0) + 1;
  }

  out.queries.push({
    id: q.id,
    candidate_count: capped.length,
    source_distribution: srcCounts,
    candidates: capped,
  });

  if (qIdx % 10 === 0) {
    console.log(`  built ${qIdx}/${golden.queries.length} candidate pools`);
  }
}

writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${out.queries.length} candidate pools to ${outPath}`);

// Verify lines
const counts = out.queries.map((q) => q.candidate_count);
const tooSmall = out.queries.filter((q) => q.candidate_count < 15);
console.log(`candidates per query: min=${Math.min(...counts)} max=${Math.max(...counts)} mean=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)}`);
console.log(`queries with <15 candidates: ${tooSmall.length} (target floor: 15)`);
if (tooSmall.length > 0) {
  console.log('  candidate-poor queries:');
  for (const q of tooSmall) console.log(`    ${q.id}: ${q.candidate_count}`);
}
const allSourceHit = out.queries.filter((q) => {
  const nonZero = Object.values(q.source_distribution).filter((v) => v > 0).length;
  return nonZero >= 3;
}).length;
console.log(`queries with ≥3 of 5 sources contributing: ${allSourceHit}/${out.queries.length} (target: ≥80%)`);

await storage.close();
