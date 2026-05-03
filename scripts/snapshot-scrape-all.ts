// Nightly snapshot orchestrator. Hits every live source we know about,
// merges into a single JSON manifest at data/registry-snapshot.json.
// No embedder dependency — pure metadata fetch, safe to run on a CI
// runner without Ollama.
//
// The local `npm run import:snapshot` command loads this file, embeds
// each spec with the configured Embedder, and upserts via the same
// dedupe path the scrapers use.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scrapeNpm } from '../src/import/npm-scraper.js';
import { scrapeAwesomeList } from '../src/import/awesome-list-scraper.js';
import { scrapePypi, PYPI_DEFAULT_NAMES } from '../src/import/pypi-scraper.js';
import { scrapeHuggingFace } from '../src/import/hf-scraper.js';
import type { ToolSpecV2 } from '../src/types.js';

interface SnapshotSource {
  source: string;
  count: number;
  duration_ms: number;
  notes?: string;
}

interface Snapshot {
  generated_at: string;
  total_specs: number;
  sources: SnapshotSource[];
  specs: ToolSpecV2[];
}

// Curated awesome-* lists. Each one becomes a separate scrape with its own
// domain bucket. Adding a new list here is the standard way to grow the
// catalog with no code changes.
const AWESOME_LISTS: Array<{ name: string; url: string; domain: string; limit: number }> = [
  {
    name: 'awesome-mcp-servers',
    url: 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
    domain: 'mcp',
    limit: 300,
  },
  {
    name: 'awesome-claude-prompts',
    url: 'https://raw.githubusercontent.com/langgptai/awesome-claude-prompts/main/README.md',
    domain: 'prompts',
    limit: 200,
  },
  {
    name: 'awesome-langchain',
    url: 'https://raw.githubusercontent.com/kyrolabs/awesome-langchain/main/README.md',
    domain: 'agent-frameworks',
    limit: 200,
  },
  {
    name: 'awesome-rag',
    url: 'https://raw.githubusercontent.com/lucifertrj/Awesome-RAG/main/README.md',
    domain: 'rag',
    limit: 150,
  },
  {
    name: 'awesome-llmops',
    url: 'https://raw.githubusercontent.com/tensorchord/Awesome-LLMOps/main/README.md',
    domain: 'llmops',
    limit: 200,
  },
];

const NPM_QUERIES: Array<{ q: string; domain: string; limit: number }> = [
  { q: 'keywords:mcp', domain: 'mcp', limit: 150 },
  { q: 'keywords:openapi', domain: 'devtools', limit: 50 },
  { q: 'keywords:vector-database', domain: 'data', limit: 30 },
];

const HF_QUERIES: Array<{ resource: 'models' | 'datasets' | 'spaces'; limit: number; sort?: string }> = [
  { resource: 'models', limit: 150, sort: 'downloads' },
  { resource: 'datasets', limit: 50, sort: 'downloads' },
];

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error(`  [${label}] FAILED: ${(e as Error).message}`);
    return null;
  }
}

const sources: SnapshotSource[] = [];
const allSpecs: ToolSpecV2[] = [];
const seenNames = new Set<string>();

function pushSpecs(specs: ToolSpecV2[]): number {
  let added = 0;
  for (const s of specs) {
    if (seenNames.has(s.name)) continue;
    seenNames.add(s.name);
    allSpecs.push(s);
    added++;
  }
  return added;
}

console.log('snapshot-scrape-all: fetching from all sources...\n');

// 1. npm
for (const q of NPM_QUERIES) {
  const t0 = Date.now();
  const r = await safe(`npm:${q.q}`, () =>
    scrapeNpm({ query: q.q, limit: q.limit, domain: q.domain }),
  );
  const ms = Date.now() - t0;
  if (r) {
    const added = pushSpecs(r.specs);
    sources.push({ source: `npm:${q.q}`, count: added, duration_ms: ms });
    console.log(`  npm "${q.q}": +${added} (${r.specs.length} scraped, ${ms}ms)`);
  } else {
    sources.push({ source: `npm:${q.q}`, count: 0, duration_ms: ms, notes: 'failed' });
  }
}

// 2. awesome-* lists
for (const list of AWESOME_LISTS) {
  const t0 = Date.now();
  const r = await safe(`awesome:${list.name}`, () =>
    scrapeAwesomeList({ url: list.url, limit: list.limit, domain: list.domain, author: `awesome-${list.name}` }),
  );
  const ms = Date.now() - t0;
  if (r) {
    const added = pushSpecs(r.specs);
    sources.push({ source: `awesome:${list.name}`, count: added, duration_ms: ms });
    console.log(`  ${list.name}: +${added} (${r.specs.length} scraped, ${r.matched_lines} matched, ${ms}ms)`);
  } else {
    sources.push({ source: `awesome:${list.name}`, count: 0, duration_ms: ms, notes: 'failed' });
  }
}

// 3. PyPI
{
  const t0 = Date.now();
  const r = await safe('pypi:default', () =>
    scrapePypi({ names: PYPI_DEFAULT_NAMES, limit: PYPI_DEFAULT_NAMES.length }),
  );
  const ms = Date.now() - t0;
  if (r) {
    const added = pushSpecs(r.specs);
    sources.push({ source: 'pypi:default', count: added, duration_ms: ms });
    console.log(`  pypi default list: +${added} (${r.fetched} fetched, ${r.failed} failed, ${ms}ms)`);
  } else {
    sources.push({ source: 'pypi:default', count: 0, duration_ms: ms, notes: 'failed' });
  }
}

// 4. Hugging Face
for (const q of HF_QUERIES) {
  const t0 = Date.now();
  const r = await safe(`hf:${q.resource}`, () =>
    scrapeHuggingFace({ resource: q.resource, limit: q.limit, sort: q.sort }),
  );
  const ms = Date.now() - t0;
  if (r) {
    const added = pushSpecs(r.specs);
    sources.push({ source: `hf:${q.resource}`, count: added, duration_ms: ms });
    console.log(`  hf ${q.resource}: +${added} (${r.fetched} scraped, ${ms}ms)`);
  } else {
    sources.push({ source: `hf:${q.resource}`, count: 0, duration_ms: ms, notes: 'failed' });
  }
}

const snapshot: Snapshot = {
  generated_at: new Date().toISOString(),
  total_specs: allSpecs.length,
  sources,
  specs: allSpecs,
};

const outPath = resolve('data/registry-snapshot.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

// Also write a human-readable summary for the commit body / dashboard.
const statsPath = resolve('docs/registry-stats.md');
mkdirSync(dirname(statsPath), { recursive: true });
const statsLines = [
  '# Registry stats',
  '',
  `Snapshot generated: \`${snapshot.generated_at}\``,
  '',
  `Total unique specs: **${snapshot.total_specs}**`,
  '',
  '## Per-source counts',
  '',
  '| Source | Specs | Duration |',
  '|---|---:|---:|',
  ...sources.map((s) => `| ${s.source}${s.notes ? ` (${s.notes})` : ''} | ${s.count} | ${s.duration_ms}ms |`),
  '',
];
writeFileSync(statsPath, statsLines.join('\n'));

console.log('\n=== snapshot ===');
console.log(`  ${snapshot.total_specs} unique specs across ${sources.length} sources`);
console.log(`  ${outPath}`);
console.log(`  ${statsPath}`);
