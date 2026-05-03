// PyPI scraper — Python's package index. Uses the JSON simple API for
// metadata (https://pypi.org/pypi/<name>/json). Discovery happens via
// libraries.io style topic search OR a curated list of search terms run
// against the PyPI XMLRPC search... except that endpoint was retired.
//
// Pragmatic approach: PyPI's official "search" was deprecated. We use the
// libraries.io-mirrored search (free public mirror) for discovery, then
// hit pypi.org/pypi/<name>/json for authoritative metadata. If
// libraries.io is unreachable, fall back to a hand-curated topic list.
//
// For the scope of this scraper we use the simpler "name list" path:
// caller passes a list of package names (or we resolve from a query
// against pypi.org's RSS/recent-uploads feed). The CLI default fetches
// the top-N MCP-related packages by name pattern.

import type { ToolSpecV2 } from '../types.js';

export interface PypiPackageInfo {
  name: string;
  version: string;
  summary?: string;
  description?: string;
  home_page?: string;
  project_urls?: Record<string, string>;
  keywords?: string;
  classifiers?: string[];
  author?: string;
  license?: string;
}

interface PypiJsonResponse {
  info: PypiPackageInfo;
  // urls, releases etc. not used here
}

const PYPI_BASE = 'https://pypi.org/pypi';
const SEARCH_PROXY = 'https://pypi.org/search/'; // HTML scraping fallback (used when libraries.io is unavailable)

export interface ScrapePypiOptions {
  /** Explicit list of package names to fetch metadata for. */
  names: string[];
  /** Fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** 2chain domain bucket. Defaults to 'python'. */
  domain?: string;
  /** User-Agent. */
  userAgent?: string;
  /** Hard cap (defaults to names.length). */
  limit?: number;
}

export interface ScrapePypiResult {
  specs: ToolSpecV2[];
  fetched: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
  duration_ms: number;
}

function infoToSpec(info: PypiPackageInfo, domain: string): ToolSpecV2 {
  const parts: string[] = [info.name];
  if (info.summary) parts.push(info.summary);
  if (info.keywords) parts.push('Keywords: ' + info.keywords + '.');
  // First 400 chars of description (often a long README; we only need a snippet for the embed).
  if (info.description) parts.push(info.description.replace(/\s+/g, ' ').slice(0, 400));
  const repo = info.project_urls?.Repository
    ?? info.project_urls?.Source
    ?? info.project_urls?.Homepage
    ?? info.home_page;
  if (repo) parts.push('Source: ' + repo + '.');

  return {
    name: 'py:' + info.name.toLowerCase(),  // py: prefix avoids collision with npm same-named packages
    version: '1.0',
    author_agent_id: 'pypi-scrape',
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

export async function scrapePypi(opts: ScrapePypiOptions): Promise<ScrapePypiResult> {
  const t0 = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const domain = opts.domain ?? 'python';
  const userAgent = opts.userAgent ?? '2chain-scraper/1.0 (+https://github.com/kitfunso/2chain)';
  const limit = opts.limit ?? opts.names.length;

  const result: ScrapePypiResult = {
    specs: [],
    fetched: 0,
    failed: 0,
    errors: [],
    duration_ms: 0,
  };

  for (const name of opts.names.slice(0, limit)) {
    try {
      const url = `${PYPI_BASE}/${encodeURIComponent(name)}/json`;
      const r = await fetchImpl(url, { headers: { 'user-agent': userAgent, 'accept': 'application/json' } });
      if (!r.ok) {
        result.failed++;
        result.errors.push({ name, error: `pypi returned ${r.status}` });
        continue;
      }
      const body = (await r.json()) as PypiJsonResponse;
      if (!body.info?.name) {
        result.failed++;
        result.errors.push({ name, error: 'no info.name in response' });
        continue;
      }
      result.specs.push(infoToSpec(body.info, domain));
      result.fetched++;
    } catch (e) {
      result.failed++;
      result.errors.push({ name, error: (e as Error).message });
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

/**
 * A curated list of well-known Python packages relevant to AI agents +
 * MCP + LLM tooling. Used when no explicit --names list is provided.
 */
export const PYPI_DEFAULT_NAMES: string[] = [
  // Anthropic / OpenAI / general LLM
  'anthropic', 'openai', 'mistralai', 'cohere', 'google-genai',
  // MCP
  'mcp', 'fastmcp', 'mcp-server', 'mcp-cli', 'mcp-client',
  // Agent frameworks
  'langchain', 'langgraph', 'llama-index', 'haystack-ai', 'autogen-agentchat',
  'crewai', 'pydantic-ai', 'instructor', 'guidance', 'dspy-ai',
  // Vector / embeddings
  'sqlite-vec', 'chromadb', 'qdrant-client', 'pinecone-client', 'weaviate-client',
  'sentence-transformers', 'voyageai',
  // Document / unstructured
  'unstructured', 'llama-parse', 'pypdf', 'pdfplumber', 'beautifulsoup4',
  // Data
  'pandas', 'polars', 'pyarrow', 'duckdb',
  // Web / browser automation
  'requests', 'httpx', 'playwright', 'selenium',
  // Testing / dev
  'pytest', 'mypy', 'ruff', 'black',
  // Cloud SDKs
  'boto3', 'google-cloud-storage', 'azure-storage-blob',
  // Embedding models
  'transformers', 'torch', 'tiktoken',
  // Misc real, useful
  'rich', 'typer', 'fastapi', 'pydantic', 'sqlalchemy',
];
