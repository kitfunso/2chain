// Hugging Face Hub scraper — pulls models, datasets, and spaces metadata.
// Uses the public Hub API: https://huggingface.co/api/{models,datasets,spaces}
// (documented at https://huggingface.co/docs/hub/api).
//
// Each model becomes a 2chain catalog entry with hf: prefix so it doesn't
// collide with npm/pypi names.

import type { ToolSpecV2 } from '../types.js';

export type HfResource = 'models' | 'datasets' | 'spaces';

export interface HfModel {
  id: string;             // e.g. "anthropic/claude-3-haiku-...
  modelId?: string;
  pipeline_tag?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
  library_name?: string;
  private?: boolean;
}

const HF_BASE = 'https://huggingface.co/api';

export interface ScrapeHfOptions {
  /** Resource type: 'models' | 'datasets' | 'spaces'. */
  resource?: HfResource;
  /** Search filter (mirrors HF UI filter, e.g. 'pipeline_tag=text-generation'). */
  filter?: string;
  /** Sort key: downloads | likes | trendingScore | createdAt | lastModified. */
  sort?: string;
  /** Page size (HF caps at 100 per page; we paginate via cursor). */
  limit?: number;
  /** 2chain domain bucket. Defaults derive from resource (models -> 'ml-models'). */
  domain?: string;
  /** Fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** User-agent. */
  userAgent?: string;
}

export interface ScrapeHfResult {
  specs: ToolSpecV2[];
  fetched: number;
  duration_ms: number;
}

function modelToSpec(m: HfModel, resource: HfResource, domain: string): ToolSpecV2 {
  const id = m.id || m.modelId || '';
  const parts: string[] = [id];
  if (m.pipeline_tag) parts.push('Pipeline: ' + m.pipeline_tag + '.');
  if (m.library_name) parts.push('Library: ' + m.library_name + '.');
  if (m.tags && m.tags.length > 0) parts.push('Tags: ' + m.tags.slice(0, 8).join(', ') + '.');
  if (m.downloads) parts.push('Downloads: ' + m.downloads + '.');
  parts.push(`Hugging Face ${resource.slice(0, -1)}: https://huggingface.co/${id}`);

  return {
    name: 'hf:' + id.toLowerCase().replace(/[^a-z0-9/-]+/g, '-'),
    version: '1.0',
    author_agent_id: 'hf-scrape',
    capability_text: parts.join('  '),
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

export async function scrapeHuggingFace(opts: ScrapeHfOptions): Promise<ScrapeHfResult> {
  const t0 = Date.now();
  const resource = opts.resource ?? 'models';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 100;
  const domain = opts.domain ?? (resource === 'datasets' ? 'datasets' : resource === 'spaces' ? 'apps' : 'ml-models');
  const userAgent = opts.userAgent ?? '2chain-scraper/1.0 (+https://github.com/kitfunso/2chain)';

  const params = new URLSearchParams();
  if (opts.filter) params.set('filter', opts.filter);
  params.set('sort', opts.sort ?? 'downloads');
  params.set('direction', '-1');
  params.set('limit', String(Math.min(100, limit)));
  params.set('full', 'false');

  const specs: ToolSpecV2[] = [];
  let cursor: string | undefined;
  while (specs.length < limit) {
    const p = new URLSearchParams(params);
    if (cursor) p.set('cursor', cursor);
    const url = `${HF_BASE}/${resource}?${p.toString()}`;
    const r = await fetchImpl(url, { headers: { 'user-agent': userAgent, 'accept': 'application/json' } });
    if (!r.ok) {
      throw new Error(`hugging face returned ${r.status} for ${url}`);
    }
    const body = (await r.json()) as HfModel[];
    if (!Array.isArray(body) || body.length === 0) break;
    for (const m of body) {
      if (specs.length >= limit) break;
      if (m.private) continue;
      specs.push(modelToSpec(m, resource, domain));
    }
    // Cursor pagination via Link header (HF uses RFC5988). For our scope
    // a single page of 100 is plenty; bail out unless the user asks for more.
    const linkHeader = r.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
    if (!next) break;
    const nextUrl = new URL(next[1]);
    cursor = nextUrl.searchParams.get('cursor') ?? undefined;
    if (!cursor) break;
  }

  return {
    specs,
    fetched: specs.length,
    duration_ms: Date.now() - t0,
  };
}
