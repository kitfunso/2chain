// Import data/registry-snapshot.json into the live SQLite DB. Embeds via
// the configured Embedder (Ollama by default) and dedupes via the
// existing scrape-import path.
//
// Usage:
//   TWOCHAIN_DB_PATH=~/.2chain/db.sqlite npm run import:snapshot
//   npm run import:snapshot -- --limit 200       # cap embeddings done in one go

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

interface CliFlags {
  snapshot: string;
  limit?: number;
  source?: string;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { snapshot: 'data/registry-snapshot.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--snapshot') out.snapshot = argv[++i] ?? out.snapshot;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i] ?? 0));
    else if (a === '--source') out.source = argv[++i];
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));
const dbPath = resolve(
  process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`,
);

const snapshotPath = resolve(flags.snapshot);
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as Snapshot;

console.log(`import-snapshot: ${snapshotPath}`);
console.log(`                 generated ${snapshot.generated_at}`);
console.log(`                 total specs: ${snapshot.total_specs}`);
console.log(`                 db: ${dbPath}`);
if (flags.source) console.log(`                 source filter: ${flags.source}`);
if (flags.limit) console.log(`                 limit: ${flags.limit}`);
console.log();

let specs = snapshot.specs;
if (flags.source) {
  specs = specs.filter((s) => s.author_agent_id?.includes(flags.source!));
}
if (flags.limit) specs = specs.slice(0, flags.limit);

const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder({ concurrency: 4 });

try {
  const result = await importScrapedSpecs(storage, embedder, specs);
  console.log('=== import result ===');
  console.log(`  scraped:           ${result.scraped}`);
  console.log(`  imported:          ${result.imported}`);
  console.log(`  skipped (existed): ${result.skipped_existing}`);
  console.log(`  duration:          ${result.duration_ms}ms`);
  if (result.errors.length > 0) {
    console.log(`\n  errors (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 10)) console.log(`    [${e.name}] ${e.error}`);
  }
  const stats = await storage.dbStats();
  console.log(`\n  db total tools: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
