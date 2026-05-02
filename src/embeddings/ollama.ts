// OllamaEmbedder — Phase 1 default embedder.
// Hits localhost:11434/api/embeddings with `nomic-embed-text` (768 dim).
// L2-normalises output; Ollama returns un-normalised vectors.
//
// Concurrency: embedBatch caps parallel in-flight calls at 4 because
// nomic-embed-text on M-series sits ~50ms/call; on CPU-only Linux it can
// be 500ms+/call. Concurrency 4 keeps the seed under the 30s PRD bar
// on M-series and roughly 6s extra on CPU.

import type { Embedder, EmbedResult } from '../types.js';
import { LruEmbeddingCache } from './cache.js';

export interface OllamaEmbedderOpts {
  host?: string;             // default http://localhost:11434
  model?: string;            // default nomic-embed-text
  timeoutMs?: number;        // default 10_000
  cacheCapacity?: number;    // default 256
  concurrency?: number;      // default 4
  warmupOnInit?: boolean;    // default false (set by setup-personal.ts in Step 8)
}

interface OllamaEmbeddingResponse {
  embedding?: number[];
  // older /api/embed returns embeddings: number[][]
}

const NOMIC_EMBED_DIM = 768;

function l2Normalize(v: number[]): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export class OllamaEmbedder implements Embedder {
  private readonly host: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly cache: LruEmbeddingCache;
  private warmedUp = false;

  constructor(opts: OllamaEmbedderOpts = {}) {
    this.host = opts.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    this.model = opts.model ?? process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.cache = new LruEmbeddingCache(opts.cacheCapacity ?? 256);
    if (opts.warmupOnInit ?? process.env.OLLAMA_WARMUP === 'true') {
      // fire-and-forget; ignore failures so constructor is always safe.
      this.embed('warmup', 'document').then(() => { this.warmedUp = true; }).catch(() => undefined);
    }
  }

  name(): string {
    return `ollama:${this.model}`;
  }

  dim(): number {
    return NOMIC_EMBED_DIM;
  }

  async embed(text: string, _kind: 'document' | 'query'): Promise<Float32Array> {
    const res = await fetchWithTimeout(
      `${this.host}/api/embeddings`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      },
      this.timeoutMs,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as OllamaEmbeddingResponse;
    if (!data.embedding || data.embedding.length === 0) {
      throw new Error(`ollama returned empty embedding (model=${this.model})`);
    }
    if (data.embedding.length !== NOMIC_EMBED_DIM) {
      throw new Error(
        `ollama returned ${data.embedding.length}-dim vector; expected ${NOMIC_EMBED_DIM}. ` +
          `Wrong model? (got ${this.model})`,
      );
    }
    if (!this.warmedUp) this.warmedUp = true;
    return l2Normalize(data.embedding);
  }

  async embedBatch(
    texts: string[],
    kind: 'document' | 'query',
  ): Promise<Float32Array[]> {
    const out: Float32Array[] = new Array(texts.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, texts.length) }, () =>
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= texts.length) return;
          out[i] = await this.embed(texts[i], kind);
        }
      })(),
    );
    await Promise.all(workers);
    return out;
  }

  async prewarm(queries: string[]): Promise<void> {
    const todo = queries.filter((q) => !this.cache.has(q));
    if (todo.length === 0) return;
    const vecs = await this.embedBatch(todo, 'query');
    const now = Date.now();
    for (let i = 0; i < todo.length; i++) {
      this.cache.set(todo[i], { vec: vecs[i], ms: 0, insertedAt: now });
    }
  }

  async cachedEmbed(query: string): Promise<EmbedResult> {
    const hit = this.cache.get(query);
    if (hit) return { vec: hit.vec, cached: true, ms: 0 };
    const t0 = Date.now();
    const vec = await this.embed(query, 'query');
    const ms = Date.now() - t0;
    this.cache.set(query, { vec, ms, insertedAt: Date.now() });
    return { vec, cached: false, ms };
  }
}
