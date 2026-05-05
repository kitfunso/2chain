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
