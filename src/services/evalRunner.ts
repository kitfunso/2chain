import type { CaseFixture } from '../fixtures/cases.js';
import { casesForDomain, STUB_DOMAIN } from '../fixtures/cases.js';
import { callStub } from './stubs.js';
import { grade } from './graders.js';
import type { EvalCaseResult } from '../types.js';

export interface EvalRunResult {
  cases: EvalCaseResult[];
  pass_count: number;
  total_count: number;
  pass_rate: number;
  duration_ms: number;
}

export interface EvalRunInput {
  endpoint_stub_name: string;
  cost_per_call_usd: number;
  malformed_bot_lenient_override?: boolean;  // for malformed-bot eval (Fix 11)
}

export const EVAL_CASE_TIMEOUT_MS = 5000;

export async function runEvals(input: EvalRunInput): Promise<EvalRunResult> {
  const tStart = Date.now();
  const domain = STUB_DOMAIN[input.endpoint_stub_name];
  if (!domain) {
    return {
      cases: [],
      pass_count: 0,
      total_count: 0,
      pass_rate: 0,
      duration_ms: Date.now() - tStart,
    };
  }

  const cases: CaseFixture[] = casesForDomain(domain);
  const results: EvalCaseResult[] = [];

  for (const c of cases) {
    const t0 = Date.now();
    let pass = false;
    let error: string | undefined;
    try {
      const output = await Promise.race([
        Promise.resolve(callStub(input.endpoint_stub_name, c.input, c.case_id)),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`timeout > ${EVAL_CASE_TIMEOUT_MS}ms`)), EVAL_CASE_TIMEOUT_MS)
        ),
      ]);
      const graderSpec = input.malformed_bot_lenient_override
        ? { type: 'malformed_bot_lenient' as const }
        : c.grader;
      const r = grade(output, graderSpec);
      pass = r.pass;
      error = r.error;
    } catch (e) {
      error = (e as Error).message;
    }
    results.push({
      case_id: c.case_id,
      pass,
      error,
      latency_ms: Date.now() - t0,
      cost_usd: input.cost_per_call_usd,
    });
  }

  const passCount = results.filter((r) => r.pass).length;
  return {
    cases: results,
    pass_count: passCount,
    total_count: results.length,
    pass_rate: results.length > 0 ? passCount / results.length : 0,
    duration_ms: Date.now() - tStart,
  };
}
