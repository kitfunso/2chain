// npm registry scraper — pulls real packages by keyword/text query, normalises
// each into a 2chain ToolSpecV2 row. Returns specs only; persistence is the
// caller's job (so we can dry-run, dedupe against existing tools, etc.).
//
// Source of truth: https://registry.npmjs.org/-/v1/search?text=<q>&size=<n>
// Documented at: https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
//
// Why this isn't a mock: we hit the real npm registry. Tests inject a
// `fetchImpl` so they can replay a recorded payload without network
// (CLAUDE.md rule 5 forbids mocking storage; HTTP is allowed to be replayed).

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
  /** npm search query — `keywords:mcp`, `text:openapi`, etc. */
  query: string;
  /** Maximum total packages to scrape across pages. */
  limit?: number;
  /** Override the fetch implementation (used by tests to replay a payload). */
  fetchImpl?: typeof fetch;
  /** 2chain domain bucket to assign. Defaults to 'devtools'. */
  domain?: string;
  /** User-Agent header — npm asks for one. */
  userAgent?: string;
}

export interface ScrapeNpmResult {
  specs: ToolSpecV2[];
  pages_fetched: number;
  total_available: number;
  duration_ms: number;
}

/**
 * Build the 2chain capability_text from an npm package's metadata. Uses
 * description + keywords + repo URL so the embedder has enough signal even
 * for terse descriptions ("MCP server for X" -> we add the keywords to the
 * text so similar packages cluster).
 */
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

  // The 2chain tool name uses the npm package name verbatim. Scoped packages
  // (@scope/name) keep the slash; SQLite UNIQUE(namespace, name, version) is
  // happy with it. Authors can republish under their own name later.
  return {
    name: pkg.name,
    version: '1.0', // we don't echo the npm version — that's the *package* version,
                     // not the registry-entry version. Re-scrapes may bump capability_text
                     // but the tool stays at v1.0 for the discovery surface.
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
    if (body.objects.length < size) break; // last page
  }

  return {
    specs,
    pages_fetched: page,
    total_available: total,
    duration_ms: Date.now() - t0,
  };
}
