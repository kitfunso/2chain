// Discover claude-code skill repos at scale by querying GitHub's search API
// across topic and keyword queries. Each result becomes a kind='skill' spec
// with real stars + last-commit timestamps. Idempotent via skip-existing.
//
// Auth: requires GITHUB_TOKEN (search API rate-limit is ~10 req/min unauth,
// ~30 req/min authed). Without it, the script will likely 403 partway through.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2, ToolKind } from '../src/types.js';

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const HEADERS: Record<string, string> = {
  'user-agent': '2chain-skills-discovery/1.0',
  accept: 'application/vnd.github+json',
};
if (TOKEN) HEADERS.authorization = `Bearer ${TOKEN}`;

interface GhRepoHit {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  pushed_at: string;
  topics?: string[];
}

interface GhSearchResp { total_count: number; items: GhRepoHit[] }

interface Query { q: string; kind: ToolKind; domain: string; per_page: number }

// Each query targets a different slice of the skills/agent ecosystem.
// Queries run sequentially with a 2s pause between to stay under search rate-limit.
const QUERIES: Query[] = [
  { q: 'topic:claude-code-skill',      kind: 'skill', domain: 'ai',   per_page: 50 },
  { q: 'topic:claude-skill',           kind: 'skill', domain: 'ai',   per_page: 50 },
  { q: 'topic:agent-skill',            kind: 'skill', domain: 'ai',   per_page: 50 },
  { q: 'topic:claude-code-skills',     kind: 'skill', domain: 'ai',   per_page: 50 },
  { q: 'topic:agent-skills',           kind: 'skill', domain: 'ai',   per_page: 50 },
  { q: 'topic:claude-skills',          kind: 'skill', domain: 'ai',   per_page: 50 },
  { q: 'topic:claude-code-subagent',   kind: 'subagent', domain: 'ai', per_page: 50 },
  { q: 'topic:claude-subagent',        kind: 'subagent', domain: 'ai', per_page: 50 },
  { q: 'topic:claude-code-agents',     kind: 'subagent', domain: 'ai', per_page: 50 },
  { q: 'topic:claude-agents',          kind: 'subagent', domain: 'ai', per_page: 50 },
  { q: 'topic:claude-code-plugin',     kind: 'tool',  domain: 'ai',   per_page: 50 },
  { q: 'topic:claude-code-mcp',        kind: 'tool',  domain: 'ai',   per_page: 50 },
];

const MIN_STARS = Number(process.env.MIN_STARS ?? 5);
const MAX_TOTAL = Number(process.env.MAX_DISCOVER ?? 800);

async function fetchReadme(slug: string): Promise<string> {
  try {
    const r = await fetch(`https://api.github.com/repos/${slug}/readme`, {
      headers: { ...HEADERS, accept: 'application/vnd.github.v3.raw' },
    });
    if (!r.ok) return '';
    const text = await r.text();
    return text.replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 600);
  } catch { return ''; }
}

async function search(q: Query): Promise<GhRepoHit[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q.q)}&sort=stars&order=desc&per_page=${q.per_page}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) {
    console.log(`  search ${q.q}: HTTP ${r.status}`);
    return [];
  }
  const j = (await r.json()) as GhSearchResp;
  return j.items || [];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  console.log(`discovering skills via github search (token=${TOKEN ? 'yes' : 'no'}, min_stars=${MIN_STARS}, max=${MAX_TOTAL})`);
  const seen = new Set<string>();
  const allHits: Array<{ hit: GhRepoHit; q: Query }> = [];

  for (const q of QUERIES) {
    const hits = await search(q);
    let kept = 0;
    for (const hit of hits) {
      if (hit.stargazers_count < MIN_STARS) continue;
      const slug = slugify(hit.full_name.replace('/', '-'));
      if (seen.has(slug)) continue;
      seen.add(slug);
      allHits.push({ hit, q });
      kept++;
      if (allHits.length >= MAX_TOTAL) break;
    }
    console.log(`  ${q.q}: ${hits.length} returned, kept ${kept} (≥${MIN_STARS}★, dedup)`);
    if (allHits.length >= MAX_TOTAL) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\nbuilding ${allHits.length} specs (fetching READMEs)`);
  const specs: ToolSpecV2[] = [];
  for (const { hit, q } of allHits) {
    const readme = await fetchReadme(hit.full_name);
    const slug = slugify(hit.full_name.replace('/', '-'));
    const desc = (hit.description || hit.name).trim();
    const cap = `${hit.full_name}. ${desc}. ${readme}.  Stars: ${hit.stargazers_count}. Topics: ${(hit.topics || []).join(', ')}. Source: ${hit.html_url}.`.slice(0, 1400);
    specs.push({
      name: slug,
      version: '1.0',
      author_agent_id: 'skills-discovery',
      capability_text: cap,
      input_contract: { type: 'object', additionalProperties: true },
      output_contract: { type: 'object', additionalProperties: true },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'catalog-only-stub',
      metadata: {
        cost_per_call_usd: 0,
        p95_latency_ms: 0,
        reliability_score: 0.92,
        github_stars: hit.stargazers_count,
        github_last_commit_at: hit.pushed_at,
        github_fetched_at: new Date().toISOString(),
      },
      status: 'active',
      domain: q.domain,
      tool_kind: q.kind,
    });
  }

  console.log(`\nimporting ${specs.length} discovered entries in chunks of 25`);
  const CHUNK = 25;
  let totalImported = 0, totalSkipped = 0, totalErrors = 0;
  for (let i = 0; i < specs.length; i += CHUNK) {
    const slice = specs.slice(i, i + CHUNK);
    const r = await importScrapedSpecs(storage, embedder, slice);
    totalImported += r.imported;
    totalSkipped += r.skipped_existing;
    totalErrors += r.errors.length;
    console.log(`  chunk ${i / CHUNK + 1}/${Math.ceil(specs.length / CHUNK)}: +${r.imported}  skipped=${r.skipped_existing}  errors=${r.errors.length}  ${r.duration_ms}ms`);
  }
  console.log(`\ntotal imported ${totalImported}  skipped(existed) ${totalSkipped}  errors ${totalErrors}`);
} finally {
  await storage.close();
}
