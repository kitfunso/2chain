// Scraper tests — exercise npm + awesome-list parsers against recorded
// payloads. The HTTP layer is injected (fetchImpl) so tests don't depend
// on network. Storage is real :memory: SQLite per CLAUDE.md rule 5.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { scrapeNpm } from '../src/import/npm-scraper.js';
import { scrapeAwesomeList, parseAwesomeMarkdown } from '../src/import/awesome-list-scraper.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { Embedder } from '../src/types.js';

class StubEmbedder implements Embedder {
  name() { return 'stub:zero'; }
  dim() { return 768; }
  async embed(): Promise<Float32Array> { return makeUnitVec(1); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, i) => makeUnitVec(i + 1));
  }
  async prewarm() {}
  async cachedEmbed() { return { vec: makeUnitVec(1), cached: false, ms: 0 }; }
}

function makeUnitVec(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

// Real-shape recorded npm registry response (3 sample @modelcontextprotocol packages).
// Trimmed to the fields the scraper actually reads.
const NPM_PAYLOAD = {
  total: 3,
  time: 'Sun May 03 2026 12:00:00 GMT+0000',
  objects: [
    {
      package: {
        name: '@modelcontextprotocol/server-filesystem',
        version: '0.1.0',
        description: 'MCP server for filesystem read/write',
        keywords: ['mcp', 'modelcontextprotocol', 'filesystem'],
        date: '2024-11-25T00:00:00Z',
        links: {
          npm: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem',
          repository: 'https://github.com/modelcontextprotocol/servers',
        },
        publisher: { username: 'modelcontextprotocol' },
      },
      score: { final: 0.62 },
      searchScore: 100,
    },
    {
      package: {
        name: '@modelcontextprotocol/server-github',
        version: '0.5.0',
        description: 'MCP server for GitHub repos',
        keywords: ['mcp', 'github'],
        date: '2024-12-10T00:00:00Z',
        links: {
          npm: 'https://www.npmjs.com/package/@modelcontextprotocol/server-github',
          repository: 'https://github.com/modelcontextprotocol/servers',
        },
        publisher: { username: 'modelcontextprotocol' },
      },
      score: { final: 0.6 },
      searchScore: 80,
    },
    {
      package: {
        name: 'mcp-server-sqlite',
        version: '1.0.0',
        description: 'Community MCP server for SQLite databases',
        keywords: ['mcp', 'sqlite'],
        date: '2025-02-01T00:00:00Z',
        links: {
          npm: 'https://www.npmjs.com/package/mcp-server-sqlite',
          repository: 'https://github.com/example/mcp-server-sqlite',
        },
      },
      score: { final: 0.4 },
      searchScore: 50,
    },
  ],
};

const AWESOME_MD = `# awesome-mcp-servers

A curated list of awesome MCP servers.

## Servers

- 🐍 [Filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) - Secure file operations with configurable access controls.
- 🟦 [GitHub](https://github.com/modelcontextprotocol/servers/tree/main/src/github) - Repository management, file operations, and GitHub API integration.
- [Postgres](https://github.com/example/mcp-postgres) - Read-only database access with schema inspection.
- **[Slack](https://github.com/example/mcp-slack)** - Channel management and messaging via Slack Web API.

## Other

This is a description sentence with [a link](https://example.com) inside but no bullet so it should not match.

\`\`\`bash
- [skip-me](https://example.com) - this is in a code block
\`\`\`

- [tooshort](https://example.com) - x
`;

let storage: SqliteStorage;

before(async () => {
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
});

after(async () => {
  await storage.close();
});

// ---- npm scraper ---------------------------------------------------------

test('scrapeNpm parses 3 packages from a recorded payload', async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify(NPM_PAYLOAD), { status: 200 });
  const r = await scrapeNpm({ query: 'keywords:mcp', limit: 100, fetchImpl: fetchImpl as typeof fetch });
  assert.equal(r.specs.length, 3);
  assert.equal(r.total_available, 3);
  assert.equal(r.specs[0].name, '@modelcontextprotocol/server-filesystem');
  assert.equal(r.specs[0].tool_kind, 'tool');
  assert.equal(r.specs[0].endpoint_stub_name, 'catalog-only-stub');
  assert.match(r.specs[0].capability_text, /filesystem/i);
  assert.match(r.specs[0].capability_text, /Keywords:/);
});

test('scrapeNpm respects --limit', async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify(NPM_PAYLOAD), { status: 200 });
  const r = await scrapeNpm({ query: 'keywords:mcp', limit: 2, fetchImpl: fetchImpl as typeof fetch });
  assert.equal(r.specs.length, 2);
});

test('scrapeNpm throws on non-2xx', async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response('boom', { status: 503 });
  await assert.rejects(
    () => scrapeNpm({ query: 'x', fetchImpl: fetchImpl as typeof fetch }),
    /returned 503/,
  );
});

// ---- awesome-list parser -------------------------------------------------

test('parseAwesomeMarkdown extracts entries, skips code blocks and short descs', () => {
  const { entries } = parseAwesomeMarkdown(AWESOME_MD);
  // 4 valid bullets (Filesystem, GitHub, Postgres, Slack). 'tooshort' rejected
  // (description < 5 chars), code block bullet skipped.
  assert.equal(entries.length, 4);
  assert.equal(entries[0].name, 'Filesystem');
  assert.equal(entries[2].name, 'Postgres');
  assert.equal(entries[3].name, 'Slack', 'bold-wrapped name should resolve');
  for (const e of entries) {
    assert.ok(e.url.startsWith('http'));
    assert.ok(e.description.length >= 5);
  }
});

test('scrapeAwesomeList returns deduped specs with catalog-only stubs', async () => {
  const fetchImpl = async (): Promise<Response> => new Response(AWESOME_MD, { status: 200 });
  const r = await scrapeAwesomeList({
    url: 'https://example/x.md',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(r.specs.length, 4);
  for (const s of r.specs) {
    assert.equal(s.tool_kind, 'tool');
    assert.equal(s.endpoint_stub_name, 'catalog-only-stub');
    assert.equal(s.author_agent_id, 'awesome-scrape');
    assert.match(s.name, /^[a-z0-9-]+$/, 'slug must be kebab-case');
  }
});

// ---- importScrapedSpecs --------------------------------------------------

test('importScrapedSpecs upserts new specs and skips existing on re-run', async () => {
  const fresh = new SqliteStorage({ path: ':memory:' });
  await fresh.init();
  const embedder = new StubEmbedder();
  const fetchImpl = async (): Promise<Response> => new Response(AWESOME_MD, { status: 200 });
  const scraped = await scrapeAwesomeList({
    url: 'https://example/x.md',
    fetchImpl: fetchImpl as typeof fetch,
  });

  const first = await importScrapedSpecs(fresh, embedder, scraped.specs);
  assert.equal(first.imported, 4);
  assert.equal(first.skipped_existing, 0);

  // Re-run with the same specs — every one should be skipped.
  const second = await importScrapedSpecs(fresh, embedder, scraped.specs);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped_existing, 4);
  await fresh.close();
});
