import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { discover } from '../../src/services/discover.js';
import { call } from '../../src/services/call.js';
import { hashKey } from '../../src/server/auth.js';
import { importMcpServers } from '../../src/import/mcp-importer.js';
import '../../src/services/stubs.js';

const dbPath = resolve(
  process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`,
);
const s = new SqliteStorage({ path: dbPath });
await s.init();
const e = new OllamaEmbedder();

await importMcpServers(s, e, { only: ['mcp-everything'] });

const apiKey = 'sk_smoke_mcp_call';
await s.upsertAgent({
  id: 'smoke-mcp-caller',
  name: 'mcp-smoke',
  api_key_hash: hashKey(apiKey),
  role: 'caller',
  created_at: new Date().toISOString(),
});

const r = await discover(s, e, 'add two integers and return the sum', 5);
console.log('=== discover ===');
for (const x of r.results) {
  console.log(`  ${x.name}@${x.version}  rrf=${x.rrf_score.toFixed(4)}`);
}

const tool = r.results.find((x) => x.name.startsWith('mcp-everything__'));
if (!tool) {
  console.error('FAIL: no mcp-everything tool in top-5; retrieval drift');
  process.exit(1);
}
console.log(`\n  selected: ${tool.name}`);

const mcpToolName = tool.name.split('__')[1];
const mcpArgs: Record<string, Record<string, unknown>> = {
  'get-sum': { a: 7, b: 5 },
  add: { a: 7, b: 5 },
  echo: { message: 'hello-from-2chain' },
};

const callRes = await call(
  s,
  'smoke-mcp-caller',
  'caller',
  {
    tool_name: tool.name,
    tool_version: '1.0',
    input: mcpArgs[mcpToolName] ?? { message: 'hello-from-2chain' },
  },
  false,
);

console.log('\n=== call ===');
console.log(JSON.stringify(callRes, null, 2));

await s.close();
if (!callRes.ok) process.exit(1);
