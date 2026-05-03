// Subagents importer — turns Claude Code subagents (single-file *.md with
// YAML frontmatter under ~/.claude/agents/) into 2chain ToolSpecV2 rows
// with tool_kind='subagent'.
//
// Subagents are discovery-only like skills: agents spawn them via the Task
// tool, the registry's job is to surface "which subagent fits this query".

import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import type { Embedder, Storage, ToolSpecV2 } from '../types.js';
import { parseSkillFile, type ParsedSkill } from './skills-importer.js';
import { applyKindEval } from '../services/applyKindEval.js';

const NAMESPACE = 'default';
const DEFAULT_AUTHOR = 'subagent-import';

/** Discover *.md files at <root>. Skip hidden files, READMEs, and symlinks. */
export function findSubagentFiles(root: string): Array<{ slug: string; path: string }> {
  const out: Array<{ slug: string; path: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (extname(entry).toLowerCase() !== '.md') continue;
    if (basename(entry, '.md').toLowerCase() === 'readme') continue;
    const full = resolve(root, entry);
    let lst: ReturnType<typeof lstatSync>;
    try {
      lst = lstatSync(full);
    } catch {
      continue;
    }
    // lstatSync doesn't follow symlinks; skip them so a malicious link in
    // ~/.claude/agents/ can't slurp arbitrary files outside the agents root.
    if (lst.isSymbolicLink()) continue;
    if (!lst.isFile()) continue;
    out.push({ slug: basename(entry, '.md'), path: full });
  }
  return out;
}

function specFromSubagent(parsed: ParsedSkill): ToolSpecV2 {
  const capability_text = [
    parsed.name,
    parsed.description,
    parsed.bodyExcerpt,
  ].filter(Boolean).join('  ');

  return {
    name: parsed.slug,
    version: '1.0',
    author_agent_id: DEFAULT_AUTHOR,
    capability_text,
    input_contract: { type: 'object', additionalProperties: true },
    output_contract: { type: 'object', additionalProperties: true },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'catalog-only-stub',
    metadata: {
      cost_per_call_usd: 0,
      p95_latency_ms: 0,
      reliability_score: 0.95,
    },
    status: 'active',
    domain: 'subagents',
    tool_kind: 'subagent',
  };
}

export interface SubagentImportOptions {
  /** Root directory to scan. Defaults to $HOME/.claude/agents. */
  root?: string;
  only?: string[];
  skipEmbedding?: boolean;
  minImports?: number;
}

export interface SubagentImportResult {
  agents_found: number;
  agents_imported: number;
  agents_skipped: number;
  errors: Array<{ slug: string; error: string }>;
  duration_ms: number;
}

export async function importSubagents(
  storage: Storage,
  embedder: Embedder,
  opts: SubagentImportOptions = {},
): Promise<SubagentImportResult> {
  const t0 = Date.now();
  const root = opts.root ?? defaultSubagentsRoot();
  const result: SubagentImportResult = {
    agents_found: 0,
    agents_imported: 0,
    agents_skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  const files = findSubagentFiles(root).filter((f) =>
    opts.only ? opts.only.includes(f.slug) : true,
  );
  result.agents_found = files.length;

  if (files.length < (opts.minImports ?? 0)) {
    throw new Error(
      `subagents importer: found ${files.length} agents under ${root}, expected >= ${opts.minImports}.`,
    );
  }

  const parsed: ParsedSkill[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(f.path, 'utf-8');
      const p = parseSkillFile(text, f.slug, f.path);
      if (!p) {
        result.agents_skipped++;
        continue;
      }
      parsed.push(p);
    } catch (e) {
      result.errors.push({ slug: f.slug, error: (e as Error).message });
      result.agents_skipped++;
    }
  }

  const specs = parsed.map(specFromSubagent);
  const embeddings = opts.skipEmbedding
    ? specs.map(() => new Float32Array(768))
    : await embedder.embedBatch(
        specs.map((s) => s.capability_text),
        'document',
      );

  for (let i = 0; i < specs.length; i++) {
    try {
      const inserted = await storage.upsertTool(specs[i], embeddings[i], NAMESPACE);
      await applyKindEval(storage, inserted);
      result.agents_imported++;
    } catch (e) {
      result.errors.push({
        slug: specs[i].name,
        error: (e as Error).message,
      });
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

function defaultSubagentsRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return resolve(home, '.claude/agents');
}
