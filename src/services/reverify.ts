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
  passed: number;
  failed: number;
  skipped: Array<{ name: string; version: string; reason: ReverifySkipReason }>;
  gate_dropped: string[];
  recovered: string[];
  errored: Array<{ tool: string; error: string }>;
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
    const tool = await storage.getToolByNameVersion(
      opts.toolName,
      opts.toolVersion,
      DEFAULT_NAMESPACE,
    );
    tools = tool ? [tool] : [];
  } else if (opts.toolName) {
    tools = await storage.listToolsByName(opts.toolName, DEFAULT_NAMESPACE);
  } else {
    tools = await storage.listTools({
      namespace: DEFAULT_NAMESPACE,
      limit: SWEEP_LIST_LIMIT,
    });
    summary.truncated = tools.length === SWEEP_LIST_LIMIT;
  }

  for (const tool of tools) {
    if (tool.tool_kind !== 'tool') {
      summary.skipped.push({ name: tool.name, version: tool.version, reason: 'catalog-kind' });
      continue;
    }

    if (tool.status === 'pending') {
      summary.skipped.push({ name: tool.name, version: tool.version, reason: 'pending-status' });
      continue;
    }

    const domain = STUB_DOMAIN[tool.endpoint_stub_name];
    if (!domain || casesForDomain(domain).length === 0) {
      summary.skipped.push({ name: tool.name, version: tool.version, reason: 'no-eval-suite' });
      continue;
    }

    try {
      const previousScore = tool.metadata.reliability_score;
      const evalResult = await runToolEvals({
        endpoint_stub_name: tool.endpoint_stub_name,
        cost_per_call_usd: tool.metadata.cost_per_call_usd,
      });

      await storage.insertEvalRun({
        tool_id: tool.id,
        tool_name: tool.name,
        tool_version: tool.version,
        namespace_id: tool.namespace_id,
        triggered_at: new Date().toISOString(),
        triggered_by: 'reverify',
        cases: evalResult.cases,
        pass_count: evalResult.pass_count,
        total_count: evalResult.total_count,
        pass_rate: evalResult.pass_rate,
        duration_ms: evalResult.duration_ms,
      });

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

      await storage.recordEvalOutcome(
        tool.id,
        blended,
        new Date().toISOString(),
      );

      summary.executed += 1;
      if (evalResult.pass_rate >= RELIABILITY_GATE) {
        summary.passed += 1;
      } else {
        summary.failed += 1;
      }
      if (previousScore >= RELIABILITY_GATE && blended < RELIABILITY_GATE) {
        summary.gate_dropped.push(`${tool.name}@${tool.version}`);
        console.warn(
          `[reverify] ${tool.name}@${tool.version} dropped below the reliability gate (${previousScore.toFixed(3)} -> ${blended.toFixed(3)})`,
        );
      }

      if (isUnfilteredSweep && tool.status === 'circuit_broken') {
        try {
          const brokenAt = tool.metadata.broken_at ?? null;
          const reverifyRuns = await storage.listEvalRunsForTool(tool.id, 10, 'reverify');
          if (evaluateRecovery(reverifyRuns, RELIABILITY_GATE, brokenAt)) {
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
