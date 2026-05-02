// Fast reset for between recording takes: wipes violations, usage, rankings,
// and clears any circuit_broken status — without re-seeding (no Voyage cost).
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'twochain';
if (!uri) { console.error('MONGODB_URI missing'); process.exit(1); }

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const v = await db.collection('violations').deleteMany({});
  const u = await db.collection('usage').deleteMany({});
  const r = await db.collection('rankings').deleteMany({});
  const t = await db.collection('tools').updateMany(
    { status: 'circuit_broken' },
    { $set: { status: 'active', updated_at: new Date() } },
  );
  console.log(`violations cleared: ${v.deletedCount}`);
  console.log(`usage cleared:      ${u.deletedCount}`);
  console.log(`rankings cleared:   ${r.deletedCount}`);
  console.log(`tools un-broken:    ${t.modifiedCount}`);
  console.log('demo state reset · ready for next take');
} finally {
  await client.close();
}
