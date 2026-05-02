// Probe the expanded catalog with queries that should route to real-corpus tools.
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { discover } from '../src/services/discover.js';

const path = process.env.TWOCHAIN_DB_PATH ?? '/tmp/v2.db';
const s = new SqliteStorage({ path });
await s.init();
const e = new OllamaEmbedder();

const queries: Array<[string, string]> = [
  ['code', 'count weekly downloads of an npm package'],
  ['code', 'list open issues for a github repository'],
  ['code', 'find security vulnerabilities in container image'],
  ['comms', 'send an SMS to a customer'],
  ['comms', 'post a message to a Slack channel from a bot'],
  ['geo', 'forecast tomorrow weather for a city worldwide'],
  ['geo', 'reverse geocode a lat lng to an address'],
  ['docs', 'OCR a scanned receipt and pull amounts'],
  ['research', 'fetch full text of a paper by DOI'],
  ['health', 'look up an ICD-10 code for a diagnosis'],
  ['ecommerce', 'list shopify orders for a store'],
  ['media', 'transcribe an audio file with timestamps'],
  ['legal', 'search US patents by inventor name'],
  ['data', 'parse a CSV file into JSON rows'],
  ['edu', 'search wikipedia for a topic'],
  ['finance', 'historical FX rates between USD and EUR'],
];

for (const [domain, q] of queries) {
  const r = await discover(s, e, q, 3);
  const top1 = r.results[0];
  console.log(`[${domain.padEnd(10)}] "${q}"`);
  console.log(`     -> ${top1?.name ?? '<none>'}@${top1?.version ?? '?'}  rrf=${top1?.rrf_score.toFixed(4)}`);
  console.log(`        top3: ${r.results.slice(0, 3).map((x) => x.name).join(', ')}`);
}
await s.close();
