import 'dotenv/config';
import { spawn } from 'node:child_process';

const PORT = 3030;
const BASE = `http://127.0.0.1:${PORT}`;
const PDF_AGENT_KEY = 'sk_demo_pdf_agent_8f2c4a';
const DEMO_QUERY = 'Extract tables from this financial report PDF';

async function waitFor(url: string, attempts = 40, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

const server = spawn('npx', ['tsx', 'scripts/dev-server.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LOG_LEVEL: 'error' },
  shell: true,  // npx on Windows needs shell
});

let serverOutput = '';
server.stdout?.on('data', (d) => (serverOutput += d.toString()));
server.stderr?.on('data', (d) => (serverOutput += d.toString()));

try {
  const ready = await waitFor(`${BASE}/health`);
  if (!ready) {
    console.error('server failed to start');
    console.error(serverOutput);
    process.exit(1);
  }

  console.log('server up\n');

  // Test 1: Auth required
  console.log('=== test 1: missing api key → 401 ===');
  const noAuth = await fetch(`${BASE}/discover?q=${encodeURIComponent(DEMO_QUERY)}`);
  console.log(`  status: ${noAuth.status}`);
  if (noAuth.status !== 401) throw new Error(`expected 401, got ${noAuth.status}`);

  // Test 2: Bad api key
  console.log('\n=== test 2: bad api key → 401 ===');
  const badAuth = await fetch(`${BASE}/discover?q=${encodeURIComponent(DEMO_QUERY)}`, {
    headers: { 'x-api-key': 'sk_not_a_real_key' },
  });
  console.log(`  status: ${badAuth.status}`);
  if (badAuth.status !== 401) throw new Error(`expected 401, got ${badAuth.status}`);

  // Test 3: Missing q
  console.log('\n=== test 3: missing query → 400 ===');
  const noQ = await fetch(`${BASE}/discover`, {
    headers: { 'x-api-key': PDF_AGENT_KEY },
  });
  console.log(`  status: ${noQ.status}`);
  if (noQ.status !== 400) throw new Error(`expected 400, got ${noQ.status}`);

  // Test 4: Demo query → expected top-N
  console.log('\n=== test 4: demo query → 200 + ranked top-N ===');
  const t = Date.now();
  const ok = await fetch(`${BASE}/discover?q=${encodeURIComponent(DEMO_QUERY)}`, {
    headers: { 'x-api-key': PDF_AGENT_KEY },
  });
  const okJson = await ok.json() as any;
  console.log(`  status: ${ok.status}, total: ${Date.now() - t}ms`);
  console.log(`  embed_ms: ${okJson.meta?.embed_ms}, search_ms: ${okJson.meta?.search_ms}`);
  console.log(`  results: ${okJson.results?.length}`);
  for (const r of okJson.results) {
    console.log(`    ${r.name}@${r.version}  rel=${r.reliability_score.toFixed(2)}  vec=${r.vec_score.toFixed(3)}  comp=${r.rank_score.toFixed(3)}`);
  }
  const a4 = [
    okJson.ok === true,
    okJson.results?.[0]?.name === 'pdf-extractor',
    okJson.results?.[0]?.version === '3.0',
    okJson.results?.[0]?.reliability_score === 1.0,
    okJson.results?.[1]?.name === 'pdftools-pro',
    okJson.results?.[1]?.version === '2.0',
    okJson.meta.total_ms < 1500,  // first-call: cold embed (no pre-cache yet)
  ];
  if (a4.some((x) => !x)) throw new Error(`test 4 failed: ${JSON.stringify(a4)}`);
  console.log('  ✓ all 7 assertions');

  // Test 5: Same query cached → fast
  console.log('\n=== test 5: cached embed → fast ===');
  const t5 = Date.now();
  const cached = await fetch(`${BASE}/discover?q=${encodeURIComponent(DEMO_QUERY)}`, {
    headers: { 'x-api-key': PDF_AGENT_KEY },
  });
  const cachedJson = await cached.json() as any;
  const elapsed = Date.now() - t5;
  console.log(`  status: ${cached.status}, total: ${elapsed}ms (embed_ms: ${cachedJson.meta?.embed_ms})`);
  if (cachedJson.meta.embed_ms !== 0) throw new Error(`expected cache hit, got embed_ms=${cachedJson.meta.embed_ms}`);
  if (elapsed >= 200) throw new Error(`expected <200ms cached, got ${elapsed}ms`);
  console.log(`  ✓ embed cached, total ${elapsed}ms < 200ms target`);

  // Test 6: Negative — irrelevant query
  console.log('\n=== test 6: irrelevant query → 200 with [] ===');
  const negative = await fetch(`${BASE}/discover?q=${encodeURIComponent('how to bake a sourdough loaf')}`, {
    headers: { 'x-api-key': PDF_AGENT_KEY },
  });
  const negJson = await negative.json() as any;
  console.log(`  status: ${negative.status}, results: ${negJson.results?.length}`);
  if (negative.status !== 200) throw new Error(`expected 200 for irrelevant query, got ${negative.status}`);
  if (!Array.isArray(negJson.results) || negJson.results.length !== 0)
    throw new Error(`expected empty results for irrelevant query, got ${JSON.stringify(negJson.results)}`);
  console.log('  ✓ relevance gate filters all candidates → []');

  console.log('\n*** all 6 HTTP tests passed ***');
} catch (err) {
  console.error('\nFAIL:', (err as Error).message);
  console.error(serverOutput);
  process.exit(1);
} finally {
  server.kill();
}
