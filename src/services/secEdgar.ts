// Real SEC EDGAR fetcher. No baked numbers, no API key.
// Hits https://data.sec.gov/api/xbrl/companyfacts/CIK{10-padded}.json
// Filters XBRL facts to the latest annual 10-K (form=10-K, fp=FY).
// SEC rule: must send a User-Agent with contact info.

const USER_AGENT = '2chain hackathon demo (skfskf27@gmail.com)';
const FETCH_TIMEOUT_MS = 4000;

// Top ~40 US tickers → CIK (zero-padded to 10 digits, as the URL requires).
// The numbers we return don't come from this table; this table only resolves
// "ticker NVDA → SEC entity 1045810" so we can hit the right URL.
const CIK_BY_TICKER: Record<string, { cik: string; name: string }> = {
  NVDA:  { cik: '0001045810', name: 'NVIDIA Corporation' },
  AAPL:  { cik: '0000320193', name: 'Apple Inc.' },
  MSFT:  { cik: '0000789019', name: 'Microsoft Corporation' },
  GOOGL: { cik: '0001652044', name: 'Alphabet Inc.' },
  GOOG:  { cik: '0001652044', name: 'Alphabet Inc.' },
  META:  { cik: '0001326801', name: 'Meta Platforms, Inc.' },
  TSLA:  { cik: '0001318605', name: 'Tesla, Inc.' },
  AMZN:  { cik: '0001018724', name: 'Amazon.com, Inc.' },
  AMD:   { cik: '0000002488', name: 'Advanced Micro Devices, Inc.' },
  INTC:  { cik: '0000050863', name: 'Intel Corporation' },
  NFLX:  { cik: '0001065280', name: 'Netflix, Inc.' },
  ADBE:  { cik: '0000796343', name: 'Adobe Inc.' },
  CRM:   { cik: '0001108524', name: 'Salesforce, Inc.' },
  ORCL:  { cik: '0001341439', name: 'Oracle Corporation' },
  CSCO:  { cik: '0000858877', name: 'Cisco Systems, Inc.' },
  IBM:   { cik: '0000051143', name: 'International Business Machines Corp.' },
  QCOM:  { cik: '0000804328', name: 'QUALCOMM Incorporated' },
  TXN:   { cik: '0000097210', name: 'Texas Instruments Incorporated' },
  AVGO:  { cik: '0001730168', name: 'Broadcom Inc.' },
  DIS:   { cik: '0001744489', name: 'The Walt Disney Company' },
  WMT:   { cik: '0000104169', name: 'Walmart Inc.' },
  HD:    { cik: '0000354950', name: 'The Home Depot, Inc.' },
  COST:  { cik: '0000909832', name: 'Costco Wholesale Corporation' },
  KO:    { cik: '0000021344', name: 'The Coca-Cola Company' },
  PEP:   { cik: '0000077476', name: 'PepsiCo, Inc.' },
  MCD:   { cik: '0000063908', name: "McDonald's Corporation" },
  NKE:   { cik: '0000320187', name: 'NIKE, Inc.' },
  SBUX:  { cik: '0000829224', name: 'Starbucks Corporation' },
  V:     { cik: '0001403161', name: 'Visa Inc.' },
  MA:    { cik: '0001141391', name: 'Mastercard Incorporated' },
  JPM:   { cik: '0000019617', name: 'JPMorgan Chase & Co.' },
  BAC:   { cik: '0000070858', name: 'Bank of America Corporation' },
  GS:    { cik: '0000886982', name: 'The Goldman Sachs Group, Inc.' },
  PFE:   { cik: '0000078003', name: 'Pfizer Inc.' },
  JNJ:   { cik: '0000200406', name: 'Johnson & Johnson' },
  XOM:   { cik: '0000034088', name: 'Exxon Mobil Corporation' },
  CVX:   { cik: '0000093410', name: 'Chevron Corporation' },
  BA:    { cik: '0000012927', name: 'The Boeing Company' },
  GE:    { cik: '0000040545', name: 'General Electric Company' },
  F:     { cik: '0000037996', name: 'Ford Motor Company' },
};

// XBRL concept fallback chain. Different filers use different us-gaap tags.
const CONCEPT_CHAIN = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet'],
  cost_of_revenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  gross_profit: ['GrossProfit'],
  operating_expenses: ['OperatingExpenses', 'CostsAndExpenses'],
  operating_income: ['OperatingIncomeLoss'],
  net_income: ['NetIncomeLoss', 'ProfitLoss'],
} as const;

interface XbrlFact {
  end: string;
  val: number;
  form: string;
  fp?: string;
  fy?: number;
  filed?: string;
  accn?: string;
}

interface CompanyFacts {
  entityName?: string;
  facts?: {
    'us-gaap'?: Record<string, { units?: Record<string, XbrlFact[]> }>;
  };
}

export interface IncomeStatement {
  ticker: string;
  company: string;
  fiscal_year_end: string;
  currency: string;
  unit: string;
  income_statement: {
    revenue: number;
    cost_of_revenue: number;
    gross_profit: number;
    operating_expenses: number;
    operating_income: number;
    net_income: number;
  };
  source_url: string;
  fetched_at: string;
}

export class SecFetchError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));
}

// Pick the latest annual 10-K fact from a list of XBRL facts.
function latestAnnual(facts: XbrlFact[] | undefined): XbrlFact | undefined {
  if (!facts) return undefined;
  const annuals = facts.filter((f) => f.form === '10-K' && f.fp === 'FY');
  if (annuals.length === 0) return undefined;
  // Most recent end date wins.
  return annuals.sort((a, b) => (a.end < b.end ? 1 : -1))[0];
}

// Pick the concept whose latest annual fact is the most recent. Filers swap
// XBRL tags over time (e.g. AAPL moved Revenues -> RevenueFromContract...),
// so the *first* hit in the chain isn't always the freshest.
function pickConcept(usgaap: NonNullable<NonNullable<CompanyFacts['facts']>['us-gaap']>, chain: readonly string[]): XbrlFact | undefined {
  let best: XbrlFact | undefined;
  for (const concept of chain) {
    const node = usgaap[concept];
    if (!node?.units) continue;
    const usdFacts = node.units['USD'] ?? Object.values(node.units)[0];
    const latest = latestAnnual(usdFacts);
    if (latest && (!best || latest.end > best.end)) best = latest;
  }
  return best;
}

// Pick a fact for `concepts` matching the anchor fiscal_year_end exactly, so
// every line item lines up to the same period. Falls back to nearest annual.
function pickConceptForEnd(
  usgaap: NonNullable<NonNullable<CompanyFacts['facts']>['us-gaap']>,
  chain: readonly string[],
  anchorEnd: string,
): XbrlFact | undefined {
  for (const concept of chain) {
    const node = usgaap[concept];
    if (!node?.units) continue;
    const usdFacts = node.units['USD'] ?? Object.values(node.units)[0];
    if (!usdFacts) continue;
    const annuals = usdFacts.filter((f) => f.form === '10-K' && f.fp === 'FY');
    const exact = annuals.find((f) => f.end === anchorEnd);
    if (exact) return exact;
  }
  return undefined;
}

export function resolveCik(ticker: string): { cik: string; name: string } | undefined {
  return CIK_BY_TICKER[ticker.trim().toUpperCase()];
}

export function knownTickers(): string[] {
  return Object.keys(CIK_BY_TICKER).sort();
}

export async function fetchIncomeStatement(rawTicker: string): Promise<IncomeStatement> {
  const ticker = rawTicker.trim().toUpperCase();
  const entry = CIK_BY_TICKER[ticker];
  if (!entry) {
    throw new SecFetchError(
      `ticker '${ticker}' not in CIK lookup. Known: ${knownTickers().slice(0, 10).join(', ')}, ...`,
      'unknown_ticker',
    );
  }

  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${entry.cik}.json`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    throw new SecFetchError(`SEC EDGAR fetch failed: ${(e as Error).message}`, 'fetch_failed');
  }
  if (!res.ok) {
    throw new SecFetchError(`SEC EDGAR returned HTTP ${res.status} for CIK${entry.cik}`, 'http_error');
  }

  const facts = (await res.json()) as CompanyFacts;
  const usgaap = facts.facts?.['us-gaap'];
  if (!usgaap) {
    throw new SecFetchError(`no us-gaap facts in companyfacts response for ${ticker}`, 'no_facts');
  }

  // Anchor on revenue's most recent annual end date so all line items match periods.
  const revenueFact = pickConcept(usgaap, CONCEPT_CHAIN.revenue);
  if (!revenueFact) {
    throw new SecFetchError(`no annual revenue concept found for ${ticker}`, 'no_revenue');
  }
  const anchorEnd = revenueFact.end;
  const costFact   = pickConceptForEnd(usgaap, CONCEPT_CHAIN.cost_of_revenue,   anchorEnd);
  const grossFact  = pickConceptForEnd(usgaap, CONCEPT_CHAIN.gross_profit,      anchorEnd);
  const opexFact   = pickConceptForEnd(usgaap, CONCEPT_CHAIN.operating_expenses, anchorEnd);
  const opIncFact  = pickConceptForEnd(usgaap, CONCEPT_CHAIN.operating_income,   anchorEnd);
  const netIncFact = pickConceptForEnd(usgaap, CONCEPT_CHAIN.net_income,         anchorEnd);

  const revenue = revenueFact.val;
  const cost_of_revenue = costFact?.val ?? 0;
  const gross_profit = grossFact?.val ?? (revenue - cost_of_revenue);
  const operating_income = opIncFact?.val ?? 0;
  const operating_expenses = opexFact?.val ?? Math.max(0, gross_profit - operating_income);
  const net_income = netIncFact?.val ?? 0;

  // SEC reports raw USD; expose in millions for analyst readability.
  const toMillions = (n: number): number => Math.round(n / 1_000) / 1_000;

  return {
    ticker,
    company: facts.entityName ?? entry.name,
    fiscal_year_end: revenueFact.end,
    currency: 'USD',
    unit: 'millions',
    income_statement: {
      revenue: toMillions(revenue),
      cost_of_revenue: toMillions(cost_of_revenue),
      gross_profit: toMillions(gross_profit),
      operating_expenses: toMillions(operating_expenses),
      operating_income: toMillions(operating_income),
      net_income: toMillions(net_income),
    },
    source_url: url,
    fetched_at: new Date().toISOString(),
  };
}
