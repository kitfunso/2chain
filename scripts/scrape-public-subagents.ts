// Scrape public Claude Code subagent collections and import them into the
// live DB. Currently pulls wshobson/agents (185+ specialist subagents).
// Each entry is tagged kind='subagent' and the relative path is rewritten
// to an absolute github.com URL so the dashboard "click name to open repo"
// works as expected.
//
// Usage:
//   STORAGE_DRIVER=sqlite EMBEDDER=ollama tsx scripts/scrape-public-subagents.ts

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import { scrapeAwesomeList } from '../src/import/awesome-list-scraper.js';
import type { ToolSpecV2 } from '../src/types.js';

interface SubagentSource {
  name: string;
  url: string;
  base: string;          // base for absolutising relative links
  domain: string;
  limit: number;
}

const SOURCES: SubagentSource[] = [
  {
    name: 'wshobson-agents',
    url: 'https://raw.githubusercontent.com/wshobson/agents/main/docs/agents.md',
    base: 'https://github.com/wshobson/agents/blob/main/docs/',
    domain: 'agents',
    limit: 250,
  },
  {
    name: 'voltagent-claude-subagents',
    url: 'https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/README.md',
    base: 'https://github.com/VoltAgent/awesome-claude-code-subagents/blob/main/',
    domain: 'agents',
    limit: 250,
  },
];

function absolutiseUrls(specs: ToolSpecV2[], base: string): ToolSpecV2[] {
  return specs.map((s) => {
    const updated = s.capability_text.replace(
      /Source:\s*(\.\.[^\s)]+|[^\s)]+\.md)/i,
      (_m, p) => {
        try {
          // node:url doesn't fold ".." correctly with raw markdown paths,
          // so do it manually: strip leading "../" segments from base.
          let b = base;
          let p2 = p;
          while (p2.startsWith('../')) {
            b = b.replace(/[^/]+\/$/, '');
            p2 = p2.slice(3);
          }
          return `Source: ${b}${p2}`;
        } catch {
          return _m;
        }
      },
    );
    return { ...s, capability_text: updated };
  });
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  for (const src of SOURCES) {
    console.log(`scraping ${src.name} from ${src.url}`);
    const r = await scrapeAwesomeList({
      url: src.url,
      limit: src.limit,
      domain: src.domain,
      author: `awesome-${src.name}`,
      kind: 'subagent',
    });
    const specs = absolutiseUrls(r.specs, src.base);
    console.log(`  scraped ${specs.length} specs (${r.matched_lines} matched lines, ${r.duration_ms}ms)`);

    const imp = await importScrapedSpecs(storage, embedder, specs);
    console.log(`  imported ${imp.imported}  skipped(existed) ${imp.skipped_existing}  errors ${imp.errors.length}`);
    if (imp.errors.length) {
      for (const e of imp.errors.slice(0, 5)) console.log(`    [${e.name}] ${e.error}`);
    }
  }
  const stats = await storage.dbStats();
  console.log(`\ndb total tools: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
