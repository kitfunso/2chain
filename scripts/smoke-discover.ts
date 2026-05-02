import 'dotenv/config';
import { MongoClient } from 'mongodb';

const DEMO_QUERY = 'Extract tables from this financial report PDF';
const VECTOR_INDEX_NAME = 'tools_capability_idx';
const RELIABILITY_GATE = 0.80;
const VEC_RELEVANCE_GATE = 0.70;  // post-search filter: drop off-topic candidates
const W_VEC = 0.4;
const W_REL = 0.6;
const TOP = 5;

const uri = process.env.MONGODB_URI!;
const dbName = process.env.MONGODB_DB || 'twochain';
const voyageKey = process.env.VOYAGE_API_KEY!;

async function embed(text: string): Promise<number[]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${voyageKey}` },
    body: JSON.stringify({ input: [text], model: 'voyage-3', input_type: 'query' }),
  });
  const json = await res.json() as { data: Array<{ embedding: number[] }> };
  return json.data[0].embedding;
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);

  console.log(`query: "${DEMO_QUERY}"\n`);
  const t0 = Date.now();
  const queryVec = await embed(DEMO_QUERY);
  console.log(`embed:        ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const results = await db.collection('tools').aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'capability_embedding',
        queryVector: queryVec,
        numCandidates: 50,
        limit: TOP * 6,
        filter: {
          status: { $eq: 'active' },
          'metadata.reliability_score': { $gte: RELIABILITY_GATE },
        },
      },
    },
    {
      $project: {
        name: 1,
        version: 1,
        capability_text: 1,
        endpoint_stub_name: 1,
        metadata: 1,
        vec_score: { $meta: 'vectorSearchScore' },
      },
    },
    { $match: { vec_score: { $gte: VEC_RELEVANCE_GATE } } },
    {
      $addFields: {
        rank_score: {
          $add: [
            { $multiply: ['$vec_score', W_VEC] },
            { $multiply: ['$metadata.reliability_score', W_REL] },
          ],
        },
      },
    },
    { $sort: { rank_score: -1 } },
    {
      $group: {
        _id: '$name',
        doc: { $first: '$$ROOT' },
      },
    },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { rank_score: -1 } },
    { $limit: TOP },
  ]).toArray();

  console.log(`$vectorSearch: ${Date.now() - t1}ms`);
  console.log(`results:       ${results.length}\n`);

  console.log('rank | name              | ver | rel  | vec   | composite');
  console.log('-----|-------------------|-----|------|-------|----------');
  results.forEach((r: any, i: number) => {
    const rel = r.metadata.reliability_score.toFixed(2);
    const vec = r.vec_score.toFixed(3);
    const comp = r.rank_score.toFixed(3);
    console.log(`  ${i + 1}  | ${r.name.padEnd(17)} | ${r.version.padEnd(3)} | ${rel} | ${vec} | ${comp}`);
  });

  console.log('\n=== assertions ===');
  const assertions = [
    { name: 'top result is pdf-extractor v3.0', pass: results[0]?.name === 'pdf-extractor' && results[0]?.version === '3.0' },
    { name: '#2 is pdftools-pro v2.0', pass: results[1]?.name === 'pdftools-pro' && results[1]?.version === '2.0' },
    { name: 'all results have rel >= 0.80', pass: results.every((r: any) => r.metadata.reliability_score >= 0.80) },
    { name: 'no version of pdf-extractor below 0.80 appears', pass: !results.some((r: any) => r.name === 'pdf-extractor' && r.metadata.reliability_score < 0.80) },
    { name: 'top result composite > 0.85', pass: (results[0]?.rank_score ?? 0) > 0.85 },
  ];
  let pass = 0;
  for (const a of assertions) {
    console.log(`  ${a.pass ? '✓' : '✗'} ${a.name}`);
    if (a.pass) pass++;
  }
  console.log(`\n${pass}/${assertions.length} passed`);
  if (pass !== assertions.length) process.exit(1);
  console.log('discover smoke OK');
} catch (err) {
  console.error('FAIL:', (err as Error).message);
  process.exit(1);
} finally {
  await client.close();
}
