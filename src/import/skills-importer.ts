// Skills importer — turns Claude Code skills (SKILL.md frontmatter + body)
// into 2chain ToolSpecV2 rows with tool_kind='skill'.
//
// Pipeline:
//   scan <root>/*/SKILL.md or <root>/SKILL.md
//     -> parse YAML frontmatter (name + description)
//     -> build capability_text from name + description + body excerpt
//     -> embed
//     -> upsert with endpoint_stub_name='catalog-only-stub'
//
// Skills are discovery-only — calling one means loading it into agent context,
// not RPC. No bridge stub. Reliability gate is bypassed at retrieval time
// only when the caller filters by tool_kind='skill'; storage runRRF still
// enforces the gate, so we ship skills with reliability_score=0.95 and
// status='active' so they pass through.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { Embedder, Storage, ToolSpecV2 } from '../types.js';

const NAMESPACE = 'default';
const DEFAULT_AUTHOR = 'skill-import';
const BODY_EXCERPT_CHARS = 600;

export interface ParsedSkill {
  /** Skill directory name (e.g. "office-hours"). Used as 2chain tool name. */
  slug: string;
  /** Frontmatter `name` field (falls back to slug if missing). */
  name: string;
  /** Frontmatter `description` field. */
  description: string;
  /** First N chars of body after frontmatter. */
  bodyExcerpt: string;
  /** Absolute path to the SKILL.md that produced this entry. */
  sourcePath: string;
}

/**
 * Parse a SKILL.md into name/description/body. Frontmatter is the standard
 * `--- key: value ---` block at the file head. We don't pull a YAML dep —
 * skills only use simple key: value pairs at the top level.
 */
export function parseSkillFile(text: string, slug: string, sourcePath: string): ParsedSkill | null {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) return null;
  const fm = match[1];
  const body = match[2];

  const get = (key: string): string | undefined => {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm');
    const m = fm.match(re);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
  };

  const description = get('description') ?? '';
  if (!description) return null; // require a description — no point indexing without one

  const bodyExcerpt = body
    .replace(/^#+\s.*$/gm, '')           // drop heading lines
    .replace(/```[\s\S]*?```/g, '')      // drop fenced code blocks
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BODY_EXCERPT_CHARS);

  return {
    slug,
    name: get('name') ?? slug,
    description,
    bodyExcerpt,
    sourcePath,
  };
}

/**
 * Discover SKILL.md files under root. Two layouts supported:
 *   <root>/<slug>/SKILL.md  (Anthropic standard, ~/.claude/skills/)
 *   <root>/SKILL.md         (single-skill root, used in tests)
 */
export function findSkillFiles(root: string): Array<{ slug: string; path: string }> {
  const out: Array<{ slug: string; path: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }

  // Single-skill layout
  if (entries.includes('SKILL.md')) {
    out.push({ slug: basename(root), path: resolve(root, 'SKILL.md') });
    return out;
  }

  // Multi-skill layout (the common case)
  for (const entry of entries) {
    const sub = resolve(root, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(sub);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillPath = resolve(sub, 'SKILL.md');
    try {
      statSync(skillPath);
    } catch {
      continue;
    }
    out.push({ slug: entry, path: skillPath });
  }
  return out;
}

function specFromSkill(parsed: ParsedSkill): ToolSpecV2 {
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
    domain: 'skills',
    tool_kind: 'skill',
  };
}

export interface SkillImportOptions {
  /** Root directory to scan. Defaults to $HOME/.claude/skills. */
  root?: string;
  /** Restrict to specific skill slugs. */
  only?: string[];
  /** Skip embedder calls; useful for dry-run + tests. */
  skipEmbedding?: boolean;
  /** Minimum number of skills required; throws if found < min. Default 0. */
  minImports?: number;
}

export interface SkillImportResult {
  skills_found: number;
  skills_imported: number;
  skills_skipped: number;
  errors: Array<{ slug: string; error: string }>;
  duration_ms: number;
}

export async function importSkills(
  storage: Storage,
  embedder: Embedder,
  opts: SkillImportOptions = {},
): Promise<SkillImportResult> {
  const t0 = Date.now();
  const root = opts.root ?? defaultSkillsRoot();
  const result: SkillImportResult = {
    skills_found: 0,
    skills_imported: 0,
    skills_skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  const files = findSkillFiles(root).filter((f) =>
    opts.only ? opts.only.includes(f.slug) : true,
  );
  result.skills_found = files.length;

  if (files.length < (opts.minImports ?? 0)) {
    throw new Error(
      `skills importer: found ${files.length} skills under ${root}, expected >= ${opts.minImports}. ` +
        `Run claude-code skill setup or pass --root <dir>.`,
    );
  }

  const parsed: ParsedSkill[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(f.path, 'utf-8');
      const p = parseSkillFile(text, f.slug, f.path);
      if (!p) {
        result.skills_skipped++;
        continue;
      }
      parsed.push(p);
    } catch (e) {
      result.errors.push({ slug: f.slug, error: (e as Error).message });
      result.skills_skipped++;
    }
  }

  const specs = parsed.map(specFromSkill);
  const embeddings = opts.skipEmbedding
    ? specs.map(() => new Float32Array(768))
    : await embedder.embedBatch(
        specs.map((s) => s.capability_text),
        'document',
      );

  for (let i = 0; i < specs.length; i++) {
    try {
      await storage.upsertTool(specs[i], embeddings[i], NAMESPACE);
      result.skills_imported++;
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

function defaultSkillsRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return resolve(home, '.claude/skills');
}
