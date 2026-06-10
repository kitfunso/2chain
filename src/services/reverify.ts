// E1/E2 re-verification engine — re-runs the publish-time eval suite over
// the registered fleet so a tool that rots AFTER publish (upstream API
// change, stub regression, contract drift) is gate-dropped by the registry
// instead of being discovered live by a user's agent.
//
// Score semantics (E2 — THE deliberate semantic change from E1's "latest
// pass_rate"): after each recorded run, the materialized reliability_score
// is the evidence blend from scoreLifecycle.ts — a recency-decayed eval leg
// (7-day half-life, all triggered_by values) plus a windowed usage leg in
// which caller-fault never counts (see scoreLifecycle.ts). Publish-time
// score writes are unchanged: a new version is a new tool_id, so the blend
// of one sample IS that sample.
//
// Recovery (the documented D34 amendment): during UNFILTERED sweeps only,
// a circuit_broken tool whose 3 most recent reverify-triggered runs are all
// clean and span >= 60 minutes is flipped back to active. Direction-bound:
// reverify may flip circuit_broken -> active ONLY — never the reverse, and
// never touches pending. call.ts remains the only flip TO circuit_broken.
//
// THE trap this partition exists for: runEvals returns pass_rate 0 for any
// stub without a STUB_DOMAIN entry. A naive sweep would zero every scraped
// catalog tool and empty the registry through the 0.80 gate. Tools without
// an eval suite are SKIPPED — never scored, never given an empty eval run.

import type { Storage, ToolV2 } from '../types.js';
import { DEFAULT_NAMESPACE, RELIABILITY_GATE } from '../types.js';
import { STUB_DOMAIN, casesForDomain } from '../fixtures/cases.js';
import { runToolEvals } from './runToolEvals.js';
import {
  EVAL_HISTORY_LIMIT,
  USAGE_WINDOW_DAYS,
  blendReliability,
  evaluateRecovery,
} from './scoreLifecycle.js';

const SWEEP_LIST_LIMIT = 10_000;

export type ReverifySkipReason = 'no-eval-suite' | 'catalog-kind' | 'pending-status';

export interface ReverifySummary {
  executed: number;
  /** RAW-RUN facts: this sweep's suite pass_rate vs RELIABILITY_GATE. A run
   *  can be `passed` yet the tool `gate_dropped` (clean run, history still
   *  bad), or `failed` without `gate_dropped` (blend still above gate) —
   *  both are correct evidence semantics under the blend. */
  passed: number;
  failed: number;
  skipped: Array<{ name: string; version: string; reason: ReverifySkipReason }>;
  /** name@version of tools whose MATERIALIZED score crossed the gate this
   *  sweep: previous score >= gate AND new BLENDED score < gate. */
  gate_dropped: string[];
  /** name@version of circuit-broken tools flipped back to active by
   *  evidence-based recovery (unfiltered sweeps only — D34 amendment). */
  recovered: string[];
  /** Tools whose eval or writes threw; sweep continues. `tool` is
   *  name@version, `error` is the thrown message (diagnostics, E1 debt). */
  errored: Array<{ tool: string; error: string }>;
  /** True when the sweep hit SWEEP_LIST_LIMIT — tools beyond it were NOT
   *  re-verified this run (truncation honesty: never report a capped sweep
   *  as full coverage). Always false for an exact name@version request. */
  truncated: boolean;
}

export interface ReverifyOpts {
  toolName?: string;
  toolVersion?: string;
}

/** Thrown when an unfiltered fleet sweep is requested while another is
 *  already running (route, CLI, or interval — any trigger). Filtered
 *  single-tool requests are cheap and exempt. */
export class SweepInFlightError extends Error {
  code = 'sweep_in_flight';
  constructor() {
    super('an unfiltered reverify sweep is already in flight');
  }
}

let unfilteredSweepInFlight = false;

/** True while an unfiltered fleet sweep is running. Change-watchers use this
 *  to coalesce per-tool rerank/broadcast work into one post-sweep refresh
 *  instead of reacting to every tools-table write a sweep emits. */
export function isSweepInFlight(): boolean {
  return unfilteredSweepInFlight;
}

export async function reverifyTools(
  storage: Storage,
  opts: ReverifyOpts = {},
): Promise<ReverifySummary> {
  const isUnfilteredSweep = !opts.toolName;
  if (isUnfilteredSweep) {
    if (unfilteredSweepInFlight) throw new SweepInFlightError();
    unfilteredSweepInFlight = true;
  }
  try {
    return await runSweep(storage, opts);
  } finally {
    if (isUnfilteredSweep) unfilteredSweepInFlight = false;
  }
}

async function runSweep(
  storage: Storage,
  opts: ReverifyOpts,
): Promise<ReverifySummary> {
  // Recovery is evaluated ONLY during unfiltered sweeps (admin/interval).
  // The tool_author filtered path can refresh blended scores but never
  // flips status — see registerReverifyRoute's authz rationale.
  const isUnfilteredSweep = !opts.toolName;

  const summary: ReverifySummary = {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: [],
    gate_dropped: [],
    recovered: [],
    errored: [],
    truncated: false,
  };

  let tools: ToolV2[];
  if (opts.toolName && opts.toolVersion) {
    // Exact lookup for a targeted request — never routed through the capped
    // sweep page (a tool sorting past the cap must not yield executed:0).
    const tool = await storage.getToolByNameVersion(
      opts.toolName,
      opts.toolVersion,
      DEFAULT_NAMESPACE,
    );
    tools = tool ? [tool] : [];
  } else {
    const page = await storage.listTools({
      namespace: DEFAULT_NAMESPACE,
      limit: SWEEP_LIST_LIMIT,
    });
    const pageWasFull = page.length === SWEEP_LIST_LIMIT;
    tools = opts.toolName ? page.filter((t) => t.name === opts.toolName) : page;
    // Truncation honesty AFTER filtering: an unfiltered capped sweep is
    // truncated; a name-only filter is truncated only when the name was not
    // found on a full page (it may exist past the cap).
    summary.truncated = opts.toolName
      ? pageWasFull && tools.length === 0
      : pageWasFull;
  }

  for (const tool of tools) {
    // Catalog kinds (skill/subagent/prompt) have no fixture eval suite; their
    // rubric score is publish-time only. Staleness for them is out of scope.
    if (tool.tool_kind !== 'tool') {
      summary.skipped.push({ name: tool.name, version: tool.version, reason: 'catalog-kind' });
      continue;
    }

    // A lingering pending row is an incomplete publish; the sweep must not
    // promote or score it.
    if (tool.status === 'pending') {
      summary.skipped.push({ name: tool.name, version: tool.version, reason: 'pending-status' });
      continue;
    }

    // Zero-rate trap: no STUB_DOMAIN entry (or a 0-case domain) means there is
    // no eval suite to re-run. NEVER write a score, NEVER insert an empty run.
    const domain = STUB_DOMAIN[tool.endpoint_stub_name];
    if (!domain || casesForDomain(domain).length === 0) {
      summary.skipped.push({ name: tool.name, version: tool.version, reason: 'no-eval-suite' });
      continue;
    }

    // Per-tool containment: one tool's storage/eval error must not abort the
    // rest of the fleet. Writes are idempotent, so an errored tool simply
    // converges on the next sweep.
    try {
      const previousScore = tool.metadata.reliability_score;
      const evalResult = await runToolEvals({
        endpoint_stub_name: tool.endpoint_stub_name,
        cost_per_call_usd: tool.metadata.cost_per_call_usd,
      });

      // NOTE (E2): insertEvalRun + recordEvalOutcome are sequential queue
      // writes, not one transaction. A crash between them leaves an eval_runs
      // row not yet reflected in reliability_score — and that is now
      // self-consistent BY DESIGN: the blend READS the eval_runs series, so
      // the orphan row simply influences the next computed score. No tx
      // needed; the next sweep converges.
      await storage.insertEvalRun({
        tool_id: tool.id,
        tool_name: tool.name,
        tool_version: tool.version,
        namespace_id: tool.namespace_id,
        triggered_at: new Date().toISOString(),
        // One value for ALL trigger paths (route/CLI and interval) so the
        // eval_runs time series is queryable on triggered_by = 'reverify'.
        triggered_by: 'reverify',
        cases: evalResult.cases,
        pass_count: evalResult.pass_count,
        total_count: evalResult.total_count,
        pass_rate: evalResult.pass_rate,
        duration_ms: evalResult.duration_ms,
      });

      // E2 blend: the materialized score is the evidence blend, not the raw
      // run's pass_rate. History is fetched AFTER the insert so the run just
      // recorded is part of its own evidence line. Usage evidence enters at
      // sweep cadence only — /call never recomputes (latency-critical path;
      // the rule-7 SQL gate consumes this materialized score).
      const history = await storage.listEvalRunsForTool(tool.id, EVAL_HISTORY_LIMIT);
      const sinceIso = new Date(
        Date.now() - USAGE_WINDOW_DAYS * 86_400_000,
      ).toISOString();
      const usageCounts = await storage.usageOutcomeCountsForTool(tool.id, sinceIso);
      const outputViolations = await storage.outputViolationCountForTool(tool.id, sinceIso);
      const blended = blendReliability(
        history,
        {
          ok: usageCounts.ok ?? 0,
          output_violations: outputViolations,
          timeout: usageCounts.timeout ?? 0,
        },
        new Date(),
      );

      // Status is NEVER written here (D34): recordEvalOutcome patches ONLY
      // reliability_score + last_eval_run atomically, so a concurrent /call
      // circuit-break (or a pending row) can never be overwritten by this
      // sweep's stale read-time snapshot. The ONE status write reverify may
      // make is the recovery flip below — circuit_broken -> active only.
      await storage.recordEvalOutcome(
        tool.id,
        blended,
        new Date().toISOString(),
      );

      summary.executed += 1;
      // passed/failed stay RAW-RUN facts (this suite run vs the gate);
      // gate_dropped is a BLEND crossing. The two are independent.
      if (evalResult.pass_rate >= RELIABILITY_GATE) {
        summary.passed += 1;
      } else {
        summary.failed += 1;
      }
      if (previousScore >= RELIABILITY_GATE && blended < RELIABILITY_GATE) {
        summary.gate_dropped.push(`${tool.name}@${tool.version}`);
      }

      // Recovery (D34 amendment, direction-bound): unfiltered sweeps only;
      // circuit_broken -> active iff the 3 most recent reverify-triggered
      // runs are all clean AND span >= 60 minutes (evaluateRecovery filters
      // and sorts; `history` already contains the run recorded above).
      // Recovered tools re-enter discover with the evidence-weighted blend
      // written above, not a clean slate.
      if (isUnfilteredSweep && tool.status === 'circuit_broken') {
        // Own fail-soft catch: the run above is already recorded and
        // counted; a recovery failure must neither abort remaining tools
        // nor double-count this one into `errored` (it retries next sweep).
        try {
          const brokenAt = await storage.lastCircuitBreakAt(tool.id);
          if (evaluateRecovery(history, RELIABILITY_GATE, brokenAt)) {
            await storage.setStatus(tool.id, 'active');
            summary.recovered.push(`${tool.name}@${tool.version}`);
          }
        } catch (err) {
          console.warn(
            `[reverify] recovery check failed for ${tool.name}@${tool.version} (sweep continues): ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      summary.errored.push({
        tool: `${tool.name}@${tool.version}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
