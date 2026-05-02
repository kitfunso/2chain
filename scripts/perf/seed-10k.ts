// Generates 10,000 synthetic ToolSpecV2 entries with diverse capability_text
// and seeds them into a fresh DB at /tmp/v2-perf-10k.db. Used by the
// benchmark-discover.ts script to measure p50/p95/p99 retrieval latency.
//
// Phase 1 plan Step 6.5. Run-time on RTX 5080 + Ollama: ~2-3 min for embed,
// ~5s for insert. Total ~3-4 min.

import { existsSync, unlinkSync } from 'node:fs';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import type { ToolSpecV2 } from '../../src/types.js';

const DB_PATH = process.env.PERF_DB_PATH ?? '/tmp/v2-perf-10k.db';
const TARGET_COUNT = Number(process.env.PERF_COUNT ?? 10_000);

for (const ext of ['', '-wal', '-shm']) {
  if (existsSync(DB_PATH + ext)) unlinkSync(DB_PATH + ext);
}

const storage = new SqliteStorage({ path: DB_PATH });
await storage.init();
const embedder = new OllamaEmbedder({ concurrency: 4 });

console.log(`perf seed: ${TARGET_COUNT} synthetic tools -> ${DB_PATH}`);
console.log(`           embedder=${embedder.name()}`);

// Domain templates — varied enough that retrieval has signal, structured
// enough that we can score relevance against a hand-graded query set.
const DOMAINS = [
  { domain: 'finance', verbs: ['fetch', 'parse', 'calculate', 'forecast', 'audit', 'reconcile'], objects: ['10-K filing', 'income statement', 'balance sheet', 'cash flow', 'earnings call transcript', 'analyst report', 'cap table', 'invoice', 'receipt', 'payroll', 'tax form', 'expense report', 'budget'] },
  { domain: 'research', verbs: ['search', 'fetch', 'summarise', 'extract', 'cite', 'translate'], objects: ['arxiv paper', 'pubmed citation', 'patent abstract', 'thesis', 'preprint', 'conference proceeding', 'systematic review'] },
  { domain: 'code', verbs: ['lint', 'format', 'test', 'refactor', 'review', 'document', 'compile', 'package'], objects: ['JavaScript file', 'Python module', 'TypeScript class', 'Go service', 'Rust crate', 'shell script', 'Dockerfile', 'YAML config', 'JSON schema', 'SQL migration', 'GraphQL query'] },
  { domain: 'data', verbs: ['parse', 'transform', 'validate', 'aggregate', 'export', 'import', 'cleanse'], objects: ['CSV file', 'Parquet file', 'JSON document', 'XML payload', 'Avro record', 'Protobuf message', 'Excel workbook', 'database row', 'log line'] },
  { domain: 'comms', verbs: ['send', 'post', 'reply to', 'forward', 'schedule', 'archive'], objects: ['email', 'Slack message', 'SMS', 'WhatsApp message', 'Discord post', 'calendar event', 'meeting invite'] },
  { domain: 'docs', verbs: ['extract', 'OCR', 'redact', 'sign', 'merge', 'split', 'compress'], objects: ['PDF document', 'scanned receipt', 'contract', 'tax form', 'medical record', 'lease agreement', 'driving licence', 'passport scan'] },
  { domain: 'geo', verbs: ['geocode', 'reverse-geocode', 'route', 'isochrone', 'forecast', 'snap'], objects: ['address', 'postcode', 'lat/lng pair', 'route between cities', 'driving directions', 'public-transit journey', 'flight path'] },
  { domain: 'ecommerce', verbs: ['list', 'create', 'cancel', 'refund', 'fulfil', 'tag'], objects: ['Shopify order', 'Stripe payment', 'Amazon listing', 'eBay auction', 'subscription', 'discount code', 'inventory item'] },
  { domain: 'health', verbs: ['look up', 'screen', 'cross-reference', 'normalise'], objects: ['ICD-10 code', 'SNOMED concept', 'drug interaction', 'lab result', 'vaccination record', 'symptom report'] },
  { domain: 'security', verbs: ['scan', 'audit', 'rotate', 'revoke', 'verify'], objects: ['IAM policy', 'JWT token', 'API key', 'TLS certificate', 'CVE advisory', 'docker image', 'kubernetes manifest'] },
];

const VENDORS = [
  'pro', 'mini', 'lite', 'plus', 'turbo', 'nano', 'enterprise', 'cloud',
  'edge', 'ng', 'next', 'core', 'ai', 'auto', 'rapid', 'sharp', 'flux',
  'apex', 'fusion', 'nimbus', 'pulse', 'beacon', 'nexus', 'orion', 'titan',
];

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

// Deterministic PRNG so re-runs build the same corpus.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);

const specs: ToolSpecV2[] = [];
const seenNames = new Set<string>();
let collisions = 0;
for (let i = 0; i < TARGET_COUNT; i++) {
  const dom = pick(DOMAINS, rng);
  const v = pick(dom.verbs, rng);
  const o = pick(dom.objects, rng);
  const vendor = pick(VENDORS, rng);
  // Build a unique-ish name with a hash suffix so collisions are rare.
  const baseName = `${o.toLowerCase().replace(/\s+/g, '-')}-${vendor}-${i.toString(16)}`;
  if (seenNames.has(baseName)) {
    collisions++;
    continue;
  }
  seenNames.add(baseName);

  const cap = `${capitalize(v)} ${o.toLowerCase()} for ${dom.domain} workflows. Variant: ${vendor}. Designed for ${pick(['streaming', 'batch', 'event-driven', 'request/response', 'CLI'], rng)} pipelines with ${pick(['structured', 'JSON', 'YAML', 'protobuf'], rng)} input. Returns ${pick(['parsed rows', 'structured tags', 'normalized records', 'enriched fields', 'machine-readable output'], rng)}.`;

  specs.push({
    name: baseName,
    version: '1.0',
    author_agent_id: 'perf-synth',
    capability_text: cap,
    input_contract: { type: 'object', additionalProperties: true },
    output_contract: { type: 'object', additionalProperties: true },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'catalog-only-stub',
    metadata: {
      cost_per_call_usd: 0,
      p95_latency_ms: 200 + Math.floor(rng() * 1500),
      reliability_score: 0.85 + rng() * 0.15,
    },
    status: 'active',
    domain: dom.domain,
  });
}

console.log(`generated ${specs.length} unique specs (${collisions} collisions skipped)`);

// Embed in chunks
console.log(`embedding ${specs.length} capability_texts (chunk=64, concurrency=4)...`);
const tEmbed = Date.now();
const embeddings: Float32Array[] = [];
const CHUNK = 64;
for (let i = 0; i < specs.length; i += CHUNK) {
  const slice = specs.slice(i, i + CHUNK).map((s) => s.capability_text);
  const vecs = await embedder.embedBatch(slice, 'document');
  embeddings.push(...vecs);
  if (i % 512 === 0 || i + CHUNK >= specs.length) {
    process.stdout.write(`  ${Math.min(i + CHUNK, specs.length)}/${specs.length}  `);
  }
}
console.log(`\n  embedded in ${((Date.now() - tEmbed) / 1000).toFixed(1)}s`);

// Insert
console.log(`inserting ${specs.length} tools...`);
const tInsert = Date.now();
for (let i = 0; i < specs.length; i++) {
  await storage.upsertTool(specs[i], embeddings[i]);
  if (i > 0 && i % 1000 === 0) process.stdout.write(`  ${i}/${specs.length}  `);
}
console.log(`\n  inserted in ${((Date.now() - tInsert) / 1000).toFixed(1)}s`);

const stats = await storage.dbStats();
console.log(`\nfinal: ${stats.collection_counts.tools} tools, ${(stats.data_size_bytes / 1024 / 1024).toFixed(1)} MB`);
await storage.close();

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
