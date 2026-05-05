// Scrape the punkpeye/awesome-mcp-servers README and import each entry as
// a kind='tool' spec with endpoint_stub_name='mcp-bridge' so it counts in
// the dashboard's MCP source bucket. Capable of being called via /call once
// the mcp-bridge stub is wired up.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import { scrapeAwesomeList } from '../src/import/awesome-list-scraper.js';
import type { ToolSpecV2 } from '../src/types.js';

const MAX = Number(process.env.MAX_MCP ?? 300);
const SOURCE = {
  url: 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
  domain: 'mcp',
  author: 'awesome-mcp-servers',
  limit: MAX,
};

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  console.log(`scraping ${SOURCE.url}`);
  const r = await scrapeAwesomeList({
    url: SOURCE.url,
    limit: SOURCE.limit,
    domain: SOURCE.domain,
    author: SOURCE.author,
    kind: 'tool',
  });
  // Override stub to mcp-bridge so the dashboard counts these in the MCP bucket.
  const specs: ToolSpecV2[] = r.specs.slice(0, MAX).map((s) => ({
    ...s,
    endpoint_stub_name: 'mcp-bridge',
  }));
  console.log(`  scraped ${specs.length} (${r.matched_lines} matched, capped at ${MAX})`);

  const imp = await importScrapedSpecs(storage, embedder, specs);
  console.log(`  imported ${imp.imported}  skipped(existed) ${imp.skipped_existing}  errors ${imp.errors.length}`);
  if (imp.errors.length) for (const e of imp.errors.slice(0, 5)) console.log(`    [${e.name}] ${e.error}`);
  const stats = await storage.dbStats();
  console.log(`  db total: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
