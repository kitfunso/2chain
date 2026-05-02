import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { MongoClient } from 'mongodb';

const PORT = 3030;
const BASE = `http://127.0.0.1:${PORT}`;
const PDF_AGENT_KEY = 'sk_demo_pdf_agent_8f2c4a';
const CODER_AGENT_KEY = 'sk_demo_coder_agent_1d9b3e';
const ADMIN_KEY = 'sk_demo_tool_author_7e5f1c';

async function waitFor(url: string, attempts = 50, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function postCall(key: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}/call`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

console.log('=== resetting state via re-seed ===');
const seed = spawnSync('npx', ['tsx', 'scripts/seed-fixtures.ts'], { encoding: 'utf-8', shell: true });
if (seed.status !== 0) { console.error(seed.stderr); process.exit(1); }
console.log('  seed complete\n');

const server = spawn('npx', ['tsx', 'scripts/dev-server.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LOG_LEVEL: 'error' },
  shell: true,
});
let serverOut = '';
server.stdout?.on('data', (d) => (serverOut += d.toString()));
server.stderr?.on('data', (d) => (serverOut += d.toString()));

try {
  if (!(await waitFor(`${BASE}/health`))) { console.error('server failed'); console.error(serverOut); process.exit(1); }
  console.log('server up\n');

  // Test 1: happy path /call to pdf-extractor v3.0 with case
  console.log('=== test 1: /call pdf-extractor@3.0, case financial-numbers → 200 ===');
  const r1 = await postCall(PDF_AGENT_KEY, {
    tool_name: 'pdf-extractor', tool_version: '3.0', case_id: 'financial-numbers',
    input: { pdf_text: 'Q3 Earnings\n\nRevenue: $1,234.56\nCost of goods: $789.01\nGross margin: $445.55\nOperating expenses: $200.10\nNet income: $245.45' },
  });
  console.log(`  status: ${r1.status}, ok: ${r1.json.ok}, latency: ${r1.json.latency_ms}ms`);
  console.log(`  result.rows.length: ${r1.json.result?.rows?.length}`);
  if (r1.status !== 200 || !r1.json.ok || r1.json.result?.rows?.length !== 5) throw new Error(`test 1 failed: ${JSON.stringify(r1.json)}`);
  console.log('  ✓');

  // Test 2: bad input → 400
  console.log('\n=== test 2: bad input shape → 400 ===');
  const r2 = await postCall(PDF_AGENT_KEY, {
    tool_name: 'pdf-extractor', tool_version: '3.0',
    input: { wrong_field: 'nope' },
  });
  console.log(`  status: ${r2.status}, code: ${r2.json.error?.code}`);
  if (r2.status !== 400 || r2.json.error?.code !== 'input_contract_violation') throw new Error(`test 2 failed`);
  console.log('  ✓');

  // Test 3: tool not found → 404
  console.log('\n=== test 3: tool not found → 404 ===');
  const r3 = await postCall(PDF_AGENT_KEY, {
    tool_name: 'does-not-exist', tool_version: '9.9',
    input: { pdf_text: 'x' },
  });
  console.log(`  status: ${r3.status}, code: ${r3.json.error?.code}`);
  if (r3.status !== 404) throw new Error(`test 3 failed`);
  console.log('  ✓');

  // Test 4 (Beat 4): malformed-bot returns string, fail-fast triggers circuit-break
  console.log('\n=== test 4 (BEAT 4): /call malformed-bot → output violation → circuit_broken ===');
  const t4Start = Date.now();
  const r4a = await postCall(CODER_AGENT_KEY, {
    tool_name: 'malformed-bot', tool_version: '1.0', case_id: 'array-of-issues',
    input: { code: 'function f() { var x = null; x.foo(); }' },
  });
  console.log(`  call 1 status: ${r4a.status}, code: ${r4a.json.error?.code}`);
  console.log(`  raw_preview: ${JSON.stringify(r4a.json.error?.details?.raw_preview).slice(0, 100)}`);
  if (r4a.status !== 503 || r4a.json.error?.code !== 'output_contract_violation_circuit_break') throw new Error(`test 4a failed: ${JSON.stringify(r4a.json)}`);
  console.log(`  ✓ first call → 503 circuit-break (${Date.now() - t4Start}ms)`);

  // Test 4b: subsequent call → tool already circuit_broken, bare 503
  console.log('\n=== test 4b: subsequent call to circuit-broken tool → 503 ===');
  const r4b = await postCall(CODER_AGENT_KEY, {
    tool_name: 'malformed-bot', tool_version: '1.0', case_id: 'array-of-issues',
    input: { code: 'anything' },
  });
  console.log(`  status: ${r4b.status}, code: ${r4b.json.error?.code}`);
  if (r4b.status !== 503 || r4b.json.error?.code !== 'circuit_broken') throw new Error(`test 4b failed: ${JSON.stringify(r4b.json)}`);
  console.log('  ✓ idempotent — no double-flip, no extra violation');

  // Test 5: verify DB state
  console.log('\n=== test 5: DB state after circuit-break ===');
  const c = new MongoClient(process.env.MONGODB_URI!);
  try {
    await c.connect();
    const db = c.db(process.env.MONGODB_DB || 'twochain');
    const t = await db.collection('tools').findOne({ name: 'malformed-bot', version: '1.0' });
    if (!t) throw new Error('malformed-bot vanished');
    console.log(`  malformed-bot status: ${t.status}`);
    if (t.status !== 'circuit_broken') throw new Error(`expected circuit_broken, got ${t.status}`);

    const violations = await db.collection('violations').find({ tool_name: 'malformed-bot' }).toArray();
    console.log(`  violations logged: ${violations.length}`);
    if (violations.length !== 1) throw new Error(`expected 1 violation, got ${violations.length}`);
    console.log(`    stage: ${violations[0].stage}, schema_errors: ${violations[0].schema_errors.length}`);

    const usage = await db.collection('usage').find({ tool_name: 'malformed-bot' }).toArray();
    // Note: usage doesn't denormalise tool_name, so this returns empty. Look up by tool_id instead.
    const usageByTool = await db.collection('usage').find({ tool_id: t._id }).toArray();
    console.log(`  usage by tool_id: ${usageByTool.length} (outcomes: ${usageByTool.map((u: any) => u.outcome).join(', ')})`);
    if (usageByTool.length !== 2) throw new Error(`expected 2 usage rows, got ${usageByTool.length}`);
  } finally { await c.close(); }
  console.log('  ✓');

  // Test 6: gated tool (pdf-extractor v3.1 still in DB from H3? actually re-seed wiped it)
  // Push v3.1 again so we have a gated tool to test against
  console.log('\n=== test 6: push v3.1 then call → 403 reliability_gate ===');
  const pushResp = await fetch(`${BASE}/push`, {
    method: 'POST',
    headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'pdf-extractor', version: '3.1',
      capability_text: 'Extract tables from PDF financial reports v3.1',
      input_contract: { type: 'object', properties: { pdf_text: { type: 'string' } }, required: ['pdf_text'] },
      output_contract: { type: 'object', properties: { rows: { type: 'array' } }, required: ['rows'] },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'pdf-extractor-v3-1',
      metadata: { cost_per_call_usd: 0.002, p95_latency_ms: 310 },
    }),
  });
  if (pushResp.status !== 200) throw new Error(`v3.1 push setup failed: ${pushResp.status}`);

  const r6 = await postCall(PDF_AGENT_KEY, {
    tool_name: 'pdf-extractor', tool_version: '3.1', case_id: 'financial-numbers',
    input: { pdf_text: 'x' },
  });
  console.log(`  status: ${r6.status}, code: ${r6.json.error?.code}, score: ${r6.json.error?.details?.score}`);
  if (r6.status !== 403 || r6.json.error?.code !== 'reliability_gate') throw new Error(`test 6 failed`);
  console.log('  ✓');

  // Test 7: admin bypass header
  console.log('\n=== test 7: admin bypass on gated tool → 200 ===');
  const r7 = await postCall(ADMIN_KEY, {
    tool_name: 'pdf-extractor', tool_version: '3.1', case_id: 'financial-numbers',
    input: { pdf_text: 'Q3 Earnings\n\nRevenue: $1,234.56' },
  }, { 'x-2chain-bypass-gate': 'true' });
  console.log(`  status: ${r7.status}, ok: ${r7.json.ok}`);
  // Note: v3.1 stub returns wrong (integer-truncated) values for financial-numbers but the OUTPUT contract only checks shape, not numeric correctness. So output validation should pass even with the bug. The contract allows {rows: [{label, value}]} where value can be any number.
  if (r7.status !== 200 || !r7.json.ok) throw new Error(`test 7 failed: ${JSON.stringify(r7.json)}`);
  console.log('  ✓ admin bypassed gate, got result');

  console.log('\n*** Beat 4 + auth + gate + bypass: all 7 tests passed ***');
} catch (err) {
  console.error('\nFAIL:', (err as Error).message);
  console.error(serverOut);
  process.exit(1);
} finally {
  server.kill();
}
