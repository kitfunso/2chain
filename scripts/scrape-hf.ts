// CLI: scrape Hugging Face Hub for top models / datasets / spaces.
// Usage:
//   npm run scrape:hf                                          # top 100 models by downloads
//   npm run scrape:hf -- --resource datasets --limit 50
//   npm run scrape:hf -- --filter "pipeline_tag=text-generation" --limit 100
//   npm run scrape:hf -- --dry-run

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { scrapeHuggingFace, type HfResource } from '../src/import/hf-scraper.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';

interface CliFlags {
  resource: HfResource;
  limit: number;
  filter?: string;
  sort?: string;
  domain?: string;
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { resource: 'models', limit: 100, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resource') {
      const v = argv[++i];
      if (v === 'models' || v === 'datasets' || v === 'spaces') out.resource = v;
    } else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i] ?? out.limit));
    else if (a === '--filter') out.filter = argv[++i];
    else if (a === '--sort') out.sort = argv[++i];
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));
const dbPath = resolve(
  process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`,
);

console.log(`scrape-hf: resource=${flags.resource} limit=${flags.limit} filter=${flags.filter ?? '-'} dryRun=${flags.dryRun}`);
console.log(`           db=${dbPath}`);
console.log();

const result = await scrapeHuggingFace({
  resource: flags.resource,
  limit: flags.limit,
  filter: flags.filter,
  sort: flags.sort,
  domain: flags.domain,
});
console.log(`  fetched ${result.fetched} ${flags.resource} (${result.duration_ms}ms)`);

if (flags.dryRun) {
  console.log('\n  dry-run — sample:');
  for (const s of result.specs.slice(0, 5)) {
    console.log(`    ${s.name}@${s.version}`);
    console.log(`      ${s.capability_text.slice(0, 100)}...`);
  }
  process.exit(0);
}

const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder({ concurrency: 4 });

try {
  const imp = await importScrapedSpecs(storage, embedder, result.specs);
  console.log('\n=== import result ===');
  console.log(`  scraped:           ${imp.scraped}`);
  console.log(`  imported:          ${imp.imported}`);
  console.log(`  skipped (existed): ${imp.skipped_existing}`);
  console.log(`  duration:          ${imp.duration_ms}ms`);
  if (imp.errors.length > 0) {
    console.log(`\n  errors (${imp.errors.length}):`);
    for (const e of imp.errors) console.log(`    [${e.name}] ${e.error}`);
  }
  const stats = await storage.dbStats();
  console.log(`\n  db total tools: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
