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

const allTools = await storage.listTools({ limit: 10_000 });
console.log(`loaded ${allTools.length} tools`);

console.log(`precomputing mxbai embeddings for ${allTools.length} capability_texts...`);
const tStart = Date.now();
const capTexts = allTools.map((t) => t.capability_text ?? '');
const mxbaiToolVecs = await mxbai.embedBatch(capTexts, 'document');
console.log(`mxbai precompute: ${Date.now() - tStart}ms`);

function cosine(a: Float32Array, b: Float32Array): number {
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
  const h = createHash('sha256').update(qid).digest();
  let seed = h.readUInt32BE(0);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const indices = Array.from({ length: allTools.length }, (_, i) => i);
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

const corpusSnap = JSON.parse(readFileSync(resolve('tests/fixtures/v2-corpus-snapshot.json'), 'utf-8'));
out.corpus_sha256 = corpusSnap.corpus_sha256;

let qIdx = 0;
for (const q of golden.queries) {
  qIdx++;
  const cands = new Map<string, Candidate>();

  const dummyVec = await nomic.cachedEmbed(q.q);
  const bm25Hits = await storage.runRRF({
    queryEmbedding: dummyVec.vec,
    queryText: q.q,
    topK: 25,
    gate: RELIABILITY_GATE,
    weights: { vector: 0.0001, text: 1.0 },
    namespace: NAMESPACE,
  });
  const bm25Only = bm25Hits
    .filter((r) => r.text_rank !== undefined)
    .sort((a, b) => (a.text_rank! - b.text_rank!))
    .slice(0, 20);
  for (const r of bm25Only) {
    mergeCandidate(cands, `${r.name}@${r.version}`, r.name, r.version, 'bm25');
  }

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

  const mxbaiQ = await mxbai.embed(q.q, 'query');
  const mxbaiIdx = topKByMxbai(mxbaiQ, 10);
  for (const idx of mxbaiIdx) {
    const t = allTools[idx];
    mergeCandidate(cands, `${t.name}@${t.version}`, t.name, t.version, 'mxbai');
  }

  const randIdx = randomSampleForQuery(q.id, 10);
  for (const idx of randIdx) {
    const t = allTools[idx];
    mergeCandidate(cands, `${t.name}@${t.version}`, t.name, t.version, 'random');
  }

  for (const name of q.expected_top3 ?? []) {
    const t = findByName(name);
    if (t) {
      mergeCandidate(cands, `${t.name}@${t.version}`, t.name, t.version, 'author');
    }
  }

  const list = Array.from(cands.values()).sort((a, b) => b.sources.length - a.sources.length);
  const capped = list.slice(0, CAP_PER_QUERY);

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
