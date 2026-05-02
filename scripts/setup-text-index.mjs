import 'dotenv/config';
import { MongoClient } from 'mongodb';

const TEXT_INDEX = 'tools_text_idx';
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'twochain';

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const tools = db.collection('tools');

  const existing = await tools.listSearchIndexes().toArray();
  const has = existing.find((i) => i.name === TEXT_INDEX);
  if (has) {
    console.log(`text index ${TEXT_INDEX} already exists (queryable=${has.queryable})`);
  } else {
    await tools.createSearchIndex({
      name: TEXT_INDEX,
      type: 'search',
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            capability_text: {
              type: 'string',
              analyzer: 'lucene.english',
            },
            name: { type: 'string', analyzer: 'lucene.keyword' },
            status: { type: 'token' },
          },
        },
      },
    });
    console.log(`text index ${TEXT_INDEX} queued for build`);
  }

  // Poll for readiness
  console.log('polling for queryable...');
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const idxs = await tools.listSearchIndexes().toArray();
    const idx = idxs.find((i) => i.name === TEXT_INDEX);
    if (idx?.queryable) {
      console.log(`✓ ${TEXT_INDEX} queryable after ${Math.round((Date.now() - start) / 1000)}s`);
      break;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log();

  // Quick smoke test
  console.log('smoke: $search "pdf table"');
  const hits = await tools.aggregate([
    {
      $search: {
        index: TEXT_INDEX,
        text: { query: 'pdf table extract', path: 'capability_text' },
      },
    },
    { $project: { name: 1, version: 1, score: { $meta: 'searchScore' }, _id: 0 } },
    { $limit: 5 },
  ]).toArray();
  for (const h of hits) console.log(`  ${h.name}@${h.version}  score=${h.score?.toFixed(3)}`);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
} finally {
  await client.close();
}
