// CLI: scrape the npm registry for packages matching a query and import
// them into 2chain as tool_kind='tool', endpoint_stub_name='catalog-only-stub'.
//
// Usage:
//   npm run scrape:npm -- --query "keywords:mcp" --limit 100
//   npm run scrape:npm -- --query "openapi" --domain devtools --limit 50
//   npm run scrape:npm -- --query "keywords:mcp" --dry-run     # no embedding/insert

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { scrapeNpm } from '../src/import/npm-scraper.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';

interface CliFlags {
  query: string;
  limit: number;
  domain?: string;
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { query: 'keywords:mcp', limit: 100, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--query') out.query = argv[++i] ?? out.query;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i] ?? out.limit));
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));
const dbPath = resolve(
  process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`,
);

console.log(`scrape-npm: query="${flags.query}" limit=${flags.limit} domain=${flags.domain ?? 'devtools'} dryRun=${flags.dryRun}`);
console.log(`            db=${dbPath}`);
console.log();

console.log('  fetching from npm registry...');
const scraped = await scrapeNpm({
  query: flags.query,
  limit: flags.limit,
  domain: flags.domain,
});
console.log(`  scraped ${scraped.specs.length} packages (${scraped.pages_fetched} pages, ${scraped.total_available} total available, ${scraped.duration_ms}ms)`);

if (flags.dryRun) {
  console.log('\n  dry-run — sampled output:');
  for (const s of scraped.specs.slice(0, 5)) {
    console.log(`    ${s.name}@${s.version}`);
    console.log(`      ${s.capability_text.slice(0, 100)}...`);
  }
  process.exit(0);
}

const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder({ concurrency: 4 });

try {
  const result = await importScrapedSpecs(storage, embedder, scraped.specs);
  console.log('\n=== import result ===');
  console.log(`  scraped:           ${result.scraped}`);
  console.log(`  imported:          ${result.imported}`);
  console.log(`  skipped (existed): ${result.skipped_existing}`);
  console.log(`  duration:          ${result.duration_ms}ms`);
  if (result.errors.length > 0) {
    console.log(`\n  errors (${result.errors.length}):`);
    for (const e of result.errors) console.log(`    [${e.name}] ${e.error}`);
  }
  const stats = await storage.dbStats();
  console.log(`\n  db total tools: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
