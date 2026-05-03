// CLI: ingest Claude Code subagents (~/.claude/agents/*.md) into 2chain.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importSubagents } from '../src/import/subagents-importer.js';

interface CliFlags {
  root?: string;
  only?: string[];
  verify: boolean;
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { verify: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify') out.verify = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--root') out.root = argv[++i];
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

console.log(`subagents-import: db=${dbPath}`);
console.log(`                  embedder=${embedder.name()}`);
console.log(`                  root=${flags.root ?? '<HOME>/.claude/agents'} verify=${flags.verify} dryRun=${flags.dryRun}`);
console.log();

try {
  const result = await importSubagents(storage, embedder, {
    root: flags.root,
    only: flags.only,
    skipEmbedding: flags.dryRun,
    minImports: flags.verify ? 10 : 0,
  });

  console.log('=== import result ===');
  console.log(`  agents found:    ${result.agents_found}`);
  console.log(`  agents imported: ${result.agents_imported}`);
  console.log(`  agents skipped:  ${result.agents_skipped}`);
  console.log(`  duration:        ${result.duration_ms}ms`);
  if (result.errors.length > 0) {
    console.log(`\n  errors (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`    [${e.slug}] ${e.error}`);
    }
  }

  const stats = await storage.dbStats();
  console.log(`\n  db total tools: ${stats.collection_counts.tools}`);
} finally {
  await storage.close();
}
