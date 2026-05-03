// CLI: scrape a curated awesome-list README from GitHub and import
// each `- [Name](url) - description.` bullet as a 2chain catalog entry.
//
// Usage:
//   npm run scrape:awesome -- --url https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md
//   npm run scrape:awesome -- --url <url> --limit 200 --domain mcp
//   npm run scrape:awesome -- --url <url> --dry-run

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { scrapeAwesomeList } from '../src/import/awesome-list-scraper.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';

interface CliFlags {
  url: string;
  limit: number;
  domain?: string;
  author?: string;
  dryRun: boolean;
}

const DEFAULT_URL = 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md';

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { url: DEFAULT_URL, limit: 500, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i] ?? out.url;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i] ?? out.limit));
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--author') out.author = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));
const dbPath = resolve(
  process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`,
);

console.log(`scrape-awesome: url=${flags.url}`);
console.log(`                limit=${flags.limit} domain=${flags.domain ?? 'awesome-list'} dryRun=${flags.dryRun}`);
console.log(`                db=${dbPath}`);
console.log();

console.log('  fetching markdown...');
const scraped = await scrapeAwesomeList({
  url: flags.url,
  limit: flags.limit,
  domain: flags.domain,
  author: flags.author,
});
console.log(`  parsed ${scraped.matched_lines} entries from ${scraped.total_lines} lines (${scraped.duration_ms}ms)`);
console.log(`  scraped ${scraped.specs.length} unique specs after dedup`);

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
