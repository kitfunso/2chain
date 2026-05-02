// Quick sanity check: open the seeded DB, run an RRF, print top-5.
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';

const path = process.env.TWOCHAIN_DB_PATH ?? '/tmp/v2.db';
const s = new SqliteStorage({ path });
await s.init();

const stats = await s.dbStats();
console.log('db', { path, ...stats.collection_counts });

const e = new OllamaEmbedder();
const queries = [
  'extract income statement from 10-K for DCF model',
  'fetch latest papers on Mamba state-space models from arxiv',
  'review javascript code for bugs',
  'audit python for OWASP security',
];
for (const q of queries) {
  const v = await e.embed(q, 'query');
  const r = await s.runRRF({
    queryEmbedding: v,
    queryText: q,
    topK: 3,
    gate: 0.8,
    weights: { vector: 0.7, text: 0.3 },
  });
  console.log(`\nquery: "${q}"`);
  for (const x of r) {
    console.log(`  ${x.name}@${x.version}  rrf=${x.rrf_score.toFixed(4)}  rel=${x.metadata.reliability_score}`);
  }
}
await s.close();
