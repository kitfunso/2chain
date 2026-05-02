import 'dotenv/config';
import { MongoClient } from 'mongodb';

const VECTOR_INDEX_NAME = 'tools_capability_idx';
const VOYAGE_DIM = 1024;

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'twochain';
if (!uri) { console.error('MONGODB_URI missing'); process.exit(1); }

const client = new MongoClient(uri);

async function ensureCollections(db) {
  const wanted = ['tools', 'eval_runs', 'violations', 'usage', 'agents', 'rankings'];
  const existing = (await db.listCollections().toArray()).map((c) => c.name);
  for (const name of wanted) {
    if (!existing.includes(name)) {
      await db.createCollection(name);
      console.log(`created collection: ${name}`);
    } else {
      console.log(`exists:             ${name}`);
    }
  }
}

async function ensureIndexes(db) {
  const tools = db.collection('tools');
  await tools.createIndex({ name: 1, version: 1 }, { unique: true });
  await tools.createIndex({ name: 1, 'metadata.reliability_score': -1 });
  await tools.createIndex({ status: 1 });
  console.log('tools: name+version unique, name+score, status');

  const evalRuns = db.collection('eval_runs');
  await evalRuns.createIndex({ tool_id: 1, triggered_at: -1 });
  console.log('eval_runs: tool_id+triggered_at');

  const violations = db.collection('violations');
  await violations.createIndex({ tool_id: 1, occurred_at: -1 });
  await violations.createIndex({ call_id: 1 });
  console.log('violations: tool_id+occurred_at, call_id');

  const usage = db.collection('usage');
  await usage.createIndex({ tool_id: 1, occurred_at: -1 });
  await usage.createIndex({ agent_id: 1, occurred_at: -1 });
  console.log('usage: tool_id+occurred_at, agent_id+occurred_at');
}

async function ensureVectorIndex(db) {
  const tools = db.collection('tools');
  const indexes = await tools.listSearchIndexes().toArray().catch(() => []);
  if (indexes.find((i) => i.name === VECTOR_INDEX_NAME)) {
    console.log(`vector index exists: ${VECTOR_INDEX_NAME}`);
    return;
  }
  await tools.createSearchIndex({
    name: VECTOR_INDEX_NAME,
    type: 'vectorSearch',
    definition: {
      fields: [
        { type: 'vector', path: 'capability_embedding', numDimensions: VOYAGE_DIM, similarity: 'cosine' },
        { type: 'filter', path: 'status' },
        { type: 'filter', path: 'metadata.reliability_score' },
        { type: 'filter', path: 'metadata.cost_per_call_usd' },
        { type: 'filter', path: 'metadata.p95_latency_ms' },
      ],
    },
  });
  console.log(`vector index queued for build: ${VECTOR_INDEX_NAME}`);
}

async function pollVectorIndexReady(db, timeoutMs = 90_000) {
  const tools = db.collection('tools');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const indexes = await tools.listSearchIndexes().toArray().catch(() => []);
    const idx = indexes.find((i) => i.name === VECTOR_INDEX_NAME);
    if (idx?.queryable) {
      console.log(`vector index queryable: ${VECTOR_INDEX_NAME} (after ${Math.round((Date.now() - start) / 1000)}s)`);
      return true;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log('\nvector index NOT queryable within timeout, but creation was queued');
  return false;
}

try {
  await client.connect();
  const db = client.db(dbName);
  console.log(`connected to db: ${dbName}\n`);

  console.log('=== collections ===');
  await ensureCollections(db);

  console.log('\n=== regular indexes ===');
  await ensureIndexes(db);

  console.log('\n=== vector index ===');
  await ensureVectorIndex(db);

  console.log('\n=== polling vector index readiness ===');
  await pollVectorIndexReady(db);

  console.log('\nsetup complete.');
} catch (err) {
  console.error('SETUP FAILED:', err.message);
  process.exit(1);
} finally {
  await client.close();
}
