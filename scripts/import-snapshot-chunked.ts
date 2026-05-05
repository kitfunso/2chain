// Chunked snapshot importer: splits the 1200-spec snapshot into batches of
// 50 specs and commits after each batch. Survives partial completion (each
// chunk is its own DB transaction) and avoids choking the embedder by
// limiting concurrent embeds. The full import on a 2GB shared-CPU VM takes
// ~10-15 minutes; resumable on next boot via skip-existing.

import 'dotenv/config';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2 } from '../src/types.js';

interface Snapshot {
  generated_at: string;
  total_specs: number;
  sources: Array<{ source: string; count: number }>;
  specs: ToolSpecV2[];
}

const CHUNK = Number(process.env.SNAPSHOT_CHUNK ?? 50);
const SNAPSHOT_PATH = resolve('data/registry-snapshot.json');
const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as Snapshot;
console.log(`snapshot: ${snapshot.total_specs} specs from ${SNAPSHOT_PATH}`);
console.log(`importing in chunks of ${CHUNK} (skip-existing dedupes against current DB)`);

const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

let totalImported = 0;
let totalSkipped = 0;
let totalErrors = 0;

try {
  for (let i = 0; i < snapshot.specs.length; i += CHUNK) {
    const batch = snapshot.specs.slice(i, i + CHUNK);
    const t0 = Date.now();
    const r = await importScrapedSpecs(storage, embedder, batch);
    totalImported += r.imported;
    totalSkipped += r.skipped_existing;
    totalErrors += r.errors.length;
    const eta = ((snapshot.specs.length - i - CHUNK) / CHUNK) * ((Date.now() - t0) / 1000);
    console.log(
      `chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(snapshot.specs.length / CHUNK)}: ` +
      `+${r.imported}  skipped=${r.skipped_existing}  errors=${r.errors.length}  ` +
      `${Date.now() - t0}ms  eta=${Math.round(eta)}s`,
    );
  }

  console.log(`\n=== done ===`);
  console.log(`  imported: ${totalImported}`);
  console.log(`  skipped:  ${totalSkipped}`);
  console.log(`  errors:   ${totalErrors}`);
  const stats = await storage.dbStats();
  console.log(`  db total: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
