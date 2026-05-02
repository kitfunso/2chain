import 'dotenv/config';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI!;
const dbName = process.env.MONGODB_DB || 'twochain';

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);

  console.log('=== probe 1: server version + edition ===');
  const buildInfo = await db.admin().command({ buildInfo: 1 });
  console.log(`  version:        ${buildInfo.version}`);
  console.log(`  modules:        ${(buildInfo.modules ?? []).join(', ') || '(none reported)'}`);

  console.log('\n=== probe 2: try $rankFusion (will error if not supported) ===');
  try {
    // Minimal $rankFusion — uses two cheap pipelines, doesn't depend on indexes existing.
    const result = await db.collection('tools').aggregate([
      {
        $rankFusion: {
          input: {
            pipelines: {
              p1: [{ $match: { status: 'active' } }, { $limit: 5 }],
              p2: [{ $match: { 'metadata.reliability_score': { $gte: 0.8 } } }, { $limit: 5 }],
            },
          },
        },
      },
      { $limit: 3 },
      { $project: { name: 1, version: 1, _id: 0 } },
    ]).toArray();
    console.log(`  ✓ $rankFusion executed, returned ${result.length} docs`);
    console.log(`  sample:`, JSON.stringify(result, null, 2));
  } catch (e) {
    console.log(`  ✗ $rankFusion failed: ${(e as Error).message}`);
  }

  console.log('\n=== probe 3: existing search indexes ===');
  const indexes = await db.collection('tools').listSearchIndexes().toArray();
  for (const idx of indexes) {
    console.log(`  ${idx.name} (${idx.type ?? 'search'}) — queryable=${idx.queryable}`);
  }

  console.log('\n=== probe 4: try $search (Atlas Search) ===');
  try {
    // If no text index exists, this will fail with "index not found".
    const r = await db.collection('tools').aggregate([
      { $search: { index: 'tools_text_idx', text: { query: 'pdf', path: 'capability_text' } } },
      { $limit: 1 },
    ]).toArray();
    console.log(`  ✓ $search worked, returned ${r.length} doc(s) — text index exists`);
  } catch (e) {
    const m = (e as Error).message;
    console.log(`  ${m.includes('index not found') || m.includes('does not exist') ? '○' : '✗'} $search: ${m.slice(0, 200)}`);
  }
} catch (err) {
  console.error('FAIL:', (err as Error).message);
  process.exit(1);
} finally {
  await client.close();
}
