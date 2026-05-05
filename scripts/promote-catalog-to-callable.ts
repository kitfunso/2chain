// Idempotent: re-point a catalog-only entry's endpoint_stub_name to a real
// callable stub so /call works. Use after adding a first-party stub whose
// name collides with a previously scraped catalog-only row.
//
// Usage: tsx scripts/promote-catalog-to-callable.ts

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';

const PROMOTIONS: Array<{ name: string; version: string; stub: string }> = [
  { name: 'hackernews-search', version: '1.0', stub: 'hackernews-search-v1' },
  { name: 'stackoverflow-search', version: '1.0', stub: 'stackoverflow-search-v1' },
];

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();

try {
  for (const p of PROMOTIONS) {
    const existing = await storage.getToolByNameVersion(p.name, p.version);
    if (!existing) {
      console.log(`skip ${p.name}@${p.version}: not in DB`);
      continue;
    }
    if (existing.endpoint_stub_name === p.stub) {
      console.log(`skip ${p.name}@${p.version}: already pointing at ${p.stub}`);
      continue;
    }
    const newSpec = { ...existing, endpoint_stub_name: p.stub, status: 'active' as const };
    // Re-upsert with same embedding (use whatever is already stored — embedder is required for upsertTool)
    // Cheap path: direct DB update via the storage's underlying handle. Promote is rare and idempotent
    // so we use the public storage API where available.
    // SqliteStorage exposes a writer queue; setStatus + a metadata patch covers both fields.
    await storage.setStatus(existing.id, 'active');
    await storage.updateToolAfterEval(existing.id, existing.metadata, 'active');
    // endpoint_stub_name has no public setter; patch via raw SQL through the writer.
    const sqliteAny = storage as unknown as { writer: { write: (sql: string, params: unknown[]) => Promise<void> } };
    await sqliteAny.writer.write(
      'UPDATE tools SET endpoint_stub_name = ? WHERE id = ?',
      [p.stub, existing.id],
    );
    console.log(`promoted ${p.name}@${p.version} -> ${p.stub}`);
  }
} finally {
  await storage.close();
}
