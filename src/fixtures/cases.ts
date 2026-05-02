export type CapabilityDomain = 'pdf-extraction' | 'summarisation' | 'code-review';

export interface CaseFixture {
  case_id: string;
  capability_domain: CapabilityDomain;
  input: Record<string, unknown>;
  grader: GraderSpec;
  expected?: unknown;
}

export type GraderSpec =
  | { type: 'numeric_tolerance'; epsilon: number; match_on: 'label'; expected: { rows: Array<{ label: string; value: number }> } }
  | { type: 'regex'; pattern: string; flags?: string; on_field: string }
  | { type: 'length_min'; min: number; on_field: string }
  | { type: 'length_max'; max: number; on_field: string }
  | { type: 'json_schema_array_field'; field: string; min_length?: number; require_int_field?: string; require_nonempty_string_field?: string; require_exactly_empty?: boolean }
  | { type: 'malformed_bot_lenient'; field?: string };

export const PDF_CASES: CaseFixture[] = [
  {
    case_id: 'financial-numbers',
    capability_domain: 'pdf-extraction',
    input: { pdf_text: 'Q3 Earnings\n\nRevenue: $1,234.56\nCost of goods: $789.01\nGross margin: $445.55\nOperating expenses: $200.10\nNet income: $245.45' },
    grader: {
      type: 'numeric_tolerance',
      epsilon: 0.001,
      match_on: 'label',
      expected: {
        rows: [
          { label: 'Revenue', value: 1234.56 },
          { label: 'Cost of goods', value: 789.01 },
          { label: 'Gross margin', value: 445.55 },
          { label: 'Operating expenses', value: 200.10 },
          { label: 'Net income', value: 245.45 },
        ],
      },
    },
  },
  {
    case_id: 'single-row',
    capability_domain: 'pdf-extraction',
    input: { pdf_text: 'Total: 42.0' },
    grader: { type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected: { rows: [{ label: 'Total', value: 42.0 }] } },
  },
  {
    case_id: 'negative-number',
    capability_domain: 'pdf-extraction',
    input: { pdf_text: 'Loss: -123.45' },
    grader: { type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected: { rows: [{ label: 'Loss', value: -123.45 }] } },
  },
  {
    case_id: 'multi-page-text',
    capability_domain: 'pdf-extraction',
    input: { pdf_text: 'Page 1\n\n--PAGE BREAK--\n\nPage 2: Total $50' },
    grader: { type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected: { rows: [{ label: 'Total', value: 50.0 }] } },
  },
  {
    case_id: 'currency-symbol-strip',
    capability_domain: 'pdf-extraction',
    input: { pdf_text: 'Revenue: €1000.00' },
    grader: { type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected: { rows: [{ label: 'Revenue', value: 1000.0 }] } },
  },
];

export const SUMMARISATION_CASES: CaseFixture[] = [
  {
    case_id: 'single-paragraph',
    capability_domain: 'summarisation',
    input: { text: 'A long passage about the formation of stars and gravitational collapse in nebulae over millions of years.' },
    grader: { type: 'regex', pattern: '\\bthe (text|article|passage|document) (says|claims|states|argues|describes)', flags: 'i', on_field: 'summary' },
  },
  {
    case_id: 'min-length',
    capability_domain: 'summarisation',
    input: { text: 'Some article about climate change ecosystems and biodiversity loss in the Amazon rainforest.' },
    grader: { type: 'length_min', min: 30, on_field: 'summary' },
  },
  {
    case_id: 'max-length',
    capability_domain: 'summarisation',
    input: { text: 'A short news headline about an election.' },
    grader: { type: 'length_max', max: 280, on_field: 'summary' },
  },
  {
    case_id: 'contains-key-term',
    capability_domain: 'summarisation',
    input: { text: 'A textbook chapter explaining quantum mechanics, wave functions, and the uncertainty principle.' },
    grader: { type: 'regex', pattern: 'quantum', flags: 'i', on_field: 'summary' },
  },
  {
    case_id: 'non-empty',
    capability_domain: 'summarisation',
    input: { text: 'Any input text whatsoever.' },
    grader: { type: 'regex', pattern: '.+', flags: '', on_field: 'summary' },
  },
];

export const CODE_REVIEW_CASES: CaseFixture[] = [
  {
    case_id: 'array-of-issues',
    capability_domain: 'code-review',
    input: { code: 'function f() { var x = null; x.foo(); }' },
    grader: { type: 'json_schema_array_field', field: 'issues' },
  },
  {
    case_id: 'at-least-one-issue',
    capability_domain: 'code-review',
    input: { code: 'function buggy() { undefinedVar.callMe(); var unused = 42; eval("dangerous"); }' },
    grader: { type: 'json_schema_array_field', field: 'issues', min_length: 1 },
  },
  {
    case_id: 'valid-line-numbers',
    capability_domain: 'code-review',
    input: { code: 'function f() { var x = null; x.foo(); }' },
    grader: { type: 'json_schema_array_field', field: 'issues', require_int_field: 'line' },
  },
  {
    case_id: 'string-comments',
    capability_domain: 'code-review',
    input: { code: 'function f() { var x = null; x.foo(); }' },
    grader: { type: 'json_schema_array_field', field: 'issues', require_nonempty_string_field: 'comment' },
  },
  {
    case_id: 'clean-code-empty',
    capability_domain: 'code-review',
    input: { code: 'const x = 1; export default x;' },
    grader: { type: 'json_schema_array_field', field: 'issues', require_exactly_empty: true },
  },
];

export const ALL_CASES: CaseFixture[] = [...PDF_CASES, ...SUMMARISATION_CASES, ...CODE_REVIEW_CASES];

export function casesForDomain(domain: CapabilityDomain): CaseFixture[] {
  return ALL_CASES.filter((c) => c.capability_domain === domain);
}

// Map endpoint_stub_name -> capability_domain so the eval runner can resolve cases.
export const STUB_DOMAIN: Record<string, CapabilityDomain> = {
  'pdf-extractor-v3': 'pdf-extraction',
  'pdf-extractor-v3-1': 'pdf-extraction',
  'pdftools-pro-v2': 'pdf-extraction',
  'summariser-mini-v1': 'summarisation',
  'code-review-mini-v1': 'code-review',
  'malformed-bot-v1': 'code-review',
};
