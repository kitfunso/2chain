// Prompts importer — turns curated prompt-template seeds into 2chain
// ToolSpecV2 rows with tool_kind='prompt'. Unlike skills/subagents, prompts
// are CALLABLE: agents pass `{ vars: { key: value } }` and get back
// `{ rendered: string }`. Substitution is `{{var}}` -> vars[var]; missing
// vars render as the literal `{{var}}` so callers can chain rounds.

import { registerStub, type StubContext } from '../services/stubs.js';
import type { Embedder, Storage, ToolSpecV2 } from '../types.js';
import { PROMPT_SEEDS, type PromptSeed } from './prompts-seed.js';

const NAMESPACE = 'default';
const DEFAULT_AUTHOR = 'prompt-import';
const PROMPT_STUB_NAME = 'prompt-template-stub';

// Side registry of templates, keyed by 2chain tool name. Populated at import
// time; the stub looks up by ctx.tool_name (same pattern as mcp-bridge).
const PROMPT_TEMPLATES = new Map<string, string>();

let stubRegistered = false;
function ensurePromptStub(): void {
  if (stubRegistered) return;
  registerStub(PROMPT_STUB_NAME, (input: Record<string, unknown>, _caseId, ctx?: StubContext) => {
    if (!ctx?.tool_name) {
      throw new Error('prompt-template-stub: missing tool ctx (call.ts must pass it)');
    }
    const template = PROMPT_TEMPLATES.get(ctx.tool_name);
    if (!template) {
      throw new Error(
        `prompt-template-stub: no template registered for "${ctx.tool_name}". Did the importer run?`,
      );
    }
    const vars = (input as { vars?: Record<string, string> }).vars ?? {};
    const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{{${key}}}`,
    );
    return { rendered };
  });
  stubRegistered = true;
}

/** Test-only: clear the in-memory template registry. */
export function _resetPromptRegistryForTests(): void {
  PROMPT_TEMPLATES.clear();
}

export function getRegisteredPromptTemplate(name: string): string | undefined {
  return PROMPT_TEMPLATES.get(name);
}

function specFromPrompt(seed: PromptSeed): ToolSpecV2 {
  const capability_text = `${seed.slug}  ${seed.description}  Variables: ${seed.vars.join(', ')}.`;

  return {
    name: seed.slug,
    version: '1.0',
    author_agent_id: DEFAULT_AUTHOR,
    capability_text,
    input_contract: {
      type: 'object',
      properties: {
        vars: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: `Substitution map. Known keys: ${seed.vars.join(', ')}.`,
        },
      },
      required: ['vars'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      properties: {
        rendered: { type: 'string' },
      },
      required: ['rendered'],
      additionalProperties: false,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: PROMPT_STUB_NAME,
    metadata: {
      cost_per_call_usd: 0,
      p95_latency_ms: 1,
      reliability_score: 0.95,
    },
    status: 'active',
    domain: seed.domain,
    tool_kind: 'prompt',
  };
}

export interface PromptImportOptions {
  /** Restrict to specific prompt slugs. */
  only?: string[];
  /** Override the seed source (used in tests). */
  seeds?: PromptSeed[];
  skipEmbedding?: boolean;
  minImports?: number;
}

export interface PromptImportResult {
  prompts_found: number;
  prompts_imported: number;
  errors: Array<{ slug: string; error: string }>;
  duration_ms: number;
}

export async function importPrompts(
  storage: Storage,
  embedder: Embedder,
  opts: PromptImportOptions = {},
): Promise<PromptImportResult> {
  ensurePromptStub();
  const t0 = Date.now();
  const seeds = (opts.seeds ?? PROMPT_SEEDS).filter((s) =>
    opts.only ? opts.only.includes(s.slug) : true,
  );
  const result: PromptImportResult = {
    prompts_found: seeds.length,
    prompts_imported: 0,
    errors: [],
    duration_ms: 0,
  };

  if (seeds.length < (opts.minImports ?? 0)) {
    throw new Error(
      `prompts importer: ${seeds.length} seeds found, expected >= ${opts.minImports}.`,
    );
  }

  const specs = seeds.map(specFromPrompt);
  const embeddings = opts.skipEmbedding
    ? specs.map(() => new Float32Array(768))
    : await embedder.embedBatch(
        specs.map((s) => s.capability_text),
        'document',
      );

  for (let i = 0; i < specs.length; i++) {
    try {
      await storage.upsertTool(specs[i], embeddings[i], NAMESPACE);
      PROMPT_TEMPLATES.set(specs[i].name, seeds[i].template);
      result.prompts_imported++;
    } catch (e) {
      result.errors.push({ slug: specs[i].name, error: (e as Error).message });
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}
