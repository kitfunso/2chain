import 'dotenv/config';
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';

const PORT = 3030;
const BASE = `http://127.0.0.1:${PORT}`;
const TOOL_AUTHOR_KEY = 'sk_demo_tool_author_7e5f1c';
const PDF_AGENT_KEY = 'sk_demo_pdf_agent_8f2c4a';
const DEMO_QUERY = 'Extract tables from this financial report PDF';

const PDF_V31_TOOL = {
  name: 'pdf-extractor',
  version: '3.1',
  capability_text:
    'Extract tables from PDF financial reports. Parses earnings statements, balance sheets, income statements, and 10-K filings. Returns each table row as a label-value pair. Improved multi-page accuracy over v3.0.',
  input_contract: {
    type: 'object',
    properties: { pdf_text: { type: 'string' } },
    required: ['pdf_text'],
    additionalProperties: false,
  },
  output_contract: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, value: { type: 'number' } },
          required: ['label', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['rows'],
    additionalProperties: false,
  },
  output_repair_strategy: 'fail-fast' as const,
  endpoint_stub_name: 'pdf-extractor-v3-1',
  metadata: { cost_per_call_usd: 0.002, p95_latency_ms: 310 },
};

async function waitFor(url: string, attempts = 50, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function deleteV31IfExists(): Promise<void> {
  const client = new MongoClient(process.env.MONGODB_URI!);
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'twochain');
    const r = await db.collection('tools').deleteOne({ name: 'pdf-extractor', version: '3.1' });
    if (r.deletedCount > 0) console.log(`(cleanup: removed previous pdf-extractor@3.1 from earlier run)`);
    await db.collection('eval_runs').deleteMany({ tool_name: 'pdf-extractor', tool_version: '3.1' });
  } finally {
    await client.close();
  }
}

await deleteV31IfExists();

const server = spawn('npx', ['tsx', 'scripts/dev-server.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LOG_LEVEL: 'error' },
  shell: true,
});
let serverOut = '';
server.stdout?.on('data', (d) => (serverOut += d.toString()));
server.stderr?.on('data', (d) => (serverOut += d.toString()));

try {
  if (!(await waitFor(`${BASE}/health`))) { console.error('server failed to start'); console.error(serverOut); process.exit(1); }
  console.log('server up\n');

  // Pre-state: /discover should show pdf-extractor v3.0 #1, pdftools-pro v2.0 #2
  console.log('=== pre-push: /discover snapshot ===');
  const before = await fetch(`${BASE}/discover?q=${encodeURIComponent(DEMO_QUERY)}`, {
    headers: { 'x-api-key': PDF_AGENT_KEY },
  }).then((r) => r.json() as any);
  for (const r of before.results) console.log(`  ${r.name}@${r.version} comp=${r.rank_score.toFixed(3)}`);
  if (before.results[0]?.name !== 'pdf-extractor' || before.results[0]?.version !== '3.0') {
    throw new Error('pre-push: expected pdf-extractor v3.0 at #1');
  }

  // Push pdf-extractor v3.1
  console.log('\n=== push pdf-extractor@3.1 (buggy stub) ===');
  const tPush = Date.now();
  const pushResp = await fetch(`${BASE}/push`, {
    method: 'POST',
    headers: { 'x-api-key': TOOL_AUTHOR_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(PDF_V31_TOOL),
  });
  const pushJson = (await pushResp.json()) as any;
  const pushElapsed = Date.now() - tPush;

  console.log(`  status: ${pushResp.status}, wall: ${pushElapsed}ms`);
  console.log(`  embed_ms: ${pushJson.embed_ms}, eval_ms: ${pushJson.eval_ms}, push_ms: ${pushJson.push_ms}`);
  console.log(`  pass: ${pushJson.pass_count}/${pushJson.total_count} (rate=${pushJson.pass_rate})`);
  console.log(`  status: ${pushJson.status}, reliability: ${pushJson.reliability_score}`);
  console.log(`  cases:`);
  for (const c of pushJson.cases) {
    console.log(`    ${c.pass ? '✓' : '✗'} ${c.case_id}${c.error ? '  (' + c.error + ')' : ''}`);
  }

  // Beat-2 EVALS assertions:
  const a = [
    { n: 'push 200', pass: pushResp.status === 200 },
    { n: 'push within 5s', pass: pushElapsed < 5000 },
    { n: 'pass_rate === 0.6', pass: pushJson.pass_rate === 0.6 },
    { n: 'status === active', pass: pushJson.status === 'active' },
    { n: 'reliability_score === 0.6', pass: pushJson.reliability_score === 0.6 },
    { n: 'pass_count === 3', pass: pushJson.pass_count === 3 },
    { n: 'total_count === 5', pass: pushJson.total_count === 5 },
    // Per spec, financial-numbers, negative-number fail (decimal); single-row, multi-page, currency-symbol-strip pass.
    { n: 'financial-numbers fails', pass: pushJson.cases.find((c: any) => c.case_id === 'financial-numbers')?.pass === false },
    { n: 'single-row passes', pass: pushJson.cases.find((c: any) => c.case_id === 'single-row')?.pass === true },
    { n: 'negative-number fails', pass: pushJson.cases.find((c: any) => c.case_id === 'negative-number')?.pass === false },
  ];
  let passCount = 0;
  console.log('\n=== Beat 2 assertions ===');
  for (const x of a) { console.log(`  ${x.pass ? '✓' : '✗'} ${x.n}`); if (x.pass) passCount++; }
  if (passCount !== a.length) throw new Error(`Beat 2: ${passCount}/${a.length}`);

  // Verify in DB
  console.log('\n=== DB verification ===');
  const c2 = new MongoClient(process.env.MONGODB_URI!);
  try {
    await c2.connect();
    const db = c2.db(process.env.MONGODB_DB || 'twochain');
    const t = await db.collection('tools').findOne({ name: 'pdf-extractor', version: '3.1' });
    if (!t) throw new Error('v3.1 not found in DB');
    console.log(`  status: ${t.status}, reliability_score: ${t.metadata.reliability_score}`);
    if (t.status !== 'active') throw new Error('expected active');
    if (t.metadata.reliability_score !== 0.6) throw new Error(`expected 0.6, got ${t.metadata.reliability_score}`);
    console.log('  ✓ DB matches push response');
  } finally { await c2.close(); }

  // Beat 3: /discover should still return v3.0 #1, pdftools-pro #2, NO v3.1
  console.log('\n=== Beat 3: /discover after push (regression protection) ===');
  const after = await fetch(`${BASE}/discover?q=${encodeURIComponent(DEMO_QUERY)}`, {
    headers: { 'x-api-key': PDF_AGENT_KEY },
  }).then((r) => r.json() as any);
  for (const r of after.results) console.log(`  ${r.name}@${r.version} rel=${r.reliability_score.toFixed(2)} comp=${r.rank_score.toFixed(3)}`);
  const b = [
    { n: '#1 still pdf-extractor v3.0', pass: after.results[0]?.name === 'pdf-extractor' && after.results[0]?.version === '3.0' },
    { n: '#2 still pdftools-pro v2.0', pass: after.results[1]?.name === 'pdftools-pro' && after.results[1]?.version === '2.0' },
    { n: 'no pdf-extractor v3.1 in results', pass: !after.results.some((r: any) => r.name === 'pdf-extractor' && r.version === '3.1') },
    { n: 'no result has reliability < 0.80', pass: after.results.every((r: any) => r.reliability_score >= 0.80) },
  ];
  let bCount = 0;
  for (const x of b) { console.log(`  ${x.pass ? '✓' : '✗'} ${x.n}`); if (x.pass) bCount++; }
  if (bCount !== b.length) throw new Error(`Beat 3: ${bCount}/${b.length}`);

  // Negative push: duplicate
  console.log('\n=== negative: duplicate push → 400 ===');
  const dup = await fetch(`${BASE}/push`, {
    method: 'POST',
    headers: { 'x-api-key': TOOL_AUTHOR_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(PDF_V31_TOOL),
  });
  console.log(`  status: ${dup.status}`);
  if (dup.status !== 400) throw new Error(`expected 400, got ${dup.status}`);
  console.log('  ✓');

  // Negative push: caller role attempts push
  console.log('\n=== negative: caller role pushing → 403 ===');
  const callerPush = await fetch(`${BASE}/push`, {
    method: 'POST',
    headers: { 'x-api-key': PDF_AGENT_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ ...PDF_V31_TOOL, version: '3.2' }),
  });
  console.log(`  status: ${callerPush.status}`);
  if (callerPush.status !== 403) throw new Error(`expected 403, got ${callerPush.status}`);
  console.log('  ✓');

  console.log('\n*** Beat 2 + Beat 3 + auth tests all passed ***');
} catch (err) {
  console.error('\nFAIL:', (err as Error).message);
  console.error(serverOut);
  process.exit(1);
} finally {
  server.kill();
}
