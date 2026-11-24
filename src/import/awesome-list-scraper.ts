import type { ToolSpecV2 } from '../types.js';

export interface AwesomeEntry {
  name: string;
  url: string;
  description: string;
}

export interface ScrapeAwesomeOptions {
  url: string;
  limit?: number;
  domain?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  author?: string;
  kind?: 'tool' | 'skill' | 'subagent' | 'prompt';
}

export interface ScrapeAwesomeResult {
  specs: ToolSpecV2[];
  total_lines: number;
  matched_lines: number;
  duration_ms: number;
}

const BULLET = /^\s*[-*]\s+[^\[\n]*\[([^\]\n]+)\]\(([^)\s]+)\)[^-\n:]*[-:–—]+\s+(.+?)\s*$/;

const TABLE = /^\|\s*\[([^\]\n]+)\]\(([^)\s]+)\)\s*\|\s*([^|\n]+?)\s*(?:\||$)/;

const BARE_BULLET = /^\s*[-*]\s+\[([^\]\n]{4,})\]\((https?:\/\/[^)\s]+)\)\s*$/;

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

    let name: string | undefined;
    let url: string | undefined;
    let description: string | undefined;
    const bm = BULLET.exec(raw);
    if (bm) {
      name = bm[1];
      url = bm[2];
      description = bm[3];
    } else {
      const tm = TABLE.exec(raw);
      if (tm) {
        name = tm[1];
        url = tm[2];
        description = tm[3];
      } else {
        const bb = BARE_BULLET.exec(raw);
        if (bb) {
          name = bb[1];
          url = bb[2];
          description = `${bb[1]} — see ${bb[2]}`;
        }
      }
    }
    if (!name || !url || !description) continue;

    name = name.trim().replace(/^\*+|\*+$/g, '');
    url = url.trim();
    description = description.trim()
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\.$/, '')
      .trim();
    if (!description || description.length < 5) continue;
    entries.push({ name, url, description });
  }
  return { entries, totalLines: lines.length };
}

function entryToSpec(e: AwesomeEntry, domain: string, author: string, kind: 'tool' | 'skill' | 'subagent' | 'prompt' = 'tool'): ToolSpecV2 {
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
    tool_kind: kind,
  };
}

export async function scrapeAwesomeList(opts: ScrapeAwesomeOptions): Promise<ScrapeAwesomeResult> {
  const t0 = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 500;
  const domain = opts.domain ?? 'awesome-list';
  const author = opts.author ?? 'awesome-scrape';
  const kind = opts.kind ?? 'tool';
  const userAgent = opts.userAgent ?? '2chain-scraper/1.0 (+https://github.com/kitfunso/2chain)';

  const r = await fetchImpl(opts.url, { headers: { 'user-agent': userAgent } });
  if (!r.ok) {
    throw new Error(`awesome-list fetch returned ${r.status} for ${opts.url}`);
  }
  const md = await r.text();
  const { entries, totalLines } = parseAwesomeMarkdown(md);

  const seen = new Set<string>();
  const specs: ToolSpecV2[] = [];
  for (const e of entries) {
    if (specs.length >= limit) break;
    const spec = entryToSpec(e, domain, author, kind);
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
