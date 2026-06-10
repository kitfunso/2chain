// E4 tool health surface — READ-ONLY aggregator. Answers "can I trust this
// tool right now?" in one query surface instead of four manual ones (tools
// row, eval_runs history, drift_events, usage counts).
//
// Scope guard: this module performs NO writes, NO status flips, NO score
// recompute — lifecycle logic lives in E2, not here. It talks to the
// database exclusively through the Storage interface (CLAUDE.md rule 1).
//
// Every list in the report is bounded (history 20 / drift 10 / usage
// windowed 7d): an unbounded history endpoint on a hot name is a DoS
// vector (rule 11 spirit).

import {
  DEFAULT_NAMESPACE,
  RELIABILITY_GATE,
  type DriftDirection,
  type Storage,
  type ToolKind,
  type ToolStatus,
} from '../types.js';

/** score_history cap per version (newest-first). */
export const HEALTH_VERSIONS_LIMIT = 50;
export const SCORE_HISTORY_LIMIT = 20;
/** drift_events cap per report (newest-first). */
export const DRIFT_EVENTS_LIMIT = 10;
/** usage outcome counts are windowed to the last N days. */
export const USAGE_WINDOW_DAYS = 7;
/** Streak window: computed over listEvalRunsForTool(id, 20, 'reverify') —
 *  the max observable streak is 20 by design. */
export const STREAK_WINDOW = 20;

export interface HealthVersion {
  version: string;
  status: ToolStatus;
  tool_kind: ToolKind;
  reliability_score: number;
  /** Newest eval_runs.triggered_at for this version, null if never run. */
  last_eval_run: string | null;
  /** Consecutive most-recent reverify-triggered runs with
   *  pass_rate >= RELIABILITY_GATE, counted until the first sub-gate run
   *  (0 if none / none clean). Interleaved push/manual runs are FILTERED
   *  OUT by the storage query (triggeredBy applies before the limit) —
   *  they are skipped, never streak-breaking. */
  verification_streak: number;
  /** Newest-first, bounded SCORE_HISTORY_LIMIT. */
  score_history: Array<{ at: string; pass_rate: number; triggered_by: string }>;
  /** Outcome counts over the USAGE_WINDOW_DAYS window. */
  usage: Record<string, number>;
}

/** PROJECTED drift fields ONLY: changes_json is EXCLUDED — it carries
 *  contract internals and the unauthenticated dashboard view must never
 *  ship it (locked by the security test in tests/health.test.ts). */
export interface HealthDriftEvent {
  from_version: string;
  to_version: string;
  direction: DriftDirection;
  classification: 'compatible' | 'breaking';
  created_at: string;
}

export interface HealthReport {
  name: string;
  versions: HealthVersion[];
  /** ROOT-level: E3 stores drift by tool_name, not tool_id — one list per
   *  report, never duplicated per version. Bounded DRIFT_EVENTS_LIMIT,
   *  newest-first. */
  drift_events: HealthDriftEvent[];
}

/**
 * Aggregate the health report for every version of `name`.
 * Returns null for an unknown name (route maps that to a 404).
 */
export async function toolHealth(
  storage: Storage,
  name: string,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<HealthReport | null> {
  // Versions enumerated via listToolsByName (indexed exact match, no cap on
  // the LOOKUP - but the REPORT is bounded: each version costs ~3 evidence
  // queries and /health-view is unauthenticated, so an unbounded report
  // would scale per-request work with author-controlled data (1+3N).
  // Newest HEALTH_VERSIONS_LIMIT versions only; the report is for humans.
  const all = await storage.listToolsByName(name, namespace);
  const tools = [...all]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, HEALTH_VERSIONS_LIMIT);
  if (tools.length === 0) return null;

  const sinceIso = new Date(
    Date.now() - USAGE_WINDOW_DAYS * 86_400_000,
  ).toISOString();

  const versions: HealthVersion[] = [];
  for (const tool of tools) {
    const history = await storage.listEvalRunsForTool(
      tool.id,
      SCORE_HISTORY_LIMIT,
    );
    const reverifyRuns = await storage.listEvalRunsForTool(
      tool.id,
      STREAK_WINDOW,
      'reverify',
    );
    let verificationStreak = 0;
    for (const run of reverifyRuns) {
      // newest-first: count until the first sub-gate run.
      if (run.pass_rate >= RELIABILITY_GATE) verificationStreak += 1;
      else break;
    }
    const usage = await storage.usageOutcomeCountsForTool(tool.id, sinceIso);

    versions.push({
      version: tool.version,
      status: tool.status,
      tool_kind: tool.tool_kind,
      reliability_score: tool.metadata.reliability_score,
      last_eval_run: history.length > 0 ? history[0].triggered_at : null,
      verification_streak: verificationStreak,
      score_history: history.map((r) => ({
        at: r.triggered_at,
        pass_rate: r.pass_rate,
        triggered_by: r.triggered_by,
      })),
      usage,
    });
  }

  const driftRows = await storage.listDriftEvents(
    name,
    namespace,
    DRIFT_EVENTS_LIMIT,
  );

  return {
    name,
    versions,
    // Explicit projection — never spread the storage row: `changes` (the
    // parsed changes_json) must not leak into either route's payload.
    drift_events: driftRows.map((d) => ({
      from_version: d.from_version,
      to_version: d.to_version,
      direction: d.direction,
      classification: d.classification,
      created_at: d.created_at,
    })),
  };
}
