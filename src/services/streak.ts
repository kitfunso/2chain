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
