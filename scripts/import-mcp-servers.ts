import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importMcpServers } from '../src/import/mcp-importer.js';
import { MCP_SERVERS } from '../src/import/mcp-registry.js';

interface CliFlags {
  verify: boolean;
  only?: string[];
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { verify: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify') out.verify = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--only') out.only = (argv[++i] ?? '').split(',').filter(Boolean);
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));
const dbPath = resolve(
  process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`,
);

const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder({ concurrency: 4 });

const targetCount = flags.only?.length ?? MCP_SERVERS.length;
console.log(`mcp-import: db=${dbPath}`);
console.log(`            embedder=${embedder.name()}`);
console.log(`            servers=${targetCount} verify=${flags.verify} dryRun=${flags.dryRun}`);
console.log();

try {
  const result = await importMcpServers(storage, embedder, {
    verify: flags.verify,
    only: flags.only,
    skipEmbedding: flags.dryRun,
  });

  console.log('=== import result ===');
  console.log(`  servers imported:        ${result.servers_imported}`);
  console.log(`  servers skipped:         ${result.servers_skipped}`);
  console.log(`  tools imported:          ${result.tools_imported}`);
  if (result.tools_failed_verify > 0) {
    console.log(`  tools w/ verify drift:   ${result.tools_failed_verify}`);
  }
  console.log(`  duration:                ${result.duration_ms}ms`);

  if (result.errors.length > 0) {
    console.log(`\n  errors (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`    [${e.serverId}] ${e.error}`);
    }
  }

  const stats = await storage.dbStats();
  console.log(`\n  db total tools: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
