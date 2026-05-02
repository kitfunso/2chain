import { MongoClient, type Db } from 'mongodb';

let client: MongoClient | null = null;
let db: Db | null = null;

export function getClient(): MongoClient {
  if (client) return client;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  return client;
}

export async function getDb(): Promise<Db> {
  if (db) return db;
  const c = getClient();
  await c.connect();
  const dbName = process.env.MONGODB_DB || 'twochain';
  db = c.db(dbName);
  return db;
}

export async function close(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
