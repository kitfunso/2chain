// One-shot SQL update: re-tag tool_kind for all rows whose author_agent_id
// matches a given source. Used to fix entries that were imported as kind=tool
// but really belong to a different kind (e.g. awesome-claude-prompts entries
// are prompts, not tools).
//
// Usage:
//   tsx scripts/retag-source-kind.ts --author awesome-awesome-claude-prompts --kind prompt
//   tsx scripts/retag-source-kind.ts --like 'awesome-%-prompts' --kind prompt

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

interface Flags {
  author?: string;
  like?: string;
  kind: string;
}

function parseFlags(argv: string[]): Flags {
  const out: Partial<Flags> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--author') out.author = argv[++i];
    else if (a === '--like') out.like = argv[++i];
    else if (a === '--kind') out.kind = argv[++i];
  }
  if (!out.kind) {
    console.error('usage: tsx scripts/retag-source-kind.ts (--author <id> | --like <pattern>) --kind <tool|skill|subagent|prompt>');
    process.exit(1);
  }
  if (!['tool', 'skill', 'subagent', 'prompt'].includes(out.kind)) {
    console.error(`invalid kind: ${out.kind}`);
    process.exit(1);
  }
  if (!out.author && !out.like) {
    console.error('must pass --author or --like');
    process.exit(1);
  }
  return out as Flags;
}

const flags = parseFlags(process.argv.slice(2));
const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);

const db = new Database(dbPath);
const where = flags.author ? 'author_agent_id = ?' : 'author_agent_id LIKE ?';
const arg = flags.author ?? flags.like!;

const before = db.prepare(`SELECT COUNT(*) AS n FROM tools WHERE ${where}`).get(arg) as { n: number };
console.log(`matched ${before.n} rows where ${where} = ${arg}`);

const r = db.prepare(`UPDATE tools SET tool_kind = ? WHERE ${where}`).run(flags.kind, arg);
console.log(`updated ${r.changes} rows → tool_kind='${flags.kind}'`);

const counts = db.prepare(`SELECT tool_kind, COUNT(*) AS n FROM tools GROUP BY tool_kind ORDER BY n DESC`).all();
console.log('current kind distribution:', counts);

db.close();
