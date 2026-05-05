// Push tool specs for the 3 new callable stubs (github-search, npm-search,
// wikipedia-search) so they appear in the registry as kind='tool' with a real
// callable endpoint. Idempotent via importScrapedSpecs skip-existing.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2 } from '../src/types.js';

const SPECS: ToolSpecV2[] = [
  {
    name: 'github-search',
    version: '1.0',
    author_agent_id: 'first-party',
    capability_text:
      'Search GitHub repositories by keyword. Returns the top-N repos sorted by stars with description, stargazer count, repo URL, last-pushed date, and primary language. Backed by api.github.com/search/repositories. Useful for finding popular libraries, AI tools, and code samples on a given topic.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        total_count: { type: 'integer' },
        results: { type: 'array', items: { type: 'object' } },
      },
      required: ['query', 'results'],
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'github-search-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 600, reliability_score: 1.0 },
    status: 'active',
    domain: 'code',
    tool_kind: 'tool',
  },
  {
    name: 'npm-search',
    version: '1.0',
    author_agent_id: 'first-party',
    capability_text:
      'Search the npm registry for packages by keyword. Returns the top-N matches with name, version, description, npm URL, homepage, and relevance score. Backed by registry.npmjs.org/-/v1/search. Useful for finding JavaScript/TypeScript libraries.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        total: { type: 'integer' },
        results: { type: 'array', items: { type: 'object' } },
      },
      required: ['query', 'results'],
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'npm-search-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 500, reliability_score: 1.0 },
    status: 'active',
    domain: 'code',
    tool_kind: 'tool',
  },
  {
    name: 'wikipedia-search',
    version: '1.0',
    author_agent_id: 'first-party',
    capability_text:
      'Search Wikipedia article titles by keyword. Returns the top-N matching articles with title, short description, and URL. Backed by en.wikipedia.org opensearch API. Useful for definitional lookups and disambiguation. No API key required.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        results: { type: 'array', items: { type: 'object' } },
      },
      required: ['query', 'results'],
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'wikipedia-search-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 400, reliability_score: 1.0 },
    status: 'active',
    domain: 'research',
    tool_kind: 'tool',
  },
  {
    name: 'hackernews-search',
    version: '1.0',
    author_agent_id: 'first-party',
    capability_text:
      'Search Hacker News stories by keyword. Returns the top-N stories by relevance with title, points, URL, and story ID. Backed by hn.algolia.com/api/v1/search. Useful for tracking startup, AI, and developer-tool discussions and finding link-worthy primary sources. No API key needed.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'hackernews-search-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 500, reliability_score: 0.95 },
    status: 'active',
    domain: 'research',
    tool_kind: 'tool',
  },
  {
    name: 'stackoverflow-search',
    version: '1.0',
    author_agent_id: 'first-party',
    capability_text:
      'Search Stack Overflow questions by keyword. Returns the top-N questions by relevance with title, score, link, and is_answered flag. Backed by api.stackexchange.com (Stack Exchange API v2.3). Useful for finding canonical answers to programming questions and surfacing community consensus on tooling.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'stackoverflow-search-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 500, reliability_score: 0.95 },
    status: 'active',
    domain: 'research',
    tool_kind: 'tool',
  },
  {
    name: 'reddit-search',
    version: '1.0',
    author_agent_id: 'first-party',
    capability_text:
      'Search Reddit posts by keyword across all subreddits. Returns the top-N posts by relevance with title, score, permalink, and subreddit. Backed by reddit.com/search.json. Useful for surfacing user discussions, product reviews, and community sentiment. No API key needed.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'reddit-search-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 700, reliability_score: 0.95 },
    status: 'active',
    domain: 'research',
    tool_kind: 'tool',
  },
  {
    name: 'pypi-search',
    version: '1.0',
    author_agent_id: 'first-party',
    capability_text:
      'Look up an exact Python package on PyPI by name. Returns the package name, version, summary, and project URLs. Backed by pypi.org/pypi/{name}/json. Returns empty results on 404 (unknown package). Note: PyPI has no general keyword search API; pass the exact distribution name as query.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'pypi-search-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 400, reliability_score: 0.95 },
    status: 'active',
    domain: 'coding',
    tool_kind: 'tool',
  },
  {
    name: 'crates-io-search',
    version: '1.0',
    author_agent_id: 'first-party',
    capability_text:
      'Search the crates.io Rust package registry by keyword. Returns the top-N crates with name, max_version, description, and download count. Backed by crates.io/api/v1/crates. Useful for finding Rust libraries and gauging adoption. No API key needed.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'crates-io-search-v1',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 500, reliability_score: 0.95 },
    status: 'active',
    domain: 'coding',
    tool_kind: 'tool',
  },
];

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  console.log(`pushing ${SPECS.length} callable-stub specs`);
  const out = await importScrapedSpecs(storage, embedder, SPECS);
  console.log(`  imported ${out.imported}  skipped(existed) ${out.skipped_existing}  errors ${out.errors.length}`);
} finally {
  await storage.close();
}
