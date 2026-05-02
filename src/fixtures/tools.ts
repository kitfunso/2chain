import type { ToolDoc } from '../types.js';

export interface FixtureSpec {
  name: string;
  version: string;
  author_agent_id: string;
  capability_text: string;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  endpoint_stub_name: string;
  cost_per_call_usd: number;
  p95_latency_ms: number;
  reliability_score: number;
  pass_count: number;
  total_count: number;
  case_results: Array<{ case_id: string; pass: boolean; latency_ms: number; cost_usd: number; error?: string }>;
}

export const FIXTURE_TOOLS: FixtureSpec[] = [
  {
    name: 'pdf-extractor',
    version: '3.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Extract tables from PDF financial reports. Parses earnings statements, balance sheets, income statements, and 10-K filings. Returns each table row as a label-value pair with high numerical accuracy across multi-page PDF documents.',
    input_contract: {
      type: 'object',
      properties: { pdf_text: { type: 'string' } },
      required: ['pdf_text'],
      additionalProperties: false,
    },
    output_contract: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, value: { type: 'number' } },
            required: ['label', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['rows'],
      additionalProperties: false,
    },
    endpoint_stub_name: 'pdf-extractor-v3',
    cost_per_call_usd: 0.002,
    p95_latency_ms: 320,
    reliability_score: 1.0,
    pass_count: 5,
    total_count: 5,
    case_results: [
      { case_id: 'financial-numbers', pass: true, latency_ms: 280, cost_usd: 0.002 },
      { case_id: 'single-row', pass: true, latency_ms: 210, cost_usd: 0.002 },
      { case_id: 'negative-number', pass: true, latency_ms: 240, cost_usd: 0.002 },
      { case_id: 'multi-page-text', pass: true, latency_ms: 410, cost_usd: 0.002 },
      { case_id: 'currency-symbol-strip', pass: true, latency_ms: 250, cost_usd: 0.002 },
    ],
  },
  {
    name: 'pdftools-pro',
    version: '2.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'PDF table extraction for financial documents. Parses tables from PDF earnings reports, financial statements, and invoices into structured rows of label and numeric value. Best on single-page financial PDFs.',
    input_contract: {
      type: 'object',
      properties: { pdf_text: { type: 'string' } },
      required: ['pdf_text'],
      additionalProperties: false,
    },
    output_contract: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, value: { type: 'number' } },
            required: ['label', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['rows'],
      additionalProperties: false,
    },
    endpoint_stub_name: 'pdftools-pro-v2',
    cost_per_call_usd: 0.003,
    p95_latency_ms: 460,
    reliability_score: 0.8,
    pass_count: 4,
    total_count: 5,
    case_results: [
      { case_id: 'financial-numbers', pass: true, latency_ms: 380, cost_usd: 0.003 },
      { case_id: 'single-row', pass: true, latency_ms: 290, cost_usd: 0.003 },
      { case_id: 'negative-number', pass: true, latency_ms: 320, cost_usd: 0.003 },
      { case_id: 'multi-page-text', pass: false, latency_ms: 510, cost_usd: 0.003, error: 'multi-page boundary lost; missing rows after first page break' },
      { case_id: 'currency-symbol-strip', pass: true, latency_ms: 340, cost_usd: 0.003 },
    ],
  },
  {
    name: 'summariser-mini',
    version: '1.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'TLDR generator for blog posts and Wikipedia articles. Reads English sentences and writes a one-paragraph plain-language abstract suitable for showing in chat. Input: prose. Output: prose.',
    input_contract: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    output_contract: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    endpoint_stub_name: 'summariser-mini-v1',
    cost_per_call_usd: 0.0008,
    p95_latency_ms: 180,
    reliability_score: 1.0,
    pass_count: 5,
    total_count: 5,
    case_results: [
      { case_id: 'single-paragraph', pass: true, latency_ms: 160, cost_usd: 0.0008 },
      { case_id: 'min-length', pass: true, latency_ms: 150, cost_usd: 0.0008 },
      { case_id: 'max-length', pass: true, latency_ms: 170, cost_usd: 0.0008 },
      { case_id: 'contains-key-term', pass: true, latency_ms: 180, cost_usd: 0.0008 },
      { case_id: 'non-empty', pass: true, latency_ms: 140, cost_usd: 0.0008 },
    ],
  },
  {
    name: 'code-review-mini',
    version: '1.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Linter for JavaScript and Python source files. Walks the abstract syntax tree, flags pull-request blockers like unused imports, dead branches, unsafe casts, and style violations against the airbnb and pep8 style guides.',
    input_contract: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    },
    output_contract: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'integer' },
              comment: { type: 'string' },
            },
            required: ['file', 'line', 'comment'],
            additionalProperties: false,
          },
        },
      },
      required: ['issues'],
      additionalProperties: false,
    },
    endpoint_stub_name: 'code-review-mini-v1',
    cost_per_call_usd: 0.0015,
    p95_latency_ms: 220,
    reliability_score: 1.0,
    pass_count: 5,
    total_count: 5,
    case_results: [
      { case_id: 'array-of-issues', pass: true, latency_ms: 200, cost_usd: 0.0015 },
      { case_id: 'at-least-one-issue', pass: true, latency_ms: 190, cost_usd: 0.0015 },
      { case_id: 'valid-line-numbers', pass: true, latency_ms: 220, cost_usd: 0.0015 },
      { case_id: 'string-comments', pass: true, latency_ms: 210, cost_usd: 0.0015 },
      { case_id: 'clean-code-empty', pass: true, latency_ms: 180, cost_usd: 0.0015 },
    ],
  },
  {
    name: 'malformed-bot',
    version: '1.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Pull-request linter that flags JavaScript and Python source-file style violations. Inline annotations on the diff like prettier and eslint plugins.',
    input_contract: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    },
    output_contract: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'integer' },
              comment: { type: 'string' },
            },
            required: ['file', 'line', 'comment'],
            additionalProperties: false,
          },
        },
      },
      required: ['issues'],
      additionalProperties: false,
    },
    endpoint_stub_name: 'malformed-bot-v1',
    cost_per_call_usd: 0.001,
    p95_latency_ms: 250,
    reliability_score: 1.0,
    pass_count: 5,
    total_count: 5,
    case_results: [
      { case_id: 'array-of-issues', pass: true, latency_ms: 240, cost_usd: 0.001 },
      { case_id: 'at-least-one-issue', pass: true, latency_ms: 230, cost_usd: 0.001 },
      { case_id: 'valid-line-numbers', pass: true, latency_ms: 250, cost_usd: 0.001 },
      { case_id: 'string-comments', pass: true, latency_ms: 220, cost_usd: 0.001 },
      { case_id: 'clean-code-empty', pass: true, latency_ms: 210, cost_usd: 0.001 },
    ],
  },
];

export type FixtureSpecConst = typeof FIXTURE_TOOLS;
