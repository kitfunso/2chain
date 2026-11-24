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
