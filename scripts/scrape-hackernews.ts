// Scrape HackerNews via Algolia search API for "Show HN" posts about
// MCP servers, AI agents, and Claude Code tooling. Each result becomes a
// kind='tool' spec tagged source=catalog with the original GitHub or project
// URL preserved.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2 } from '../src/types.js';

interface HnHit {
  objectID: string;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  author?: string;
  points?: number;
  story_text?: string;
  num_comments?: number;
  created_at?: string;
}

const QUERIES: Array<{ q: string; domain: string }> = [
  { q: 'mcp server claude',     domain: 'ai' },
  { q: 'show hn ai agent',      domain: 'ai' },
  { q: 'show hn llm tool',      domain: 'ai' },
  { q: 'show hn vector database', domain: 'data' },
  { q: 'show hn rag pipeline',  domain: 'ai' },
  { q: 'show hn embedding',     domain: 'ai' },
];
const HITS_PER_QUERY = Number(process.env.HN_HITS ?? 50);
const MIN_POINTS = Number(process.env.HN_MIN_POINTS ?? 10);

async function searchHn(query: string, hits: number): Promise<HnHit[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${hits}&tags=story`;
  const r = await fetch(url, { headers: { 'user-agent': '2chain-scraper/1.0' } });
  if (!r.ok) throw new Error(`hn ${r.status}`);
  const j = (await r.json()) as { hits: HnHit[] };
  return j.hits ?? [];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  const seen = new Set<string>();
  const allSpecs: ToolSpecV2[] = [];

  for (const { q, domain } of QUERIES) {
    console.log(`searching HN: "${q}"`);
    const hits = await searchHn(q, HITS_PER_QUERY);
    let kept = 0;
    for (const h of hits) {
      const url = h.url || h.story_url;
      const title = (h.title || h.story_title || '').trim();
      if (!url || !title) continue;
      if ((h.points ?? 0) < MIN_POINTS) continue;
      const name = slugify(title);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const desc = (h.story_text || title).replace(/<[^>]+>/g, '').trim().slice(0, 280);
      allSpecs.push({
        name,
        version: '1.0',
        author_agent_id: 'hackernews-show',
        capability_text: `${title}. ${desc}.  Posted by ${h.author ?? 'unknown'} (${h.points ?? 0} points). Source: ${url}.`,
        input_contract: { type: 'object', additionalProperties: true },
        output_contract: { type: 'object', additionalProperties: true },
        output_repair_strategy: 'fail-fast',
        endpoint_stub_name: 'catalog-only-stub',
        metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.92 },
        status: 'active',
        domain,
        tool_kind: 'tool',
      });
      kept++;
    }
    console.log(`  kept ${kept} (>=${MIN_POINTS} points, dedup, real URL)`);
  }

  console.log(`\nimporting ${allSpecs.length} HN entries`);
  const r = await importScrapedSpecs(storage, embedder, allSpecs);
  console.log(`  imported ${r.imported}  skipped(existed) ${r.skipped_existing}  errors ${r.errors.length}`);
  const stats = await storage.dbStats();
  console.log(`  db total: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
