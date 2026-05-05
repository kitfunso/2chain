// Insert (or update) an agent in the deployed DB so the server has an
// API key to authenticate /discover, /push, /call.
//
// Usage:
//   tsx scripts/create-agent.ts --name <name> --role caller|tool_author|admin --key <raw_api_key>
//   tsx scripts/create-agent.ts --name public-demo --role caller --key sk_public_demo_<random>

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { hashKey } from '../src/server/auth.js';

interface Flags {
  name: string;
  role: 'caller' | 'tool_author' | 'admin';
  key: string;
}

function parseFlags(argv: string[]): Flags {
  const out: Partial<Flags> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--role') out.role = argv[++i] as Flags['role'];
    else if (a === '--key') out.key = argv[++i];
  }
  if (!out.name || !out.role || !out.key) {
    console.error('usage: tsx scripts/create-agent.ts --name <name> --role caller|tool_author|admin --key <raw_api_key>');
    process.exit(1);
  }
  if (!['caller', 'tool_author', 'admin'].includes(out.role)) {
    console.error(`invalid role: ${out.role}`);
    process.exit(1);
  }
  return out as Flags;
}

const flags = parseFlags(process.argv.slice(2));
const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);

const storage = new SqliteStorage({ path: dbPath });
await storage.init();
try {
  const agent = {
    id: randomUUID(),
    name: flags.name,
    api_key_hash: hashKey(flags.key),
    role: flags.role,
    created_at: new Date().toISOString(),
  };
  await storage.upsertAgent(agent);
  console.log(`created agent ${agent.name} (role=${agent.role}) id=${agent.id}`);
  console.log(`api_key_hash=${agent.api_key_hash.slice(0, 16)}...`);
} finally {
  await storage.close();
}
