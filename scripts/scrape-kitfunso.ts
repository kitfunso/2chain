// Pull Keith's first-party repos from github.com/kitfunso so 2chain ranks
// our own work alongside the public catalog. Curated whitelist: course
// exercises and case-study repos are excluded; the rest are real shipping
// tools / MCP servers / SDKs.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2 } from '../src/types.js';

interface Repo { name: string; description: string | null; html_url: string; stargazers_count: number; topics?: string[] }

const WHITELIST: Record<string, { domain: string; kind: 'tool' | 'skill' | 'subagent' | 'prompt' }> = {
  'hippo-memory':     { domain: 'ai',       kind: 'tool' },
  'luminus':          { domain: 'data',     kind: 'tool' },
  '2chain':           { domain: 'ai',       kind: 'tool' },
  'omniskill':        { domain: 'code',     kind: 'tool' },
  'token-discipline': { domain: 'ai',       kind: 'tool' },
  // openclaw removed: real openclaw is openclaw/openclaw, not kitfunso/openclaw.
  // Now lives in scripts/scrape-agent-infra.ts.
  'backtestlab':      { domain: 'finance',  kind: 'tool' },
  'boring-maths':     { domain: 'docs',     kind: 'tool' },
};

async function fetchReadme(repo: string): Promise<string> {
  try {
    const r = await fetch(`https://api.github.com/repos/kitfunso/${repo}/readme`, {
      headers: { 'user-agent': '2chain-scraper/1.0', accept: 'application/vnd.github.v3.raw' },
    });
    if (!r.ok) return '';
    const text = await r.text();
    return text.replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 600);
  } catch { return ''; }
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  console.log('fetching kitfunso repo list');
  const r = await fetch('https://api.github.com/users/kitfunso/repos?per_page=100&type=public', {
    headers: { 'user-agent': '2chain-scraper/1.0' },
  });
  if (!r.ok) throw new Error(`gh ${r.status}`);
  const repos = (await r.json()) as Repo[];
  console.log(`  ${repos.length} repos found, filtering to whitelist`);

  const specs: ToolSpecV2[] = [];
  for (const repo of repos) {
    const cfg = WHITELIST[repo.name];
    if (!cfg) continue;
    const readme = await fetchReadme(repo.name);
    const desc = (repo.description || repo.name).trim();
    const cap = `${repo.name}. ${desc}. ${readme}.  Stars: ${repo.stargazers_count}. Source: ${repo.html_url}.`.slice(0, 1400);
    specs.push({
      name: `kitfunso-${repo.name.toLowerCase()}`,
      version: '1.0',
      author_agent_id: 'kitfunso',
      capability_text: cap,
      input_contract: { type: 'object', additionalProperties: true },
      output_contract: { type: 'object', additionalProperties: true },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'catalog-only-stub',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.95 },
      status: 'active',
      domain: cfg.domain,
      tool_kind: cfg.kind,
    });
    console.log(`  + ${repo.name} (${repo.stargazers_count}★)`);
  }

  console.log(`\nimporting ${specs.length} kitfunso entries`);
  const out = await importScrapedSpecs(storage, embedder, specs);
  console.log(`  imported ${out.imported}  skipped(existed) ${out.skipped_existing}  errors ${out.errors.length}`);
  const stats = await storage.dbStats();
  console.log(`  db total: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
