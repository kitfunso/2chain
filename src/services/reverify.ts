// E1 re-verification engine — re-runs the publish-time eval suite over the
// registered fleet so a tool that rots AFTER publish (upstream API change,
// stub regression, contract drift) is gate-dropped by the registry instead
// of being discovered live by a user's agent.
//
// Score semantics match publish: reliability_score = latest pass_rate.
// Decay/blend across runs is E2's concern, not E1's.
//
// THE trap this partition exists for: runEvals returns pass_rate 0 for any
// stub without a STUB_DOMAIN entry. A naive sweep would zero every scraped
// catalog tool and empty the registry through the 0.80 gate. Tools without
// an eval suite are SKIPPED — never scored, never given an empty eval run.

import type { Storage, ToolV2 } from '../types.js';
import { DEFAULT_NAMESPACE, RELIABILITY_GATE } from '../types.js';
import { STUB_DOMAIN, casesForDomain } from '../fixtures/cases.js';
import { runToolEvals } from './runToolEvals.js';

const SWEEP_LIST_LIMIT = 10_000;

export type ReverifySkipReason = 'no-eval-suite' | 'catalog-kind' | 'pending-status';

export interface ReverifySummary {
  executed: number;
  passed: number;
  failed: number;
  skipped: Array<{ name: string; version: string; reason: ReverifySkipReason }>;
  /** name@version of tools whose score crossed from >= gate to < gate. */
  gate_dropped: string[];
  /** name@version of tools whose eval or writes threw; sweep continues. */
  errored: string[];
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
  const summary: ReverifySummary = {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: [],
    gate_dropped: [],
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
      // row not yet reflected in reliability_score — self-healing under E1's
      // latest-pass_rate semantics (the next deterministic re-run converges),
      // but E2's decay/blend must either wrap these in a tx or tolerate the
      // orphan row when reading the time series.
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

      // Status is NEVER written by reverify (D34): recordEvalOutcome patches
      // ONLY reliability_score + last_eval_run atomically, so a concurrent
      // /call circuit-break (or a pending row) can never be overwritten by
      // this sweep's stale read-time snapshot. Recovery from circuit_broken
      // is E2's concern; the recorded run feeds its signal.
      await storage.recordEvalOutcome(
        tool.id,
        evalResult.pass_rate,
        new Date().toISOString(),
      );

      summary.executed += 1;
      if (evalResult.pass_rate >= RELIABILITY_GATE) {
        summary.passed += 1;
      } else {
        summary.failed += 1;
        if (previousScore >= RELIABILITY_GATE) {
          summary.gate_dropped.push(`${tool.name}@${tool.version}`);
        }
      }
    } catch {
      summary.errored.push(`${tool.name}@${tool.version}`);
    }
  }

  return summary;
}
