// Step 4 of Episode A1: two-judge ensemble grading.
//
// Judge 1: Claude 4.7 via `claude -p` headless mode.
// Judge 2: Codex (default model) via `codex exec --json`.
//
// Each judge sees one query + all its candidates from
// v2-golden-candidates.json in a single batched call, returns a JSON array
// of {name, version, relevance: 0|1|2|3, rationale}. Both judges' raw
// outputs are recorded; disagreements (|claude - codex| >= 2 on any
// candidate of a query) routed to v2-golden-disagreements.json.
//
// Usage:
//   npx tsx scripts/eval/grade-llm-judge.ts            # full 100 queries
//   PILOT=5 npx tsx scripts/eval/grade-llm-judge.ts    # first 5 queries only
//
// Outputs (incremental — script can resume):
//   tests/fixtures/v2-golden-judge-raw.json
//   tests/fixtures/v2-golden-disagreements.json
//   trajectories/grading-actions.log (per-query band + retries)

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import type { ToolV2 } from '../../src/types.js';

interface Query {
  id: string;
  stratum: string;
  q: string;
  expected_top1?: string;
  expected_top1_in?: string[];
  expected_top3: string[];
}
interface CandidateEntry {
  id: string;
  candidates: Array<{ name: string; version: string; sources: string[] }>;
}
interface Grade {
  name: string;
  version: string;
  relevance: number; // 0|1|2|3
  rationale: string;
}
interface JudgeOutput {
  judge: 'claude' | 'codex';
  query_id: string;
  grades: Grade[];
  latency_ms: number;
  error?: string;
  raw?: string;
}

const PILOT = process.env.PILOT ? parseInt(process.env.PILOT, 10) : null;
const ROOT = process.cwd();
const goldenPath = resolve('tests/fixtures/v2-golden.json');
const candidatesPath = resolve('tests/fixtures/v2-golden-candidates.json');
const rawPath = resolve('tests/fixtures/v2-golden-judge-raw.json');
const disagreementsPath = resolve('tests/fixtures/v2-golden-disagreements.json');
const actionsLog = resolve('trajectories/grading-actions.log');

const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as { queries: Query[] };
const cands = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as { queries: CandidateEntry[] };
const candsById = new Map(cands.queries.map((q) => [q.id, q]));

// Load tools (for capability_text lookups)
const storage = new SqliteStorage({ path: process.env.TWOCHAIN_DB_PATH ?? 'C:/tmp/v2.db' });
await storage.init();
const allTools = await storage.listTools({ limit: 10_000 });
const toolByKey = new Map(allTools.map((t) => [`${t.name}@${t.version}`, t]));

// Resume support: load existing raw file if present
let raw: { queries: Array<{ id: string; q: string; claude?: JudgeOutput; codex?: JudgeOutput }> } = { queries: [] };
if (existsSync(rawPath)) {
  raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
  console.log(`resuming from existing raw file (${raw.queries.length} graded queries)`);
}
const rawById = new Map(raw.queries.map((q) => [q.id, q]));

function buildPrompt(query: Query, candidateList: Array<{ name: string; version: string; capability_text: string }>): string {
  return `You are grading retrieval candidates for a tool registry called 2chain. For each candidate below, decide how relevant it is to the user query on a 0-3 scale and return ONLY a JSON array.

Scale:
  3 = ideal     (this candidate IS what the query is asking for)
  2 = acceptable (works as a substitute, partial credit)
  1 = related    (same domain, wrong specific tool)
  0 = wrong      (different domain, unrelated)

USER QUERY:
"${query.q}"

CANDIDATES (${candidateList.length}):
${candidateList.map((c, i) => `${i + 1}. name=${c.name}@${c.version}\n   capability_text: ${c.capability_text.slice(0, 300).replace(/\n/g, ' ')}`).join('\n\n')}

Return ONLY a single JSON array (no prose, no markdown fence) with one object per candidate IN THE SAME ORDER as listed:
[
  {"name": "...", "version": "...", "relevance": 0-3, "rationale": "one short sentence why"}
]`;
}

function extractJsonArray(text: string): unknown {
  // Strip markdown fences if present
  let s = text.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Find first [ and last ]
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) throw new Error('no JSON array found');
  return JSON.parse(s.slice(start, end + 1));
}

function normaliseGrades(parsed: unknown, candidateList: Array<{ name: string; version: string }>): Grade[] {
  if (!Array.isArray(parsed)) throw new Error('parsed output is not an array');
  const byKey = new Map<string, Grade>();
  for (const item of parsed as Array<Record<string, unknown>>) {
    if (typeof item !== 'object' || item === null) continue;
    const name = String(item.name ?? '');
    const version = String(item.version ?? '');
    const relRaw = item.relevance;
    const rel = typeof relRaw === 'number' ? Math.max(0, Math.min(3, Math.round(relRaw))) : 0;
    const rationale = String(item.rationale ?? '').slice(0, 240);
    if (name && version) byKey.set(`${name}@${version}`, { name, version, relevance: rel, rationale });
  }
  // For any candidate the judge skipped, fill with relevance=0 (treat as wrong-by-omission)
  return candidateList.map((c) => byKey.get(`${c.name}@${c.version}`) ?? {
    name: c.name,
    version: c.version,
    relevance: 0,
    rationale: '(judge did not grade — defaulting to 0)',
  });
}

async function callClaude(prompt: string, queryId: string): Promise<{ text: string; latencyMs: number }> {
  return new Promise((resolveP, rejectP) => {
    const t = Date.now();
    const claudeBin = process.platform === 'win32'
      ? 'C:/Users/skf_s/.local/bin/claude.exe'
      : 'claude';
    const child = spawn(claudeBin, ['-p', '--model', 'claude-sonnet-4-6'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_DISABLE_TELEMETRY: 'true' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => rejectP(new Error(`claude spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      const latencyMs = Date.now() - t;
      if (code !== 0) return rejectP(new Error(`claude exit ${code}: ${err.slice(0, 200)}`));
      resolveP({ text: out, latencyMs });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function callCodex(prompt: string, queryId: string): Promise<{ text: string; latencyMs: number }> {
  return new Promise((resolveP, rejectP) => {
    const t = Date.now();
    // Invoke real codex via node directly (codex.cmd is the hippo wrapper; codex without ext is a shell script).
    const codexJs = 'C:/Users/skf_s/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js';
    const child = spawn('node', [codexJs, 'exec', '--skip-git-repo-check', '--json', '-'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => rejectP(new Error(`codex spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      const latencyMs = Date.now() - t;
      if (code !== 0) return rejectP(new Error(`codex exit ${code}: ${err.slice(0, 200)}`));
      // codex --json emits per-event JSONL; the final agent_message is what we want
      const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
      let text = '';
      for (const ln of lines.reverse()) {
        try {
          const obj = JSON.parse(ln);
          if (obj.type === 'item.completed' && obj.item?.type === 'agent_message' && obj.item?.text) {
            text = obj.item.text;
            break;
          }
        } catch {}
      }
      if (!text) return rejectP(new Error(`codex: no agent_message found in ${lines.length} JSON lines`));
      resolveP({ text, latencyMs });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function logAction(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  appendFileSync(actionsLog, line);
}

const queriesToGrade = PILOT ? golden.queries.slice(0, PILOT) : golden.queries;
const CONCURRENCY = Number(process.env.GRADE_CONCURRENCY ?? 4);
console.log(`grading ${queriesToGrade.length} queries (PILOT=${PILOT ?? 'full'}) concurrency=${CONCURRENCY}`);

async function gradeOne(q: Query): Promise<void> {
  const existing = rawById.get(q.id);
  if (existing?.claude && existing?.codex) {
    console.log(`  ${q.id}: already graded, skipping`);
    return;
  }
  const candEntry = candsById.get(q.id);
  if (!candEntry) {
    console.error(`  ${q.id}: no candidates entry, skipping`);
    return;
  }
  const candList = candEntry.candidates.map((c) => {
    const tool = toolByKey.get(`${c.name}@${c.version}`);
    return {
      name: c.name,
      version: c.version,
      capability_text: tool?.capability_text ?? '(missing)',
    };
  });
  const prompt = buildPrompt(q, candList);

  const entry = existing ?? { id: q.id, q: q.q };
  const t0 = Date.now();

  // Run both judges in parallel for this query.
  const [claudeRes, codexRes] = await Promise.allSettled([
    entry.claude ? Promise.resolve(null) : callClaude(prompt, q.id),
    entry.codex ? Promise.resolve(null) : callCodex(prompt, q.id),
  ]);

  if (!entry.claude) {
    if (claudeRes.status === 'fulfilled' && claudeRes.value) {
      try {
        const parsed = extractJsonArray(claudeRes.value.text);
        const grades = normaliseGrades(parsed, candList);
        entry.claude = { judge: 'claude', query_id: q.id, grades, latency_ms: claudeRes.value.latencyMs, raw: claudeRes.value.text.slice(0, 4000) };
      } catch (e) {
        entry.claude = { judge: 'claude', query_id: q.id, grades: [], latency_ms: claudeRes.value.latencyMs, error: (e as Error).message };
      }
    } else if (claudeRes.status === 'rejected') {
      entry.claude = { judge: 'claude', query_id: q.id, grades: [], latency_ms: 0, error: (claudeRes.reason as Error).message };
    }
  }
  if (!entry.codex) {
    if (codexRes.status === 'fulfilled' && codexRes.value) {
      try {
        const parsed = extractJsonArray(codexRes.value.text);
        const grades = normaliseGrades(parsed, candList);
        entry.codex = { judge: 'codex', query_id: q.id, grades, latency_ms: codexRes.value.latencyMs, raw: codexRes.value.text.slice(0, 4000) };
      } catch (e) {
        entry.codex = { judge: 'codex', query_id: q.id, grades: [], latency_ms: codexRes.value.latencyMs, error: (e as Error).message };
      }
    } else if (codexRes.status === 'rejected') {
      entry.codex = { judge: 'codex', query_id: q.id, grades: [], latency_ms: 0, error: (codexRes.reason as Error).message };
    }
  }

  const wallMs = Date.now() - t0;
  const cStatus = entry.claude?.error ? 'FAIL' : `OK ${entry.claude?.grades.length}`;
  const xStatus = entry.codex?.error ? 'FAIL' : `OK ${entry.codex?.grades.length}`;
  console.log(`  ${q.id}: claude=${cStatus} codex=${xStatus} wall=${wallMs}ms`);
  if (entry.claude?.error) logAction(`${q.id} claude error: ${entry.claude.error.slice(0, 200)}`);
  if (entry.codex?.error) logAction(`${q.id} codex error: ${entry.codex.error.slice(0, 200)}`);

  // Update raw map + persist
  if (!rawById.has(q.id)) {
    raw.queries.push(entry);
    rawById.set(q.id, entry);
  } else {
    Object.assign(rawById.get(q.id)!, entry);
  }
  writeFileSync(rawPath, JSON.stringify(raw, null, 2) + '\n');
}

// Bounded concurrency runner
async function runPool(items: Query[], k: number): Promise<void> {
  let idx = 0;
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < k; w++) {
    workers.push((async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        try {
          await gradeOne(items[i]);
        } catch (e) {
          console.error(`worker error on ${items[i].id}: ${(e as Error).message}`);
        }
      }
    })());
  }
  await Promise.all(workers);
}

const tRun = Date.now();
await runPool(queriesToGrade, CONCURRENCY);
console.log(`\nrun complete in ${Math.round((Date.now() - tRun) / 1000)}s`);

// Compute disagreements + bands
const disagreements: { queries: Array<{ id: string; q: string; pairs: Array<{ name: string; claude_rel: number; codex_rel: number; gap: number }> }> } = { queries: [] };
let pairsTotal = 0;
let pairsDisagree = 0;
let queriesDisagree = 0;
for (const entry of raw.queries) {
  if (!entry.claude || !entry.codex || entry.claude.error || entry.codex.error) continue;
  const codexByKey = new Map(entry.codex.grades.map((g) => [`${g.name}@${g.version}`, g]));
  const queryPairs: Array<{ name: string; claude_rel: number; codex_rel: number; gap: number }> = [];
  let anyDisagree = false;
  for (const cg of entry.claude.grades) {
    const cog = codexByKey.get(`${cg.name}@${cg.version}`);
    if (!cog) continue;
    pairsTotal++;
    const gap = Math.abs(cg.relevance - cog.relevance);
    if (gap >= 2) {
      pairsDisagree++;
      anyDisagree = true;
      queryPairs.push({ name: cg.name, claude_rel: cg.relevance, codex_rel: cog.relevance, gap });
    }
  }
  if (anyDisagree) {
    queriesDisagree++;
    disagreements.queries.push({ id: entry.id, q: entry.q, pairs: queryPairs });
  }
}
writeFileSync(disagreementsPath, JSON.stringify(disagreements, null, 2) + '\n');

const pairRate = pairsTotal > 0 ? (pairsDisagree / pairsTotal) : 0;
const queryRate = raw.queries.length > 0 ? (queriesDisagree / raw.queries.length) : 0;
console.log(`\n=== disagreement summary ===`);
console.log(`  pair-level: ${pairsDisagree}/${pairsTotal} = ${(pairRate * 100).toFixed(1)}%`);
console.log(`  query-level (any pair disagrees): ${queriesDisagree}/${raw.queries.length} = ${(queryRate * 100).toFixed(1)}%`);
let band = '';
if (pairRate < 0.10) band = '<10%: agreed-into-corner; swap one judge for different model family';
else if (pairRate <= 0.25) band = '10-25%: route disagreements to human adjudication (Step 5)';
else band = '>25%: queries themselves ambiguous; rephrase before re-grading';
console.log(`  band action: ${band}`);
logAction(`finalised: pair-rate=${(pairRate * 100).toFixed(1)}% queries=${queriesDisagree}/${raw.queries.length} band=${band.split(':')[0]}`);

await storage.close();
