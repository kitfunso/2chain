import 'dotenv/config';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { discover } from '../../src/services/discover.js';

interface DemoQuery {
  id: string;
  q: string;
  expected_top1: string;
}

const DEMO_ARC: DemoQuery[] = [
  { id: 'demo-1a-dcf-long', q: "I am building a DCF model for NVIDIA. Use 2chain to pull the latest year's income statement from NVIDIA's 10-K. I need it as JSON for my model.", expected_top1: 'sec-edgar-financials' },
  { id: 'demo-1b-dcf-short', q: 'build a DCF for NVIDIA pull income statement', expected_top1: 'sec-edgar-financials' },
  { id: 'demo-2a-arxiv-long', q: 'I am doing a literature review on Mamba state-space models. Use 2chain to fetch the latest papers on this topic from arxiv. I need top 3 with title, authors, and abstract.', expected_top1: 'arxiv-paper-search' },
  { id: 'demo-2b-arxiv-short', q: 'fetch latest papers on mamba from arxiv for literature review', expected_top1: 'arxiv-paper-search' },
  { id: 'demo-3a-jslint-long', q: 'Use 2chain to find a JS linter that gives structured findings I can use on a PR review', expected_top1: 'eslint-snitch' },
  { id: 'demo-3b-jslint-short', q: 'find a JS linter for structured findings on a PR review', expected_top1: 'eslint-snitch' },
  { id: 'demo-4a-secaudit-long', q: 'audit this Python authentication function for OWASP issues and structured findings', expected_top1: 'security-scanner' },
  { id: 'demo-4b-secaudit-short', q: 'audit this Python authentication function for OWASP recall', expected_top1: 'security-scanner' },
  { id: 'demo-5a-pgmcp-long', q: 'I need an MCP server I can wire into my agent to query a Postgres database for read-only analytics queries', expected_top1: 'mcp-postgres__query' },
  { id: 'demo-5b-pgmcp-short', q: 'find an MCP server for postgres', expected_top1: 'mcp-postgres__query' },
];

const dbPath = process.env.TWOCHAIN_DB_PATH ?? 'C:/tmp/v2.db';
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

let pass = 0;
let fail = 0;
const results: Array<{ id: string; q: string; expected: string; got: string; ok: boolean }> = [];

console.log(`preflight-demo-arc: db=${dbPath}, embedder=${embedder.name()}, queries=${DEMO_ARC.length}`);
console.log();

for (const dq of DEMO_ARC) {
  const out = await discover(storage, embedder, dq.q, 5);
  const got = out.results[0]?.name ?? '<none>';
  const ok = got === dq.expected_top1;
  results.push({ id: dq.id, q: dq.q, expected: dq.expected_top1, got, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${dq.id.padEnd(24)} expected=${dq.expected_top1.padEnd(24)} got=${got}`);
  if (ok) pass++;
  else fail++;
}

console.log();
console.log(`=== preflight result: ${pass}/${DEMO_ARC.length} strict top-1 ===`);

if (fail > 0) {
  console.log();
  console.log('FAIL queries (need expanded demo text or retrieval fix):');
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  - ${r.id}: expected ${r.expected}, got ${r.got}`);
    console.log(`    q: "${r.q}"`);
  }
}

await storage.close();
process.exit(fail > 0 ? 2 : 0);
