// Real-tool catalog for v2 retrieval testing at scale.
//
// Drawn from authoritative sources where the capability_text is verifiable:
//   - Anthropic MCP registry (github.com/modelcontextprotocol/servers)
//   - Major public APIs (SEC EDGAR, arxiv, Wikipedia, OpenStreetMap, ...)
//   - Well-known SaaS APIs (Stripe, GitHub, Slack, Twilio, ...)
//   - LangChain canonical tools
//
// Each entry has status='active' and reliability_score=0.92 (above the 0.80
// gate so they show up in retrieval). Stubs all point at 'catalog-only-stub'
// so /call returns the "spec-only" error — these are searchable specs, not
// runnable tools. Real stubs land per-tool when someone forks and adds them.
//
// Author: kept as 'catalog-import' so they don't conflict with the demo
// authors' name-ownership rules.

import type { ToolSpecV2 } from '../types.js';

const AUTHOR = 'catalog-import';
const STUB = 'catalog-only-stub';

// Compact factory — most fields are repetitive across imports.
function t(
  domain: string,
  name: string,
  capabilityText: string,
  opts: {
    version?: string;
    reliability?: number;
    cost?: number;
    p95?: number;
    inputContract?: Record<string, unknown>;
    outputContract?: Record<string, unknown>;
  } = {},
): ToolSpecV2 {
  return {
    name,
    version: opts.version ?? '1.0',
    author_agent_id: AUTHOR,
    capability_text: capabilityText,
    input_contract: opts.inputContract ?? {
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: true,
    },
    output_contract: opts.outputContract ?? {
      type: 'object',
      additionalProperties: true,
    },
    output_repair_strategy: 'fail-fast',
    endpoint_stub_name: STUB,
    metadata: {
      cost_per_call_usd: opts.cost ?? 0,
      p95_latency_ms: opts.p95 ?? 800,
      reliability_score: opts.reliability ?? 0.92,
    },
    status: 'active',
    domain,
  };
}

// =============================================================================
// 1. FINANCE & MARKET DATA
// =============================================================================
const FINANCE: ToolSpecV2[] = [
  t('finance', 'sec-edgar-companyfacts', 'Fetches XBRL companyfacts JSON from SEC EDGAR for any US-listed ticker. Returns historical filed values across all GAAP concepts (revenue, assets, equity, ...). Free, no API key. Use for fundamental research, audit trails, time-series of any line item.'),
  t('finance', 'sec-edgar-filings-list', 'Lists all filings (10-K, 10-Q, 8-K, S-1, DEF 14A, ...) for a given CIK or ticker, ordered by filing date. Returns accession numbers and document URLs. Free SEC EDGAR API.'),
  t('finance', 'yahoo-finance-quote', 'Real-time and historical price quotes for stocks, ETFs, indexes, mutual funds, crypto, FX. Returns OHLCV bars at intervals from 1m to 1mo. Free, unofficial.'),
  t('finance', 'yahoo-finance-fundamentals', 'Pulls income statement, balance sheet, cash flow for any US-listed ticker. Quarterly or annual. Returns the same numbers Yahoo Finance shows on the Financials tab.'),
  t('finance', 'alpha-vantage-quote', 'Stock quotes + technical indicators (RSI, MACD, BBANDS, etc.) via Alpha Vantage API. Free tier 5 calls/min. Returns OHLCV plus computed indicator values.'),
  t('finance', 'fred-series', 'Federal Reserve Economic Data (FRED) time series fetcher. Pulls macro indicators by series ID — GDP, CPI, unemployment, mortgage rates, M2. Free with FRED API key.'),
  t('finance', 'polygon-aggregates', 'Polygon.io stock aggregates API. Sub-second OHLCV bars at minute, hour, day resolution. Tick-level trade and quote data on paid plans. Real-time SIP feed.'),
  t('finance', 'iex-cloud-stats', 'IEX Cloud key statistics endpoint — market cap, P/E, dividend yield, beta, 52-week high/low, EPS, EBITDA, gross profit. Single ticker per call.'),
  t('finance', 'finnhub-earnings-calendar', 'Finnhub earnings calendar. Returns upcoming and historical earnings dates with EPS estimate vs actual. Free tier 60 calls/min.'),
  t('finance', 'tiingo-eod', 'Tiingo end-of-day historical prices for US equities, ETFs, mutual funds, crypto, FX. Adjusted and unadjusted. 30+ years of history.'),
  t('finance', 'open-exchange-rates', 'Open Exchange Rates daily and historical FX rates for 170+ currencies. Returns conversion rates with USD as base. Free tier 1k calls/month.'),
  t('finance', 'coingecko-coin-price', 'CoinGecko cryptocurrency prices. Returns current and historical prices for 14k+ coins, in any of 60+ fiat currencies. Free, no API key.'),
  t('finance', 'binance-klines', 'Binance kline (candlestick) data for spot and futures markets. Returns OHLCV bars from 1m to 1mo for any traded pair. Free public endpoint.'),
  t('finance', 'plaid-transactions', 'Plaid transactions endpoint — pulls categorized bank transactions across 12k+ US/EU institutions. Connects via Plaid Link. Returns merchant, amount, date, MCC, ISO category.'),
  t('finance', 'stripe-payment-intents', 'Stripe PaymentIntents API — create, capture, cancel, refund payments. Idempotent. Returns charge ID, status, last_payment_error. Live and test modes.'),
  t('finance', 'companies-house-filings', 'UK Companies House filings API. Returns accounts, confirmation statements, officer changes, charges for any UK-registered company by company number.'),
];

// =============================================================================
// 2. RESEARCH & ACADEMIC
// =============================================================================
const RESEARCH: ToolSpecV2[] = [
  t('research', 'arxiv-search-papers', 'Searches arxiv.org for academic papers via the Atom export API. Returns title, authors, abstract, arxiv ID, PDF URL. Sortable by relevance, submission date, or last update.'),
  t('research', 'semantic-scholar-paper', 'Semantic Scholar paper lookup by DOI, arxiv ID, or title. Returns abstract, authors, citation count, references, citing papers. Graph of academic literature.'),
  t('research', 'openalex-search', 'OpenAlex full-text search across 240M+ scholarly works (papers, books, datasets, theses). Returns OpenAlex ID, citation count, OA status, author affiliations.'),
  t('research', 'pubmed-search', 'PubMed E-utilities search across 35M biomedical citations from MEDLINE. Returns PMID, title, abstract, MeSH terms, journal, publication date.'),
  t('research', 'crossref-doi-lookup', 'Crossref DOI metadata lookup. Returns full citation, authors, journal, issue, page numbers, references list, ORCID IDs.'),
  t('research', 'core-fulltext-search', 'CORE full-text academic search across 200M+ open-access papers. Returns full PDF text where available, plus standard metadata.'),
  t('research', 'openreview-papers', 'OpenReview API — fetches papers and reviews for ICLR, NeurIPS, AAAI, etc. Returns paper text, peer reviews, author responses, decision (accept/reject).'),
  t('research', 'wikipedia-summary', 'Wikipedia REST API summary endpoint. Returns the lead paragraph, thumbnail, page URL, and Wikidata QID for any Wikipedia article.'),
  t('research', 'wikipedia-fulltext', 'Wikipedia full article text via the action API. Returns the cleaned-up wikitext or rendered HTML for any article.'),
  t('research', 'wolfram-alpha-query', 'Wolfram Alpha computational query API. Solves math, retrieves facts (population, atomic mass, distances), unit conversions, plots. Returns step-by-step solutions.'),
  t('research', 'arxiv-paper-pdf', 'Downloads the PDF of an arxiv paper given its arxiv ID. Returns binary content. Useful for full-text RAG over preprints.'),
  t('research', 'isbn-lookup', 'ISBN to book metadata lookup via the Open Library API. Returns title, authors, publication date, publisher, cover image URL, subjects.'),
];

// =============================================================================
// 3. CODE & DEVOPS
// =============================================================================
const CODE: ToolSpecV2[] = [
  t('code', 'github-repo-info', 'GitHub repo metadata API. Returns stars, forks, open issues, primary language, topics, default branch, license, archived state. Public repos free.'),
  t('code', 'github-issues-list', 'GitHub issues API. Lists open + closed issues for a repo, filterable by label, assignee, milestone. Returns title, body, comments, created/updated time.'),
  t('code', 'github-pulls-list', 'GitHub pull requests API. Lists open + closed PRs with status checks, review state, mergeable flag, files changed.'),
  t('code', 'github-commits-list', 'GitHub commits API. Lists commits on a branch with SHA, author, message, files touched. Filterable by path, author, date range.'),
  t('code', 'github-search-code', 'GitHub code search across all public repos. Returns file path, repo, language, line snippet. Rate-limited to 30 queries/min for unauthenticated.'),
  t('code', 'github-actions-runs', 'GitHub Actions runs API. Lists workflow runs with status, conclusion, duration, triggering commit. Used for CI dashboards.'),
  t('code', 'gitlab-projects', 'GitLab projects API. Equivalent of GitHub repos for self-hosted and GitLab.com. Returns visibility, default branch, statistics.'),
  t('code', 'npm-registry-package', 'npm registry package metadata. Returns version list, dependencies, last-publish date, weekly downloads, README. Free public endpoint.'),
  t('code', 'npm-package-downloads', 'npm download counts API. Returns daily/weekly/monthly download stats for any package, going back to 2015. Useful for popularity gating.'),
  t('code', 'pypi-package', 'PyPI JSON API for any Python package. Returns version list, classifiers, requires_python, long description, project URLs.'),
  t('code', 'docker-hub-tags', 'Docker Hub tags API. Lists all tags + digests for a public Docker image. Returns size, architectures, last-pushed time.'),
  t('code', 'cratesio-package', 'crates.io package metadata. Rust crates with versions, dependencies, downloads, owners, README.'),
  t('code', 'rubygems-search', 'RubyGems.org search. Returns gem name, version, downloads, license, project URL.'),
  t('code', 'go-pkg-info', 'pkg.go.dev module info via the proxy API. Returns version list, go.mod, license, deprecation notices.'),
  t('code', 'docker-image-scan', 'Trivy-style container image vulnerability scan. Returns CVEs by severity for any pulled Docker image. Used in CI security gates.'),
  t('code', 'eslint-stylecheck', 'ESLint style and bug check for JavaScript/TypeScript. Returns issues with file, line, rule ID, severity. Configurable rule sets.'),
  t('code', 'pylint-lint', 'pylint static analysis for Python. Returns issues with code, message, line, column. Used in CI gates and IDE integrations.'),
  t('code', 'ruff-fast-lint', 'Ruff — extremely fast Python linter and formatter (Rust-based, 10-100x faster than pylint). Drop-in for flake8/isort/pylint.'),
  t('code', 'shellcheck-bash', 'ShellCheck — finds bugs in shell scripts. Returns warnings with code, message, line, column. Catches quoting bugs, unset vars, unsafe globs.'),
  t('code', 'staticcheck-go', 'staticcheck — Go linter that finds bugs and performance issues missed by go vet. Returns SA-prefixed issues with severity.'),
  t('code', 'snyk-vuln-scan', 'Snyk vulnerability scan. Scans package.json / go.mod / requirements.txt for known CVEs. Returns severity, fix versions, exploit maturity.'),
  t('code', 'sonarqube-quality-gate', 'SonarQube code quality gate. Returns code smells, bugs, security hotspots, coverage, duplications for a project.'),
  t('code', 'github-actions-marketplace', 'GitHub Actions marketplace search. Finds reusable CI actions by keyword, returns name, author, latest version, README excerpt.'),
  t('code', 'terraform-registry-module', 'Terraform Registry module metadata. Returns inputs, outputs, dependencies, examples, latest version. Used for IaC templating.'),
];

// =============================================================================
// 4. DATA & TRANSFORMATION
// =============================================================================
const DATA: ToolSpecV2[] = [
  t('data', 'jq-jsonpath-query', 'jq-style JSONPath query against a JSON document. Returns extracted values. Used for parsing API responses, log processing, config inspection.'),
  t('data', 'csv-parse', 'CSV parser. Returns array of row objects with column headers as keys. Handles quoted fields, custom delimiters, encoding detection.'),
  t('data', 'csv-to-json', 'CSV to JSON converter. Streams large files. Returns newline-delimited JSON or full array. Custom delimiter, quote, escape handling.'),
  t('data', 'json-validate-schema', 'JSON Schema validator (Draft 7/2019-09/2020-12). Returns pass/fail plus per-property error paths. Powered by ajv.'),
  t('data', 'regex-match-extract', 'Regex match and extract tool. Runs a PCRE pattern against text and returns all matches with capture groups, byte offsets, line numbers.'),
  t('data', 'sql-query-postgres', 'SQL query executor against a Postgres database. Parameterised queries only. Returns row array, column types, affected row count.'),
  t('data', 'sql-query-sqlite', 'SQL query executor against a SQLite database. Parameterised. Returns row array. Useful for local data work and ETL pipelines.'),
  t('data', 'duckdb-analytics-query', 'DuckDB analytics query — runs SQL over Parquet, CSV, JSON, Arrow files in-process. Excellent for ad-hoc data analysis.'),
  t('data', 'pandas-dataframe-op', 'pandas DataFrame operations — filter, group, agg, pivot, merge, melt, resample. Returns transformed DataFrame as JSON.'),
  t('data', 'parquet-reader', 'Apache Parquet reader. Returns row count, schema, optional row sample. Reads from local path or S3/GCS URLs.'),
  t('data', 'avro-reader', 'Apache Avro reader. Returns schema, decoded records. Supports the Confluent Schema Registry wire format.'),
  t('data', 'string-diff', 'Word-level or line-level string diff (Myers algorithm). Returns unified diff, plus added/removed/unchanged spans for rendering.'),
];

// =============================================================================
// 5. COMMUNICATION
// =============================================================================
const COMMS: ToolSpecV2[] = [
  t('comms', 'slack-post-message', 'Posts a message to a Slack channel via the chat.postMessage API. Supports rich blocks, threads, broadcast, attachments. Requires bot token.'),
  t('comms', 'slack-list-channels', 'Lists Slack channels accessible to the bot. Returns channel ID, name, topic, purpose, member count. Pagination support.'),
  t('comms', 'discord-send-message', 'Posts a message to a Discord channel via the bot REST API. Supports embeds, files, mentions. Rate-limited to 5 messages/2s per channel.'),
  t('comms', 'email-send-smtp', 'SMTP email sender. Sends multipart messages with HTML + text + attachments. Authenticates via SASL PLAIN/LOGIN. Works with Gmail, SES, SendGrid SMTP.'),
  t('comms', 'sendgrid-send-mail', 'SendGrid v3 mail send API. Templates, dynamic data, scheduled send, batch IDs, ASM groups. Returns message ID for tracking.'),
  t('comms', 'twilio-send-sms', 'Twilio SMS send via the Messages API. Supports MMS, WhatsApp Business, alphanumeric sender ID where allowed. Returns SID + status callback.'),
  t('comms', 'twilio-make-call', 'Twilio voice call via the Calls API. Drives a TwiML flow (Say, Gather, Dial). Returns call SID and recording URLs.'),
  t('comms', 'gcal-list-events', 'Google Calendar events list via the v3 API. Returns events in a date range with start/end, attendees, conferencing, description. Per-calendar.'),
  t('comms', 'gcal-create-event', 'Google Calendar create event. Adds title, attendees, location, conferencing (Meet), reminders. Returns event ID and HTML link.'),
  t('comms', 'outlook-list-messages', 'Microsoft Graph mail list. Returns messages with from, subject, body preview, attachments, importance. Filterable by folder, date, search.'),
  t('comms', 'gmail-list-messages', 'Gmail API messages.list — filters by Gmail search query (label, from, after, has:attachment). Returns message IDs for fetching.'),
];

// =============================================================================
// 6. DOCUMENTS
// =============================================================================
const DOCS: ToolSpecV2[] = [
  t('docs', 'pdf-extract-text', 'PDF text extractor. Returns raw text per page plus optional layout-preserving columns. Handles encrypted PDFs with password.'),
  t('docs', 'pdf-extract-tables', 'PDF table extractor (camelot/tabula-style). Returns list of tables with rows + cells. Works on bordered or stream-mode tables.'),
  t('docs', 'tesseract-ocr', 'Tesseract OCR. Returns text from a scanned page or image. Supports 100+ languages, confidence scores, hOCR output.'),
  t('docs', 'google-vision-ocr', 'Google Cloud Vision OCR API. Higher accuracy than Tesseract on noisy / handwritten / multi-column documents. Per-page billing.'),
  t('docs', 'aws-textract-document', 'AWS Textract document analysis. Returns text + tables + form key-value pairs. Optimised for invoices, receipts, forms, ID cards.'),
  t('docs', 'azure-doc-intelligence', 'Azure AI Document Intelligence (formerly Form Recognizer). Pre-built models for invoices, receipts, IDs, business cards, plus custom training.'),
  t('docs', 'docx-extract-text', 'Microsoft Word .docx text extractor. Preserves paragraphs, headings, lists, tables. Returns markdown or plain text.'),
  t('docs', 'xlsx-read-sheet', 'Excel .xlsx reader. Returns sheet names + cell grid. Handles formulas (computed value), merged cells, named ranges.'),
  t('docs', 'pptx-extract-slides', 'PowerPoint .pptx extractor. Returns per-slide text content, speaker notes, embedded image refs. Used for slide-deck RAG.'),
  t('docs', 'image-resize', 'Image resize via libvips/sharp. Returns resized PNG/JPEG/WebP/AVIF. Bicubic, lanczos3, nearest. Strips metadata by default.'),
  t('docs', 'image-convert-format', 'Image format converter. PNG <-> JPEG <-> WebP <-> AVIF <-> HEIC. Quality knob. Optional EXIF preservation.'),
  t('docs', 'markdown-to-html', 'Markdown to HTML converter (CommonMark + GFM). Returns HTML with optional syntax highlighting, mermaid diagrams, math via KaTeX.'),
  t('docs', 'html-to-markdown', 'HTML to Markdown converter (turndown-style). Cleans up tags, preserves links + images + code blocks. Useful for web-scrape -> RAG pipelines.'),
];

// =============================================================================
// 7. MAPS, GEO, WEATHER
// =============================================================================
const GEO: ToolSpecV2[] = [
  t('geo', 'google-maps-geocode', 'Google Maps Geocoding API. Address -> lat/lng + place_id, or reverse. Returns location type, formatted address, address components.'),
  t('geo', 'mapbox-geocoding', 'Mapbox Geocoding API. Forward and reverse geocoding with autocomplete. Returns relevance-scored matches with bounding boxes.'),
  t('geo', 'osm-nominatim', 'OpenStreetMap Nominatim geocoder. Free, fair-use, attributable. Returns address components and OSM IDs. Strict 1 req/sec rate limit.'),
  t('geo', 'osm-overpass-query', 'OpenStreetMap Overpass API. Query OSM data via Overpass QL — find nearby pubs, bus stops, hospitals, postboxes. Returns nodes/ways/relations.'),
  t('geo', 'distance-haversine', 'Haversine great-circle distance between two lat/lng pairs. Returns meters. Pure compute, no API.'),
  t('geo', 'noaa-weather-forecast', 'US NOAA weather forecast for any lat/lng. Returns hourly + 7-day forecast. Free, no API key. US only.'),
  t('geo', 'open-meteo-forecast', 'Open-Meteo weather forecast API. Worldwide, free, no API key. Returns temperature, precip, wind, solar at hourly resolution up to 16 days.'),
  t('geo', 'openweather-current', 'OpenWeatherMap current weather. Worldwide, paid tier for high-frequency use. Returns temperature, humidity, pressure, wind, conditions.'),
  t('geo', 'tomorrow-io-weather', 'Tomorrow.io weather + hyperlocal nowcast (60min minute-by-minute precipitation). Climate signals, severe alerts.'),
  t('geo', 'gtfs-public-transit', 'GTFS-RT real-time public transit feed. Returns vehicle positions, trip updates, service alerts. Used for transit apps and arrival predictions.'),
  t('geo', 'osrm-route', 'OSRM routing. Returns turn-by-turn directions, distance, duration for car/bike/foot between coordinate pairs. Open-source self-host.'),
  t('geo', 'mapbox-directions', 'Mapbox Directions API. Walking/cycling/driving routes with traffic, alternatives, geometry, voice + banner instructions.'),
  t('geo', 'timezone-from-latlng', 'Timezone resolver from lat/lng. Returns IANA TZ ID + UTC offset. Used to localize timestamps to user-relevant time.'),
  t('geo', 'iss-current-position', 'Current International Space Station position via Open Notify API. Returns lat/lng. Free, no API key.'),
];

// =============================================================================
// 8. ECOMMERCE & PAYMENTS
// =============================================================================
const ECOMMERCE: ToolSpecV2[] = [
  t('ecommerce', 'shopify-products-list', 'Shopify Admin API — list products with variants, prices, inventory, tags. Pagination. Per-store auth via OAuth or private app.'),
  t('ecommerce', 'shopify-orders-list', 'Shopify orders list. Filterable by status, date, customer. Returns line items, fulfillment, tax breakdown.'),
  t('ecommerce', 'amazon-product-search', 'Amazon Product Advertising API search. Returns ASIN, title, price, image, customer reviews summary. Requires PA-API credentials.'),
  t('ecommerce', 'ebay-finding', 'eBay Browse API search. Find active listings by keyword, category, price range. Returns title, price, condition, seller, ending time.'),
  t('ecommerce', 'paypal-create-order', 'PayPal v2 Orders create. Initiates a checkout flow. Returns order ID and approval URL for redirecting the buyer.'),
  t('ecommerce', 'klarna-checkout', 'Klarna Checkout v3. Buy-now-pay-later checkout flow with installment options. Returns checkout HTML snippet.'),
  t('ecommerce', 'algolia-product-search', 'Algolia search index — typo-tolerant product search with faceted filters. Sub-50ms response time. Used as the search backend on many ecommerce sites.'),
  t('ecommerce', 'walmart-marketplace-orders', 'Walmart Marketplace orders API. Lists orders with item, fulfillment, shipping. Acknowledge + ship + cancel actions.'),
];

// =============================================================================
// 9. LEGAL & COMPLIANCE
// =============================================================================
const LEGAL: ToolSpecV2[] = [
  t('legal', 'uspto-patents-search', 'USPTO PatentsView API search across granted US patents. Returns patent number, title, abstract, inventors, assignees, filing date.'),
  t('legal', 'epo-patent-search', 'European Patent Office (EPO) Open Patent Services. Search EP and WO patents. Returns title, abstract, family, status.'),
  t('legal', 'court-listener-decisions', 'CourtListener.com decisions search. US federal + state court opinions, oral arguments, citations. Free, attribution required.'),
  t('legal', 'companies-house-search', 'UK Companies House company search. Find by name, returns company number + registered address. Stepping stone to filings.'),
  t('legal', 'sec-edgar-form4', 'SEC EDGAR Form 4 (insider transactions). Returns insider buys/sells with date, price, shares, post-transaction holdings.'),
  t('legal', 'gdpr-cookie-categorize', 'GDPR cookie categorization. Given a cookie name + domain, returns category (necessary, functional, analytics, advertising) and legal basis.'),
  t('legal', 'eu-court-curia-search', 'EU Court of Justice (CURIA) decisions search. Returns case number, parties, subject, judgment text in 24 EU languages.'),
];

// =============================================================================
// 10. HEALTH & MEDICAL
// =============================================================================
const HEALTH: ToolSpecV2[] = [
  t('health', 'openfda-drug-label', 'OpenFDA drug label endpoint. Returns indications, dosage, contraindications, adverse reactions, ingredients. Searchable by brand/generic name or NDC.'),
  t('health', 'rxnorm-name-lookup', 'RxNorm normalized drug names from NLM. Maps brand names to generic, strength, dose form. Used for medication reconciliation.'),
  t('health', 'icd10-code-lookup', 'ICD-10-CM diagnosis code lookup. Given a code, returns description, category, parent codes. Given a description, returns matching codes.'),
  t('health', 'snomed-ct-search', 'SNOMED CT clinical terminology search. Returns concept ID, fully specified name, synonyms, parent/child relationships.'),
  t('health', 'pubmed-clinical-search', 'PubMed clinical query. Filtered for therapy, diagnosis, etiology, prognosis, clinical prediction guides. Returns PMIDs and abstracts.'),
  t('health', 'clinical-trials-gov', 'ClinicalTrials.gov API. Find trials by condition, intervention, phase, status. Returns NCT ID, sponsor, locations, eligibility.'),
  t('health', 'who-icd11-search', 'WHO ICD-11 international classification of diseases. Returns code, title, description. Foundation for international health statistics.'),
];

// =============================================================================
// 11. EDUCATION & KNOWLEDGE
// =============================================================================
const EDU: ToolSpecV2[] = [
  t('edu', 'wikipedia-search', 'Wikipedia search via the action API. Returns article titles + snippets matching a query. Supports per-language wiki.'),
  t('edu', 'wikidata-sparql', 'Wikidata SPARQL endpoint. Query the structured-knowledge graph for entities, relations, properties. Returns rows of bound variables.'),
  t('edu', 'mdn-docs-search', 'MDN Web Docs search. Returns API references, CSS properties, JS methods, HTTP semantics with browser compat data.'),
  t('edu', 'stackoverflow-search', 'Stack Overflow search via the SE API. Returns highest-voted answers for a question pattern. Filter by tag.'),
  t('edu', 'devto-articles', 'DEV.to articles API. Search by tag, returns title, body markdown, author, reading time, reactions.'),
  t('edu', 'hackernews-search', 'Hacker News Algolia search. Find stories, comments by keyword + date range. Returns score, comment count, URL.'),
  t('edu', 'youtube-search', 'YouTube Data API search. Returns video ID, title, channel, published date. Use with channel/video.list for fuller metadata.'),
  t('edu', 'youtube-transcript', 'YouTube auto-generated or human-uploaded transcript fetcher. Returns timed segments. Use for video summarisation pipelines.'),
];

// =============================================================================
// 12. MEDIA, IMAGES, AUDIO
// =============================================================================
const MEDIA: ToolSpecV2[] = [
  t('media', 'unsplash-photo-search', 'Unsplash photos search. Returns CC-licensed photos with photographer credit, download URL, dominant color. Free attribution required.'),
  t('media', 'pexels-photo-search', 'Pexels royalty-free photo + video search. Returns assets in multiple resolutions, photographer + URL.'),
  t('media', 'spotify-track-search', 'Spotify track search via the Web API. Returns track ID, name, album, artist, duration, popularity, audio features (tempo, key, energy).'),
  t('media', 'spotify-audio-features', 'Spotify audio features for a track ID. Returns danceability, energy, valence, tempo, key, time signature, acousticness.'),
  t('media', 'last-fm-track-info', 'Last.fm track info API. Returns play count, listeners, genre tags, similar tracks, biography of artists.'),
  t('media', 'openai-dalle-image', 'OpenAI DALL-E 3 image generation. Returns 1024x1024 / 1792x1024 PNG. Per-image billing. Strict content policy.'),
  t('media', 'stability-sd-image', 'Stability AI Stable Diffusion image generation. SDXL, SD3, custom checkpoints. Returns PNG with optional in/out-painting masks.'),
  t('media', 'whisper-audio-transcribe', 'OpenAI Whisper audio-to-text. Multi-language. Returns timed transcript with word-level timestamps. Supports 25MB files via API.'),
  t('media', 'eleven-labs-tts', 'ElevenLabs text-to-speech. High-quality voice cloning. Returns MP3 stream. Per-character billing.'),
  t('media', 'ffmpeg-trim-video', 'FFmpeg video trim operation. Cuts a video to a [start, end] range. Returns transcoded MP4. Local or cloud worker.'),
];

// =============================================================================
// Combined catalog
// =============================================================================
export const REAL_CORPUS: ToolSpecV2[] = [
  ...FINANCE, ...RESEARCH, ...CODE, ...DATA, ...COMMS,
  ...DOCS, ...GEO, ...ECOMMERCE, ...LEGAL, ...HEALTH,
  ...EDU, ...MEDIA,
];

export const REAL_CORPUS_BY_DOMAIN = {
  finance: FINANCE,
  research: RESEARCH,
  code: CODE,
  data: DATA,
  comms: COMMS,
  docs: DOCS,
  geo: GEO,
  ecommerce: ECOMMERCE,
  legal: LEGAL,
  health: HEALTH,
  edu: EDU,
  media: MEDIA,
};
