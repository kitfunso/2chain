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
  gate_dropped: string[];
}

export interface ReverifyOpts {
  toolName?: string;
  toolVersion?: string;
  namespace?: string;
}

export async function reverifyTools(
  storage: Storage,
  opts: ReverifyOpts = {},
): Promise<ReverifySummary> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  const summary: ReverifySummary = {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: [],
    gate_dropped: [],
  };

  let tools: ToolV2[] = await storage.listTools({ namespace, limit: SWEEP_LIST_LIMIT });
  if (opts.toolName) {
    tools = tools.filter(
      (t) =>
        t.name === opts.toolName &&
        (opts.toolVersion === undefined || t.version === opts.toolVersion),
    );
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
      // One value for ALL trigger paths (route/CLI and interval) so the
      // eval_runs time series is queryable on triggered_by = 'reverify'.
      triggered_by: 'reverify',
      cases: evalResult.cases,
      pass_count: evalResult.pass_count,
      total_count: evalResult.total_count,
      pass_rate: evalResult.pass_rate,
      duration_ms: evalResult.duration_ms,
    });

    // Status passed through VERBATIM (D34): only call.ts flips a tool to
    // circuit_broken, and recovery from circuit_broken is E2's concern.
    // A circuit_broken tool still gets its evals run and recorded (feeds
    // E2's recovery signal) but stays circuit_broken here.
    await storage.updateToolAfterEval(
      tool.id,
      {
        ...tool.metadata,
        reliability_score: evalResult.pass_rate,
        last_eval_run: new Date().toISOString(),
      },
      tool.status,
    );

    summary.executed += 1;
    if (evalResult.pass_rate >= RELIABILITY_GATE) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
      if (previousScore >= RELIABILITY_GATE) {
        summary.gate_dropped.push(tool.name);
      }
    }
  }

  return summary;
}
