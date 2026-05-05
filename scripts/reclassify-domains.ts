// Retroactive domain cleanup. Inline classification at import time
// (src/import/scrape-import.ts) is the primary path; this tool exists for:
//   1. Migrating legacy rows that landed before inline classify shipped.
//   2. Re-running after the RULES in src/import/domain-classifier.ts change.
// It is no longer required on every boot. Run on demand via:
//   STORAGE_DRIVER=sqlite tsx scripts/reclassify-domains.ts

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { resolveDomain, CANONICAL_DOMAINS, CURATED_AUTHORS } from '../src/import/domain-classifier.js';

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const db = new Database(dbPath);
db.function('notify_change', { deterministic: false, varargs: true }, (..._args: unknown[]) => null);

const rows = db.prepare(
  `SELECT rowid, name, author_agent_id, domain, capability_text FROM tools`,
).all() as Array<{ rowid: number; name: string; author_agent_id: string; domain: string; capability_text: string }>;
console.log(`scanning ${rows.length} tools`);

let updated = 0, unchanged = 0, curated_skipped = 0;
const counts: Record<string, number> = {};
const upd = db.prepare('UPDATE tools SET domain = ? WHERE rowid = ?');

for (const row of rows) {
  const current = (row.domain || '').toLowerCase();
  // Curated authors with a canonical domain: leave alone.
  if (CURATED_AUTHORS.has(row.author_agent_id) && CANONICAL_DOMAINS.has(current)) {
    curated_skipped++;
    continue;
  }
  const target = resolveDomain({
    author_agent_id: row.author_agent_id,
    domain: row.domain,
    capability_text: row.capability_text,
    name: row.name,
  });
  if (target === current) { unchanged++; continue; }
  upd.run(target, row.rowid);
  counts[target] = (counts[target] || 0) + 1;
  updated++;
}

console.log(`updated:           ${updated}`);
console.log(`unchanged:         ${unchanged}`);
console.log(`curated (skipped): ${curated_skipped}`);
console.log('per-domain additions:', counts);

const final = db.prepare(`SELECT domain, COUNT(*) AS n FROM tools GROUP BY domain ORDER BY n DESC`).all();
console.log('\nfinal domain counts:', final);
db.close();
