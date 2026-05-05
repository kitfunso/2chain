// Enrich each tool's metadata with github_stars + github_last_commit_at by
// extracting the Source URL from capability_text and calling GitHub's REST API.
// Idempotent: skips tools whose metadata.github_fetched_at is < REFRESH_DAYS old.
//
// Auth: set GITHUB_TOKEN to get 5000/hr; unauthenticated is 60/hr.
// Run: STORAGE_DRIVER=sqlite tsx scripts/enrich-github-stats.ts

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const REFRESH_DAYS = 7;
const REQ_PAUSE_MS = Number(process.env.GH_PAUSE_MS ?? 100);
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const HEADERS: Record<string, string> = {
  'user-agent': '2chain-enricher/1.0',
  accept: 'application/vnd.github+json',
};
if (TOKEN) HEADERS.authorization = `Bearer ${TOKEN}`;

interface ToolRow { rowid: number; name: string; author_agent_id: string; metadata: string; capability_text: string }

// Authors whose entries point at an aggregator catalog repo (not the per-tool
// repo), so the inherited star count is meaningless and floods sort-by-stars.
const SKIP_AUTHORS = new Set([
  'awesome-chatgpt-prompts',
  'awesome-voltagent-claude-subagents',
  'awesome-wshobson-agents',
  'anthropic-skills',
]);

const REPO_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:[\/.#?]|$)/i;

function extractRepo(text: string): { owner: string; repo: string } | null {
  const m = text.match(REPO_RE);
  if (!m) return null;
  let repo = m[2];
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (['issues','pulls','blob','tree','releases','actions'].includes(repo)) return null;
  return { owner: m[1], repo };
}

interface RepoMeta { stargazers_count: number; pushed_at: string }

async function fetchRepo(owner: string, repo: string): Promise<RepoMeta | { error: string; status: number }> {
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: HEADERS });
  if (!r.ok) return { error: r.statusText, status: r.status };
  const j = (await r.json()) as RepoMeta;
  return j;
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const db = new Database(dbPath);
db.function('notify_change', { deterministic: false, varargs: true }, (..._args: unknown[]) => null);

const rows = db.prepare(`SELECT rowid, name, author_agent_id, metadata, capability_text FROM tools`).all() as ToolRow[];
console.log(`scanning ${rows.length} tools  (token=${TOKEN ? 'yes' : 'no'}, pause=${REQ_PAUSE_MS}ms)`);

const upd = db.prepare('UPDATE tools SET metadata = ? WHERE rowid = ?');

let fetched = 0, skipped_recent = 0, skipped_no_repo = 0, errors = 0, rate_limited = 0;
const cutoff = Date.now() - REFRESH_DAYS * 86400_000;

let cleared_aggregator = 0;
for (const row of rows) {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(row.metadata || '{}'); } catch {}

  // Aggregator-sourced rows: clear any inherited parent-repo stars and skip.
  if (SKIP_AUTHORS.has(row.author_agent_id)) {
    if (meta.github_stars !== undefined) {
      delete meta.github_stars;
      delete meta.github_last_commit_at;
      delete meta.github_fetched_at;
      upd.run(JSON.stringify(meta), row.rowid);
      cleared_aggregator++;
    }
    continue;
  }

  const fetchedAt = (meta.github_fetched_at as string) || '';
  if (fetchedAt && new Date(fetchedAt).getTime() > cutoff) { skipped_recent++; continue; }

  const repo = extractRepo(row.capability_text || '');
  if (!repo) { skipped_no_repo++; continue; }

  const result = await fetchRepo(repo.owner, repo.repo);
  if ('error' in result) {
    if (result.status === 403 || result.status === 429) {
      rate_limited++;
      console.log(`rate-limited at row ${rows.indexOf(row)}/${rows.length} after ${fetched} fetched. stop.`);
      break;
    }
    errors++;
    if (errors < 10) console.log(`  ${row.name}: ${result.status} ${result.error}`);
    meta.github_fetched_at = new Date().toISOString();
    meta.github_error = result.status;
    upd.run(JSON.stringify(meta), row.rowid);
    continue;
  }
  meta.github_stars = result.stargazers_count;
  meta.github_last_commit_at = result.pushed_at;
  meta.github_fetched_at = new Date().toISOString();
  delete meta.github_error;
  upd.run(JSON.stringify(meta), row.rowid);
  fetched++;
  if (fetched % 50 === 0) console.log(`  ${fetched} fetched`);
  if (REQ_PAUSE_MS) await new Promise((r) => setTimeout(r, REQ_PAUSE_MS));
}

console.log(`\nfetched: ${fetched}`);
console.log(`cleared (aggregator-sourced): ${cleared_aggregator}`);
console.log(`skipped (recently refreshed): ${skipped_recent}`);
console.log(`skipped (no github URL): ${skipped_no_repo}`);
console.log(`errors (404/etc): ${errors}`);
console.log(`rate-limit hit: ${rate_limited > 0 ? 'yes' : 'no'}`);

db.close();
