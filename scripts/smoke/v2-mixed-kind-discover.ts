// Mixed-kind discover smoke. Builds a tmp DB, imports a handful of real
// skills, the prompt seed list, and a couple of fixture tools, then runs
// three queries and asserts the top-5 contains at least one 'skill' and
// at least one 'tool' row. Exits 1 on failure.
//
// Requires Ollama with nomic-embed-text. If Ollama is unreachable the
// script exits 1 with a clear message; install per docs/perf/ if missing.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { discover } from '../../src/services/discover.js';
import { importSkills } from '../../src/import/skills-importer.js';
import { importPrompts } from '../../src/import/prompts-importer.js';
import type { ToolSpecV2 } from '../../src/types.js';

const TMPDIR = mkdtempSync(resolve(tmpdir(), '2chain-mixed-'));
const DB_PATH = resolve(TMPDIR, 'mixed.sqlite');
const SKILLS_ROOT = resolve(TMPDIR, 'skills');

// Plant a small skills tree so the smoke is self-contained even on a
// machine without ~/.claude/skills (e.g. CI or a fresh dev box).
function plantSkills(): void {
  mkdirSync(SKILLS_ROOT, { recursive: true });
  const fixtures = [
    {
      slug: 'office-hours',
      desc: 'Brainstorming new ideas, validating whether something is worth building.',
    },
    {
      slug: 'investigate',
      desc: 'Root-cause debugging without proposing a fix until the cause is known.',
    },
    {
      slug: 'design-review',
      desc: 'Visual QA audit of a frontend with iterative polish fixes.',
    },
    {
      slug: 'codex',
      desc: 'Cross-model adversarial code review for plans and diffs.',
    },
    {
      slug: 'qa',
      desc: 'Browser QA testing with Playwright and an auto-fix loop.',
    },
  ];
  for (const f of fixtures) {
    const dir = resolve(SKILLS_ROOT, f.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'SKILL.md'),
      `---\nname: ${f.slug}\ndescription: ${f.desc}\n---\n\nUse this skill for the matching task.\n`,
    );
  }
}

// Two fixture tools so the corpus has 'tool' rows, not just skills/prompts.
async function plantTools(storage: SqliteStorage, embedder: OllamaEmbedder): Promise<void> {
  const tools: ToolSpecV2[] = [
    {
      name: 'pdf-extractor',
      version: '1.0',
      author_agent_id: 'smoke',
      capability_text:
        'Extracts tables from PDF financial reports. Returns rows of cells. Works on 10-K, 10-Q, annual reports.',
      input_contract: { type: 'object', properties: { url: { type: 'string' } } },
      output_contract: { type: 'object', properties: { rows: { type: 'array' } } },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'catalog-only-stub',
      metadata: { cost_per_call_usd: 0.005, p95_latency_ms: 1500, reliability_score: 0.95 },
      status: 'active',
      domain: 'docs',
    },
    {
      name: 'js-bug-linter',
      version: '1.0',
      author_agent_id: 'smoke',
      capability_text:
        'Reviews JavaScript code for common bugs: missing null checks, unhandled errors, race conditions.',
      input_contract: { type: 'object', properties: { code: { type: 'string' } } },
      output_contract: { type: 'object', properties: { issues: { type: 'array' } } },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'catalog-only-stub',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 800, reliability_score: 0.95 },
      status: 'active',
      domain: 'code',
    },
    {
      name: 'grant-application-fetcher',
      version: '1.0',
      author_agent_id: 'smoke',
      capability_text:
        'Fetches UK research grant programmes (Innovate UK, DASA, ARIA) by topic and eligibility. Returns open calls, deadlines, funding amounts. Useful for writing grant applications.',
      input_contract: { type: 'object', properties: { topic: { type: 'string' } } },
      output_contract: { type: 'object', properties: { grants: { type: 'array' } } },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'catalog-only-stub',
      metadata: { cost_per_call_usd: 0, p95_latency_ms: 1200, reliability_score: 0.95 },
      status: 'active',
      domain: 'grants',
    },
  ];
  for (const spec of tools) {
    const v = await embedder.embed(spec.capability_text, 'document');
    await storage.upsertTool(spec, v);
  }
}

async function probeOllama(): Promise<boolean> {
  try {
    const e = new OllamaEmbedder();
    await e.embed('warmup', 'query');
    return true;
  } catch {
    return false;
  }
}

const QUERIES = [
  'help me write a grant for an AI memory project',
  'review my code for bugs',
  'extract tables from a PDF',
];

async function main() {
  console.log(`mixed-kind smoke: db=${DB_PATH}`);

  const ok = await probeOllama();
  if (!ok) {
    console.error('FAIL: Ollama unreachable. Install Ollama + `ollama pull nomic-embed-text`.');
    process.exit(1);
  }

  plantSkills();

  const storage = new SqliteStorage({ path: DB_PATH });
  await storage.init();
  const embedder = new OllamaEmbedder({ concurrency: 4 });

  const skillRes = await importSkills(storage, embedder, { root: SKILLS_ROOT });
  console.log(`  imported skills:  ${skillRes.skills_imported}`);

  const promptRes = await importPrompts(storage, embedder);
  console.log(`  imported prompts: ${promptRes.prompts_imported}`);

  await plantTools(storage, embedder);
  console.log(`  imported tools:   3`);

  let pass = 0;
  let fail = 0;
  for (const q of QUERIES) {
    const r = await discover(storage, embedder, q, 5);
    const kinds = r.results.map((x) => x.tool_kind);
    const hasSkillOrPrompt = kinds.some((k) => k === 'skill' || k === 'prompt');
    const hasTool = kinds.some((k) => k === 'tool');
    const ok = hasSkillOrPrompt && hasTool;
    if (ok) pass++;
    else fail++;
    console.log(`\n  query: "${q}"`);
    for (const x of r.results) {
      console.log(`    [${x.tool_kind}] ${x.name}@${x.version}  rrf=${x.rrf_score.toFixed(3)}  vec=${x.vec_score.toFixed(3)}`);
    }
    console.log(`    -> ${ok ? 'PASS' : 'FAIL'} (need >=1 skill|prompt AND >=1 tool)`);
  }

  await storage.close();
  rmSync(TMPDIR, { recursive: true, force: true });

  console.log(`\nmixed-kind smoke: ${pass}/${QUERIES.length} passed`);
  if (fail > 0) {
    console.error('FAIL: some queries did not surface mixed-kind top-5');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
