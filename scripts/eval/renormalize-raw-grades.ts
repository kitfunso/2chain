// Fix-up: the original grading run normalised Claude's output using key
// `${name}@${version}`, but Claude sometimes echoed the prompt's full
// "name@version" string back into the `name` field — causing the lookup to
// miss and ~21 candidates across 8 queries to be defaulted to rel=0 instead
// of getting Claude's actual grades.
//
// This script re-parses the raw text we captured at grading time (the first
// 4000 chars of each judge's stdout), applies the corrected key normalisation
// (strip @-suffix when present), and overwrites v2-golden-judge-raw.json with
// the corrected grades. Idempotent.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Grade { name: string; version: string; relevance: number; rationale: string; }
interface JudgeOut { judge?: string; query_id?: string; grades: Grade[]; latency_ms?: number; error?: string; raw?: string; }
interface RawQuery { id: string; q: string; claude?: JudgeOut; codex?: JudgeOut; }

const rawPath = resolve('tests/fixtures/v2-golden-judge-raw.json');
const candPath = resolve('tests/fixtures/v2-golden-candidates.json');
const raw = JSON.parse(readFileSync(rawPath, 'utf-8')) as { queries: RawQuery[] };
const cand = JSON.parse(readFileSync(candPath, 'utf-8')) as { queries: Array<{ id: string; candidates: Array<{ name: string; version: string }> }> };
const candById = new Map(cand.queries.map((q) => [q.id, q.candidates]));

function extractJsonArray(text: string): unknown {
  let s = text.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) throw new Error('no JSON array');
  return JSON.parse(s.slice(start, end + 1));
}

// Strip trailing @vN.M from name so "foo@1.0" → "foo".
function stripVerSuffix(name: string): string {
  const at = name.lastIndexOf('@');
  if (at < 0) return name;
  const suffix = name.slice(at + 1);
  // Heuristic: only treat as version suffix if it looks like a version string
  if (/^[\d.]+[a-z0-9-]*$/.test(suffix)) return name.slice(0, at);
  return name;
}

function renormalise(rawText: string, candList: Array<{ name: string; version: string }>): Grade[] {
  let parsed: unknown;
  try {
    parsed = extractJsonArray(rawText);
  } catch (e) {
    return candList.map((c) => ({ name: c.name, version: c.version, relevance: 0, rationale: '(re-parse failed)' }));
  }
  if (!Array.isArray(parsed)) return candList.map((c) => ({ name: c.name, version: c.version, relevance: 0, rationale: '(not array)' }));
  const byKey = new Map<string, Grade>();
  for (const item of parsed as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    const rawName = String(item.name ?? '');
    const version = String(item.version ?? '');
    const name = stripVerSuffix(rawName);
    const relRaw = item.relevance;
    const rel = typeof relRaw === 'number' ? Math.max(0, Math.min(3, Math.round(relRaw))) : 0;
    const rationale = String(item.rationale ?? '').slice(0, 240);
    if (name && version) byKey.set(`${name}@${version}`, { name, version, relevance: rel, rationale });
  }
  return candList.map((c) => byKey.get(`${c.name}@${c.version}`) ?? {
    name: c.name,
    version: c.version,
    relevance: 0,
    rationale: '(judge did not grade — defaulting to 0)',
  });
}

let fixed = 0;
for (const q of raw.queries) {
  const candList = candById.get(q.id) ?? [];
  if (q.claude?.raw && !q.claude.error) {
    const newG = renormalise(q.claude.raw, candList);
    const oldNonZero = q.claude.grades.filter((g) => g.relevance > 0).length;
    const newNonZero = newG.filter((g) => g.relevance > 0).length;
    if (newNonZero > oldNonZero) {
      console.log(`  ${q.id} claude: ${oldNonZero} -> ${newNonZero} non-zero grades`);
      fixed++;
    }
    q.claude.grades = newG;
  }
  if (q.codex?.raw && !q.codex.error) {
    const newG = renormalise(q.codex.raw, candList);
    const oldNonZero = q.codex.grades.filter((g) => g.relevance > 0).length;
    const newNonZero = newG.filter((g) => g.relevance > 0).length;
    if (newNonZero > oldNonZero) {
      console.log(`  ${q.id} codex: ${oldNonZero} -> ${newNonZero} non-zero grades`);
      fixed++;
    }
    q.codex.grades = newG;
  }
}

writeFileSync(rawPath, JSON.stringify(raw, null, 2) + '\n');
console.log(`renormalised ${fixed} judge-records (raw text re-parsed with stripped @version)`);
