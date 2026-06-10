// E2 reliability lifecycle — pure scoring module.
//
// No storage imports, no driver imports, no I/O: every input is passed in
// and `now` is injected, so the module is deterministic and table-testable.
// reverify.ts is the only production caller; it fetches the evidence
// (eval history, windowed usage counts, output-stage violation counts) via
// the Storage interface and hands plain data here.
//
// The blend replaces "reliability_score = latest pass_rate" (E1) with an
// evidence-weighted view: a tool that fails every other sweep can no longer
// score 1.0 the moment one run passes, and a tool with months of clean
// history no longer scores 0.0 after one bad run.
//
// Tuning constants — named exports, deliberately NOT env-configurable
// (configurability is speculative until someone needs it; change them here
// and the tests in tests/score-lifecycle.test.ts pin the consequences):
//   HALF_LIFE_DAYS        eval evidence loses half its weight every 7 days.
//   EVAL_LEG_WEIGHT/USAGE_LEG_WEIGHT  0.8/0.2 — eval suites are controlled
//                         evidence; live usage is noisier, so it nudges
//                         rather than dominates.
//   USAGE_WINDOW_DAYS     usage evidence considered for the last 7 days.
//   EVAL_HISTORY_LIMIT    runs fetched per tool for the blend; 50 daily
//                         sweeps ≈ 7 half-lives, beyond which weight < 1%.
//   RECOVERY_CONSECUTIVE_CLEAN / RECOVERY_MIN_SPAN_MINUTES  3 clean
//                         reverify runs spanning ≥ 60 minutes — three
//                         back-to-back sweeps of a deterministic suite
//                         carry the evidence of one, so the span forces
//                         evidence across time (spam-proof).

export const HALF_LIFE_DAYS = 7;
export const EVAL_LEG_WEIGHT = 0.8;
export const USAGE_LEG_WEIGHT = 0.2;
export const USAGE_WINDOW_DAYS = 7;
export const EVAL_HISTORY_LIMIT = 50;
export const RECOVERY_CONSECUTIVE_CLEAN = 3;
export const RECOVERY_MIN_SPAN_MINUTES = 60;

const MS_PER_DAY = 86_400_000;

/** One eval run, any `triggered_by` (push/manual/reverify) — the evidence
 *  line is the tool's whole eval record; only RECOVERY filters by trigger. */
export interface EvalHistoryPoint {
  pass_rate: number;
  triggered_at: string; // ISO-8601
}

/** Windowed per-tool usage evidence. Caller-fault never counts against the
 *  tool (R1 must-fix 1): the `usage` table's 'violation' outcome conflates
 *  input-stage (caller sent bad input) with output-stage (tool returned
 *  garbage), so `output_violations` is counted from the `violations` table
 *  WHERE stage='output'. Input-stage violations appear NOWHERE in the
 *  formula — malformed-input spam cannot drag a healthy tool below the
 *  gate. `circuit_broken` and `gated` usage outcomes are likewise EXCLUDED:
 *  they are consequences of scoring, not evidence; feeding them back would
 *  double-count. `timeout` is stub-side (CALL_TIMEOUT_MS), so it is
 *  tool-fault evidence. */
export interface UsageEvidence {
  ok: number;
  output_violations: number;
  timeout: number;
}

/** Subset of EvalRunRow that recovery needs. */
export interface ReverifyRunPoint {
  pass_rate: number;
  triggered_at: string; // ISO-8601
  triggered_by: string;
}

/** Exponentially-decayed eval leg: w_i = 0.5^(age_days_i / HALF_LIFE_DAYS),
 *  score = Σ(w_i · pass_rate_i) / Σ(w_i). Order-independent (a weighted
 *  mean), so callers may pass history in any order. Negative ages (clock
 *  skew) clamp to 0 so no weight exceeds 1. Returns null when there is no
 *  eval evidence. */
function decayedEvalScore(
  evalHistory: readonly EvalHistoryPoint[],
  now: Date,
): number | null {
  if (evalHistory.length === 0) return null;
  const nowMs = now.getTime();
  let weighted = 0;
  let total = 0;
  for (const run of evalHistory) {
    const parsedMs = Date.parse(run.triggered_at);
    // A NaN age would flow into the blend and then into the materialized
    // score, where NaN bypasses every gate comparison (NaN < gate is false
    // — fail-open). Skip unparseable timestamps; ignoring a corrupt row is
    // conservative.
    if (!Number.isFinite(parsedMs)) continue;
    const ageDays = Math.max(0, (nowMs - parsedMs) / MS_PER_DAY);
    const w = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    weighted += w * run.pass_rate;
    total += w;
  }
  if (total === 0) return null;
  return weighted / total;
}

/** Blended reliability score in [0, 1].
 *
 *  - Eval leg (weight 0.8): recency-decayed mean of pass_rates — a point
 *    sample becomes a history (alternating 0.6/1.0 blends strictly below
 *    all-1.0; old failures fade with a 7-day half-life).
 *  - Usage leg (weight 0.2): ok / (ok + output_violations + timeout).
 *  - Fallbacks: no usage evidence ⇒ eval leg gets weight 1.0; no eval
 *    history ⇒ usage-only; both empty ⇒ 0. */
export function blendReliability(
  evalHistory: readonly EvalHistoryPoint[],
  usage: UsageEvidence,
  now: Date,
): number {
  const evalScore = decayedEvalScore(evalHistory, now);
  const usageDenominator = usage.ok + usage.output_violations + usage.timeout;
  const usageScore = usageDenominator > 0 ? usage.ok / usageDenominator : null;

  if (evalScore === null && usageScore === null) return 0;
  if (evalScore === null) return usageScore as number;
  if (usageScore === null) return evalScore;
  return EVAL_LEG_WEIGHT * evalScore + USAGE_LEG_WEIGHT * usageScore;
}

/** True iff the tool has earned recovery from circuit_broken (D34
 *  amendment, evaluated by reverify during UNFILTERED sweeps only):
 *
 *  1. `brokenAt` is known, and ONLY runs strictly after it count — without
 *     this, a tool with a clean daily-sweep history that is live-broken by
 *     an output violation the suite does not cover recovers on the FIRST
 *     next sweep using yesterday's runs (fail-open; code-review HIGH).
 *     call.ts logs a usage outcome='circuit_broken' row at every break, so
 *     a missing break timestamp means the evidence trail is gone: fail
 *     CLOSED (an admin can setStatus manually; recovery never guesses).
 *  2. ≥ RECOVERY_CONSECUTIVE_CLEAN (3) post-break runs with
 *     triggered_by='reverify', the 3 most recent all pass_rate >= gate;
 *  3. the oldest and newest of those 3 are ≥ RECOVERY_MIN_SPAN_MINUTES (60)
 *     apart — measured oldest-to-newest WITHIN the 3 runs, so evidence
 *     must accumulate across real time.
 *
 *  Non-reverify runs (push/manual) are ignored: publish-time evals prove
 *  the suite passed once, not that the tool stays healthy in place. */
export function evaluateRecovery(
  recentReverifyRuns: readonly ReverifyRunPoint[],
  gate: number,
  brokenAt: string | null,
): boolean {
  if (brokenAt === null) return false;
  const reverifyRuns = recentReverifyRuns
    .filter((r) => r.triggered_by === 'reverify' && r.triggered_at > brokenAt)
    // ISO-8601 strings sort lexicographically; plain comparison, locale-free.
    .sort((a, b) => (a.triggered_at < b.triggered_at ? 1 : -1));
  if (reverifyRuns.length < RECOVERY_CONSECUTIVE_CLEAN) return false;

  const latest = reverifyRuns.slice(0, RECOVERY_CONSECUTIVE_CLEAN);
  if (!latest.every((r) => r.pass_rate >= gate)) return false;

  const newestMs = Date.parse(latest[0].triggered_at);
  const oldestMs = Date.parse(latest[latest.length - 1].triggered_at);
  return newestMs - oldestMs >= RECOVERY_MIN_SPAN_MINUTES * 60_000;
}
