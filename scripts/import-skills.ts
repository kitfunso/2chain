// CLI: ingest Claude Code skills into 2chain.
//
// Usage:
//   npm run import:skills                        # ingest from ~/.claude/skills
//   npm run import:skills -- --root <dir>
//   npm run import:skills -- --only office-hours,codex
//   npm run import:skills -- --verify            # require >=10 found
//   TWOCHAIN_DB_PATH=/tmp/v2.db npm run import:skills

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importSkills } from '../src/import/skills-importer.js';

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

console.log(`skills-import: db=${dbPath}`);
console.log(`               embedder=${embedder.name()}`);
console.log(`               root=${flags.root ?? '<HOME>/.claude/skills'} verify=${flags.verify} dryRun=${flags.dryRun}`);
console.log();

try {
  const result = await importSkills(storage, embedder, {
    root: flags.root,
    only: flags.only,
    skipEmbedding: flags.dryRun,
    minImports: flags.verify ? 10 : 0,
  });

  console.log('=== import result ===');
  console.log(`  skills found:    ${result.skills_found}`);
  console.log(`  skills imported: ${result.skills_imported}`);
  console.log(`  skills skipped:  ${result.skills_skipped}`);
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
