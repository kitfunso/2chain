// v2 seed: SQLite + Ollama. Atomic reseed via .tmp + rename so a running
// server doesn't get mid-write reads. Phase 1 plan Step 8.
//
// Usage:
//   STORAGE_DRIVER=sqlite EMBEDDER=ollama tsx scripts/seed-fixtures.ts
//   TWOCHAIN_DB_PATH=/tmp/v2.db   # override
//   INCLUDE_GENERATED=false       # 14 hand-crafted only

import 'dotenv/config';
import { existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { FIXTURE_TOOLS, type FixtureSpec } from '../src/fixtures/tools.js';
import { FIXTURE_AGENTS } from '../src/fixtures/agents.js';
import { hashKey } from '../src/server/auth.js';
import { generateFixtures } from '../src/fixtures/generated.js';
import type { ToolSpecV2 } from '../src/types.js';

const INCLUDE_GENERATED = process.env.INCLUDE_GENERATED !== 'false';
const ALL_TOOLS: FixtureSpec[] = INCLUDE_GENERATED
  ? [...FIXTURE_TOOLS, ...generateFixtures()]
  : FIXTURE_TOOLS;

const finalPath = resolve(
  process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`,
);
const tmpPath = `${finalPath}.tmp`;

mkdirSync(dirname(finalPath), { recursive: true });
if (existsSync(tmpPath)) unlinkSync(tmpPath);

const storage = new SqliteStorage({ path: tmpPath });
await storage.init();
const embedder = new OllamaEmbedder({ concurrency: 4 });

console.log(`seed: writing to ${tmpPath}`);
console.log(`seed: ${ALL_TOOLS.length} tools (${FIXTURE_TOOLS.length} hand-crafted, ${ALL_TOOLS.length - FIXTURE_TOOLS.length} generated)`);
console.log(`seed: embedder=${embedder.name()} dim=${embedder.dim()}`);

try {
  // 1. Agents
  console.log('\n=== agents ===');
  const nowIso = new Date().toISOString();
  for (const a of FIXTURE_AGENTS) {
    await storage.upsertAgent({
      id: a._id,
      name: a.name,
      api_key_hash: hashKey(a.api_key),
      role: a.role,
      created_at: nowIso,
    });
    console.log(`  ${a._id} [${a.role}] key=${a.api_key.slice(0, 12)}...`);
  }

  // 2. Embed all capability_text in chunks of 32 (OllamaEmbedder caps inner concurrency at 4)
  console.log(`\n=== embedding ${ALL_TOOLS.length} capability_texts ===`);
  const tEmbed = Date.now();
  const texts = ALL_TOOLS.map((t) => t.capability_text);
  const embeddings: Float32Array[] = [];
  const CHUNK = 32;
  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const vecs = await embedder.embedBatch(slice, 'document');
    embeddings.push(...vecs);
    process.stdout.write(`  ${Math.min(i + CHUNK, texts.length)}/${texts.length}  `);
  }
  console.log(`\n  embedded in ${Date.now() - tEmbed}ms`);

  // 3. Tools (status='active', reliability already known from fixture)
  console.log('\n=== tools ===');
  const tInsert = Date.now();
  for (let i = 0; i < ALL_TOOLS.length; i++) {
    const spec = ALL_TOOLS[i];
    const v2: ToolSpecV2 = {
      name: spec.name,
      version: spec.version,
      author_agent_id: spec.author_agent_id,
      capability_text: spec.capability_text,
      input_contract: spec.input_contract,
      output_contract: spec.output_contract,
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: spec.endpoint_stub_name,
      metadata: {
        cost_per_call_usd: spec.cost_per_call_usd,
        p95_latency_ms: spec.p95_latency_ms,
        reliability_score: spec.reliability_score,
        last_eval_run: nowIso,
      },
      status: 'active',
    };
    const inserted = await storage.upsertTool(v2, embeddings[i]);

    // Eval run from fixture results
    const totalLatency = spec.case_results.reduce((s, c) => s + c.latency_ms, 0);
    await storage.insertEvalRun({
      tool_id: inserted.id,
      tool_name: spec.name,
      tool_version: spec.version,
      namespace_id: 'default',
      triggered_at: nowIso,
      triggered_by: 'manual',
      cases: spec.case_results,
      pass_count: spec.pass_count,
      total_count: spec.total_count,
      pass_rate: spec.pass_count / spec.total_count,
      duration_ms: totalLatency,
    });
  }
  console.log(`  inserted ${ALL_TOOLS.length} tools + eval_runs in ${Date.now() - tInsert}ms`);

  // 4. Stats
  const stats = await storage.dbStats();
  console.log('\n=== verification ===');
  console.log(`  tools:     ${stats.collection_counts.tools}`);
  console.log(`  agents:    ${stats.collection_counts.agents}`);
  console.log(`  eval_runs: ${stats.collection_counts.eval_runs}`);
  console.log(`  driver:    ${stats.driver}`);
  console.log(`  version:   ${stats.version}`);

  await storage.close();

  // 5. Atomic swap
  if (existsSync(finalPath)) unlinkSync(finalPath);
  // Also remove WAL/SHM files so the swap is clean
  for (const ext of ['-wal', '-shm']) {
    const sib = `${finalPath}${ext}`;
    if (existsSync(sib)) unlinkSync(sib);
  }
  renameSync(tmpPath, finalPath);
  console.log(`\nseed complete: ${finalPath}`);
} catch (err) {
  await storage.close().catch(() => {});
  if (existsSync(tmpPath)) unlinkSync(tmpPath);
  console.error('SEED FAILED:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}
