import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { MongoClient } from 'mongodb';

const HOST = process.env.TWOCHAIN_HOST || 'http://127.0.0.1:3030';
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? C.green + '✓' : C.red + '✗'} ${name}${detail ? '  ' + C.dim + detail + C.reset : ''}${C.reset}`);
}

console.log(`${C.cyan}${C.bold}═══ 2chain pre-flight ═══${C.reset}\n`);

console.log('=== env ===');
check('MONGODB_URI set', !!process.env.MONGODB_URI);
check('VOYAGE_API_KEY set', !!process.env.VOYAGE_API_KEY);

console.log('\n=== mongo connection ===');
let mc: MongoClient | null = null;
try {
  mc = new MongoClient(process.env.MONGODB_URI!);
  await mc.connect();
  const db = mc.db(process.env.MONGODB_DB || 'twochain');
  const buildInfo = await db.admin().command({ buildInfo: 1 });
  const isMaster = await db.admin().command({ hello: 1 });
  check('atlas reachable', true, `mongo ${buildInfo.version}`);
  check('replica set live', !!isMaster.setName, isMaster.setName ?? 'NONE');
  check('replica hosts >= 3', (isMaster.hosts?.length ?? 0) >= 3, `${isMaster.hosts?.length ?? 0} hosts`);

  console.log('\n=== indexes ===');
  const tools = db.collection('tools');
  const idxs = await tools.listSearchIndexes().toArray();
  const vec = idxs.find((i: any) => i.name === 'tools_capability_idx');
  const txt = idxs.find((i: any) => i.name === 'tools_text_idx');
  check('tools_capability_idx exists', !!vec);
  check('tools_capability_idx queryable', !!vec?.queryable);
  check('tools_text_idx exists', !!txt, txt ? '' : 'run npm run setup:text');
  check('tools_text_idx queryable', !!txt?.queryable);

  console.log('\n=== seeded data ===');
  const tCount = await tools.countDocuments({ status: 'active' });
  const aCount = await db.collection('agents').countDocuments({});
  const eCount = await db.collection('eval_runs').countDocuments({});
  check('active tools >= 5', tCount >= 5, `${tCount} active`);
  check('agents == 3', aCount === 3, `${aCount} agents`);
  check('eval_runs >= 5', eCount >= 5, `${eCount} runs`);

  console.log('\n=== sanity query ===');
  const t0 = Date.now();
  const sample = await tools.aggregate([
    {
      $vectorSearch: {
        index: 'tools_capability_idx',
        path: 'capability_embedding',
        queryVector: (await tools.findOne({ name: 'pdf-extractor', version: '3.0' }))!.capability_embedding,
        numCandidates: 50,
        limit: 3,
        filter: { status: { $eq: 'active' }, 'metadata.reliability_score': { $gte: 0.8 } },
      },
    },
    { $project: { name: 1, version: 1 } },
  ]).toArray();
  check('$vectorSearch returns >= 1 result', sample.length >= 1, `${Date.now() - t0}ms`);
} catch (e) {
  check('atlas reachable', false, (e as Error).message);
} finally {
  if (mc) await mc.close();
}

console.log('\n=== api server ===');
let apiUp = false;
try {
  const r = await fetch(`${HOST}/health`, { signal: AbortSignal.timeout(2000) });
  apiUp = r.ok;
  check('GET /health', r.ok, `${r.status}`);
} catch (e) {
  check('GET /health', false, `${HOST} unreachable — start with npm run dev`);
}

if (apiUp) {
  try {
    const r = await fetch(`${HOST}/discover?q=test&mode=hybrid`, {
      headers: { 'x-api-key': 'sk_demo_pdf_agent_8f2c4a' },
    });
    check('GET /discover (hybrid)', r.ok, `${r.status}`);
  } catch (e) { check('GET /discover (hybrid)', false, (e as Error).message); }

  try {
    const r = await fetch(`${HOST}/atlas-stats`);
    const j = await r.json() as any;
    check('GET /atlas-stats', r.ok && !!j.mongo);
  } catch (e) { check('GET /atlas-stats', false, (e as Error).message); }
}

console.log('\n=== mcp server ===');
const mcp = spawnSync('node', ['bin/2chain-mcp.mjs'], {
  input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
  encoding: 'utf-8',
  timeout: 5000,
});
const mcpStdout = mcp.stdout ?? '';
check('MCP server boots', mcpStdout.includes('discover_tools') && mcpStdout.includes('call_tool'),
  mcpStdout ? 'tools listed' : 'no response');

const failed = checks.filter((c) => !c.pass);
console.log(`\n${C.cyan}${C.bold}═══ summary: ${checks.length - failed.length}/${checks.length} ═══${C.reset}`);
if (failed.length === 0) {
  console.log(`${C.green}${C.bold}✓ pre-flight passed — ready for stage${C.reset}\n`);
  process.exit(0);
}
console.log(`${C.red}${C.bold}${failed.length} failed${C.reset}`);
for (const f of failed) console.log(`  - ${f.name}${f.detail ? '  (' + f.detail + ')' : ''}`);
console.log();
process.exit(1);
