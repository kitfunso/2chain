import 'dotenv/config';

const HOST = process.env['2CHAIN_HOST'] || 'http://127.0.0.1:3030';
const KEY = 'sk_demo_pdf_agent_8f2c4a';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m', red: '\x1b[31m' };

const QUERIES = [
  { q: 'Extract tables from this financial report PDF', mode: 'vector', why: 'natural-language semantic match' },
  { q: 'Extract tables from this financial report PDF', mode: 'hybrid', why: 'same query, hybrid rankFusion' },
  { q: 'lint javascript code for style violations', mode: 'hybrid', why: 'lexical-strong query — text rank should win' },
  { q: 'summarise this article into one paragraph', mode: 'hybrid', why: 'semantic match for summarisation domain' },
  { q: 'find security vulnerabilities in this Python source', mode: 'hybrid', why: 'multi-keyword — should land security-scanner / pylint-pro' },
  { q: 'parse a UK invoice and pull line items', mode: 'hybrid', why: 'specific domain language — invoice-grok target' },
];

async function discover(query: string, mode: string): Promise<{ ok: boolean; results: any[]; meta: any; ms: number }> {
  const t = Date.now();
  const url = `${HOST}/discover?q=${encodeURIComponent(query)}&mode=${mode}`;
  const r = await fetch(url, { headers: { 'x-api-key': KEY } });
  const j: any = await r.json();
  return { ok: r.ok && j.ok, results: j.results || [], meta: j.meta || {}, ms: Date.now() - t };
}

console.log(`\n${C.cyan}${C.bold}═══ 2chain query showcase ═══${C.reset}`);
console.log(`${C.dim}runs ${QUERIES.length} different queries against the registry, prints top-3 each${C.reset}\n`);

for (const [i, qspec] of QUERIES.entries()) {
  console.log(`${C.magenta}${C.bold}● Query ${i + 1}/${QUERIES.length}${C.reset}  ${C.dim}(${qspec.mode})${C.reset}`);
  console.log(`  ${C.bold}"${qspec.q}"${C.reset}`);
  console.log(`  ${C.dim}why: ${qspec.why}${C.reset}`);
  const r = await discover(qspec.q, qspec.mode);
  console.log(`  ${C.dim}embed: ${r.meta.embed_ms ?? 0}ms · search: ${r.meta.search_ms ?? 0}ms · candidates: ${r.results.length}${C.reset}`);
  if (!r.results.length) {
    console.log(`  ${C.yellow}(no candidates passed gates)${C.reset}\n`);
    continue;
  }
  console.log(`  rank  name              ver   rel   ${qspec.mode === 'hybrid' ? '   rrf' : '  vec     comp'}`);
  for (const [j, t] of r.results.slice(0, 3).entries()) {
    const score = qspec.mode === 'hybrid'
      ? `   ${t.rank_score.toFixed(4)}`
      : `  ${t.vec_score.toFixed(3)}  ${t.rank_score.toFixed(3)}`;
    console.log(`    ${j + 1}   ${(t.name as string).padEnd(17)} ${(t.version as string).padEnd(4)}  ${t.reliability_score.toFixed(2)}${score}`);
  }
  console.log();
}

console.log(`${C.green}${C.bold}✓ showcase complete${C.reset}`);
console.log(`${C.dim}rerun: npm run demo:queries${C.reset}`);
