// Per-kind eval rubric tests. Pure functions over ToolSpecV2 — no storage,
// no network. Verifies the rubric catches the failure modes that mattered
// when we found them: empty descriptions, missing domain, malformed
// templates, missing action verbs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runSkillEval,
  runSubagentEval,
  runPromptEval,
  runKindEval,
} from '../src/services/kindEvalRunner.js';
import { setPromptTemplate, _resetPromptTemplatesForTests } from '../src/services/stubs.js';
import type { ToolV2 } from '../src/types.js';

function spec(overrides: Partial<ToolV2>): ToolV2 {
  return {
    id: 'test-id',
    name: 'sample',
    version: '1.0',
    namespace_id: 'default',
    source_registry_id: null,
    author_agent_id: 'test',
    capability_text: 'A reasonably specific description of what this thing does. Use to extract structured data from arbitrary file or web sources, with reliable schemas.',
    input_contract: { type: 'object' },
    output_contract: { type: 'object' },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: 'catalog-only-stub',
    metadata: { cost_per_call_usd: 0, p95_latency_ms: 0, reliability_score: 0 },
    status: 'active',
    tool_kind: 'tool',
    domain: 'docs',
    created_at: '2026-05-03T00:00:00Z',
    updated_at: '2026-05-03T00:00:00Z',
    ...overrides,
  };
}

test('runSkillEval passes for a complete spec', () => {
  const r = runSkillEval(spec({ tool_kind: 'skill', domain: 'skills', name: 'office-hours' }));
  assert.equal(r.pass_count, r.total_count, 'all checks should pass');
  assert.ok(r.pass_rate >= 1.0);
});

test('runSkillEval fails has-body when capability_text is too short', () => {
  const r = runSkillEval(spec({ tool_kind: 'skill', domain: 'skills', capability_text: 'short' }));
  const failed = r.cases.filter((c) => !c.pass).map((c) => c.case_id);
  assert.ok(failed.includes('has-body'), `expected has-body to fail; got failures: ${failed}`);
});

test('runSkillEval fails domain-set when domain != skills', () => {
  const r = runSkillEval(spec({ tool_kind: 'skill', domain: 'docs' }));
  const failed = r.cases.filter((c) => !c.pass).map((c) => c.case_id);
  assert.ok(failed.includes('domain-set'));
});

test('runSkillEval fails has-action-verb on bland text', () => {
  const r = runSkillEval(spec({
    tool_kind: 'skill', domain: 'skills',
    capability_text: 'A skill that is a thing for things and stuff and more abstract nouns ' +
                     'without any actionable description that an agent could route on.',
  }));
  const failed = r.cases.filter((c) => !c.pass).map((c) => c.case_id);
  assert.ok(failed.includes('has-action-verb'));
});

test('runSubagentEval passes for a routable description', () => {
  const r = runSubagentEval(spec({
    tool_kind: 'subagent', domain: 'subagents',
    capability_text: 'Use this agent when you need to debug failing tests. The debugger agent inspects stack traces and proposes fixes.',
  }));
  assert.equal(r.pass_count, r.total_count);
});

test('runSubagentEval fails agent-routing-signal when description is generic', () => {
  const r = runSubagentEval(spec({
    tool_kind: 'subagent', domain: 'subagents',
    capability_text: 'A thing that does useful stuff. It can help you with various tasks. Run it when needed.',
  }));
  const failed = r.cases.filter((c) => !c.pass).map((c) => c.case_id);
  assert.ok(failed.includes('agent-routing-signal'));
});

test('runPromptEval requires a registered template + that it renders', () => {
  _resetPromptTemplatesForTests();
  // No template registered yet
  const noTemplate = runPromptEval(spec({
    tool_kind: 'prompt', domain: 'code', name: 'my-prompt',
    endpoint_stub_name: 'prompt-template-stub',
  }));
  const failed1 = noTemplate.cases.filter((c) => !c.pass).map((c) => c.case_id);
  assert.ok(failed1.includes('template-registered'));

  // Register a template, eval should now pass.
  setPromptTemplate('my-prompt', 'Hello {{name}}, welcome!');
  const withTemplate = runPromptEval(spec({
    tool_kind: 'prompt', domain: 'code', name: 'my-prompt',
    endpoint_stub_name: 'prompt-template-stub',
  }));
  assert.equal(withTemplate.pass_count, withTemplate.total_count, JSON.stringify(withTemplate.cases));
});

test('runKindEval dispatches by tool_kind', () => {
  const skillResult = runKindEval(spec({ tool_kind: 'skill', domain: 'skills' }));
  assert.ok(skillResult);
  const toolResult = runKindEval(spec({ tool_kind: 'tool' }));
  assert.equal(toolResult, null, 'tool kind uses fixture eval, not rubric');
});
