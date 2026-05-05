// Curated list of additional skills repos to grow beyond anthropics/skills.
// Mix of:
//  (a) Single-skill repos -> imported as one kind='skill' entry
//  (b) Awesome-skills lists -> README parsed to extract per-skill rows
// Stars + last-commit pulled per entry so the GH column is populated.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2, ToolKind } from '../src/types.js';

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const HEADERS: Record<string, string> = { 'user-agent': '2chain/1.0', accept: 'application/vnd.github+json' };
if (TOKEN) HEADERS.authorization = `Bearer ${TOKEN}`;

interface Repo { full_name: string; description: string | null; html_url: string; stargazers_count: number; pushed_at: string }

interface SingleSkill { repo: string; name: string; domain: string }

// Single-skill repos: each becomes one kind='skill' entry.
const SINGLE_SKILLS: SingleSkill[] = [
  { repo: 'JuliusBrussee/caveman',                      name: 'caveman',                       domain: 'ai' },
  { repo: 'OthmanAdi/planning-with-files',              name: 'planning-with-files',           domain: 'ai' },
  { repo: 'forrestchang/andrej-karpathy-skills',        name: 'andrej-karpathy-skills',        domain: 'ai' },
  { repo: 'safishamsi/graphify',                        name: 'graphify',                       domain: 'ai' },
  { repo: 'coreyhaines31/marketingskills',              name: 'marketing-skills',              domain: 'comms' },
  { repo: 'santifer/career-ops',                        name: 'career-ops',                     domain: 'comms' },
  { repo: 'Donchitos/Claude-Code-Game-Studios',         name: 'game-studios',                   domain: 'media' },
  { repo: 'affaan-m/everything-claude-code',            name: 'everything-claude-code',         domain: 'ai' },
  { repo: 'farion1231/cc-switch',                       name: 'cc-switch',                      domain: 'ai' },
  { repo: 'iOfficeAI/AionUi',                           name: 'aion-ui',                        domain: 'ai' },
  { repo: 'nexu-io/open-design',                        name: 'open-design',                    domain: 'media' },
  { repo: 'anthropics/claude-plugins-official',         name: 'anthropic-plugins-official',     domain: 'ai' },
];

// Awesome-skills lists: each is a single kind='tool' entry pointing to the list.
// The actual skill markdown files inside aren't worth scraping individually
// here - they're already covered by the anthropics/skills + voltagent
// subagent scrapers, and the awesome lists are useful entries in their own
// right (curated meta-resources).
const AWESOME_LISTS: SingleSkill[] = [
  { repo: 'hesreallyhim/awesome-claude-code',           name: 'awesome-claude-code',            domain: 'ai' },
  { repo: 'VoltAgent/awesome-agent-skills',             name: 'awesome-agent-skills',           domain: 'ai' },
  { repo: 'sickn33/antigravity-awesome-skills',         name: 'antigravity-awesome-skills',     domain: 'ai' },
];

async function fetchRepo(slug: string): Promise<Repo | null> {
  const r = await fetch(`https://api.github.com/repos/${slug}`, { headers: HEADERS });
  if (!r.ok) return null;
  return (await r.json()) as Repo;
}

async function fetchReadme(slug: string): Promise<string> {
  try {
    const r = await fetch(`https://api.github.com/repos/${slug}/readme`, {
      headers: { ...HEADERS, accept: 'application/vnd.github.v3.raw' },
    });
    if (!r.ok) return '';
    const text = await r.text();
    return text.replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 800);
  } catch { return ''; }
}

function buildSpec(entry: SingleSkill, repo: Repo, readme: string, kind: ToolKind): ToolSpecV2 {
  const cap = `${entry.name}. ${(repo.description || entry.name).trim()}. ${readme}.  Stars: ${repo.stargazers_count}. Source: ${repo.html_url}.`.slice(0, 1400);
  return {
    name: entry.name,
    version: '1.0',
    author_agent_id: 'skills-extra',
    capability_text: cap,
    input_contract: { type: 'object', additionalProperties: true },
    output_contract: { type: 'object', additionalProperties: true },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'catalog-only-stub',
    metadata: {
      cost_per_call_usd: 0,
      p95_latency_ms: 0,
      reliability_score: 0.92,
      github_stars: repo.stargazers_count,
      github_last_commit_at: repo.pushed_at,
      github_fetched_at: new Date().toISOString(),
    },
    status: 'active',
    domain: entry.domain,
    tool_kind: kind,
  };
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  console.log(`scraping ${SINGLE_SKILLS.length} single-skill repos + ${AWESOME_LISTS.length} awesome-skills lists`);
  const specs: ToolSpecV2[] = [];

  for (const entry of SINGLE_SKILLS) {
    const repo = await fetchRepo(entry.repo);
    if (!repo) { console.log(`  ! ${entry.repo}: not found`); continue; }
    const readme = await fetchReadme(entry.repo);
    specs.push(buildSpec(entry, repo, readme, 'skill'));
    console.log(`  + skill ${entry.name} (${repo.stargazers_count}★)`);
  }
  for (const entry of AWESOME_LISTS) {
    const repo = await fetchRepo(entry.repo);
    if (!repo) { console.log(`  ! ${entry.repo}: not found`); continue; }
    const readme = await fetchReadme(entry.repo);
    specs.push(buildSpec(entry, repo, readme, 'tool'));
    console.log(`  + list  ${entry.name} (${repo.stargazers_count}★)`);
  }

  console.log(`\nimporting ${specs.length} entries`);
  const out = await importScrapedSpecs(storage, embedder, specs);
  console.log(`  imported ${out.imported}  skipped(existed) ${out.skipped_existing}  errors ${out.errors.length}`);
} finally {
  await storage.close();
}
