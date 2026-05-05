import { fetchIncomeStatement, knownTickers } from '../tools/secEdgar.js';
import { searchArxiv } from '../tools/arxivSearch.js';
import { searchGithubRepos, searchNpm, searchWikipedia } from '../tools/webSearch.js';

// Stubs receive (input, caseId, ctx) where ctx exposes the calling tool's
// name + version. Bridges (e.g. mcp-bridge) use ctx.tool_name to derive
// per-tool routing without forcing callers to wrap args in an envelope.
export interface StubContext {
  tool_name: string;
  tool_version: string;
}
type StubFn = (input: Record<string, unknown>, caseId?: string, ctx?: StubContext) => unknown;

const REGISTRY = new Map<string, StubFn>();

export function registerStub(name: string, fn: StubFn): void {
  REGISTRY.set(name, fn);
}

export function getStub(name: string): StubFn | undefined {
  return REGISTRY.get(name);
}

export function callStub(
  name: string,
  input: Record<string, unknown>,
  caseId?: string,
  ctx?: StubContext,
): unknown {
  const fn = REGISTRY.get(name);
  if (!fn) throw new Error(`unknown stub: ${name}`);
  return fn(input, caseId, ctx);
}

// =====================================================================
// catalog-only-stub — placeholder for tools imported from external
// directories (MCP registry, public APIs list, etc.) that have a real
// spec but no first-party stub yet.
//
// Per CLAUDE.md rule 12, v2 ships only first-party stubs. Imported tool
// specs are SEARCHABLE so users can find them, but /call returns a clear
// "spec only" error pointing at how to add a stub. This is the catalog
// equivalent of a 501.
// =====================================================================
registerStub('catalog-only-stub', (_input, _caseId) => {
  // Returns a structured payload that EVERY ajv contract will fail validation
  // on (most contracts don't allow this exact shape), so /call ends up
  // logging a violation. This is intentional — the catalog tool is a stub.
  return {
    __catalog_only: true,
    message:
      'This tool is a spec-only catalog entry. To make it callable, add a ' +
      'first-party stub under src/tools/ and register it in stubs.ts. See ' +
      'CLAUDE.md rule 12 for the trust-boundary rationale.',
  };
});

// =====================================================================
// prompt-template-stub — first-party stub for tool_kind='prompt' rows.
// Looks up the template from the in-memory registry (populated by
// importPrompts via setPromptTemplate) and substitutes {{var}}.
// Lives in stubs.ts so it registers at module load — /push validates
// the stub name independently of whether importPrompts has run yet.
// =====================================================================
const PROMPT_TEMPLATES = new Map<string, string>();

export function setPromptTemplate(toolName: string, template: string): void {
  PROMPT_TEMPLATES.set(toolName, template);
}

export function getPromptTemplate(toolName: string): string | undefined {
  return PROMPT_TEMPLATES.get(toolName);
}

export function _resetPromptTemplatesForTests(): void {
  PROMPT_TEMPLATES.clear();
}

registerStub('prompt-template-stub', (input, _caseId, ctx) => {
  if (!ctx?.tool_name) {
    throw new Error('prompt-template-stub: missing tool ctx (call.ts must pass it)');
  }
  const template = PROMPT_TEMPLATES.get(ctx.tool_name);
  if (!template) {
    throw new Error(
      `prompt-template-stub: no template registered for "${ctx.tool_name}". Did the importer run?`,
    );
  }
  const rawVars = (input as { vars?: unknown }).vars;
  const vars: Record<string, unknown> =
    rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)
      ? (rawVars as Record<string, unknown>)
      : {};
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return `{{${key}}}`;
    const v = vars[key];
    // Only substitute strings. Non-string values render as the literal
    // placeholder so callers see the type mismatch instead of a lossy
    // String(value) coercion ("[object Object]", "null", etc.).
    return typeof v === 'string' ? v : `{{${key}}}`;
  });
  return { rendered };
});

// =====================================================================
// sec-edgar-financials v1.0 — REAL fetch from SEC EDGAR XBRL API.
// No baked numbers. Hits data.sec.gov, parses companyfacts JSON,
// returns the latest annual 10-K income statement. Latency ~500-1500ms.
// =====================================================================
// =====================================================================
// arxiv-paper-search v1.0 — REAL search against export.arxiv.org public API.
// Returns top-N matching papers with title, authors, abstract, and arxiv ID.
// No baked content. Network round-trip ~400-1500ms.
// =====================================================================
registerStub('arxiv-paper-search-v1', async (input) => {
  const query = String((input as { query?: string })?.query ?? '').trim();
  const limit = Number((input as { limit?: number })?.limit ?? 3);
  if (!query) throw new Error('query is required');
  return await searchArxiv(query, limit);
});

registerStub('sec-edgar-financials-v1', async (input) => {
  const tk = String((input as { ticker?: string })?.ticker ?? '').trim().toUpperCase();
  if (!tk) {
    throw new Error('ticker is required');
  }
  try {
    return await fetchIncomeStatement(tk);
  } catch (err) {
    const msg = (err as Error).message;
    // Surface a known-ticker hint so demos don't dead-end on a typo.
    throw new Error(`${msg}. Known tickers include: ${knownTickers().slice(0, 12).join(', ')}`);
  }
});

// =====================================================================
// github-search v1.0 — REAL search via api.github.com/search/repositories.
// Sorts by stars desc. Returns top-N matches with description, stars, repo URL.
// Authed (GITHUB_TOKEN env) gets 5000 req/hr; unauth gets 60.
// =====================================================================
registerStub('github-search-v1', async (input) => {
  const query = String((input as { query?: string })?.query ?? '').trim();
  const limit = Number((input as { limit?: number })?.limit ?? 10);
  if (!query) throw new Error('query is required');
  return await searchGithubRepos(query, limit);
});

// =====================================================================
// npm-search v1.0 — REAL search via registry.npmjs.org/-/v1/search.
// Returns top-N packages by relevance with description and npm URL.
// =====================================================================
registerStub('npm-search-v1', async (input) => {
  const query = String((input as { query?: string })?.query ?? '').trim();
  const limit = Number((input as { limit?: number })?.limit ?? 10);
  if (!query) throw new Error('query is required');
  return await searchNpm(query, limit);
});

// =====================================================================
// wikipedia-search v1.0 — REAL search via en.wikipedia.org opensearch API.
// Returns top-N article titles + descriptions + URLs. No API key needed.
// =====================================================================
registerStub('wikipedia-search-v1', async (input) => {
  const query = String((input as { query?: string })?.query ?? '').trim();
  const limit = Number((input as { limit?: number })?.limit ?? 10);
  if (!query) throw new Error('query is required');
  return await searchWikipedia(query, limit);
});

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
registerStub('pdf-extractor-v3', (input, caseId) => {
  if (caseId && caseId in PDF_V3_CORRECT) return PDF_V3_CORRECT[caseId];
  // Flexible parser for real 10-K paste. Handles:
  //   "Label: $1,234.56"             (colon-separated)
  //   "Label .......... $ 1,234"     (dotted leaders, common in PDF text)
  //   "Label                $ 1,234" (whitespace-aligned columns)
  //   "Label  1,234  5,678"          (multi-column tables — takes first value)
  //   Negative values in parens: "(123)" → -123
  const text = (input as { pdf_text?: string })?.pdf_text ?? '';
  const rows = text.split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.replace(/\.{2,}/g, '  ').trim();  // collapse dotted leaders
    if (!line) return [];
    // Pattern A: "Label: ..."
    let m = line.match(/^([A-Za-z][A-Za-z\s,\-\(\)&\.]+?):\s*[$£€¥]?\s*([\(\-]?[\d,]+(?:\.\d+)?\)?)/);
    // Pattern B: "Label  ...  number" (≥2 spaces or tab between label and number)
    if (!m) m = line.match(/^([A-Za-z][A-Za-z\s,\-\(\)&]+?)\s{2,}[$£€¥]?\s*([\(\-]?[\d,]+(?:\.\d+)?\)?)/);
    if (!m) return [];
    const label = m[1].trim();
    if (label.length < 3) return [];  // avoid garbage matches
    let valStr = m[2];
    let neg = false;
    if (valStr.startsWith('(') && valStr.endsWith(')')) { neg = true; valStr = valStr.slice(1, -1); }
    const value = parseFloat(valStr.replace(/,/g, ''));
    if (Number.isNaN(value)) return [];
    return [{ label, value: neg ? -value : value }];
  });
  return { rows };
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
registerStub('pdftools-pro-v2', (input, caseId) => {
  if (caseId && caseId in PDFTOOLS_PRO_V2) return PDFTOOLS_PRO_V2[caseId];
  // Same flexible parser, but drops anything past the first --PAGE BREAK--
  const text = (input as { pdf_text?: string })?.pdf_text ?? '';
  const beforeBreak = text.split(/--PAGE BREAK--/i)[0];
  const rows = beforeBreak.split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^([A-Za-z][A-Za-z\s\-]+?):\s*[$£€¥]?\s*(-?\d{1,3}(?:[,]\d{3})*(?:\.\d+)?|\-?\d+(?:\.\d+)?)/);
    if (!m) return [];
    return [{ label: m[1].trim(), value: parseFloat(m[2].replace(/,/g, '')) }];
  });
  return { rows };
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
  }
  // Flexible fallback: extract first sentence + a topic keyword
  const text = (input as { text?: string })?.text ?? '';
  const firstSentence = text.split(/[.!?]\s/)[0].slice(0, 180);
  const tokens = text.toLowerCase().match(/\b[a-z]{6,}\b/g) ?? [];
  const topic = tokens[0] ?? 'the topic';
  return {
    summary: `The text describes ${firstSentence ? `${firstSentence}.` : `content about ${topic}.`} The passage covers ${topic} in detail.`,
  };
});

// =====================================================================
// code-review-mini v1.0 — passes all 5 cases
// =====================================================================
registerStub('code-review-mini-v1', (input, caseId) => {
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
  }
  // Flexible fallback: scan for known smells. Hand-rolled "linter" — just enough
  // for live demo coverage. Real implementation would be ESLint/Pylint.
  const code = (input as { code?: string })?.code ?? '';
  const issues: Array<{ file: string; line: number; comment: string }> = [];
  const lines = code.split(/\r?\n/);
  const ext = /\bpython|def\s|import\s|self\./i.test(code) ? 'py' : 'js';
  const file = `submitted.${ext}`;
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (/\bvar\s/.test(line)) issues.push({ file, line: lineNo, comment: 'use of "var" — prefer let or const' });
    if (/\beval\s*\(/.test(line)) issues.push({ file, line: lineNo, comment: 'eval() is unsafe; refactor to remove' });
    if (/console\.log|print\s*\(/.test(line) && !/^\s*\/\//.test(line)) issues.push({ file, line: lineNo, comment: 'debug print left in production code' });
    if (/\.foo\(\)/.test(line) || /\.bar\(\)/.test(line)) issues.push({ file, line: lineNo, comment: 'method called on potentially null value' });
    if (/SELECT.*\+/i.test(line) || /f"SELECT/.test(line)) issues.push({ file, line: lineNo, comment: 'possible SQL injection — use parameterised query' });
    if (/password\s*=\s*["']/.test(line) || /api_key\s*=\s*["']/.test(line)) issues.push({ file, line: lineNo, comment: 'hardcoded secret — move to environment variable' });
    if (/except\s*:/i.test(line)) issues.push({ file, line: lineNo, comment: 'bare except clause — catch specific exceptions' });
  });
  return { issues };
});

// =====================================================================
// malformed-bot v1.0 — eval is intentionally lenient (Fix 11), all pass
// at eval time. But at /call time it returns prose, NOT the contracted
// {issues: [...]} shape. The runtime contract layer catches this in Beat 4.
// =====================================================================
registerStub('malformed-bot-v1', (_input, _caseId) => {
  return 'Found 3 issues: missing semicolon, unused variable, deprecated API call.';
});
