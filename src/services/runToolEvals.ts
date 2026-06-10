// Shared eval invocation for publish (/push) and re-verification sweeps.
//
// Grader-policy parity (E1 plan, R1 must-fix 1): the malformed-bot lenient
// override (Fix 11) lives HERE, keyed on the stub name, so push and reverify
// can never diverge on grader policy. A tool's eval_runs time series must
// never mix strict and lenient grading — a reverify sweep that strict-graded
// malformed-bot would gate-drop the rule-8 demo tool.

import { runEvals, type EvalRunResult } from './evalRunner.js';

export interface ToolEvalInput {
  endpoint_stub_name: string;
  cost_per_call_usd: number;
}

export async function runToolEvals(input: ToolEvalInput): Promise<EvalRunResult> {
  return runEvals({
    endpoint_stub_name: input.endpoint_stub_name,
    cost_per_call_usd: input.cost_per_call_usd,
    malformed_bot_lenient_override: input.endpoint_stub_name === 'malformed-bot-v1',
  });
}
