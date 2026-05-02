import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const HOST = process.env['2CHAIN_HOST'] || 'http://127.0.0.1:3030';
const PDF_KEY = 'sk_demo_pdf_agent_8f2c4a';
const CODER_KEY = 'sk_demo_coder_agent_1d9b3e';
const ADMIN_KEY = 'sk_demo_tool_author_7e5f1c';
const QUERY = 'Extract tables from this financial report PDF';

// Colors for terminal output
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m',
};

const banner = (text: string, color: string = C.cyan) =>
  console.log(`\n${color}${C.bold}${'━'.repeat(72)}\n  ${text}\n${'━'.repeat(72)}${C.reset}\n`);

const beat = (n: number, title: string, secondsPlanned: number) => {
  console.log(`\n${C.magenta}${C.bold}● BEAT ${n} ${C.reset}${C.bold}${title}${C.reset}  ${C.dim}(planned: ${secondsPlanned}s)${C.reset}`);
  return performance.now();
};

const pause = (s: number, label = 'pause') => new Promise<void>((r) => {
  console.log(`${C.dim}   ${label} ${s}s ...${C.reset}`);
  setTimeout(r, s * 1000);
});

async function checkServer(): Promise<boolean> {
  try {
    const r = await fetch(`${HOST}/health`);
    return r.ok;
  } catch { return false; }
}

async function http(method: string, path: string, key: string, body?: unknown): Promise<{ status: number; ms: number; json: any }> {
  const t = performance.now();
  const r = await fetch(`${HOST}${path}`, {
    method,
    headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  return { status: r.status, ms: Math.round(performance.now() - t), json };
}

const main = async (): Promise<void> => {
  banner('2chain — full demo dry run', C.cyan);

  if (!(await checkServer())) {
    console.error(`${C.red}server not reachable at ${HOST}${C.reset}`);
    console.error(`run: ${C.bold}npm run dev${C.reset} in another terminal first`);
    process.exit(1);
  }

  banner('PRE-FLIGHT: reset state to fresh seed', C.yellow);
  const t0 = performance.now();
  const seed = spawnSync('npx', ['tsx', 'scripts/seed-fixtures.ts'], { stdio: 'inherit', shell: true });
  if (seed.status !== 0) { console.error('seed failed'); process.exit(1); }
  console.log(`\n${C.green}seed complete (${Math.round(performance.now() - t0)}ms)${C.reset}`);
  await pause(2, 'state reset, allow change-streams to settle');

  // ─────────────────────────────────────────────────────────────────────
  banner('DEMO BEAT SEQUENCE', C.cyan);

  const tBeat1 = beat(1, 'Discovery: agent queries the registry', 30);
  const r1 = await http('GET', `/discover?q=${encodeURIComponent(QUERY)}`, PDF_KEY);
  console.log(`   GET /discover → ${r1.status} (${r1.ms}ms)`);
  console.log(`   embed: ${r1.json.meta.embed_ms}ms · search: ${r1.json.meta.search_ms}ms`);
  console.log(`   ${C.green}top results:${C.reset}`);
  for (const r of r1.json.results) {
    console.log(`     ${r.name}@${r.version}  rel=${r.reliability_score.toFixed(2)}  vec=${r.vec_score.toFixed(3)}  composite=${C.bold}${r.rank_score.toFixed(3)}${C.reset}`);
  }
  console.log(`${C.dim}   beat 1 elapsed: ${Math.round(performance.now() - tBeat1)}ms${C.reset}`);
  await pause(3, 'breath, point at dashboard');

  const tBeat2 = beat(2, 'Push pdf-extractor v3.1 (buggy) — evals catch it', 30);
  const v31 = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync('demo/pdf-extractor-3.1.json', 'utf-8')));
  const r2 = await http('POST', '/push', ADMIN_KEY, v31);
  console.log(`   POST /push → ${r2.status} (${r2.ms}ms wall)`);
  console.log(`   ${r2.json.ok ? C.green + '✓ pushed' : C.red + '✗ failed'}${C.reset} ${r2.json.name}@${r2.json.version}`);
  console.log(`   pass: ${r2.json.pass_count}/${r2.json.total_count} (rate ${r2.json.pass_rate})`);
  console.log(`   status: ${r2.json.status}, reliability: ${r2.json.reliability_score}`);
  console.log(`   cases:`);
  for (const c of r2.json.cases) {
    console.log(`     ${c.pass ? C.green + '✓' : C.red + '✗'}${C.reset} ${c.case_id}${c.error ? '  ' + C.dim + '(' + c.error + ')' + C.reset : ''}`);
  }
  console.log(`${C.dim}   beat 2 elapsed: ${Math.round(performance.now() - tBeat2)}ms${C.reset}`);
  await pause(3, 'change-stream re-rank fires; watch dashboard');

  const tBeat3 = beat(3, 'Re-discover: v3.1 is filtered, v3.0 still wins', 20);
  const r3 = await http('GET', `/discover?q=${encodeURIComponent(QUERY)}`, PDF_KEY);
  console.log(`   GET /discover → ${r3.status} (${r3.ms}ms)`);
  console.log(`   ${C.green}top results (after the buggy push):${C.reset}`);
  for (const r of r3.json.results) {
    console.log(`     ${r.name}@${r.version}  rel=${r.reliability_score.toFixed(2)}  vec=${r.vec_score.toFixed(3)}  composite=${C.bold}${r.rank_score.toFixed(3)}${C.reset}`);
  }
  const hasV31 = r3.json.results.some((r: any) => r.name === 'pdf-extractor' && r.version === '3.1');
  console.log(`   ${hasV31 ? C.red + '✗ v3.1 LEAKED THROUGH (BAD)' : C.green + '✓ v3.1 absent — reliability gate held'}${C.reset}`);
  console.log(`${C.dim}   beat 3 elapsed: ${Math.round(performance.now() - tBeat3)}ms${C.reset}`);
  await pause(3, 'transition to contract-layer beat');

  const tBeat4 = beat(4, 'Contract enforcement: malformed-bot circuit-breaks', 30);
  const r4 = await http('POST', '/call', CODER_KEY, {
    tool_name: 'malformed-bot', tool_version: '1.0', case_id: 'array-of-issues',
    input: { code: 'function f() { var x = null; x.foo(); }' },
  });
  console.log(`   POST /call → ${r4.status} (${r4.ms}ms)`);
  if (r4.json.ok) {
    console.log(`   ${C.red}✗ unexpected 200 — malformed-bot should have circuit-broken${C.reset}`);
  } else {
    console.log(`   ${C.green}✓ ${r4.json.error.code}${C.reset}`);
    console.log(`   ${r4.json.error.message}`);
    if (r4.json.error.details?.raw_preview !== undefined) {
      const preview = typeof r4.json.error.details.raw_preview === 'string'
        ? '"' + r4.json.error.details.raw_preview + '"'
        : JSON.stringify(r4.json.error.details.raw_preview);
      console.log(`   ${C.dim}raw: ${preview}${C.reset}`);
    }
  }
  console.log(`${C.dim}   beat 4 elapsed: ${Math.round(performance.now() - tBeat4)}ms${C.reset}`);

  // Verify follow-up call returns the gated state
  const r4b = await http('POST', '/call', CODER_KEY, {
    tool_name: 'malformed-bot', tool_version: '1.0', case_id: 'array-of-issues',
    input: { code: 'irrelevant' },
  });
  console.log(`   ${C.dim}follow-up call: ${r4b.status} ${r4b.json.error?.code} (${r4b.ms}ms — short-circuit at status check)${C.reset}`);

  // ─────────────────────────────────────────────────────────────────────
  banner('SUMMARY', C.green);
  console.log(`Total wall time across 4 beats: ${C.bold}${Math.round(performance.now() - tBeat1)}ms${C.reset}`);
  console.log(`Per-beat:`);
  console.log(`  Beat 1 discover:     ${r1.ms}ms`);
  console.log(`  Beat 2 push:         ${r2.ms}ms`);
  console.log(`  Beat 3 re-discover:  ${r3.ms}ms`);
  console.log(`  Beat 4 call:         ${r4.ms}ms`);
  console.log(`\n${C.dim}rerun:  ${C.reset}npm run demo:full`);
  console.log(`${C.dim}reset:  ${C.reset}npm run demo:reset`);
};

main().catch((e) => { console.error(e); process.exit(1); });
