// Import the curated REAL_CORPUS fixtures into the live DB.
// Skips existing entries via the shared scrape-import path. Adds the
// finance / code / research / docs / geo / comms / etc. domain coverage
// the snapshot scrape doesn't produce.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import { REAL_CORPUS } from '../src/fixtures/real-corpus.js';

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
console.log(`import-corpus: ${REAL_CORPUS.length} curated specs → ${dbPath}`);

const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  const result = await importScrapedSpecs(storage, embedder, REAL_CORPUS);
  console.log(`  imported: ${result.imported}  skipped(existed): ${result.skipped_existing}  duration: ${result.duration_ms}ms`);
  if (result.errors.length) {
    console.log(`  errors (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 10)) console.log(`    [${e.name}] ${e.error}`);
  }
  const stats = await storage.dbStats();
  console.log(`  db total: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
