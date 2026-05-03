// Per-kind eval harness. Skills, subagents, and prompts can't reuse the
// fixture eval cases (those expect the demo stubs: pdf-extractor,
// summariser, malformed-bot...). Each non-tool kind needs its own rubric
// because the trust signal it carries is different:
//
//   skill    -> "is this discoverable?" (frontmatter complete, body informative)
//   subagent -> same shape, plus a description specific enough to route
//   prompt   -> "does the template actually work?" (registered + substitutes)
//
// All rubrics are deterministic, side-effect-free, and run in microseconds.
// Output mirrors the fixture EvalRunRow shape so push.ts and the dashboard
// don't need to special-case kind.

import type { ToolSpecV2 } from '../types.js';
import { getPromptTemplate, callStub } from './stubs.js';

export interface KindEvalCase {
  case_id: string;
  pass: boolean;
  error?: string;
  latency_ms: number;
  cost_usd: number;
}

export interface KindEvalResult {
  pass_count: number;
  total_count: number;
  pass_rate: number;
  cases: KindEvalCase[];
  duration_ms: number;
}

const MIN_DESC_CHARS = 40;
const MIN_BODY_CHARS = 100;
const MIN_NAME_CHARS = 2;

function ok(case_id: string): KindEvalCase {
  return { case_id, pass: true, latency_ms: 0, cost_usd: 0 };
}
function bad(case_id: string, error: string): KindEvalCase {
  return { case_id, pass: false, error, latency_ms: 0, cost_usd: 0 };
}

function commonChecks(spec: ToolSpecV2, expectedDomain: string): KindEvalCase[] {
  const cases: KindEvalCase[] = [];

  cases.push(
    spec.name && spec.name.length >= MIN_NAME_CHARS
      ? ok('has-name')
      : bad('has-name', `name "${spec.name}" too short (min ${MIN_NAME_CHARS} chars)`),
  );

  cases.push(
    spec.version && /^\d/.test(spec.version)
      ? ok('has-version')
      : bad('has-version', `version "${spec.version}" missing or invalid`),
  );

  // capability_text is what the embedder consumes — under-MIN_DESC means
  // retrieval will be unreliable (sparse vector, weak BM25 match).
  const capLen = (spec.capability_text ?? '').trim().length;
  cases.push(
    capLen >= MIN_DESC_CHARS
      ? ok('has-description')
      : bad('has-description', `capability_text ${capLen} chars (min ${MIN_DESC_CHARS})`),
  );

  cases.push(
    capLen >= MIN_BODY_CHARS
      ? ok('has-body')
      : bad('has-body', `capability_text ${capLen} chars (min ${MIN_BODY_CHARS} for routable signal)`),
  );

  cases.push(
    spec.domain === expectedDomain
      ? ok('domain-set')
      : bad('domain-set', `domain "${spec.domain}" expected "${expectedDomain}"`),
  );

  return cases;
}

export function runSkillEval(spec: ToolSpecV2): KindEvalResult {
  const t0 = Date.now();
  const cases = commonChecks(spec, 'skills');
  // Skill-specific: the capability_text is name + description + body excerpt;
  // a healthy skill mentions at least one verb-y action word.
  const text = (spec.capability_text ?? '').toLowerCase();
  const ACTION_WORDS = /\b(use|build|review|check|verify|create|generate|run|find|search|extract|test|debug|fix|deploy|scrape|parse)\b/;
  cases.push(
    ACTION_WORDS.test(text)
      ? ok('has-action-verb')
      : bad('has-action-verb', 'capability_text has no recognisable action verb'),
  );
  return finalise(cases, t0);
}

export function runSubagentEval(spec: ToolSpecV2): KindEvalResult {
  const t0 = Date.now();
  const cases = commonChecks(spec, 'subagents');
  // Subagent-specific: descriptions usually reference "agent" or "use this"
  // pattern. We don't enforce verbatim — just check the description is
  // specific enough to distinguish from the next subagent.
  const text = (spec.capability_text ?? '').toLowerCase();
  cases.push(
    /\b(agent|review|debug|build|design|specialist|expert)\b/.test(text)
      ? ok('agent-routing-signal')
      : bad('agent-routing-signal', 'capability_text lacks subagent role hint'),
  );
  return finalise(cases, t0);
}

/**
 * Prompt eval includes a real call into the prompt-template-stub to verify
 * substitution actually works. Catches templates that registered but have
 * malformed `{{var}}` placeholders, or seeds whose template wasn't loaded
 * (PROMPT_TEMPLATES Map miss).
 */
export function runPromptEval(spec: ToolSpecV2): KindEvalResult {
  const t0 = Date.now();
  const cases: KindEvalCase[] = commonChecks(spec, spec.domain ?? '');

  // Domain-set check is naturally permissive for prompts (many domains are
  // valid: code, marketing, grants, ...). Override the expected-domain miss.
  const idx = cases.findIndex((c) => c.case_id === 'domain-set');
  if (idx >= 0 && spec.domain) cases[idx] = ok('domain-set');

  // Template must be registered.
  const template = getPromptTemplate(spec.name);
  if (!template) {
    cases.push(bad('template-registered', `no template registered for "${spec.name}"`));
    return finalise(cases, t0);
  }
  cases.push(ok('template-registered'));

  // Template should actually substitute when called via the stub.
  try {
    const result = callStub(
      'prompt-template-stub',
      { vars: { __probe__: 'probe-value' } },
      undefined,
      { tool_name: spec.name, tool_version: spec.version },
    );
    const rendered = (result as { rendered?: unknown })?.rendered;
    if (typeof rendered !== 'string' || rendered.length === 0) {
      cases.push(bad('template-renders', 'stub returned non-string or empty'));
    } else {
      cases.push(ok('template-renders'));
    }
  } catch (e) {
    cases.push(bad('template-renders', (e as Error).message));
  }

  return finalise(cases, t0);
}

function finalise(cases: KindEvalCase[], t0: number): KindEvalResult {
  const pass_count = cases.filter((c) => c.pass).length;
  const total_count = cases.length;
  return {
    pass_count,
    total_count,
    pass_rate: total_count === 0 ? 0 : pass_count / total_count,
    cases,
    duration_ms: Date.now() - t0,
  };
}

export function runKindEval(spec: ToolSpecV2): KindEvalResult | null {
  switch (spec.tool_kind) {
    case 'skill':    return runSkillEval(spec);
    case 'subagent': return runSubagentEval(spec);
    case 'prompt':   return runPromptEval(spec);
    case 'tool':
    default:         return null; // tools use the existing fixture eval harness
  }
}
