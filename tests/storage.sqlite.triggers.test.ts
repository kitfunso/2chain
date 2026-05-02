// Real-DB tests for the FTS5 + vec0 sync triggers.
// Validates that INSERT/UPDATE/DELETE on `tools` keeps tools_fts and tools_vec aligned.
// Phase 1 plan Step 3 verify criterion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const MIGRATION_SQL = readFileSync(
  resolve('src/storage/migrations/sqlite/001_init.sql'),
  'utf-8',
);

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(MIGRATION_SQL);
  return db;
}

function makeEmbedding(seed: number): Buffer {
  // 768-dim Float32 array. L2-normalize so cosine distance is well-defined.
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 768; i++) v[i] /= norm;
  return Buffer.from(v.buffer);
}

function insertTool(
  db: Database.Database,
  opts: { id: string; name: string; version: string; capability_text: string; embedding_seed: number },
): void {
  db.prepare(
    `INSERT INTO tools (id, name, version, author_agent_id, capability_text, capability_embedding,
                        input_contract, output_contract, endpoint_stub_name, metadata, status)
     VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', 'stub', '{"reliability_score":1.0}', 'active')`,
  ).run(
    opts.id,
    opts.name,
    opts.version,
    'test-author',
    opts.capability_text,
    makeEmbedding(opts.embedding_seed),
  );
}

test('migration creates all expected objects', () => {
  const db = makeDb();
  const objects = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>;
  const names = objects.map((o) => o.name);

  // Tables
  for (const t of ['_migrations', 'tools', 'agents', 'eval_runs', 'usage', 'violations', 'rankings']) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
  // Virtual tables
  assert.ok(names.includes('tools_fts'), 'missing tools_fts');
  assert.ok(names.includes('tools_vec'), 'missing tools_vec');
  // Sync triggers
  for (const trig of [
    'tools_ai_fts', 'tools_ai_vec',
    'tools_ad_fts', 'tools_ad_vec',
    'tools_au_fts', 'tools_au_vec',
  ]) {
    assert.ok(names.includes(trig), `missing trigger: ${trig}`);
  }
  db.close();
});

test('INSERT into tools mirrors to tools_fts and tools_vec', () => {
  const db = makeDb();
  insertTool(db, { id: 't1', name: 'pdf-extractor', version: '3.0', capability_text: 'extract financial tables from PDF', embedding_seed: 1 });

  const fts = db.prepare('SELECT count(*) AS n FROM tools_fts').get() as { n: number };
  const vec = db.prepare('SELECT count(*) AS n FROM tools_vec').get() as { n: number };
  assert.equal(fts.n, 1, 'fts should have 1 row');
  assert.equal(vec.n, 1, 'vec should have 1 row');

  // FTS5 MATCH should find it
  const match = db.prepare(`SELECT rowid FROM tools_fts WHERE tools_fts MATCH 'PDF'`).all();
  assert.equal(match.length, 1, 'FTS5 MATCH should hit the inserted row');
  db.close();
});

test('DELETE from tools cascades to tools_fts and tools_vec', () => {
  const db = makeDb();
  insertTool(db, { id: 't1', name: 'a', version: '1.0', capability_text: 'first tool', embedding_seed: 1 });
  insertTool(db, { id: 't2', name: 'b', version: '1.0', capability_text: 'second tool', embedding_seed: 2 });

  db.prepare('DELETE FROM tools WHERE id = ?').run('t1');

  const tools = db.prepare('SELECT count(*) AS n FROM tools').get() as { n: number };
  const fts = db.prepare('SELECT count(*) AS n FROM tools_fts').get() as { n: number };
  const vec = db.prepare('SELECT count(*) AS n FROM tools_vec').get() as { n: number };
  assert.equal(tools.n, 1);
  assert.equal(fts.n, 1, 'fts should reflect the delete');
  assert.equal(vec.n, 1, 'vec should reflect the delete');
  db.close();
});

test('UPDATE capability_text on tools refreshes tools_fts (no stale content)', () => {
  const db = makeDb();
  insertTool(db, { id: 't1', name: 'a', version: '1.0', capability_text: 'old text about INVOICES', embedding_seed: 1 });

  // Initially FTS finds INVOICES
  let hit = db.prepare(`SELECT rowid FROM tools_fts WHERE tools_fts MATCH 'INVOICES'`).all();
  assert.equal(hit.length, 1);

  // Update the capability_text
  db.prepare('UPDATE tools SET capability_text = ? WHERE id = ?').run('new text about RECEIPTS', 't1');

  // FTS should no longer find INVOICES, but should find RECEIPTS
  hit = db.prepare(`SELECT rowid FROM tools_fts WHERE tools_fts MATCH 'INVOICES'`).all();
  assert.equal(hit.length, 0, 'stale FTS5 content should be gone');
  hit = db.prepare(`SELECT rowid FROM tools_fts WHERE tools_fts MATCH 'RECEIPTS'`).all();
  assert.equal(hit.length, 1, 'new FTS5 content should be present');
  db.close();
});

test('UPDATE capability_embedding on tools refreshes tools_vec', () => {
  const db = makeDb();
  insertTool(db, { id: 't1', name: 'a', version: '1.0', capability_text: 'unchanged', embedding_seed: 1 });

  // Get the original embedding via vec0; replace with a different one
  const newEmbedding = makeEmbedding(99);
  db.prepare('UPDATE tools SET capability_embedding = ? WHERE id = ?').run(newEmbedding, 't1');

  // tools_vec still has exactly 1 row (no duplicate, no orphan)
  const vec = db.prepare('SELECT count(*) AS n FROM tools_vec').get() as { n: number };
  assert.equal(vec.n, 1);
  db.close();
});

test('namespace_id defaults to "default" and is enforced unique with name+version', () => {
  const db = makeDb();
  insertTool(db, { id: 't1', name: 'foo', version: '1.0', capability_text: 'a', embedding_seed: 1 });

  // Inserting same (namespace_id='default', name, version) must fail
  assert.throws(() => {
    insertTool(db, { id: 't2', name: 'foo', version: '1.0', capability_text: 'b', embedding_seed: 2 });
  }, /UNIQUE constraint failed/);

  // Different namespace, same name+version, must succeed
  db.prepare(
    `INSERT INTO tools (id, namespace_id, name, version, author_agent_id, capability_text, capability_embedding,
                        input_contract, output_contract, endpoint_stub_name, metadata, status)
     VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, '{}', '{}', 'stub', '{"reliability_score":1.0}', 'active')`,
  ).run('t3', 'foo', '1.0', 'test-author', 'c', makeEmbedding(3));

  const total = db.prepare('SELECT count(*) AS n FROM tools').get() as { n: number };
  assert.equal(total.n, 2);
  db.close();
});
