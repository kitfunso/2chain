import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { createHash } from 'node:crypto';
import { FIXTURE_TOOLS } from '../src/fixtures/tools.js';
import { FIXTURE_AGENTS, hashKey } from '../src/fixtures/agents.js';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'twochain';
const voyageKey = process.env.VOYAGE_API_KEY;
if (!uri || !voyageKey) { console.error('Missing env'); process.exit(1); }

const client = new MongoClient(uri);

async function embedBatch(texts) {
  const t0 = Date.now();
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${voyageKey}` },
    body: JSON.stringify({ input: texts, model: 'voyage-3', input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const vecs = json.data.map((d) => d.embedding);
  console.log(`embedded ${vecs.length} docs in ${Date.now() - t0}ms`);
  return vecs;
}

try {
  await client.connect();
  const db = client.db(dbName);
  console.log(`connected to ${dbName}\n`);

  // 1. Wipe existing fixtures (idempotent re-runs)
  console.log('=== clearing fixture collections ===');
  for (const c of ['tools', 'eval_runs', 'agents', 'violations', 'usage', 'rankings']) {
    const r = await db.collection(c).deleteMany({});
    console.log(`  ${c}: deleted ${r.deletedCount}`);
  }

  // 2. Seed agents
  console.log('\n=== seeding agents ===');
  const now = new Date();
  const agentDocs = FIXTURE_AGENTS.map((a) => ({
    _id: a._id,
    name: a.name,
    api_key_hash: hashKey(a.api_key),
    role: a.role,
    created_at: now,
  }));
  await db.collection('agents').insertMany(agentDocs);
  for (const a of FIXTURE_AGENTS) {
    console.log(`  ${a._id} [${a.role}] key=${a.api_key.slice(0, 12)}...`);
  }

  // 3. Embed all 5 capability_texts in one batch
  console.log('\n=== embedding capability_texts ===');
  const texts = FIXTURE_TOOLS.map((t) => t.capability_text);
  const embeddings = await embedBatch(texts);

  // 4. Build tool docs
  console.log('\n=== seeding tools ===');
  const toolDocs = FIXTURE_TOOLS.map((spec, i) => {
    const evalRunId = new ObjectId();
    return {
      _doc: {
        name: spec.name,
        version: spec.version,
        author_agent_id: spec.author_agent_id,
        capability_text: spec.capability_text,
        capability_embedding: embeddings[i],
        input_contract: spec.input_contract,
        output_contract: spec.output_contract,
        output_repair_strategy: 'fail-fast',
        endpoint_stub_name: spec.endpoint_stub_name,
        metadata: {
          cost_per_call_usd: spec.cost_per_call_usd,
          p95_latency_ms: spec.p95_latency_ms,
          reliability_score: spec.reliability_score,
          last_eval_run: now,
          last_eval_run_id: evalRunId,
        },
        status: 'active',
        created_at: now,
        updated_at: now,
      },
      _evalRunId: evalRunId,
      _spec: spec,
    };
  });

  const toolInsert = await db.collection('tools').insertMany(toolDocs.map((t) => t._doc));
  for (let i = 0; i < FIXTURE_TOOLS.length; i++) {
    const t = FIXTURE_TOOLS[i];
    console.log(`  ${t.name}@${t.version} rel=${t.reliability_score.toFixed(2)} active`);
  }

  // 5. Build eval_runs
  console.log('\n=== seeding eval_runs ===');
  const evalRuns = toolDocs.map((td, i) => {
    const insertedId = toolInsert.insertedIds[i];
    const totalLatency = td._spec.case_results.reduce((s, c) => s + c.latency_ms, 0);
    return {
      _id: td._evalRunId,
      tool_id: insertedId,
      tool_name: td._spec.name,
      tool_version: td._spec.version,
      triggered_at: now,
      triggered_by: 'manual',
      cases: td._spec.case_results,
      pass_count: td._spec.pass_count,
      total_count: td._spec.total_count,
      pass_rate: td._spec.pass_count / td._spec.total_count,
      duration_ms: totalLatency,
    };
  });
  await db.collection('eval_runs').insertMany(evalRuns);
  for (const r of evalRuns) {
    console.log(`  ${r.tool_name}@${r.tool_version} ${r.pass_count}/${r.total_count} (${r.pass_rate.toFixed(2)})`);
  }

  // 6. Sanity: count + sample query
  console.log('\n=== verification ===');
  const toolCount = await db.collection('tools').countDocuments({ status: 'active' });
  const agentCount = await db.collection('agents').countDocuments({});
  const evalRunCount = await db.collection('eval_runs').countDocuments({});
  console.log(`  active tools: ${toolCount}`);
  console.log(`  agents:       ${agentCount}`);
  console.log(`  eval_runs:    ${evalRunCount}`);

  console.log('\nseed complete.');
} catch (err) {
  console.error('SEED FAILED:', err.message, err.stack);
  process.exit(1);
} finally {
  await client.close();
}
