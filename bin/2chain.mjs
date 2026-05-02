#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOST = process.env['2CHAIN_HOST'] || 'http://127.0.0.1:3030';
const KEY = process.env['2CHAIN_API_KEY'] || 'sk_demo_tool_author_7e5f1c';

const [, , cmd, ...rest] = process.argv;

function die(msg, code = 1) { console.error(msg); process.exit(code); }

async function push(file) {
  const body = JSON.parse(readFileSync(resolve(file), 'utf-8'));
  const t = Date.now();
  const r = await fetch(`${HOST}/push`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  const ms = Date.now() - t;
  if (!r.ok || !j.ok) {
    console.error(`push failed (${r.status}): ${j.error?.message ?? JSON.stringify(j)}`);
    process.exit(1);
  }
  console.log(`✓ pushed ${j.name}@${j.version}`);
  console.log(`  pass_rate:   ${j.pass_rate} (${j.pass_count}/${j.total_count})`);
  console.log(`  status:      ${j.status}`);
  console.log(`  reliability: ${j.reliability_score}`);
  console.log(`  wall:        ${ms}ms (embed=${j.embed_ms}ms, eval=${j.eval_ms}ms)`);
  console.log('  cases:');
  for (const c of j.cases) console.log(`    ${c.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.case_id}${c.error ? '  (' + c.error + ')' : ''}`);
}

async function discover(query) {
  const url = `${HOST}/discover?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'x-api-key': process.env['2CHAIN_AGENT_KEY'] || 'sk_demo_pdf_agent_8f2c4a' } });
  const j = await r.json();
  if (!r.ok) die(`discover failed (${r.status}): ${j.error?.message}`);
  console.log(`query: "${query}"   embed=${j.meta.embed_ms}ms search=${j.meta.search_ms}ms`);
  if (!j.results.length) { console.log('  (no results)'); return; }
  console.log('rank  name              ver   rel   vec    composite');
  console.log('────  ───────────────── ───   ────  ────   ─────────');
  j.results.forEach((res, i) => {
    console.log(`  ${i + 1}   ${res.name.padEnd(17)} ${res.version.padEnd(4)}  ${res.reliability_score.toFixed(2)}  ${res.vec_score.toFixed(3)}  ${res.rank_score.toFixed(3)}`);
  });
}

async function call(toolNameVer, caseId, inputJson) {
  const [name, version] = toolNameVer.split('@');
  if (!name || !version) die('usage: 2chain call <name@version> <case_id> [<input_json>]');
  const input = inputJson ? JSON.parse(inputJson) : {};
  const r = await fetch(`${HOST}/call`, {
    method: 'POST',
    headers: { 'x-api-key': process.env['2CHAIN_AGENT_KEY'] || 'sk_demo_pdf_agent_8f2c4a', 'content-type': 'application/json' },
    body: JSON.stringify({ tool_name: name, tool_version: version, case_id: caseId, input }),
  });
  const j = await r.json();
  if (j.ok) {
    console.log(`✓ ${toolNameVer} → 200 (${j.latency_ms}ms)`);
    console.log(JSON.stringify(j.result, null, 2));
  } else {
    console.log(`✗ ${toolNameVer} → ${r.status} \x1b[31m${j.error?.code}\x1b[0m`);
    console.log(`  ${j.error?.message}`);
    if (j.error?.details?.raw_preview !== undefined) {
      const p = j.error.details.raw_preview;
      console.log(`  raw: ${typeof p === 'string' ? '"' + p + '"' : JSON.stringify(p)}`);
    }
  }
}

const HELP = `2chain CLI

  2chain push <tool.json>             # publish a tool, run inline evals
  2chain discover "<natural query>"   # query the registry, see ranked top-N
  2chain call <name@version> <case_id> [<input_json>]
                                      # call a tool through the contract layer
`;

try {
  switch (cmd) {
    case 'push':       if (!rest[0]) die('missing tool.json path'); await push(rest[0]); break;
    case 'discover':   if (!rest[0]) die('missing query'); await discover(rest.join(' ')); break;
    case 'call':       await call(rest[0], rest[1], rest[2]); break;
    case '--help':
    case '-h':
    case undefined:    process.stdout.write(HELP); break;
    default:           die(`unknown command: ${cmd}\n\n${HELP}`);
  }
} catch (e) { die(`error: ${e.message}`); }
