// Real Ollama tests for OllamaEmbedder. Skips if Ollama unreachable so CI
// can run without an Ollama service. Personal-tier developers running
// `npm test` locally will hit the real model — that's the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { LruEmbeddingCache } from '../src/embeddings/cache.js';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

async function ollamaReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${HOST}/api/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const skip = !(await ollamaReachable());

test('OllamaEmbedder: name + dim metadata', { skip }, () => {
  const e = new OllamaEmbedder();
  assert.equal(e.name(), 'ollama:nomic-embed-text');
  assert.equal(e.dim(), 768);
});

test('OllamaEmbedder: embed returns 768-dim L2-normalized Float32Array', { skip }, async () => {
  const e = new OllamaEmbedder();
  const v = await e.embed('extract financial line items from a 10-K', 'document');
  assert.equal(v.length, 768, 'should be 768-dim');
  assert.ok(v instanceof Float32Array, 'should be Float32Array');
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  assert.ok(Math.abs(norm - 1.0) < 1e-4, `expected unit-length, got ||v||=${norm}`);
});

test('OllamaEmbedder: embedBatch preserves input order', { skip }, async () => {
  const e = new OllamaEmbedder({ concurrency: 4 });
  const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const vecs = await e.embedBatch(texts, 'document');
  assert.equal(vecs.length, texts.length);
  // Embedding the first text twice should give identical vectors
  const v0Again = await e.embed('alpha', 'document');
  for (let i = 0; i < 768; i++) {
    assert.ok(Math.abs(vecs[0][i] - v0Again[i]) < 1e-6, `index ${i} should match deterministically`);
  }
});

test('OllamaEmbedder: cachedEmbed returns cached=true on second call, <1ms', { skip }, async () => {
  const e = new OllamaEmbedder();
  const r1 = await e.cachedEmbed('build a DCF for NVIDIA');
  assert.equal(r1.cached, false);
  assert.ok(r1.ms >= 0);
  const r2 = await e.cachedEmbed('build a DCF for NVIDIA');
  assert.equal(r2.cached, true);
  assert.ok(r2.ms <= 1, `cache hit should be <=1ms, got ${r2.ms}`);
  assert.equal(r1.vec.length, r2.vec.length);
});

test('OllamaEmbedder: prewarm populates the cache', { skip }, async () => {
  const e = new OllamaEmbedder();
  await e.prewarm(['extract income statement', 'fetch latest arxiv papers']);
  const r = await e.cachedEmbed('extract income statement');
  assert.equal(r.cached, true);
});

// LRU cache unit tests don't need Ollama
test('LruEmbeddingCache: evicts oldest at capacity', () => {
  const c = new LruEmbeddingCache(2);
  c.set('a', { vec: new Float32Array(1), ms: 0, insertedAt: 0 });
  c.set('b', { vec: new Float32Array(1), ms: 0, insertedAt: 0 });
  c.set('c', { vec: new Float32Array(1), ms: 0, insertedAt: 0 });
  assert.equal(c.has('a'), false, 'a should be evicted');
  assert.equal(c.has('b'), true);
  assert.equal(c.has('c'), true);
});

test('LruEmbeddingCache: get refreshes recency', () => {
  const c = new LruEmbeddingCache(2);
  c.set('a', { vec: new Float32Array(1), ms: 0, insertedAt: 0 });
  c.set('b', { vec: new Float32Array(1), ms: 0, insertedAt: 0 });
  c.get('a'); // touches 'a' — now 'b' is the oldest
  c.set('c', { vec: new Float32Array(1), ms: 0, insertedAt: 0 });
  assert.equal(c.has('a'), true, 'a was recently used, should survive');
  assert.equal(c.has('b'), false, 'b should be evicted');
  assert.equal(c.has('c'), true);
});
