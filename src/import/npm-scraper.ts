import type { ToolSpecV2 } from '../types.js';

export interface NpmSearchPackage {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  date?: string;
  links?: {
    npm?: string;
    homepage?: string;
    repository?: string;
    bugs?: string;
  };
  publisher?: { username?: string };
}

export interface NpmSearchResponse {
  objects: Array<{
    package: NpmSearchPackage;
    score?: { final?: number };
    searchScore?: number;
  }>;
  total: number;
}

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const PAGE_SIZE = 250; // npm caps at 250 per page

export interface ScrapeNpmOptions {
  query: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  domain?: string;
  userAgent?: string;
}

export interface ScrapeNpmResult {
  specs: ToolSpecV2[];
  pages_fetched: number;
  total_available: number;
  duration_ms: number;
}

function packageToSpec(pkg: NpmSearchPackage, domain: string): ToolSpecV2 {
  const parts: string[] = [pkg.name];
  if (pkg.description) parts.push(pkg.description);
  if (pkg.keywords && pkg.keywords.length > 0) {
    parts.push('Keywords: ' + pkg.keywords.join(', ') + '.');
  }
  if (pkg.links?.repository) {
    parts.push('Source: ' + pkg.links.repository + '.');
  }
  const capability_text = parts.join('  ');

  return {
    name: pkg.name,
    version: '1.0',
    author_agent_id: 'npm-scrape',
    capability_text,
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

export async function scrapeNpm(opts: ScrapeNpmOptions): Promise<ScrapeNpmResult> {
  const t0 = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 250;
  const domain = opts.domain ?? 'devtools';
  const userAgent = opts.userAgent ?? '2chain-scraper/1.0 (+https://github.com/kitfunso/2chain)';

  const specs: ToolSpecV2[] = [];
  let page = 0;
  let total = 0;
  while (specs.length < limit) {
    const size = Math.min(PAGE_SIZE, limit - specs.length);
    const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(opts.query)}&size=${size}&from=${page * PAGE_SIZE}`;
    const r = await fetchImpl(url, { headers: { 'user-agent': userAgent } });
    if (!r.ok) {
      throw new Error(`npm registry returned ${r.status} for ${url}`);
    }
    const body = (await r.json()) as NpmSearchResponse;
    total = body.total;
    if (!body.objects || body.objects.length === 0) break;
    for (const obj of body.objects) {
      if (specs.length >= limit) break;
      specs.push(packageToSpec(obj.package, domain));
    }
    page++;
    if (body.objects.length < size) break;
  }

  return {
    specs,
    pages_fetched: page,
    total_available: total,
    duration_ms: Date.now() - t0,
  };
}
