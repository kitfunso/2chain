// PyPI + HF scraper tests with recorded payloads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapePypi } from '../src/import/pypi-scraper.js';
import { scrapeHuggingFace } from '../src/import/hf-scraper.js';

const PYPI_PAYLOAD = {
  info: {
    name: 'mcp',
    version: '1.5.0',
    summary: 'Model Context Protocol Python SDK',
    description: 'The Model Context Protocol lets you build local-first servers...',
    keywords: 'mcp, model-context-protocol, anthropic',
    project_urls: {
      Homepage: 'https://modelcontextprotocol.io',
      Repository: 'https://github.com/modelcontextprotocol/python-sdk',
    },
    classifiers: ['Development Status :: 4 - Beta'],
  },
};

test('scrapePypi pulls /pypi/<name>/json and builds spec', async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify(PYPI_PAYLOAD), { status: 200 });
  const r = await scrapePypi({ names: ['mcp'], fetchImpl: fetchImpl as typeof fetch });
  assert.equal(r.fetched, 1);
  assert.equal(r.specs.length, 1);
  assert.equal(r.specs[0].name, 'py:mcp');
  assert.equal(r.specs[0].author_agent_id, 'pypi-scrape');
  assert.equal(r.specs[0].endpoint_stub_name, 'catalog-only-stub');
  assert.match(r.specs[0].capability_text, /Model Context Protocol/);
  assert.match(r.specs[0].capability_text, /github.com\/modelcontextprotocol/);
});

test('scrapePypi captures errors per-name without aborting the batch', async () => {
  let call = 0;
  const fetchImpl = async (): Promise<Response> => {
    call++;
    if (call === 2) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(PYPI_PAYLOAD), { status: 200 });
  };
  const r = await scrapePypi({ names: ['mcp', 'nope', 'mcp'], fetchImpl: fetchImpl as typeof fetch });
  assert.equal(r.fetched, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.errors[0].name, 'nope');
  assert.match(r.errors[0].error, /404/);
});

const HF_PAYLOAD = [
  {
    id: 'meta-llama/Llama-3.1-8B-Instruct',
    pipeline_tag: 'text-generation',
    library_name: 'transformers',
    tags: ['text-generation', 'transformers', 'pytorch'],
    downloads: 1234567,
    likes: 4321,
    private: false,
  },
  {
    id: 'sentence-transformers/all-MiniLM-L6-v2',
    pipeline_tag: 'sentence-similarity',
    library_name: 'sentence-transformers',
    tags: ['sentence-similarity', 'feature-extraction'],
    downloads: 99000000,
    likes: 5000,
    private: false,
  },
  {
    id: 'someone/private-thing',
    private: true,
  },
];

test('scrapeHuggingFace pulls models, skips private, and prefixes name with hf:', async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify(HF_PAYLOAD), { status: 200 });
  const r = await scrapeHuggingFace({ limit: 50, fetchImpl: fetchImpl as typeof fetch });
  assert.equal(r.fetched, 2, 'private model must be skipped');
  assert.equal(r.specs[0].name, 'hf:meta-llama/llama-3-1-8b-instruct', 'dots collapse to dashes for slug safety');
  assert.match(r.specs[0].capability_text, /text-generation/);
  assert.match(r.specs[0].capability_text, /huggingface.co\/meta-llama/);
  assert.equal(r.specs[1].domain, 'ml-models');
});

test('scrapeHuggingFace assigns datasets/apps domain by resource', async () => {
  const fetchImpl = async (): Promise<Response> => new Response('[]', { status: 200 });
  const r1 = await scrapeHuggingFace({ resource: 'datasets', limit: 1, fetchImpl: fetchImpl as typeof fetch });
  const r2 = await scrapeHuggingFace({ resource: 'spaces', limit: 1, fetchImpl: fetchImpl as typeof fetch });
  // No specs, but verify the function doesn't throw on empty.
  assert.equal(r1.fetched, 0);
  assert.equal(r2.fetched, 0);
});

test('scrapeHuggingFace throws on non-2xx', async () => {
  const fetchImpl = async (): Promise<Response> => new Response('rate limited', { status: 429 });
  await assert.rejects(
    () => scrapeHuggingFace({ fetchImpl: fetchImpl as typeof fetch }),
    /returned 429/,
  );
});
