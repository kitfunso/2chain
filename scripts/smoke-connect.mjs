import 'dotenv/config';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI missing'); process.exit(1); }

const client = new MongoClient(uri);
const t0 = Date.now();
try {
  await client.connect();
  const admin = client.db('admin');
  const result = await admin.command({ ping: 1 });
  const buildInfo = await admin.command({ buildInfo: 1 });
  const isMaster = await admin.command({ hello: 1 });
  console.log('ping:', result.ok === 1 ? 'OK' : 'FAIL');
  console.log('mongo version:', buildInfo.version);
  console.log('replica set:', isMaster.setName || 'NONE');
  console.log('hosts:', isMaster.hosts?.length || 0);
  console.log('latency:', `${Date.now() - t0}ms`);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
} finally {
  await client.close();
}
