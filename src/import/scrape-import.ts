import type { Embedder, Storage, ToolSpecV2 } from '../types.js';
import { resolveDomain } from './domain-classifier.js';

const NAMESPACE = 'default';

export interface ScrapeImportOptions {
  skipEmbedding?: boolean;
  skipExisting?: boolean;
}

export interface ScrapeImportResult {
  scraped: number;
  imported: number;
  skipped_existing: number;
  errors: Array<{ name: string; error: string }>;
  duration_ms: number;
}

export async function importScrapedSpecs(
  storage: Storage,
  embedder: Embedder,
  specs: ToolSpecV2[],
  opts: ScrapeImportOptions = {},
): Promise<ScrapeImportResult> {
  const t0 = Date.now();
  const result: ScrapeImportResult = {
    scraped: specs.length,
    imported: 0,
    skipped_existing: 0,
    errors: [],
    duration_ms: 0,
  };

  const normalized: ToolSpecV2[] = specs.map((s) => ({
    ...s,
    domain: resolveDomain({
      author_agent_id: s.author_agent_id,
      domain: s.domain,
      capability_text: s.capability_text,
      name: s.name,
    }),
  }));

  const fresh: ToolSpecV2[] = [];
  if (opts.skipExisting !== false) {
    for (const s of normalized) {
      const existing = await storage.getToolByNameVersion(s.name, s.version, NAMESPACE);
      if (existing) {
        result.skipped_existing++;
      } else {
        fresh.push(s);
      }
    }
  } else {
    fresh.push(...normalized);
  }

  if (fresh.length === 0) {
    result.duration_ms = Date.now() - t0;
    return result;
  }

  const embeddings = opts.skipEmbedding
    ? fresh.map(() => new Float32Array(768))
    : await embedder.embedBatch(
        fresh.map((s) => s.capability_text),
        'document',
      );

  for (let i = 0; i < fresh.length; i++) {
    try {
      await storage.upsertTool(fresh[i], embeddings[i], NAMESPACE);
      result.imported++;
    } catch (e) {
      result.errors.push({ name: fresh[i].name, error: (e as Error).message });
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}
