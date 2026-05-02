import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const HOST = process.env['2CHAIN_HOST'] || 'http://127.0.0.1:3030';
const PDF_KEY = 'sk_demo_pdf_agent_8f2c4a';
const CODER_KEY = 'sk_demo_coder_agent_1d9b3e';
const ADMIN_KEY = 'sk_demo_tool_author_7e5f1c';
const QUERY = 'Extract tables from this financial report PDF';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? '  →  ' + detail : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? '  →  ' + detail : ''}`);
  }
}

async function waitFor(url: string, attempts = 60, delayMs = 250): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function http(method: string, path: string, key: string, body?: unknown): Promise<{ status: number; ms: number; json: any }> {
  const t = performance.now();
  const r = await fetch(`${HOST}${path}`, {
    method,
    headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ms: Math.round(performance.now() - t), json: await r.json() };
}

console.log('\x1b[36m\x1b[1m═══ 2chain integration test ═══\x1b[0m');
console.log('  reset state via re-seed...');
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
  if (!(await waitFor(`${HOST}/health`))) {
    console.error('server failed to start');
    console.error(serverOut);
    process.exit(1);
  }
  console.log('  server up\n');

  // ─── Beat 1 ────────────────────────────────────────────────────────────
  console.log('\x1b[35m▸ Beat 1: discovery\x1b[0m');
  const r1 = await http('GET', `/discover?q=${encodeURIComponent(QUERY)}`, PDF_KEY);
  assert('GET /discover returns 200', r1.status === 200, `got ${r1.status}`);
  assert('result is ok', r1.json.ok === true);
  assert('returns 2 results', r1.json.results?.length === 2, `got ${r1.json.results?.length}`);
  assert('#1 is pdf-extractor v3.0', r1.json.results?.[0]?.name === 'pdf-extractor' && r1.json.results?.[0]?.version === '3.0');
  assert('#2 is pdftools-pro v2.0', r1.json.results?.[1]?.name === 'pdftools-pro' && r1.json.results?.[1]?.version === '2.0');
  assert('latency under 200ms (warm cache)', r1.ms < 200, `${r1.ms}ms`);

  // ─── Beat 2: push the buggy v3.1 ───────────────────────────────────────
  console.log('\n\x1b[35m▸ Beat 2: push pdf-extractor v3.1 (buggy)\x1b[0m');
  const v31 = JSON.parse(readFileSync('demo/pdf-extractor-3.1.json', 'utf-8'));
  const r2 = await http('POST', '/push', ADMIN_KEY, v31);
  assert('POST /push returns 200', r2.status === 200, `got ${r2.status}`);
  assert('push wall under 5s', r2.ms < 5000, `${r2.ms}ms`);
  assert('pass_rate is exactly 0.6', r2.json.pass_rate === 0.6, `got ${r2.json.pass_rate}`);
  assert('pass_count is 3', r2.json.pass_count === 3, `got ${r2.json.pass_count}`);
  assert('total_count is 5', r2.json.total_count === 5);
  assert('status is active', r2.json.status === 'active', `got ${r2.json.status}`);
  assert('reliability_score is 0.6', r2.json.reliability_score === 0.6);
  const findCase = (id: string) => r2.json.cases.find((c: any) => c.case_id === id);
  assert('financial-numbers fails (decimal swap)', findCase('financial-numbers')?.pass === false);
  assert('single-row passes (integer)', findCase('single-row')?.pass === true);
  assert('negative-number fails (decimal swap)', findCase('negative-number')?.pass === false);
  assert('multi-page-text passes (integer)', findCase('multi-page-text')?.pass === true);
  assert('currency-symbol-strip passes (integer)', findCase('currency-symbol-strip')?.pass === true);

  // ─── Beat 3: re-discover, v3.1 must be filtered ────────────────────────
  console.log('\n\x1b[35m▸ Beat 3: re-discover, regression protection\x1b[0m');
  const r3 = await http('GET', `/discover?q=${encodeURIComponent(QUERY)}`, PDF_KEY);
  assert('GET /discover returns 200', r3.status === 200);
  assert('still 2 results', r3.json.results?.length === 2);
  assert('#1 is still pdf-extractor v3.0', r3.json.results?.[0]?.name === 'pdf-extractor' && r3.json.results?.[0]?.version === '3.0');
  assert('#2 is still pdftools-pro v2.0', r3.json.results?.[1]?.name === 'pdftools-pro' && r3.json.results?.[1]?.version === '2.0');
  assert('NO version of pdf-extractor with reliability < 0.80 in results',
    !r3.json.results.some((r: any) => r.name === 'pdf-extractor' && r.reliability_score < 0.80));
  assert('NO v3.1 in results', !r3.json.results.some((r: any) => r.name === 'pdf-extractor' && r.version === '3.1'));

  // ─── Beat 4: malformed-bot circuit-break ───────────────────────────────
  console.log('\n\x1b[35m▸ Beat 4: malformed-bot → circuit-break\x1b[0m');
  const r4 = await http('POST', '/call', CODER_KEY, {
    tool_name: 'malformed-bot', tool_version: '1.0', case_id: 'array-of-issues',
    input: { code: 'function f() { var x = null; x.foo(); }' },
  });
  assert('first /call returns 503', r4.status === 503, `got ${r4.status}`);
  assert('error code is output_contract_violation_circuit_break', r4.json.error?.code === 'output_contract_violation_circuit_break');
  assert('latency under 500ms', r4.ms < 500, `${r4.ms}ms`);
  assert('error includes raw_preview', typeof r4.json.error?.details?.raw_preview === 'string');

  const r4b = await http('POST', '/call', CODER_KEY, {
    tool_name: 'malformed-bot', tool_version: '1.0', case_id: 'array-of-issues',
    input: { code: 'whatever' },
  });
  assert('subsequent call returns 503 circuit_broken', r4b.status === 503 && r4b.json.error?.code === 'circuit_broken');
  assert('subsequent call is fast (status check, no stub)', r4b.ms < 100, `${r4b.ms}ms`);

  // ─── Beat 4b: reliability gate ─────────────────────────────────────────
  console.log('\n\x1b[35m▸ Beat 4b: reliability gate on /call\x1b[0m');
  const r5 = await http('POST', '/call', PDF_KEY, {
    tool_name: 'pdf-extractor', tool_version: '3.1', case_id: 'financial-numbers',
    input: { pdf_text: 'x' },
  });
  assert('gated tool returns 403', r5.status === 403);
  assert('error code is reliability_gate', r5.json.error?.code === 'reliability_gate');
  assert('error details.score is 0.6', r5.json.error?.details?.score === 0.6);

  // ─── Auth ──────────────────────────────────────────────────────────────
  console.log('\n\x1b[35m▸ Auth & shape\x1b[0m');
  const noAuth = await fetch(`${HOST}/discover?q=${encodeURIComponent(QUERY)}`);
  assert('missing api key → 401', noAuth.status === 401);
  const callerPush = await http('POST', '/push', PDF_KEY, v31);
  assert('caller role pushing → 403', callerPush.status === 403);
  const dup = await http('POST', '/push', ADMIN_KEY, v31);
  assert('duplicate push → 400', dup.status === 400);

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(`\n\x1b[36m\x1b[1m═══ summary ═══\x1b[0m`);
  console.log(`  ${pass} passed`);
  if (fail > 0) {
    console.log(`  \x1b[31m${fail} failed\x1b[0m`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  console.log();

  if (fail > 0) process.exit(1);
  console.log('\x1b[32m\x1b[1m✓ INTEGRATION TEST PASSED\x1b[0m');
} catch (err) {
  console.error('\nERROR:', (err as Error).message);
  console.error(serverOut);
  process.exit(1);
} finally {
  server.kill();
}
