// CLI: scrape PyPI metadata for a list of packages.
// Usage:
//   npm run scrape:pypi                       # default curated AI/MCP list
//   npm run scrape:pypi -- --names mcp,fastmcp,langgraph
//   npm run scrape:pypi -- --names-file pkgs.txt --limit 200
//   npm run scrape:pypi -- --dry-run

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { scrapePypi, PYPI_DEFAULT_NAMES } from '../src/import/pypi-scraper.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';

interface CliFlags {
  names?: string[];
  namesFile?: string;
  limit: number;
  domain?: string;
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { limit: 100, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--names') out.names = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--names-file') out.namesFile = argv[++i];
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

let names: string[];
if (flags.namesFile) {
  names = readFileSync(flags.namesFile, 'utf-8')
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
} else if (flags.names) {
  names = flags.names;
} else {
  names = PYPI_DEFAULT_NAMES;
}

console.log(`scrape-pypi: ${names.length} names, limit=${flags.limit}, dryRun=${flags.dryRun}`);
console.log(`             db=${dbPath}`);
console.log();

const result = await scrapePypi({
  names,
  limit: flags.limit,
  domain: flags.domain,
});
console.log(`  fetched ${result.fetched} of ${Math.min(names.length, flags.limit)} (${result.failed} failed, ${result.duration_ms}ms)`);

if (flags.dryRun) {
  console.log('\n  dry-run — sample:');
  for (const s of result.specs.slice(0, 5)) {
    console.log(`    ${s.name}@${s.version}`);
    console.log(`      ${s.capability_text.slice(0, 100)}...`);
  }
  if (result.errors.length > 0) {
    console.log(`\n  errors (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 5)) console.log(`    [${e.name}] ${e.error}`);
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
