// Captures v1 retrieval baseline against the live v1 server.
// For each golden query, records top-1 + top-3 + RRF margin.
// v2 must match this baseline within tolerance (see Phase 1 plan Step 10).

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOST = process.env.TWOCHAIN_HOST ?? 'http://127.0.0.1:3030';
const API_KEY = process.env.TWOCHAIN_API_KEY ?? 'sk_demo_pdf_agent_8f2c4a';
const MODE = process.env.BASELINE_MODE ?? 'hybrid';

interface GoldenQuery {
  id: string;
  category: string;
  q: string;
  expected_top1?: string;
  expected_top1_in?: string[];
}

interface BaselineEntry {
  id: string;
  category: string;
  q: string;
  mode: string;
  top1: { name: string; version: string; rrf_score: number; vec_score: number; rerank_score: number };
  top3: Array<{ name: string; version: string; rrf_score: number; rerank_score: number }>;
  rrf_margin_top1_top2: number;
  rerank_margin_top1_top2: number;
  candidates_after_filter: number;
  total_ms: number;
  expected_match: boolean | 'unspecified';
  meta_pipeline_present: boolean;
}

async function fetchDiscover(query: string): Promise<any> {
  const url = new URL(HOST + '/discover');
  url.searchParams.set('q', query);
  url.searchParams.set('top', '5');
  url.searchParams.set('mode', MODE);
  const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${query.slice(0, 40)}`);
  return await res.json();
}

function checkExpectation(top1Name: string, q: GoldenQuery): boolean | 'unspecified' {
  if (q.expected_top1) return top1Name === q.expected_top1;
  if (q.expected_top1_in) return q.expected_top1_in.includes(top1Name);
  return 'unspecified';
}

const goldenPath = resolve('tests/fixtures/golden-queries.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as { queries: GoldenQuery[] };
console.log(`loaded ${golden.queries.length} golden queries from ${goldenPath}`);
console.log(`hitting ${HOST}/discover?mode=${MODE}\n`);

const out: BaselineEntry[] = [];
let pass = 0;
let fail = 0;
let unspec = 0;
let errors = 0;

for (const q of golden.queries) {
  try {
    const r = await fetchDiscover(q.q);
    const results = (r.results ?? []) as Array<any>;
    if (results.length === 0) {
      console.log(`  EMPTY  [${q.id}] ${q.q.slice(0, 60)}`);
      out.push({
        id: q.id,
        category: q.category,
        q: q.q,
        mode: MODE,
        top1: { name: '', version: '', rrf_score: 0, vec_score: 0, rerank_score: 0 },
        top3: [],
        rrf_margin_top1_top2: 0,
        rerank_margin_top1_top2: 0,
        candidates_after_filter: 0,
        total_ms: r.meta?.total_ms ?? 0,
        expected_match: false,
        meta_pipeline_present: !!r.meta?.pipeline_json,
      });
      errors++;
      continue;
    }
    const top1 = results[0];
    const top2 = results[1] ?? { rrf_score: 0, rerank_score: 0 };
    const matched = checkExpectation(top1.name, q);
    const entry: BaselineEntry = {
      id: q.id,
      category: q.category,
      q: q.q,
      mode: MODE,
      top1: {
        name: top1.name,
        version: top1.version,
        rrf_score: Number(top1.rrf_score ?? top1.rank_score ?? 0),
        vec_score: Number(top1.vec_score ?? 0),
        rerank_score: Number(top1.rerank_score ?? 0),
      },
      top3: results.slice(0, 3).map((t) => ({
        name: t.name,
        version: t.version,
        rrf_score: Number(t.rrf_score ?? t.rank_score ?? 0),
        rerank_score: Number(t.rerank_score ?? 0),
      })),
      rrf_margin_top1_top2: Number(top1.rrf_score ?? 0) - Number(top2.rrf_score ?? 0),
      rerank_margin_top1_top2: Number(top1.rerank_score ?? 0) - Number(top2.rerank_score ?? 0),
      candidates_after_filter: Number(r.meta?.candidates_after_filter ?? results.length),
      total_ms: Number(r.meta?.total_ms ?? 0),
      expected_match: matched,
      meta_pipeline_present: !!r.meta?.pipeline_json,
    };
    out.push(entry);
    if (matched === true) { pass++; console.log(`  PASS   [${q.id}] -> ${top1.name}@${top1.version}`); }
    else if (matched === false) { fail++; console.log(`  MISS   [${q.id}] -> ${top1.name}@${top1.version} (expected ${q.expected_top1 ?? q.expected_top1_in})`); }
    else { unspec++; console.log(`  -      [${q.id}] -> ${top1.name}@${top1.version}`); }
  } catch (err) {
    errors++;
    console.error(`  ERROR  [${q.id}]: ${(err as Error).message}`);
  }
  // Voyage free tier is 3 RPM. Cold queries hit Voyage; if we don't throttle,
  // 41% of queries 500. 22s gap respects 3 RPM with 2s buffer.
  await new Promise((r) => setTimeout(r, 22_000));
}

const summary = {
  generated_at: new Date().toISOString(),
  host: HOST,
  mode: MODE,
  total_queries: golden.queries.length,
  pass,
  fail,
  unspecified: unspec,
  errors,
  entries: out,
};

const outPath = resolve('tests/fixtures/v1-baseline.json');
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`\n=== summary ===`);
console.log(`  pass:        ${pass}`);
console.log(`  miss:        ${fail}`);
console.log(`  unspecified: ${unspec}`);
console.log(`  errors:      ${errors}`);
console.log(`  written:     ${outPath}`);
