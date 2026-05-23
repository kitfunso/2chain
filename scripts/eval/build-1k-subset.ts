// Build a 1k subset of the 10k corpus for CI gate reference.
// Deterministic: first 1000 tools by name+version ascending sort.

import 'dotenv/config';
import { existsSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';

const sourcePath = process.env.TWOCHAIN_SRC_DB ?? 'C:/tmp/v2-10k.db';
const targetPath = process.env.TWOCHAIN_DST_DB ?? 'C:/tmp/v2-1k.db';

const src = new SqliteStorage({ path: sourcePath });
await src.init();
const all = await src.listTools({ limit: 20_000 });
console.log(`source: ${all.length} tools from ${sourcePath}`);

// Sort name+version ascending and take first 1k
const sorted = [...all].sort((a, b) => {
  const aKey = `${a.name}@${a.version}|${a.namespace_id}`;
  const bKey = `${b.name}@${b.version}|${b.namespace_id}`;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
});
const subset = sorted.slice(0, 1000);
await src.close();

if (existsSync(targetPath)) unlinkSync(targetPath);
mkdirSync(dirname(targetPath), { recursive: true });
const tmp = `${targetPath}.tmp`;
if (existsSync(tmp)) unlinkSync(tmp);
const dst = new SqliteStorage({ path: tmp });
await dst.init();

const embedder = new OllamaEmbedder();
const texts = subset.map((t) => t.capability_text);
const embeds = await embedder.embedBatch(texts, 'document');

for (let i = 0; i < subset.length; i++) {
  const { id, created_at, updated_at, ...spec } = subset[i];
  await dst.upsertTool(spec, embeds[i]);
}
await dst.close();
renameSync(tmp, targetPath);
console.log(`wrote 1k subset to ${targetPath}`);
