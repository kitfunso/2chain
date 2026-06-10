// Verification streak — pure helper (E5). No storage, no embedder, no HTTP.
//
// Semantics pinned to E4's health surface (the parked feat/e4-health-surface
// branch computes the same streak inline in health.ts; the post-merge
// follow-up refactors health.ts onto this module — named in the backlog):
// consecutive most-recent reverify-triggered runs with pass_rate >= gate,
// counted newest-first until the first sub-gate reverify run. Runs with any
// other trigger (push / manual / scheduled) are SKIPPED, never
// streak-breaking — callers normally pre-filter via
// listEvalRunsForTool(id, STREAK_WINDOW, 'reverify') (the triggeredBy filter
// applies before the limit), so the skip here is defence in depth, not the
// primary filter.

import type { EvalRunRow } from '../types.js';

/** Streak window: computed over listEvalRunsForTool(id, 20, 'reverify') —
 *  the max observable streak is 20 by design. */
export const STREAK_WINDOW = 20;

/**
 * Count consecutive most-recent reverify-triggered runs with
 * pass_rate >= gate.
 *
 * @param runs newest-first eval runs (the order listEvalRunsForTool returns)
 * @param gate the pass bar, normally RELIABILITY_GATE (0.80)
 * @returns 0 for an empty window or a sub-gate newest reverify run
 */
export function verificationStreak(
  runs: readonly EvalRunRow[],
  gate: number,
): number {
  let streak = 0;
  for (const run of runs) {
    if (run.triggered_by !== 'reverify') continue;
    if (run.pass_rate >= gate) streak += 1;
    else break;
  }
  return streak;
}
