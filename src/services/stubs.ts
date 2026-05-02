type StubFn = (input: Record<string, unknown>, caseId?: string) => unknown;

const REGISTRY = new Map<string, StubFn>();

export function registerStub(name: string, fn: StubFn): void {
  REGISTRY.set(name, fn);
}

export function getStub(name: string): StubFn | undefined {
  return REGISTRY.get(name);
}

export function callStub(name: string, input: Record<string, unknown>, caseId?: string): unknown {
  const fn = REGISTRY.get(name);
  if (!fn) throw new Error(`unknown stub: ${name}`);
  return fn(input, caseId);
}

// =====================================================================
// pdf-extractor v3.0 — correct outputs, all 5 cases pass
// =====================================================================
const PDF_V3_CORRECT: Record<string, unknown> = {
  'financial-numbers': {
    rows: [
      { label: 'Revenue', value: 1234.56 },
      { label: 'Cost of goods', value: 789.01 },
      { label: 'Gross margin', value: 445.55 },
      { label: 'Operating expenses', value: 200.10 },
      { label: 'Net income', value: 245.45 },
    ],
  },
  'single-row': { rows: [{ label: 'Total', value: 42.0 }] },
  'negative-number': { rows: [{ label: 'Loss', value: -123.45 }] },
  'multi-page-text': { rows: [{ label: 'Total', value: 50.0 }] },
  'currency-symbol-strip': { rows: [{ label: 'Revenue', value: 1000.0 }] },
};
registerStub('pdf-extractor-v3', (_input, caseId) => {
  if (!caseId || !(caseId in PDF_V3_CORRECT)) return { rows: [] };
  return PDF_V3_CORRECT[caseId];
});

// =====================================================================
// pdf-extractor v3.1 — decimal-comma swap bug
// Returns wrong numeric values for non-integer cases (financial-numbers,
// negative-number, currency-symbol-strip). single-row (42.0) and
// multi-page (50.0) happen to work because they're effectively integers.
// Result: 2/5 pass = 0.4. To hit 0.6 (3/5), single-row + multi-page +
// currency-symbol-strip pass. Bug applies to financial-numbers (decimals)
// and negative-number (negative + decimal). currency-symbol-strip works
// because 1000.0 is also effectively integer.
// =====================================================================
const PDF_V3_1_BUGGY: Record<string, unknown> = {
  'financial-numbers': {
    // Bug: decimal-comma swap corrupts these
    rows: [
      { label: 'Revenue', value: 1234 },           // wrong, expected 1234.56
      { label: 'Cost of goods', value: 789 },      // wrong
      { label: 'Gross margin', value: 445 },       // wrong
      { label: 'Operating expenses', value: 200 }, // wrong
      { label: 'Net income', value: 245 },         // wrong
    ],
  },
  'single-row': { rows: [{ label: 'Total', value: 42.0 }] },           // pass — integer
  'negative-number': { rows: [{ label: 'Loss', value: -123 }] },        // wrong (lost .45)
  'multi-page-text': { rows: [{ label: 'Total', value: 50.0 }] },       // pass — integer
  'currency-symbol-strip': { rows: [{ label: 'Revenue', value: 1000.0 }] }, // pass — integer
};
registerStub('pdf-extractor-v3-1', (_input, caseId) => {
  if (!caseId || !(caseId in PDF_V3_1_BUGGY)) return { rows: [] };
  return PDF_V3_1_BUGGY[caseId];
});

// =====================================================================
// pdftools-pro v2.0 — multi-page weakness
// =====================================================================
const PDFTOOLS_PRO_V2: Record<string, unknown> = {
  'financial-numbers': PDF_V3_CORRECT['financial-numbers'],
  'single-row': PDF_V3_CORRECT['single-row'],
  'negative-number': PDF_V3_CORRECT['negative-number'],
  'multi-page-text': { rows: [] },  // FAIL: multi-page boundary lost
  'currency-symbol-strip': PDF_V3_CORRECT['currency-symbol-strip'],
};
registerStub('pdftools-pro-v2', (_input, caseId) => {
  if (!caseId || !(caseId in PDFTOOLS_PRO_V2)) return { rows: [] };
  return PDFTOOLS_PRO_V2[caseId];
});

// =====================================================================
// summariser-mini v1.0 — passes all 5 cases by including required tokens
// =====================================================================
registerStub('summariser-mini-v1', (input, caseId) => {
  switch (caseId) {
    case 'single-paragraph':
      return { summary: 'The article describes the formation of stars over millions of years through gravitational collapse in nebulae.' };
    case 'min-length':
      return { summary: 'The text describes climate change impacts on ecosystems and biodiversity loss in the Amazon rainforest region.' };
    case 'max-length':
      return { summary: 'The article describes an upcoming national election.' };
    case 'contains-key-term':
      return { summary: 'The article describes quantum mechanics, wave functions, and the uncertainty principle in physics.' };
    case 'non-empty':
      return { summary: 'The text describes the input content.' };
    default:
      return { summary: 'No summary available.' };
  }
});

// =====================================================================
// code-review-mini v1.0 — passes all 5 cases
// =====================================================================
registerStub('code-review-mini-v1', (_input, caseId) => {
  switch (caseId) {
    case 'array-of-issues':
      return { issues: [{ file: 'a.js', line: 1, comment: 'null pointer dereference at x.foo()' }] };
    case 'at-least-one-issue':
      return { issues: [
        { file: 'a.js', line: 1, comment: 'undefinedVar referenced before declaration' },
        { file: 'a.js', line: 1, comment: 'unused variable: unused' },
        { file: 'a.js', line: 1, comment: 'use of eval() is unsafe' },
      ] };
    case 'valid-line-numbers':
      return { issues: [{ file: 'a.js', line: 1, comment: 'null deref' }] };
    case 'string-comments':
      return { issues: [{ file: 'a.js', line: 1, comment: 'reads after null assignment' }] };
    case 'clean-code-empty':
      return { issues: [] };
    default:
      return { issues: [] };
  }
});

// =====================================================================
// malformed-bot v1.0 — eval is intentionally lenient (Fix 11), all pass
// at eval time. But at /call time it returns prose, NOT the contracted
// {issues: [...]} shape. The runtime contract layer catches this in Beat 4.
// =====================================================================
registerStub('malformed-bot-v1', (_input, _caseId) => {
  return 'Found 3 issues: missing semicolon, unused variable, deprecated API call.';
});
