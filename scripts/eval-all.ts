// Run the per-kind eval rubric on every tool in the live DB and write the
// pass-rate as the new reliability_score. Tools below the 0.80 gate get
// status='circuit_broken' so they drop out of /discover results.
//
// The rubric is deterministic and side-effect-free. Runs in microseconds
// per tool, so 1000+ tools complete in <1s.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { runSkillEval, runSubagentEval, runPromptEval } from '../src/services/kindEvalRunner.js';
import type { ToolSpecV2 } from '../src/types.js';

// Lightweight tool eval that only checks structural quality. The full eval
// would re-run the fixture cases against a callable stub, which most
// catalog-only entries can't satisfy. Score = pass/total of: has-name,
// has-version, has-description (>=40 chars), has-body (>=100 chars).
function runToolEval(spec: ToolSpecV2): { pass_count: number; total_count: number; pass_rate: number } {
  let pass = 0, total = 0;
  total++; if ((spec.name || '').length >= 2) pass++;
  total++; if (/^\d/.test(spec.version || '')) pass++;
  const cap = (spec.capability_text || '').trim();
  total++; if (cap.length >= 40) pass++;
  total++; if (cap.length >= 100) pass++;
  return { pass, total_count: total, pass_count: pass, pass_rate: pass / total } as any;
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();

// SqliteStorage registers the notify_change UDF in init() so the trigger
// fires cleanly when updateToolAfterEval() runs. No extra setup needed.

try {
  const tools = await storage.listTools({ limit: 10000 });
  console.log(`evaluating ${tools.length} tools`);

  const writeRuns = process.env.WRITE_EVAL_RUNS === '1';
  const histogram: Record<string, number> = { '1.00': 0, '0.83': 0, '0.80': 0, '0.67': 0, '0.50': 0, 'below': 0 };
  let updated = 0;
  let gated = 0;
  let runsWritten = 0;

  for (const t of tools) {
    const startedAt = Date.now();
    let result: { pass_count: number; total_count: number; pass_rate: number };
    if (t.tool_kind === 'skill') result = runSkillEval(t);
    else if (t.tool_kind === 'subagent') result = runSubagentEval(t);
    else if (t.tool_kind === 'prompt') result = runPromptEval(t);
    else result = runToolEval(t);

    const adjustedRate = result.pass_rate;

    const newReliability = Math.round(adjustedRate * 100) / 100;
    const bucket = newReliability >= 1.0 ? '1.00'
      : newReliability >= 0.83 ? '0.83'
      : newReliability >= 0.80 ? '0.80'
      : newReliability >= 0.67 ? '0.67'
      : newReliability >= 0.50 ? '0.50'
      : 'below';
    histogram[bucket]++;

    if (newReliability < 0.80) gated++;

    if (writeRuns) {
      await storage.insertEvalRun({
        tool_id: t.id,
        tool_name: t.name,
        tool_version: t.version,
        namespace_id: t.namespace_id,
        triggered_at: new Date().toISOString(),
        triggered_by: 'scheduled',
        cases: [{ case_id: 'structural', pass: newReliability >= 0.80, latency_ms: 0, cost_usd: 0 }],
        pass_count: result.pass_count,
        total_count: result.total_count,
        pass_rate: result.pass_rate,
        duration_ms: Date.now() - startedAt,
      });
      runsWritten++;
    }

    if (Math.abs((t.metadata.reliability_score ?? 0) - newReliability) > 0.005) {
      const newMeta = { ...t.metadata, reliability_score: newReliability };
      const newStatus = newReliability < 0.80 ? 'circuit_broken' : 'active';
      await storage.updateToolAfterEval(t.id, newMeta, newStatus);
      updated++;
    }
  }

  console.log(`updated ${updated} tools`);
  console.log(`gated (below 0.80): ${gated}`);
  if (writeRuns) console.log(`eval_run rows written: ${runsWritten}`);
  console.log('reliability histogram:', histogram);
} finally {
  await storage.close();
}
