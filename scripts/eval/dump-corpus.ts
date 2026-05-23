// Step 1 of Episode A1: snapshot the v2 corpus + prewarm list with
// content-addressed signatures.
//
// Outputs:
//   tests/fixtures/v2-corpus-snapshot.json   — canonical entries + signature
//   tests/fixtures/v2-prewarm-snapshot.json  — frozen prewarm query list
//
// Usage:
//   TWOCHAIN_DB_PATH=C:/tmp/v2.db STORAGE_DRIVER=sqlite EMBEDDER=ollama \
//     npx tsx scripts/eval/dump-corpus.ts

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { PREWARM_QUERIES } from '../../src/services/discover.js';
import { canonicalize, signCorpus, signPrewarm } from '../../src/eval/corpus-signature.js';

const dbPath = process.env.TWOCHAIN_DB_PATH ?? 'C:/tmp/v2.db';
const storage = new SqliteStorage({ path: dbPath });
await storage.init();

const all = await storage.listTools({ limit: 10_000 });
const canonical = all.map(canonicalize);
const corpus_sha256 = signCorpus(canonical);
const prewarm_sha256 = signPrewarm(PREWARM_QUERIES);

const corpusOut = {
  version: 2,
  generated_at: new Date().toISOString(),
  count: canonical.length,
  corpus_sha256,
  entries: canonical,
};

const prewarmOut = {
  version: 2,
  generated_at: new Date().toISOString(),
  count: PREWARM_QUERIES.length,
  prewarm_sha256,
  queries: PREWARM_QUERIES,
};

const corpusPath = resolve('tests/fixtures/v2-corpus-snapshot.json');
const prewarmPath = resolve('tests/fixtures/v2-prewarm-snapshot.json');

writeFileSync(corpusPath, JSON.stringify(corpusOut, null, 2) + '\n');
writeFileSync(prewarmPath, JSON.stringify(prewarmOut, null, 2) + '\n');

console.log(`corpus:  ${canonical.length} entries -> ${corpusPath}`);
console.log(`         corpus_sha256 = ${corpus_sha256}`);
console.log(`prewarm: ${PREWARM_QUERIES.length} queries -> ${prewarmPath}`);
console.log(`         prewarm_sha256 = ${prewarm_sha256}`);

// Sanity: demo-arc tools present
const names = new Set(canonical.map((c) => c.name));
const expected = ['sec-edgar-financials', 'arxiv-paper-search', 'eslint-snitch', 'security-scanner'];
const missing = expected.filter((n) => !names.has(n));
if (missing.length > 0) {
  console.error(`WARN: expected tools missing from corpus: ${missing.join(', ')}`);
}

await storage.close();
