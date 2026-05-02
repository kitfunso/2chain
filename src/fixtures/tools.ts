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
    name: 'sec-edgar-financials',
    version: '1.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Fetches the latest annual 10-K income statement directly from SEC EDGAR for any US-listed company by ticker symbol. Live data: hits data.sec.gov XBRL companyfacts API, parses revenue, cost of revenue, gross profit, operating expenses, operating income, and net income from the most recent 10-K filing. Free, no API key. Returns numbers in USD millions plus the source URL for audit. Use for DCF modelling, equity research, and any analyst workflow where you need real reported financials. Coverage: NVDA, AAPL, MSFT, GOOGL, META, TSLA, AMZN, AMD, INTC, NFLX, ADBE, CRM, ORCL, JPM, BAC and ~40 US large-caps.',
    input_contract: {
      type: 'object',
      properties: { ticker: { type: 'string' } },
      required: ['ticker'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      properties: {
        ticker: { type: 'string' },
        company: { type: 'string' },
        fiscal_year_end: { type: 'string' },
        currency: { type: 'string' },
        unit: { type: 'string' },
        income_statement: {
          type: 'object',
          properties: {
            revenue: { type: 'number' },
            cost_of_revenue: { type: 'number' },
            gross_profit: { type: 'number' },
            operating_expenses: { type: 'number' },
            operating_income: { type: 'number' },
            net_income: { type: 'number' },
          },
          required: ['revenue', 'cost_of_revenue', 'gross_profit', 'operating_expenses', 'operating_income', 'net_income'],
          additionalProperties: true,
        },
        source_url: { type: 'string' },
        fetched_at: { type: 'string' },
      },
      required: ['ticker', 'company', 'income_statement'],
      additionalProperties: true,
    },
    endpoint_stub_name: 'sec-edgar-financials-v1',
    cost_per_call_usd: 0.0,
    p95_latency_ms: 1500,
    reliability_score: 1.0,
    pass_count: 5,
    total_count: 5,
    case_results: [
      { case_id: 'nvda-revenue-positive', pass: true, latency_ms: 820, cost_usd: 0.0 },
      { case_id: 'aapl-revenue-positive', pass: true, latency_ms: 760, cost_usd: 0.0 },
      { case_id: 'msft-revenue-positive', pass: true, latency_ms: 910, cost_usd: 0.0 },
      { case_id: 'unknown-ticker-errors', pass: true, latency_ms: 40, cost_usd: 0.0 },
      { case_id: 'shape-matches-contract', pass: true, latency_ms: 870, cost_usd: 0.0 },
    ],
  },
  {
    name: 'arxiv-paper-search',
    version: '1.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Fetches and retrieves academic papers from arxiv.org by topic, keyword, author, or natural-language search query. Live data fetch: hits export.arxiv.org public API, parses the Atom XML feed, returns the top matching papers with title, authors, abstract, arxiv ID, publication date, and PDF URL. Free, no API key. Use whenever a user wants to FIND, FETCH, LOOK UP, SEARCH FOR, RETRIEVE, or DISCOVER academic papers, preprints, or research literature. Use this when the user does NOT have the paper text yet and needs to retrieve papers on a topic. Covers all 2.4M+ arxiv preprints across CS, physics, math, biology, economics. Do NOT use this for summarising paper text the user already has.',
    input_contract: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: true,
    },
    output_contract: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        total_results: { type: 'integer' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              arxiv_id: { type: 'string' },
              title: { type: 'string' },
              authors: { type: 'array', items: { type: 'string' } },
              abstract: { type: 'string' },
              published: { type: 'string' },
              url: { type: 'string' },
              pdf_url: { type: 'string' },
            },
            required: ['arxiv_id', 'title', 'authors', 'abstract'],
            additionalProperties: true,
          },
        },
        source_url: { type: 'string' },
        fetched_at: { type: 'string' },
      },
      required: ['query', 'results'],
      additionalProperties: true,
    },
    endpoint_stub_name: 'arxiv-paper-search-v1',
    cost_per_call_usd: 0.0,
    p95_latency_ms: 1200,
    reliability_score: 1.0,
    pass_count: 5,
    total_count: 5,
    case_results: [
      { case_id: 'mamba-search-returns-results', pass: true, latency_ms: 720, cost_usd: 0.0 },
      { case_id: 'transformer-search-returns-results', pass: true, latency_ms: 680, cost_usd: 0.0 },
      { case_id: 'empty-query-errors', pass: true, latency_ms: 5, cost_usd: 0.0 },
      { case_id: 'shape-matches-contract', pass: true, latency_ms: 750, cost_usd: 0.0 },
      { case_id: 'limit-respected', pass: true, latency_ms: 690, cost_usd: 0.0 },
    ],
  },
  {
    name: 'pdf-extractor',
    version: '3.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Income statement and balance sheet extractor for SEC 10-K, 10-Q, and annual report PDFs. Pulls revenue, COGS, gross profit, operating expenses, EBITDA, net income, EPS, cash flow line items. Built for equity research, DCF modelling, and financial diligence on US-listed companies.',
    input_contract: {
      type: 'object',
      properties: { pdf_text: { type: 'string' } },
      required: ['pdf_text'],
      additionalProperties: true,
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
      'General-purpose PDF table extraction for earnings reports, prospectuses, and financial statements. Single-page focus. Returns each row as label-value pair.',
    input_contract: {
      type: 'object',
      properties: { pdf_text: { type: 'string' } },
      required: ['pdf_text'],
      additionalProperties: true,
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
      additionalProperties: true,
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
      additionalProperties: true,
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
      additionalProperties: true,
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
  // ── extra fixtures (8 more tools across 3 domains) ──────────────────────
  {
    name: 'invoice-grok',
    version: '1.2',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Supplier invoice and accounts-payable document parser. Reads VAT invoices, purchase orders, and tax receipts from suppliers. Calculates VAT totals and reconciles with subtotal. Specifically for European AP workflows: HMRC, BTW, TVA. Not for SEC filings or financial statements.',
    input_contract: { type: 'object', properties: { pdf_text: { type: 'string' } }, required: ['pdf_text'], additionalProperties: true },
    output_contract: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'], additionalProperties: false } } }, required: ['rows'], additionalProperties: false },
    endpoint_stub_name: 'pdftools-pro-v2',
    cost_per_call_usd: 0.004,
    p95_latency_ms: 540,
    reliability_score: 0.8,
    pass_count: 4, total_count: 5,
    case_results: [
      { case_id: 'financial-numbers', pass: true, latency_ms: 420, cost_usd: 0.004 },
      { case_id: 'single-row', pass: true, latency_ms: 320, cost_usd: 0.004 },
      { case_id: 'negative-number', pass: true, latency_ms: 380, cost_usd: 0.004 },
      { case_id: 'multi-page-text', pass: false, latency_ms: 520, cost_usd: 0.004, error: 'multi-page boundary lost' },
      { case_id: 'currency-symbol-strip', pass: true, latency_ms: 350, cost_usd: 0.004 },
    ],
  },
  {
    name: 'slow-pdf',
    version: '0.9',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Slow but thorough PDF table extractor. Reads scanned PDFs, financial statements, and OCR text. Higher cost, higher latency, designed for batch processing.',
    input_contract: { type: 'object', properties: { pdf_text: { type: 'string' } }, required: ['pdf_text'], additionalProperties: true },
    output_contract: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'], additionalProperties: false } } }, required: ['rows'], additionalProperties: false },
    endpoint_stub_name: 'pdf-extractor-v3',
    cost_per_call_usd: 0.012,
    p95_latency_ms: 2100,
    reliability_score: 0.6,
    pass_count: 3, total_count: 5,
    case_results: [
      { case_id: 'financial-numbers', pass: true, latency_ms: 1900, cost_usd: 0.012 },
      { case_id: 'single-row', pass: true, latency_ms: 1500, cost_usd: 0.012 },
      { case_id: 'negative-number', pass: false, latency_ms: 2100, cost_usd: 0.012, error: 'OCR confused minus sign with hyphen' },
      { case_id: 'multi-page-text', pass: true, latency_ms: 2500, cost_usd: 0.012 },
      { case_id: 'currency-symbol-strip', pass: false, latency_ms: 1700, cost_usd: 0.012, error: 'kept the currency glyph' },
    ],
  },
  {
    name: 'tldr-bot',
    version: '2.1',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Wikipedia-grade text summariser. Compresses long English prose into one short paragraph. Reads articles, blog posts, news. Cheap, fast, single-paragraph output.',
    input_contract: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: true },
    output_contract: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
    endpoint_stub_name: 'summariser-mini-v1',
    cost_per_call_usd: 0.0005,
    p95_latency_ms: 130,
    reliability_score: 1.0,
    pass_count: 5, total_count: 5,
    case_results: [
      { case_id: 'single-paragraph', pass: true, latency_ms: 120, cost_usd: 0.0005 },
      { case_id: 'min-length', pass: true, latency_ms: 110, cost_usd: 0.0005 },
      { case_id: 'max-length', pass: true, latency_ms: 130, cost_usd: 0.0005 },
      { case_id: 'contains-key-term', pass: true, latency_ms: 125, cost_usd: 0.0005 },
      { case_id: 'non-empty', pass: true, latency_ms: 100, cost_usd: 0.0005 },
    ],
  },
  {
    name: 'paper-digest',
    version: '1.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Summarises the full text of an academic paper that the caller already has in hand. Input is paper prose (abstract + body); output is a one-paragraph plain-language digest covering methodology and key findings. Use when the user pastes paper text and wants a TL;DR. Do NOT use when the user wants to find, fetch, or search for papers — this only summarises text it is given.',
    input_contract: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: true },
    output_contract: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
    endpoint_stub_name: 'summariser-mini-v1',
    cost_per_call_usd: 0.002,
    p95_latency_ms: 320,
    reliability_score: 1.0,
    pass_count: 5, total_count: 5,
    case_results: [
      { case_id: 'single-paragraph', pass: true, latency_ms: 280, cost_usd: 0.002 },
      { case_id: 'min-length', pass: true, latency_ms: 290, cost_usd: 0.002 },
      { case_id: 'max-length', pass: true, latency_ms: 310, cost_usd: 0.002 },
      { case_id: 'contains-key-term', pass: true, latency_ms: 320, cost_usd: 0.002 },
      { case_id: 'non-empty', pass: true, latency_ms: 270, cost_usd: 0.002 },
    ],
  },
  {
    name: 'pylint-pro',
    version: '4.0',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Python style linter for code-quality reviews. Detects PEP-8 style issues, unused imports, mutable default arguments, and shadowing of builtins. For style and readability — not a security tool.',
    input_contract: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: true },
    output_contract: { type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, comment: { type: 'string' } }, required: ['file', 'line', 'comment'], additionalProperties: false } } }, required: ['issues'], additionalProperties: false },
    endpoint_stub_name: 'code-review-mini-v1',
    cost_per_call_usd: 0.0012,
    p95_latency_ms: 200,
    reliability_score: 1.0,
    pass_count: 5, total_count: 5,
    case_results: [
      { case_id: 'array-of-issues', pass: true, latency_ms: 180, cost_usd: 0.0012 },
      { case_id: 'at-least-one-issue', pass: true, latency_ms: 170, cost_usd: 0.0012 },
      { case_id: 'valid-line-numbers', pass: true, latency_ms: 200, cost_usd: 0.0012 },
      { case_id: 'string-comments', pass: true, latency_ms: 190, cost_usd: 0.0012 },
      { case_id: 'clean-code-empty', pass: true, latency_ms: 160, cost_usd: 0.0012 },
    ],
  },
  {
    name: 'eslint-snitch',
    version: '7.5',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'JavaScript and TypeScript linter. Walks the AST, flags bugs, type coercion smells, unused variables, console.log statements, and airbnb style violations.',
    input_contract: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: true },
    output_contract: { type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, comment: { type: 'string' } }, required: ['file', 'line', 'comment'], additionalProperties: false } } }, required: ['issues'], additionalProperties: false },
    endpoint_stub_name: 'code-review-mini-v1',
    cost_per_call_usd: 0.0008,
    p95_latency_ms: 140,
    reliability_score: 1.0,
    pass_count: 5, total_count: 5,
    case_results: [
      { case_id: 'array-of-issues', pass: true, latency_ms: 130, cost_usd: 0.0008 },
      { case_id: 'at-least-one-issue', pass: true, latency_ms: 120, cost_usd: 0.0008 },
      { case_id: 'valid-line-numbers', pass: true, latency_ms: 140, cost_usd: 0.0008 },
      { case_id: 'string-comments', pass: true, latency_ms: 135, cost_usd: 0.0008 },
      { case_id: 'clean-code-empty', pass: true, latency_ms: 110, cost_usd: 0.0008 },
    ],
  },
  {
    name: 'security-scanner',
    version: '1.5',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Security audit for Python and JavaScript source code. Specifically targets OWASP top-10 vulnerabilities: SQL injection patterns, XSS vectors, hardcoded credentials and API keys, unsafe eval and exec calls, bare except clauses that hide errors, and authentication weaknesses. Use this for pre-deploy security review, not for general code-quality linting.',
    input_contract: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: true },
    output_contract: { type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, comment: { type: 'string' } }, required: ['file', 'line', 'comment'], additionalProperties: false } } }, required: ['issues'], additionalProperties: false },
    endpoint_stub_name: 'code-review-mini-v1',
    cost_per_call_usd: 0.005,
    p95_latency_ms: 380,
    reliability_score: 1.0,
    pass_count: 5, total_count: 5,
    case_results: [
      { case_id: 'array-of-issues', pass: true, latency_ms: 350, cost_usd: 0.005 },
      { case_id: 'at-least-one-issue', pass: true, latency_ms: 340, cost_usd: 0.005 },
      { case_id: 'valid-line-numbers', pass: true, latency_ms: 380, cost_usd: 0.005 },
      { case_id: 'string-comments', pass: true, latency_ms: 370, cost_usd: 0.005 },
      { case_id: 'clean-code-empty', pass: true, latency_ms: 320, cost_usd: 0.005 },
    ],
  },
  {
    name: 'flaky-extractor',
    version: '0.5',
    author_agent_id: 'demo-tool-author',
    capability_text:
      'Experimental PDF table reader. Promising on financial statements, but inconsistent: about 1 in 4 calls returns wrong row counts. Use with caution.',
    input_contract: { type: 'object', properties: { pdf_text: { type: 'string' } }, required: ['pdf_text'], additionalProperties: true },
    output_contract: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'], additionalProperties: false } } }, required: ['rows'], additionalProperties: false },
    endpoint_stub_name: 'pdftools-pro-v2',
    cost_per_call_usd: 0.0015,
    p95_latency_ms: 280,
    reliability_score: 0.4,                                 // ← deliberately below the 0.80 gate
    pass_count: 2, total_count: 5,
    case_results: [
      { case_id: 'financial-numbers', pass: true, latency_ms: 240, cost_usd: 0.0015 },
      { case_id: 'single-row', pass: true, latency_ms: 220, cost_usd: 0.0015 },
      { case_id: 'negative-number', pass: false, latency_ms: 260, cost_usd: 0.0015, error: 'occasional sign confusion' },
      { case_id: 'multi-page-text', pass: false, latency_ms: 280, cost_usd: 0.0015, error: 'sometimes drops first page' },
      { case_id: 'currency-symbol-strip', pass: false, latency_ms: 250, cost_usd: 0.0015, error: 'inconsistent symbol handling' },
    ],
  },
];

export type FixtureSpecConst = typeof FIXTURE_TOOLS;
