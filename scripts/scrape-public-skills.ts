// Scrape public Claude Code skill collections. Pulls anthropics/skills
// (the official Anthropic skills repo) by listing its `skills/` dir via the
// GitHub API, fetching each SKILL.md, and parsing the YAML frontmatter for
// name + description.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2 } from '../src/types.js';

interface SkillRepo {
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string;       // path inside repo where skills live (e.g. 'skills')
  domain: string;
  author: string;
}

const REPOS: SkillRepo[] = [
  {
    owner: 'anthropics',
    repo: 'skills',
    branch: 'main',
    pathPrefix: 'skills',
    domain: 'skills',
    author: 'anthropic-skills',
  },
];

interface GhEntry { name: string; type: 'dir' | 'file' }

async function listDirs(repo: SkillRepo): Promise<string[]> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${repo.pathPrefix}?ref=${repo.branch}`;
  const r = await fetch(url, { headers: { 'user-agent': '2chain-scraper/1.0', accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`gh contents ${r.status}`);
  const arr = (await r.json()) as GhEntry[];
  return arr.filter((e) => e.type === 'dir').map((e) => e.name);
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const body = m[1];
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (kv) out[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return { name: out.name, description: out.description };
}

async function fetchSkill(repo: SkillRepo, dir: string): Promise<ToolSpecV2 | null> {
  const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.branch}/${repo.pathPrefix}/${dir}/SKILL.md`;
  const r = await fetch(url, { headers: { 'user-agent': '2chain-scraper/1.0' } });
  if (!r.ok) return null;
  const md = await r.text();
  const fm = parseFrontmatter(md);
  const name = fm.name ?? dir;
  const description = fm.description ?? `Claude Code skill: ${dir}.`;
  const sourceUrl = `https://github.com/${repo.owner}/${repo.repo}/tree/${repo.branch}/${repo.pathPrefix}/${dir}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || dir;
  return {
    name: slug,
    version: '1.0',
    author_agent_id: repo.author,
    capability_text: `${name}  ${description}.  Source: ${sourceUrl}.`,
    input_contract: { type: 'object', additionalProperties: true },
    output_contract: { type: 'object', additionalProperties: true },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'catalog-only-stub',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0.92 },
    status: 'active',
    domain: repo.domain,
    tool_kind: 'skill',
  };
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  const allSpecs: ToolSpecV2[] = [];
  for (const repo of REPOS) {
    console.log(`listing ${repo.owner}/${repo.repo}/${repo.pathPrefix}`);
    const dirs = await listDirs(repo);
    console.log(`  found ${dirs.length} skill dirs`);
    for (const dir of dirs) {
      const spec = await fetchSkill(repo, dir);
      if (spec) allSpecs.push(spec);
    }
  }
  console.log(`\nimporting ${allSpecs.length} skill specs`);
  const r = await importScrapedSpecs(storage, embedder, allSpecs);
  console.log(`  imported ${r.imported}  skipped(existed) ${r.skipped_existing}  errors ${r.errors.length}`);
  if (r.errors.length) for (const e of r.errors.slice(0, 5)) console.log(`    [${e.name}] ${e.error}`);
  const stats = await storage.dbStats();
  console.log(`\ndb total tools: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
