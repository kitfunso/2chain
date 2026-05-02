// Hard preflight for personal-tier deploy. Phase 1 plan Step 8.
// All checks must pass; otherwise print remediation and exit non-zero.
//
// Usage:
//   npx tsx scripts/setup-personal.ts
//
// Checks:
//   1. Ollama reachable on $OLLAMA_HOST (default http://localhost:11434)
//   2. nomic-embed-text model present (ollama show)
//   3. sqlite-vec extension loadable into better-sqlite3
//   4. ~/.2chain/ writable
//   5. Embedder warm probe (one tiny embed) so seed time isn't model-load-bound

import { mkdirSync, existsSync, writeFileSync, unlinkSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL ?? 'nomic-embed-text';
const DATA_DIR = process.env.TWOCHAIN_DATA_DIR ?? join(homedir(), '.2chain');

let failed = false;
function ok(msg: string): void { console.log(`  ✓ ${msg}`); }
function fail(msg: string, fix: string): void {
  console.error(`  ✗ ${msg}`);
  console.error(`    fix: ${fix}`);
  failed = true;
}

console.log('preflight: 2chain personal tier');
console.log(`  OLLAMA_HOST=${HOST}`);
console.log(`  OLLAMA_MODEL=${MODEL}`);
console.log(`  DATA_DIR=${DATA_DIR}\n`);

// ---- 1. Ollama reachable ----
console.log('check 1/5: Ollama reachable');
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  const r = await fetch(`${HOST}/api/version`, { signal: ctrl.signal });
  clearTimeout(t);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json() as { version: string };
  ok(`Ollama version ${j.version} responding at ${HOST}`);
} catch (e) {
  fail(
    `Ollama not reachable at ${HOST} (${(e as Error).message})`,
    `install from https://ollama.com/download then run: ollama serve`,
  );
}

// ---- 2. Model present ----
console.log('check 2/5: nomic-embed-text installed');
try {
  const r = await fetch(`${HOST}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: MODEL }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json() as { details?: { parameter_size?: string } };
  ok(`${MODEL} installed${j.details?.parameter_size ? ` (${j.details.parameter_size})` : ''}`);
} catch (e) {
  fail(
    `${MODEL} not pulled (${(e as Error).message})`,
    `run: ollama pull ${MODEL}`,
  );
}

// ---- 3. sqlite-vec loadable ----
console.log('check 3/5: sqlite-vec extension loadable');
try {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  const v = db.prepare('SELECT vec_version() AS v').get() as { v: string };
  db.close();
  ok(`sqlite-vec ${v.v} loaded`);
} catch (e) {
  fail(
    `sqlite-vec failed to load (${(e as Error).message})`,
    `reinstall: npm install sqlite-vec better-sqlite3`,
  );
}

// ---- 4. Data dir writable ----
console.log('check 4/5: ~/.2chain writable');
try {
  mkdirSync(DATA_DIR, { recursive: true });
  const probe = join(DATA_DIR, '.preflight-probe');
  writeFileSync(probe, 'ok');
  accessSync(probe, constants.W_OK);
  unlinkSync(probe);
  ok(`${DATA_DIR} writable`);
} catch (e) {
  fail(
    `cannot write to ${DATA_DIR} (${(e as Error).message})`,
    `set TWOCHAIN_DATA_DIR=/path/you/can/write OR fix perms on ${DATA_DIR}`,
  );
}

// ---- 5. Embedder warm probe ----
console.log('check 5/5: embedder warm probe');
if (!failed) {
  try {
    const t0 = Date.now();
    const r = await fetch(`${HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: 'warmup' }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { embedding: number[] };
    if (!Array.isArray(j.embedding) || j.embedding.length !== 768) {
      throw new Error(`expected 768-dim, got ${j.embedding?.length}`);
    }
    ok(`warmup embed in ${Date.now() - t0}ms (${j.embedding.length}-dim)`);
  } catch (e) {
    fail(
      `warm probe failed (${(e as Error).message})`,
      'check Ollama logs: journalctl -u ollama  OR  Ollama desktop app',
    );
  }
} else {
  console.log('  - skipped (earlier check failed)');
}

console.log();
if (failed) {
  console.error('PREFLIGHT FAILED. Fix the issues above before seeding.');
  process.exit(1);
}
console.log('PREFLIGHT OK. Next: npm run seed:v2');
