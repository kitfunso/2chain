// Awesome-list scraper — fetches a markdown README from a curated GitHub
// list (e.g. awesome-mcp-servers) and parses each `- [Name](url) - desc.`
// bullet into a ToolSpecV2. Resilient to leading emoji prefixes and bold
// markers (the popular punkpeye/awesome-mcp-servers list uses 🐍🟦 prefixes
// for language hints).
//
// Like npm-scraper, we fetch real bytes; tests inject `fetchImpl` to replay.

import type { ToolSpecV2 } from '../types.js';

export interface AwesomeEntry {
  name: string;
  url: string;
  description: string;
}

export interface ScrapeAwesomeOptions {
  /** Raw markdown URL — typically https://raw.githubusercontent.com/<owner>/<repo>/main/README.md */
  url: string;
  /** Maximum entries to extract. Default 500. */
  limit?: number;
  /** 2chain domain bucket. Defaults to 'awesome-list'. */
  domain?: string;
  /** Override the fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** User-agent for the GitHub fetch. */
  userAgent?: string;
  /** Author tag for resulting specs. */
  author?: string;
}

export interface ScrapeAwesomeResult {
  specs: ToolSpecV2[];
  total_lines: number;
  matched_lines: number;
  duration_ms: number;
}

// Match `- [Name](url) - description.` with optional leading prefix matter
// (emoji, bold markers, hashtags) and optional trailing prefix matter
// (closing bold). Handles all four common awesome-list shapes:
//   - [Name](url) - desc
//   - 🐍 [Name](url) - desc
//   - **[Name](url)** - desc
//   - **🐍 [Name](url)** - desc
//
// `[^\[\n]*` swallows the prefix matter (anything that isn't another link
// or a newline). `[^-\n:]*` between the closing paren and the separator
// accepts the trailing `**` / spaces of bold-wrapped names.
const BULLET = /^\s*[-*]\s+[^\[\n]*\[([^\]\n]+)\]\(([^)\s]+)\)[^-\n:]*[-:–—]+\s+(.+?)\s*$/;

export function parseAwesomeMarkdown(md: string): { entries: AwesomeEntry[]; totalLines: number } {
  const lines = md.split(/\r?\n/);
  const entries: AwesomeEntry[] = [];
  let inCodeBlock = false;
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const m = BULLET.exec(raw);
    if (!m) continue;
    const name = m[1].trim().replace(/^\*+|\*+$/g, ''); // strip bold markers
    const url = m[2].trim();
    const description = m[3].trim().replace(/\.$/, '');
    if (!name || !url || !description) continue;
    if (description.length < 5) continue; // skip near-empty descriptions
    entries.push({ name, url, description });
  }
  return { entries, totalLines: lines.length };
}

function entryToSpec(e: AwesomeEntry, domain: string, author: string): ToolSpecV2 {
  const slug = e.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return {
    name: slug,
    version: '1.0',
    author_agent_id: author,
    capability_text: `${e.name}  ${e.description}.  Source: ${e.url}.`,
    input_contract: { type: 'object', additionalProperties: true },
    output_contract: { type: 'object', additionalProperties: true },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'catalog-only-stub',
    metadata: {
      cost_per_call_usd: 0,
      p95_latency_ms: 0,
      reliability_score: 0.92,
    },
    status: 'active',
    domain,
    tool_kind: 'tool',
  };
}

export async function scrapeAwesomeList(opts: ScrapeAwesomeOptions): Promise<ScrapeAwesomeResult> {
  const t0 = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 500;
  const domain = opts.domain ?? 'awesome-list';
  const author = opts.author ?? 'awesome-scrape';
  const userAgent = opts.userAgent ?? '2chain-scraper/1.0 (+https://github.com/kitfunso/2chain)';

  const r = await fetchImpl(opts.url, { headers: { 'user-agent': userAgent } });
  if (!r.ok) {
    throw new Error(`awesome-list fetch returned ${r.status} for ${opts.url}`);
  }
  const md = await r.text();
  const { entries, totalLines } = parseAwesomeMarkdown(md);

  // Dedup by slug (multiple bullets occasionally point at the same project
  // under different names in long awesome lists).
  const seen = new Set<string>();
  const specs: ToolSpecV2[] = [];
  for (const e of entries) {
    if (specs.length >= limit) break;
    const spec = entryToSpec(e, domain, author);
    if (seen.has(spec.name)) continue;
    seen.add(spec.name);
    specs.push(spec);
  }

  return {
    specs,
    total_lines: totalLines,
    matched_lines: entries.length,
    duration_ms: Date.now() - t0,
  };
}
