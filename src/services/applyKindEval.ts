// Helper used by the kind importers (skills, subagents, prompts) to run
// the per-kind eval rubric and persist the resulting reliability_score.
// Keeps importers DRY — they all want the same "upsert + evaluate + update"
// shape but the eval rubric differs per kind.

import type { Storage, ToolV2 } from '../types.js';
import { runKindEval } from './kindEvalRunner.js';

export async function applyKindEval(storage: Storage, inserted: ToolV2): Promise<{
  reliability_score: number;
  pass_count: number;
  total_count: number;
} | null> {
  const result = runKindEval(inserted);
  if (!result) return null;

  await storage.insertEvalRun({
    tool_id: inserted.id,
    tool_name: inserted.name,
    tool_version: inserted.version,
    namespace_id: inserted.namespace_id,
    triggered_at: new Date().toISOString(),
    triggered_by: 'manual',
    cases: result.cases,
    pass_count: result.pass_count,
    total_count: result.total_count,
    pass_rate: result.pass_rate,
    duration_ms: result.duration_ms,
  });

  await storage.updateToolAfterEval(
    inserted.id,
    {
      ...inserted.metadata,
      reliability_score: result.pass_rate,
      last_eval_run: new Date().toISOString(),
    },
    'active',
  );

  return {
    reliability_score: result.pass_rate,
    pass_count: result.pass_count,
    total_count: result.total_count,
  };
}
