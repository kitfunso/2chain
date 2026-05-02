// Programmatically generated tool fixtures — adds ~190 tools on top of the
// 13 hand-crafted ones in tools.ts to demonstrate registry scale.
//
// Each tool has:
//   - a plausible name + version
//   - a capability_text describing a real-world agent task
//   - reliability_score uniformly distributed 0.40 .. 1.00 (so the
//     0.80 gate visibly filters about 35% of candidates)
//   - cost + latency in plausible ranges per tier
import type { FixtureSpec } from './tools.js';

interface DomainTpl {
  domain: 'pdf-extraction' | 'summarisation' | 'code-review';
  endpoint_stub_name: string;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  templates: Array<{ namePrefix: string; capability: string }>;
}

const PDF_INPUT = { type: 'object', properties: { pdf_text: { type: 'string' } }, required: ['pdf_text'], additionalProperties: false };
const PDF_OUTPUT = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'], additionalProperties: false } } }, required: ['rows'], additionalProperties: false };
const TEXT_INPUT = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const TEXT_OUTPUT = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const CODE_INPUT = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false };
const CODE_OUTPUT = { type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, comment: { type: 'string' } }, required: ['file', 'line', 'comment'], additionalProperties: false } } }, required: ['issues'], additionalProperties: false };

const DOMAINS: DomainTpl[] = [
  {
    domain: 'pdf-extraction',
    endpoint_stub_name: 'pdf-extractor-v3',
    input_contract: PDF_INPUT,
    output_contract: PDF_OUTPUT,
    templates: [
      { namePrefix: 'receipt-parser', capability: 'OCR receipt and till-roll parser. Extracts merchant, line items, tax, and total from photographed or scanned retail receipts. For expense management workflows.' },
      { namePrefix: 'cap-table-extractor', capability: 'Cap table extraction from VC term-sheet PDFs and SAFE notes. Pulls share class, ownership %, valuation, and pre/post-money columns.' },
      { namePrefix: 'lease-reader', capability: 'Commercial real-estate lease parser. Extracts rent schedule, escalation clauses, break dates, and service-charge breakdown from PDF leases.' },
      { namePrefix: 'medical-bill-decoder', capability: 'US medical bill and EOB extractor. Pulls procedure codes, billed amounts, insurance adjustments, and patient responsibility from itemized hospital invoices.' },
      { namePrefix: 'utility-bill-parser', capability: 'Utility bill extraction for energy, water, and broadband. Reads kWh, peak/off-peak rates, standing charges, and totals from supplier PDFs.' },
      { namePrefix: 'shipping-label-reader', capability: 'Shipping manifest and bill-of-lading extractor. Pulls carrier, weight, dimensions, declared value, and consignee details.' },
      { namePrefix: 'tax-form-parser', capability: 'IRS 1040, W-2, and 1099 form parser. Extracts taxpayer ID, wages, withholding, and dependent fields. US tax returns only.' },
      { namePrefix: 'bank-statement-extractor', capability: 'Personal and SME bank statement parser. Pulls per-transaction date, description, debit/credit, and running balance from monthly PDF statements.' },
      { namePrefix: 'mortgage-doc-reader', capability: 'Mortgage offer document parser. Reads APR, term, monthly payment, fees, and lender disclosures from UK and US mortgage offer letters.' },
      { namePrefix: 'invoice-line-extractor', capability: 'Generic invoice line-item extractor. Reads quantity, unit price, discount, and line total from B2B invoices.' },
      { namePrefix: 'pension-statement-parser', capability: 'Workplace pension and SIPP statement extractor. Pulls fund value, contributions, transfers, and management fees.' },
      { namePrefix: 'insurance-cert-reader', capability: 'Commercial insurance certificate of coverage parser. Extracts policy number, limits, deductibles, named insureds, effective dates.' },
      { namePrefix: 'shareholder-letter-extractor', capability: 'Annual report and shareholder letter financial figure extractor. Pulls revenue, profit, dividend per share figures from CEO letters.' },
      { namePrefix: 'arxiv-table-reader', capability: 'Academic-paper table extractor. Reads benchmark scores from results tables in machine-learning and physics arxiv papers.' },
      { namePrefix: 'expense-report-parser', capability: 'Corporate expense report PDF parser. Pulls per-expense category, amount, date, and approval status.' },
    ],
  },
  {
    domain: 'summarisation',
    endpoint_stub_name: 'summariser-mini-v1',
    input_contract: TEXT_INPUT,
    output_contract: TEXT_OUTPUT,
    templates: [
      { namePrefix: 'news-tldr', capability: 'News article TLDR generator. Compresses breaking-news stories from Reuters, AP, BBC into a 2-sentence summary covering the lede.' },
      { namePrefix: 'meeting-notes-summariser', capability: 'Meeting transcript summariser. Reads Zoom or Teams transcripts and produces a one-paragraph summary plus action items.' },
      { namePrefix: 'legal-brief-condenser', capability: 'Legal brief and judgment summariser. Compresses court rulings into a single paragraph capturing holding, reasoning, and disposition.' },
      { namePrefix: 'medical-paper-digester', capability: 'Clinical research paper summariser. Targets PubMed abstracts; outputs a one-paragraph plain-English summary preserving methodology and findings.' },
      { namePrefix: 'financial-report-tldr', capability: 'Quarterly earnings call transcript summariser. Pulls the CEO commentary, guidance changes, and analyst Q&A highlights into one short paragraph.' },
      { namePrefix: 'patent-summariser', capability: 'USPTO patent abstract and claims summariser. Compresses prior-art-laden patent text into plain English describing the invention scope.' },
      { namePrefix: 'reddit-thread-condenser', capability: 'Reddit thread summariser. Reads top-100 comments and produces a single-paragraph summary of consensus opinion plus dissent.' },
      { namePrefix: 'wikipedia-tldr', capability: 'Wikipedia article one-paragraph TLDR generator. Reads the lead section, infobox, and references to produce a summary.' },
      { namePrefix: 'podcast-recap', capability: 'Podcast transcript summariser. Reads Spotify/Apple Podcast transcripts and outputs a single-paragraph episode summary.' },
      { namePrefix: 'youtube-video-recap', capability: 'YouTube auto-caption summariser. Compresses long-form video transcripts into a 1-paragraph recap.' },
      { namePrefix: 'book-chapter-digester', capability: 'Book-chapter summariser for non-fiction. Compresses single chapters into a paragraph covering main argument and key examples.' },
      { namePrefix: 'github-issue-tldr', capability: 'GitHub issue thread summariser. Reads the issue body plus all comments and produces a paragraph capturing the bug, root cause hypothesis, and current status.' },
      { namePrefix: 'slack-thread-condenser', capability: 'Slack thread summariser. Compresses long support threads or design discussions into a single paragraph.' },
    ],
  },
  {
    domain: 'code-review',
    endpoint_stub_name: 'code-review-mini-v1',
    input_contract: CODE_INPUT,
    output_contract: CODE_OUTPUT,
    templates: [
      { namePrefix: 'rust-clippy-wrap', capability: 'Rust code review using clippy lints. Detects unidiomatic ownership patterns, unnecessary clones, and unsafe blocks.' },
      { namePrefix: 'go-vet-bot', capability: 'Go code review using go vet and staticcheck. Detects shadowed variables, unused imports, and concurrency anti-patterns.' },
      { namePrefix: 'sql-injection-finder', capability: 'SQL string-concatenation detector for any backend language. Finds parameterised-query violations across Java, Python, Node, and Go.' },
      { namePrefix: 'react-hooks-checker', capability: 'React Hooks linter. Detects rule-of-hooks violations, missing dependency arrays, and stale-closure bugs in functional components.' },
      { namePrefix: 'typescript-strict-linter', capability: 'TypeScript strict-mode auditor. Finds implicit any, ts-ignore abuse, and unsafe assertions in large codebases.' },
      { namePrefix: 'sql-query-optimizer', capability: 'SQL EXPLAIN analyser for Postgres and MySQL. Reads queries and surfaces missing indexes, sequential scans, and join-order issues.' },
      { namePrefix: 'a11y-auditor', capability: 'HTML accessibility auditor. Checks WCAG 2.1 AA compliance: alt text, ARIA labels, contrast ratios, keyboard nav. For frontend code review.' },
      { namePrefix: 'docker-security-scanner', capability: 'Dockerfile security review. Detects running as root, missing healthcheck, secrets in build args, and outdated base images.' },
      { namePrefix: 'k8s-manifest-validator', capability: 'Kubernetes manifest review. Detects missing resource limits, privileged containers, hostPath mounts, and ingress misconfigurations.' },
      { namePrefix: 'terraform-policy-checker', capability: 'Terraform code review for cloud security. Detects open security groups, unencrypted volumes, and IAM-policy wildcards in AWS, GCP, Azure providers.' },
      { namePrefix: 'graphql-schema-linter', capability: 'GraphQL schema linter. Detects naming inconsistencies, missing field descriptions, and breaking changes between schema versions.' },
      { namePrefix: 'prisma-schema-checker', capability: 'Prisma ORM schema review. Detects missing indexes on foreign keys, cascade-delete risks, and field-name conflicts.' },
      { namePrefix: 'nextjs-patterns-bot', capability: 'Next.js App Router pattern auditor. Detects misuse of server vs client components, fetch-cache anti-patterns, and bundle-size issues.' },
      { namePrefix: 'css-redundancy-finder', capability: 'CSS deduplication and redundancy detector. Finds duplicated rules, unused selectors, and specificity-conflict patterns in large stylesheets.' },
      { namePrefix: 'shell-script-linter', capability: 'Bash and POSIX shell script linter. Wraps shellcheck. Detects unquoted variables, glob expansion bugs, and unsafe rm patterns.' },
      { namePrefix: 'license-compliance-checker', capability: 'Open-source license compliance checker. Reads package.json or requirements.txt and flags GPL/AGPL conflicts with proprietary code.' },
      { namePrefix: 'cobol-modernizer', capability: 'COBOL legacy-code review. Detects banking-mainframe anti-patterns, GOTOs, and recommends modern Java/Go equivalents.' },
      { namePrefix: 'apex-salesforce-linter', capability: 'Salesforce Apex code review. Detects governor-limit violations, SOQL-in-loops, and bulkification issues.' },
    ],
  },
];

// Deterministic pseudo-random with seeded LCG so this generates stable fixtures.
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 1000) / 1000;
  };
}

const PASSING_PATTERNS: Array<{ rate: number; passes: number; total: number }> = [
  { rate: 1.0, passes: 5, total: 5 },
  { rate: 0.8, passes: 4, total: 5 },
  { rate: 0.8, passes: 4, total: 5 },
  { rate: 1.0, passes: 5, total: 5 },
  { rate: 0.6, passes: 3, total: 5 },
  { rate: 0.4, passes: 2, total: 5 },
];

const VERSION_PATTERNS = ['1.0', '1.1', '2.0', '2.5', '3.0', '0.9', '0.5', '4.2', '1.3', '1.0-beta'];

function generatedFor(idx: number, tpl: { namePrefix: string; capability: string }, dom: DomainTpl, rng: () => number): FixtureSpec {
  // Add a one-clause variation suffix so embedding clusters spread out a bit.
  const cap = tpl.capability;
  const version = VERSION_PATTERNS[idx % VERSION_PATTERNS.length];
  const pat = PASSING_PATTERNS[idx % PASSING_PATTERNS.length];
  const cost = +((rng() * 0.01).toFixed(4)) + 0.0005;
  const latency = Math.round(80 + rng() * 700);
  const baseCases = pickCases(dom.domain);
  const cases = baseCases.map((cid, i) => ({
    case_id: cid,
    pass: i < pat.passes,
    latency_ms: Math.round(latency * (0.7 + rng() * 0.4)),
    cost_usd: cost,
    error: i < pat.passes ? undefined : 'edge case missed',
  }));
  return {
    name: tpl.namePrefix,
    version,
    author_agent_id: 'demo-tool-author',
    capability_text: cap,
    input_contract: dom.input_contract,
    output_contract: dom.output_contract,
    endpoint_stub_name: dom.endpoint_stub_name,
    cost_per_call_usd: cost,
    p95_latency_ms: latency,
    reliability_score: pat.rate,
    pass_count: pat.passes,
    total_count: pat.total,
    case_results: cases,
  };
}

function pickCases(domain: 'pdf-extraction' | 'summarisation' | 'code-review'): string[] {
  if (domain === 'pdf-extraction') return ['financial-numbers', 'single-row', 'negative-number', 'multi-page-text', 'currency-symbol-strip'];
  if (domain === 'summarisation') return ['single-paragraph', 'min-length', 'max-length', 'contains-key-term', 'non-empty'];
  return ['array-of-issues', 'at-least-one-issue', 'valid-line-numbers', 'string-comments', 'clean-code-empty'];
}

export function generateFixtures(): FixtureSpec[] {
  const rng = makeRng(42);
  const out: FixtureSpec[] = [];
  let idx = 0;
  for (const dom of DOMAINS) {
    for (const tpl of dom.templates) {
      // Generate 4 variations per template (different versions/reliability/cost mixes)
      // 46 templates * 4 variations = 184 generated tools
      for (let variant = 0; variant < 4; variant++) {
        out.push(generatedFor(idx++, { ...tpl, namePrefix: `${tpl.namePrefix}-${variant + 1}` }, dom, rng));
      }
    }
  }
  return out;
}
