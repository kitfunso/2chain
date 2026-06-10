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
  if (j.drift) console.log(`  drift:       ${j.drift.from_version} → ${j.version}  input=${j.drift.input.classification} output=${j.drift.output.classification}`);
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

async function reverify(args) {
  let body = {};
  // Strict args on a mutating verb: a forgotten '--tool' (e.g.
  // `2chain reverify pdf-extractor@3.0`) must never silently widen into an
  // unfiltered fleet sweep. Only [] or ['--tool', '<spec>'] are accepted.
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--tool')) {
    die('usage: 2chain reverify [--tool name@version]');
  }
  const flagIdx = args.indexOf('--tool');
  if (flagIdx !== -1) {
    const spec = args[flagIdx + 1];
    if (!spec) die('usage: 2chain reverify [--tool name@version]');
    const [name, version] = spec.split('@');
    if (!name) die('usage: 2chain reverify [--tool name@version]');
    // A trailing '@' (empty version) on a mutating verb must error, not
    // silently widen scope to every version of the name.
    if (spec.includes('@') && !version) die('--tool: version is empty; use name@version or bare name');
    body = version ? { tool_name: name, tool_version: version } : { tool_name: name };
  }
  const t = Date.now();
  const r = await fetch(`${HOST}/v1/reverify`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    console.error(`reverify failed (${r.status}): ${j.error?.message ?? JSON.stringify(j)}`);
    process.exit(1);
  }
  console.log(`✓ reverify complete (${Date.now() - t}ms)`);
  console.log(`  executed: ${j.executed}   passed: ${j.passed}   failed: ${j.failed}`);
  console.log(`  gate-dropped: ${j.gate_dropped.length ? j.gate_dropped.join(', ') : '(none)'}`);
  if (j.recovered?.length) {
    console.log(`  recovered: ${j.recovered.join(', ')}`);
  }
  if (j.errored?.length) {
    console.log(`  errored (${j.errored.length}): ${j.errored.map((e) => `${e.tool} (${e.error})`).join(', ')}`);
  }
  if (j.truncated) {
    console.log('  WARNING: sweep truncated at the list cap; tools beyond it were NOT re-verified');
  }
  if (j.skipped.length) {
    console.log(`  skipped (${j.skipped.length}):`);
    for (const s of j.skipped) console.log(`    - ${s.name}@${s.version}  (${s.reason})`);
  }
}

async function health(args) {
  // Strict args: exactly one positional (the tool name). A second positional
  // is a typo, not a request — die before any fetch.
  if (args.length !== 1) die('usage: 2chain health <name>');
  const name = args[0];
  const t = Date.now();
  const r = await fetch(`${HOST}/v1/tools/${encodeURIComponent(name)}/health`, {
    headers: { 'x-api-key': KEY },
  });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    console.error(`health failed (${r.status}): ${j.error?.message ?? JSON.stringify(j)}`);
    process.exit(1);
  }
  console.log(`✓ health ${j.name} (${Date.now() - t}ms)`);
  console.log('  version   status           score  streak  last-verified');
  for (const v of j.versions) {
    const score = Number(v.reliability_score ?? 0).toFixed(2);
    const statusCol = v.status === 'active' ? `\x1b[32m${v.status.padEnd(16)}\x1b[0m`
      : v.status === 'circuit_broken' ? `\x1b[31m${v.status.padEnd(16)}\x1b[0m`
      : v.status.padEnd(16);
    console.log(`  ${v.version.padEnd(9)} ${statusCol} ${score}   ${String(v.verification_streak).padEnd(7)} ${v.last_eval_run ?? '(never)'}`);
  }
  if (j.drift_events.length) {
    // The payload is capped at the newest 10 events; never imply totality.
    console.log(`  drift (newest ${j.drift_events.length}):`);
    for (const d of j.drift_events) {
      const cls = d.classification === 'breaking' ? `\x1b[31m${d.classification}\x1b[0m` : d.classification;
      console.log(`    - ${d.from_version} → ${d.to_version}  ${d.direction}  ${cls}  (${d.created_at})`);
    }
  } else {
    console.log('  drift: (none)');
  }
  const agg = {};
  for (const v of j.versions) {
    for (const [k, n] of Object.entries(v.usage ?? {})) agg[k] = (agg[k] ?? 0) + n;
  }
  console.log(`  usage (7d): ${Object.entries(agg).map(([k, n]) => `${k}=${n}`).join('  ') || '(none)'}`);
}

const HELP = `2chain CLI

  2chain push <tool.json>             # publish a tool, run inline evals
  2chain discover "<natural query>"   # query the registry, see ranked top-N
  2chain call <name@version> <case_id> [<input_json>]
                                      # call a tool through the contract layer
  2chain reverify [--tool name@version]
                                      # re-run publish-time evals; full sweep is admin-only
  2chain health <name>                # per-version status/score/streak + drift & usage
`;

try {
  switch (cmd) {
    case 'push':       if (!rest[0]) die('missing tool.json path'); await push(rest[0]); break;
    case 'discover':   if (!rest[0]) die('missing query'); await discover(rest.join(' ')); break;
    case 'call':       await call(rest[0], rest[1], rest[2]); break;
    case 'reverify':   await reverify(rest); break;
    case 'health':     await health(rest); break;
    case '--help':
    case '-h':
    case undefined:    process.stdout.write(HELP); break;
    default:           die(`unknown command: ${cmd}\n\n${HELP}`);
  }
} catch (e) { die(`error: ${e.message}`); }
