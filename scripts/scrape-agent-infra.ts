// Curated whitelist of personal AI assistants, agent frameworks, memory systems,
// RAG/orchestration tools. Each entry has a hand-picked domain so reclassify
// (which now skips author='agent-infra') leaves them alone.

import 'dotenv/config';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { OllamaEmbedder } from '../src/embeddings/ollama.js';
import { importScrapedSpecs } from '../src/import/scrape-import.js';
import type { ToolSpecV2, ToolKind } from '../src/types.js';

interface Repo { name: string; description: string | null; html_url: string; stargazers_count: number; pushed_at: string }

interface Entry { repo: string; name: string; domain: string; kind: ToolKind }

// Format: '<owner>/<repo>': { name (slug), domain, kind }.
// Domains are CANONICAL: ai/code/data/comms/docs/finance/research/media/devops/security/geo
const WHITELIST: Entry[] = [
  // Personal AI assistants / coding agents (the openclaw cohort)
  { repo: 'openclaw/openclaw',                name: 'openclaw',          domain: 'ai',   kind: 'tool' },
  { repo: 'cline/cline',                      name: 'cline',             domain: 'ai',   kind: 'tool' },
  { repo: 'Aider-AI/aider',                   name: 'aider',             domain: 'ai',   kind: 'tool' },
  { repo: 'continuedev/continue',             name: 'continue',          domain: 'ai',   kind: 'tool' },
  { repo: 'openai/codex',                     name: 'openai-codex',      domain: 'ai',   kind: 'tool' },
  { repo: 'opencode-ai/opencode',             name: 'opencode',          domain: 'ai',   kind: 'tool' },
  { repo: 'charmbracelet/crush',              name: 'crush',             domain: 'ai',   kind: 'tool' },
  { repo: 'block/goose',                      name: 'goose',             domain: 'ai',   kind: 'tool' },
  { repo: 'All-Hands-AI/OpenHands',           name: 'openhands',         domain: 'ai',   kind: 'tool' },
  { repo: 'frdel/agent-zero',                 name: 'agent-zero',        domain: 'ai',   kind: 'tool' },
  { repo: 'kortix-ai/suna',                   name: 'suna',              domain: 'ai',   kind: 'tool' },
  { repo: 'danielmiessler/fabric',            name: 'fabric',            domain: 'ai',   kind: 'tool' },
  { repo: 'BasedHardware/omi',                name: 'omi-wearable',      domain: 'ai',   kind: 'tool' },
  { repo: 'princeton-nlp/SWE-agent',          name: 'swe-agent',         domain: 'ai',   kind: 'tool' },

  // Agent frameworks
  { repo: 'Significant-Gravitas/AutoGPT',     name: 'autogpt',           domain: 'ai',   kind: 'tool' },
  { repo: 'yoheinakajima/babyagi',            name: 'babyagi',           domain: 'ai',   kind: 'tool' },
  { repo: 'TransformerOptimus/SuperAGI',      name: 'superagi',          domain: 'ai',   kind: 'tool' },
  { repo: 'microsoft/autogen',                name: 'autogen',           domain: 'ai',   kind: 'tool' },
  { repo: 'crewAIInc/crewAI',                 name: 'crewai',            domain: 'ai',   kind: 'tool' },
  { repo: 'microsoft/UFO',                    name: 'ufo-windows-agent', domain: 'ai',   kind: 'tool' },
  { repo: 'mervinpraison/PraisonAI',          name: 'praisonai',         domain: 'ai',   kind: 'tool' },

  // Memory systems (the hippo-memory cohort)
  { repo: 'mem0ai/mem0',                      name: 'mem0',              domain: 'ai',   kind: 'tool' },
  { repo: 'letta-ai/letta',                   name: 'letta',             domain: 'ai',   kind: 'tool' },
  { repo: 'getzep/zep',                       name: 'zep-memory',        domain: 'ai',   kind: 'tool' },
  { repo: 'topoteretes/cognee',               name: 'cognee',            domain: 'ai',   kind: 'tool' },
  { repo: 'microsoft/graphrag',               name: 'graphrag',          domain: 'ai',   kind: 'tool' },

  // RAG / orchestration / LLM frameworks
  { repo: 'run-llama/llama_index',            name: 'llama-index',       domain: 'ai',   kind: 'tool' },
  { repo: 'langchain-ai/langchain',           name: 'langchain',         domain: 'ai',   kind: 'tool' },
  { repo: 'langchain-ai/langgraph',           name: 'langgraph',         domain: 'ai',   kind: 'tool' },
  { repo: 'langgenius/dify',                  name: 'dify',              domain: 'ai',   kind: 'tool' },
  { repo: 'FlowiseAI/Flowise',                name: 'flowise',           domain: 'ai',   kind: 'tool' },
  { repo: 'n8n-io/n8n',                       name: 'n8n',               domain: 'ai',   kind: 'tool' },

  // Token / efficiency utilities (the token-discipline cohort)
  { repo: 'openai/tiktoken',                  name: 'tiktoken',          domain: 'ai',   kind: 'tool' },

  // Inference / local LLM (the ollama cohort, complementary to existing)
  { repo: 'vllm-project/vllm',                name: 'vllm',              domain: 'ai',   kind: 'tool' },
  { repo: 'ggerganov/llama.cpp',              name: 'llama-cpp',         domain: 'ai',   kind: 'tool' },
];

async function fetchRepo(slug: string): Promise<Repo | null> {
  const r = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: {
      'user-agent': '2chain-scraper/1.0',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!r.ok) return null;
  return (await r.json()) as Repo;
}

async function fetchReadme(slug: string): Promise<string> {
  try {
    const r = await fetch(`https://api.github.com/repos/${slug}/readme`, {
      headers: {
        'user-agent': '2chain-scraper/1.0',
        accept: 'application/vnd.github.v3.raw',
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (!r.ok) return '';
    const text = await r.text();
    return text.replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 800);
  } catch { return ''; }
}

const dbPath = resolve(process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`);
const storage = new SqliteStorage({ path: dbPath });
await storage.init();
const embedder = new OllamaEmbedder();

try {
  console.log(`scraping ${WHITELIST.length} curated agent-infra repos`);
  const specs: ToolSpecV2[] = [];
  for (const entry of WHITELIST) {
    const repo = await fetchRepo(entry.repo);
    if (!repo) {
      console.log(`  ! ${entry.repo}: not found, skip`);
      continue;
    }
    const readme = await fetchReadme(entry.repo);
    const desc = (repo.description || entry.name).trim();
    const cap = `${entry.name}. ${desc}. ${readme}.  Stars: ${repo.stargazers_count}. Source: ${repo.html_url}.`.slice(0, 1400);
    specs.push({
      name: entry.name,
      version: '1.0',
      author_agent_id: 'agent-infra',
      capability_text: cap,
      input_contract: { type: 'object', additionalProperties: true },
      output_contract: { type: 'object', additionalProperties: true },
      output_repair_strategy: 'fail-fast',
      endpoint_stub_name: 'catalog-only-stub',
      metadata: {
        cost_per_call_usd: 0,
        p95_latency_ms: 0,
        reliability_score: 0.92,
        github_stars: repo.stargazers_count,
        github_last_commit_at: repo.pushed_at,
        github_fetched_at: new Date().toISOString(),
      },
      status: 'active',
      domain: entry.domain,
      tool_kind: entry.kind,
    });
    console.log(`  + ${entry.name} (${repo.stargazers_count}★)`);
  }
  console.log(`\nimporting ${specs.length} agent-infra entries`);
  const out = await importScrapedSpecs(storage, embedder, specs);
  console.log(`  imported ${out.imported}  skipped(existed) ${out.skipped_existing}  errors ${out.errors.length}`);
} finally {
  await storage.close();
}
