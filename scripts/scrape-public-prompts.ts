// Scrape public prompt collections. Pulls f/awesome-chatgpt-prompts CSV
// (200+ real prompts), parses, imports as kind='prompt'.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2 } from '../src/types.js';

interface CsvSource {
  url: string;
  sourceUrl: string;
  author: string;
  domain: string;
}

const SOURCES: CsvSource[] = [
  {
    url: 'https://raw.githubusercontent.com/f/awesome-chatgpt-prompts/main/prompts.csv',
    sourceUrl: 'https://github.com/f/awesome-chatgpt-prompts',
    author: 'awesome-chatgpt-prompts',
    domain: 'prompts',
  },
];

// Cap on rows imported per source. The full chatgpt-prompts CSV has ~1700
// rows but the long tail is noisy/repetitive. The first ~250 are the
// canonical catalog (Linux Terminal, English Translator, etc.) and represent
// the high-signal subset.
const MAX_PER_SOURCE = Number(process.env.MAX_PROMPTS_PER_SOURCE ?? 250);

// Minimal CSV parser tolerant of quoted fields with commas + escaped quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  const allSpecs: ToolSpecV2[] = [];
  for (const src of SOURCES) {
    console.log(`fetching ${src.url}`);
    const r = await fetch(src.url, { headers: { 'user-agent': '2chain-scraper/1.0' } });
    if (!r.ok) { console.error(`  HTTP ${r.status}`); continue; }
    const text = await r.text();
    const rows = parseCsv(text);
    if (!rows.length) { console.error('  no rows'); continue; }
    const header = rows[0].map((h) => h.toLowerCase());
    const actCol = header.indexOf('act');
    const promptCol = header.indexOf('prompt');
    if (actCol < 0 || promptCol < 0) { console.error(`  missing act/prompt cols (got ${header})`); continue; }
    console.log(`  parsed ${rows.length - 1} rows (cap: ${MAX_PER_SOURCE})`);
    const seen = new Set<string>();
    let kept = 0;
    for (let i = 1; i < rows.length && kept < MAX_PER_SOURCE; i++) {
      const act = rows[i][actCol]?.trim();
      const prompt = rows[i][promptCol]?.trim();
      if (!act || !prompt) continue;
      const slug = act.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const cap = `${act}. ${prompt.slice(0, 350)}.  Source: ${src.sourceUrl}.`;
      allSpecs.push({
        name: slug,
        version: '1.0',
        author_agent_id: src.author,
        capability_text: cap,
        input_contract: { type: 'object', additionalProperties: true },
        output_contract: { type: 'object', additionalProperties: true },
        output_repair_strategy: 'fail-fast',
        endpoint_stub_name: 'catalog-only-stub',
        metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.92 },
        status: 'active',
        domain: src.domain,
        tool_kind: 'prompt',
      });
      kept++;
    }
  }
  console.log(`\nimporting ${allSpecs.length} prompt specs in chunks of 25`);
  const CHUNK = 25;
  let totalImported = 0, totalSkipped = 0, totalErrors = 0;
  for (let i = 0; i < allSpecs.length; i += CHUNK) {
    const slice = allSpecs.slice(i, i + CHUNK);
    const r = await importScrapedSpecs(storage, embedder, slice);
    totalImported += r.imported;
    totalSkipped += r.skipped_existing;
    totalErrors += r.errors.length;
    console.log(`  chunk ${i / CHUNK + 1}/${Math.ceil(allSpecs.length / CHUNK)}: +${r.imported}  skipped=${r.skipped_existing}  errors=${r.errors.length}  ${r.duration_ms}ms`);
  }
  console.log(`\ntotal imported ${totalImported}  skipped(existed) ${totalSkipped}  errors ${totalErrors}`);
  const stats = await storage.dbStats();
  console.log(`db total tools: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
