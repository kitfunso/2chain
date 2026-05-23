// Experiment: does adding reliability_score as a third RRF arm recover the
// scale-break Episode A2 found at 10k corpus? One-off script — does fusion
// in JS without touching the Storage interface. If results justify it,
// ship the interface change in a separate PR.
//
// Sweep: reliability arm weight ∈ {0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5}
// while keeping vector=0.5, text=0.5 fixed.
//
// Score per query = sum_{arm} weight / (K + rank), summed across each arm
// the candidate appears in. The third arm ranks all tools above the
// reliability gate by reliability_score DESC.
//
// Usage:
//   TWOCHAIN_DB_PATH=C:/tmp/v2.db npx tsx scripts/eval/sweep-reliability-arm.ts
//   TWOCHAIN_DB_PATH=C:/tmp/v2-10k.db npx tsx scripts/eval/sweep-reliability-arm.ts

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { ndcgAtK, mrrIdeal, recallAtK } from '../../src/eval/ndcg.js';

interface GoldenQuery {
  id: string; stratum: string; q: string;
  expected_top1?: string; expected_top1_in?: string[];
  expected_top3: string[];
  relevance: Record<string, number>;
}
interface Golden { queries: GoldenQuery[] }

const RELIABILITY_GATE = 0.8;
const NAMESPACE = 'default';
const K_CONSTANT = 60;

const dbPath = process.env.TWOCHAIN_DB_PATH ?? 'C:/tmp/v2.db';
const golden = JSON.parse(readFileSync(resolve('tests/fixtures/v2-golden.json'), 'utf-8')) as Golden;

const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();
const allTools = await storage.listTools({ limit: 20_000 });

// Pre-compute reliability ranking: all tools sorted by reliability_score DESC
// (gated by RELIABILITY_GATE; below-gate tools never enter RRF anyway).
const reliabilityRanked = allTools
  .filter((t) => t.status === 'active' && t.metadata.reliability_score >= RELIABILITY_GATE)
  .sort((a, b) => {
    if (b.metadata.reliability_score !== a.metadata.reliability_score) return b.metadata.reliability_score - a.metadata.reliability_score;
    // stable tie-break: name+version ascending
    const aKey = a.name + '@' + a.version;
    const bKey = b.name + '@' + b.version;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
// Take a generous top-N for the reliability arm (matches runRRF's 50 vec/text top-N)
const RELIABILITY_TOP_N = 50;
const reliabilityTop = reliabilityRanked.slice(0, RELIABILITY_TOP_N);
const reliabilityRankByKey = new Map<string, number>();
reliabilityTop.forEach((t, i) => reliabilityRankByKey.set(`${t.name}@${t.version}`, i + 1));

console.log(`db=${dbPath}, total tools=${allTools.length}, reliability arm pool=${reliabilityRanked.length}, top-N for fusion=${RELIABILITY_TOP_N}`);

async function runWithReliabilityWeight(reliabilityWeight: number): Promise<{ ndcg3: number; mrr: number; recall3: number; singleHits: number; singleTotal: number }> {
  let sumN = 0, sumM = 0, sumR = 0;
  let singleHits = 0, singleTotal = 0;

  for (const q of golden.queries) {
    // Standard discover gives us vector + text arms fused; we need the
    // pre-fused vec/text top-K to add reliability. Get top-30 from current
    // RRF, then re-fuse with reliability injected.
    const queryEmbed = await embedder.cachedEmbed(q.q);
    const baseHits = await storage.runRRF({
      queryEmbedding: queryEmbed.vec,
      queryText: q.q,
      topK: 30,
      gate: RELIABILITY_GATE,
      weights: { vector: 0.5, text: 0.5 },
      namespace: NAMESPACE,
    });

    // Reconstruct the per-arm ranks from the base RRF result and merge
    // reliability rank. Note: baseHits already has vec_rank and text_rank set.
    const fused = new Map<string, { score: number; name: string; version: string }>();
    for (const r of baseHits) {
      const key = `${r.name}@${r.version}`;
      // existing fused score has vector and text contributions already
      let score = r.rrf_score;
      // Add reliability arm contribution
      const relRank = reliabilityRankByKey.get(key);
      if (relRank !== undefined) {
        score += reliabilityWeight / (K_CONSTANT + relRank);
      }
      fused.set(key, { score, name: r.name, version: r.version });
    }
    // Also include items from reliability arm that didn't appear in baseHits
    // (they'd have score = reliabilityWeight / (K + relRank) with no vec/text contribution)
    if (reliabilityWeight > 0) {
      for (const [key, relRank] of reliabilityRankByKey.entries()) {
        if (!fused.has(key)) {
          const t = reliabilityTop[relRank - 1];
          fused.set(key, { score: reliabilityWeight / (K_CONSTANT + relRank), name: t.name, version: t.version });
        }
      }
    }
    const ranked = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, 10);
    sumN += ndcgAtK(ranked, q.relevance, 3);
    sumM += mrrIdeal(ranked, q.relevance);
    sumR += recallAtK(ranked, q.expected_top3, 3);
    if (q.stratum === 'single-tool' && q.expected_top1) {
      singleTotal++;
      if (ranked[0]?.name === q.expected_top1) singleHits++;
    }
  }
  const n = golden.queries.length;
  return { ndcg3: sumN / n, mrr: sumM / n, recall3: sumR / n, singleHits, singleTotal };
}

const weights = [0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5];
console.log(`\nsweeping reliability arm weight (vector=0.5, text=0.5 fixed)\n`);
console.log(`  weight |   NDCG@3 |    MRR | Recall@3 | single`);
console.log(`  -------+----------+--------+----------+--------`);
const results: Array<{ weight: number; ndcg3: number; mrr: number; recall3: number; singleHits: number; singleTotal: number }> = [];
for (const w of weights) {
  const r = await runWithReliabilityWeight(w);
  results.push({ weight: w, ...r });
  console.log(`  ${w.toFixed(2)}   | ${r.ndcg3.toFixed(4)}  | ${r.mrr.toFixed(4)} | ${r.recall3.toFixed(4)}  | ${r.singleHits}/${r.singleTotal}`);
}

console.log(`\nBest by NDCG@3:`);
const best = results.reduce((a, b) => b.ndcg3 > a.ndcg3 ? b : a);
console.log(`  weight=${best.weight} -> NDCG@3=${best.ndcg3.toFixed(4)} (vs baseline ${results[0].ndcg3.toFixed(4)} at weight=0)`);

await storage.close();
