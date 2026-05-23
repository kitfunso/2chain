// Step 5 prep: merge judge-raw grades into v2-golden.json relevance maps.
//
// For each (query, candidate) pair:
//   - if both judges graded AND |claude - codex| <= 1: use rounded mean
//   - if |claude - codex| >= 2: NOT merged, must be adjudicated by human
//   - if only one judge graded (rare; the other errored): use that one
//
// The script writes:
//   - tests/fixtures/v2-golden.json (updated with merged relevance maps)
//   - tests/fixtures/v2-golden-disagreements.json (queries+pairs awaiting Keith adjudication)
//
// Re-running the script is idempotent: relevance maps are recomputed from scratch each time.

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Grade { name: string; version: string; relevance: number; rationale: string; }
interface JudgeOut { grades: Grade[]; error?: string; }
interface RawQuery { id: string; q: string; claude?: JudgeOut; codex?: JudgeOut; }
interface Raw { queries: RawQuery[]; }
interface GoldenQuery {
  id: string;
  stratum: string;
  q: string;
  expected_top1?: string;
  expected_top1_in?: string[];
  expected_top3: string[];
  relevance: Record<string, number>;
}
interface Golden { queries: GoldenQuery[]; [k: string]: unknown; }

const rawPath = resolve('tests/fixtures/v2-golden-judge-raw.json');
const goldenPath = resolve('tests/fixtures/v2-golden.json');
const disagreementsPath = resolve('tests/fixtures/v2-golden-disagreements.json');

const raw = JSON.parse(readFileSync(rawPath, 'utf-8')) as Raw;
const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as Golden;
const rawById = new Map(raw.queries.map((q) => [q.id, q]));

interface DisagreementEntry {
  query_id: string;
  q: string;
  candidate: string;
  claude_rel: number;
  codex_rel: number;
  gap: number;
  claude_rationale: string;
  codex_rationale: string;
}
const disagreements: { queries: Array<{ id: string; q: string; pairs: DisagreementEntry[] }> } = { queries: [] };

let totalPairs = 0;
let mergedPairs = 0;
let disagreePairs = 0;
let oneJudgeOnly = 0;
let queriesUngraded = 0;

for (const gq of golden.queries) {
  const r = rawById.get(gq.id);
  if (!r || (!r.claude && !r.codex)) {
    queriesUngraded++;
    continue;
  }
  const cByKey = new Map<string, Grade>();
  const xByKey = new Map<string, Grade>();
  // Normalise: claude sometimes echoes the prompt's "name@version" format into
  // the name field. If the name already contains "@", treat the whole string
  // as the key; otherwise build key = name@version.
  function normKey(g: Grade): string {
    return g.name.includes('@') ? g.name : `${g.name}@${g.version}`;
  }
  if (r.claude && !r.claude.error) for (const g of r.claude.grades) cByKey.set(normKey(g), g);
  if (r.codex && !r.codex.error) for (const g of r.codex.grades) xByKey.set(normKey(g), g);

  const allKeys = new Set([...cByKey.keys(), ...xByKey.keys()]);
  const newRelevance: Record<string, number> = {};
  const pairDisagreements: DisagreementEntry[] = [];

  for (const key of allKeys) {
    totalPairs++;
    const c = cByKey.get(key);
    const x = xByKey.get(key);
    if (c && x) {
      const gap = Math.abs(c.relevance - x.relevance);
      if (gap >= 2) {
        // Known parser bug in grade-llm-judge.ts: Claude sometimes echoed the
        // prompt's "name@version" string into the `name` field, causing
        // `${name}@${version}` lookups to miss and grade to default to 0.
        // Detect: if Claude's rationale says "did not grade — defaulting" AND
        // Codex graded the same candidate >= 2, treat Claude's "0" as a parser
        // artifact (not a real Claude judgment) and auto-accept Codex's grade.
        const claudeIsArtifact = !!c.rationale.match(/^\((judge did not grade|re-parse failed|not array)/);
        if (claudeIsArtifact && x.relevance >= 2) {
          mergedPairs++;
          newRelevance[key] = x.relevance;
          continue;
        }
        // Mirror: if Codex defaulted to 0 (same parser issue) and Claude graded >= 2.
        const codexIsArtifact = !!x.rationale.match(/^\((judge did not grade|re-parse failed|not array)/);
        if (codexIsArtifact && c.relevance >= 2) {
          mergedPairs++;
          newRelevance[key] = c.relevance;
          continue;
        }
        disagreePairs++;
        pairDisagreements.push({
          query_id: gq.id,
          q: gq.q,
          candidate: key,
          claude_rel: c.relevance,
          codex_rel: x.relevance,
          gap,
          claude_rationale: c.rationale,
          codex_rationale: x.rationale,
        });
        // Leave out of relevance map — must be adjudicated.
      } else {
        mergedPairs++;
        newRelevance[key] = Math.round((c.relevance + x.relevance) / 2);
      }
    } else if (c) {
      oneJudgeOnly++;
      newRelevance[key] = c.relevance;
    } else if (x) {
      oneJudgeOnly++;
      newRelevance[key] = x.relevance;
    }
  }

  // Also include author top3 entries as rel=2 (acceptable) if not already graded.
  // This is a safety net — author's hint should at least be considered for the
  // relevance map even if the judges didn't cover it.
  for (const name of gq.expected_top3 ?? []) {
    // Find any version (judges might have named ANY version; we keep all entries that resolve)
    if (!Object.keys(newRelevance).some((k) => k.startsWith(name + '@'))) {
      // Skip: author-only entries without judge coverage aren't graded.
    }
  }

  gq.relevance = newRelevance;
  if (pairDisagreements.length > 0) {
    disagreements.queries.push({ id: gq.id, q: gq.q, pairs: pairDisagreements });
  }
}

writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n');
writeFileSync(disagreementsPath, JSON.stringify(disagreements, null, 2) + '\n');

const pairRate = totalPairs > 0 ? (disagreePairs / totalPairs) : 0;
const queriesWithDis = disagreements.queries.length;
const queryRate = golden.queries.length > 0 ? (queriesWithDis / golden.queries.length) : 0;

console.log(`merge complete`);
console.log(`  total pairs:       ${totalPairs}`);
console.log(`  merged (gap<=1):   ${mergedPairs} (${(100 * mergedPairs / totalPairs).toFixed(1)}%)`);
console.log(`  disagreed (gap>=2): ${disagreePairs} (${(100 * pairRate).toFixed(1)}%)`);
console.log(`  one-judge-only:    ${oneJudgeOnly}`);
console.log(`  queries ungraded:  ${queriesUngraded}`);
console.log(`  queries with ≥1 disagreement: ${queriesWithDis}/${golden.queries.length} (${(100 * queryRate).toFixed(1)}%)`);

let band = '';
if (pairRate < 0.10) band = '<10%: agreed-into-corner — consider swapping one judge for a different model family before locking grades';
else if (pairRate <= 0.25) band = '10-25%: route to human adjudication (Step 5)';
else band = '>25%: queries themselves ambiguous — consider rephrasing the affected ones';
console.log(`  band: ${band}`);
