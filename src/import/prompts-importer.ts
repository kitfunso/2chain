// Prompts importer — turns curated prompt-template seeds into 2chain
// ToolSpecV2 rows with tool_kind='prompt'. Unlike skills/subagents, prompts
// are CALLABLE: agents pass `{ vars: { key: value } }` and get back
// `{ rendered: string }`. Substitution is `{{var}}` -> vars[var]; missing
// vars render as the literal `{{var}}` so callers can chain rounds.

import {
  setPromptTemplate,
  getPromptTemplate,
  _resetPromptTemplatesForTests,
} from '../services/stubs.js';
import { applyKindEval } from '../services/applyKindEval.js';
import type { Embedder, Storage, ToolSpecV2 } from '../types.js';
import { PROMPT_SEEDS, type PromptSeed } from './prompts-seed.js';

const NAMESPACE = 'default';
const DEFAULT_AUTHOR = 'prompt-import';
const PROMPT_STUB_NAME = 'prompt-template-stub';

/** Test-only: clear the in-memory template registry. */
export function _resetPromptRegistryForTests(): void {
  _resetPromptTemplatesForTests();
}

export function getRegisteredPromptTemplate(name: string): string | undefined {
  return getPromptTemplate(name);
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
      // Register the template BEFORE the eval — runPromptEval calls the
      // stub to verify substitution, which needs the template registered.
      setPromptTemplate(specs[i].name, seeds[i].template);
      const inserted = await storage.upsertTool(specs[i], embeddings[i], NAMESPACE);
      await applyKindEval(storage, inserted);
      result.prompts_imported++;
    } catch (e) {
      result.errors.push({ slug: specs[i].name, error: (e as Error).message });
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}
