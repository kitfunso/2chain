// Strategy-A expanded fixture generator for Episode A2's 10k scale corpus.
// Cross-products the 47 base templates from generated.ts with synthetic vendor
// names + scenario qualifiers, producing ~10k tools with reliably-distinct
// capability_texts.
//
// Diversity is the load-bearing constraint, not count. The build script
// (scripts/eval/build-10k-corpus.ts) runs a cosine-similarity sample on the
// output and escalates to Strategy B if <80% of 200 random pairs land below
// 0.97 cosine.

import type { FixtureSpec } from './tools.js';

// Re-export DOMAINS by importing the private interface from generated.ts via
// a structural copy. Keeping this in sync is a small maintenance cost vs the
// alternative of refactoring generated.ts.

interface DomainTpl {
  domain: 'pdf-extraction' | 'summarisation' | 'code-review';
  endpoint_stub_name: string;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  templates: Array<{ vendors: string[]; capability: string }>;
}

// Industry verticals — used to bias capability_text into a specific domain.
const VERTICALS = [
  { tag: 'fintech', phrase: 'Tuned for fintech back-office workflows with PCI-DSS-aware redaction.' },
  { tag: 'healthtech', phrase: 'Calibrated against HIPAA-compliant document pipelines and protected-health-information redaction.' },
  { tag: 'logistics', phrase: 'Optimised for cross-border freight forwarders with ISO 6346 container code recognition.' },
  { tag: 'real-estate', phrase: 'Aimed at commercial property managers handling multi-tenant lease portfolios.' },
  { tag: 'energy', phrase: 'Built for UK and EU energy retailers covering half-hourly settlement data.' },
  { tag: 'legaltech', phrase: 'Designed for in-house counsel reviewing high-volume contract intake.' },
  { tag: 'martech', phrase: 'Targeted at performance-marketing teams running multi-channel attribution.' },
  { tag: 'devtools', phrase: 'For platform-engineering teams managing internal developer portals at scale.' },
  { tag: 'edtech', phrase: 'Tuned for university registrars handling FERPA-protected transcripts.' },
  { tag: 'insurtech', phrase: 'Configured for actuarial reviews and claims-handler workflows.' },
];

// Geographic/regulatory framing.
const GEOS = [
  'United Kingdom', 'European Union', 'United States', 'Canada', 'Australia',
  'Japan', 'India', 'Brazil', 'Singapore', 'United Arab Emirates',
];

// Specific use-case scenarios that meaningfully shift capability_text.
const SCENARIOS = [
  'high-volume batch processing',
  'real-time agent-driven workflows',
  'overnight reconciliation jobs',
  'human-in-the-loop review queues',
  'one-off audit-trail extraction',
  'continuous quality-assurance sampling',
  'sandboxed test-fixture generation',
  'compliance evidence collection',
  'on-call incident triage',
  'multi-region disaster recovery',
  'mobile-first capture flows',
  'desktop power-user scripting',
];

// Vendor-name elements (procedural; cross-product with verbs gives many distinct names).
const VENDOR_PREFIXES = [
  'acuity', 'apex', 'atlas', 'axiom', 'beacon', 'caliber', 'clarion', 'cobalt',
  'compass', 'crystal', 'delta', 'echelon', 'ember', 'flux', 'forge', 'frontier',
  'glacier', 'helix', 'horizon', 'ironclad', 'kepler', 'lattice', 'lighthouse', 'lumen',
  'meridian', 'mosaic', 'nexus', 'nova', 'olive', 'onyx', 'orbit', 'pinnacle',
  'prism', 'quartz', 'redwood', 'sable', 'sapphire', 'sentry', 'sigma', 'silvercrest',
  'solstice', 'spire', 'sterling', 'summit', 'tempo', 'thalia', 'titan', 'tundra',
  'vertex', 'voyager', 'wavelet', 'weald', 'zenith', 'zephyr',
];

const VENDOR_SUFFIXES = [
  'analytics', 'automation', 'cloud', 'core', 'data', 'engine', 'extract', 'forge',
  'gateway', 'graph', 'hub', 'ingest', 'insights', 'intel', 'kit', 'lab',
  'logic', 'matrix', 'metrics', 'network', 'ops', 'orbit', 'parse', 'pipeline',
  'platform', 'reader', 'relay', 'router', 'sense', 'signal', 'stack', 'studio',
  'sync', 'systems', 'tools', 'works',
];

// Seeded RNG (mulberry32) — deterministic given the same seed so the snapshot
// hash is stable across re-builds.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERSION_PATTERNS = ['1.0', '1.1', '2.0', '2.5', '3.0', '0.9', '0.5', '4.2', '1.3', '1.0-beta'];
const PASSING_PATTERNS = [
  { passes: 5, total: 5, rate: 1.0 },
  { passes: 4, total: 5, rate: 0.8 },
  { passes: 3, total: 5, rate: 0.6 },
  { passes: 5, total: 5, rate: 0.95 },
  { passes: 4, total: 5, rate: 0.85 },
];

function pickCases(domain: 'pdf-extraction' | 'summarisation' | 'code-review'): string[] {
  if (domain === 'pdf-extraction') return ['financial-numbers', 'single-row', 'negative-number', 'multi-page-text', 'currency-symbol-strip'];
  if (domain === 'summarisation') return ['single-paragraph', 'min-length', 'max-length', 'contains-key-term', 'non-empty'];
  return ['array-of-issues', 'at-least-one-issue', 'valid-line-numbers', 'string-comments', 'clean-code-empty'];
}

function buildName(prefix: string, suffix: string, idx: number): string {
  // Add idx-derived disambiguator so similar prefixes don't collide
  return `${prefix}-${suffix}-${(idx % 1000).toString(36)}`;
}

function buildCapability(baseCapability: string, vendor: string, vertical: typeof VERTICALS[number], geo: string, scenario: string): string {
  // The capability text is deliberately verbose: vendor + base + vertical + geo + scenario.
  // Embedding diversity comes from the combinatorial framing, not synonym
  // substitution (which produces high-cosine near-duplicates).
  return `${baseCapability} ${vertical.phrase} Region focus: ${geo}. Built for ${scenario}. (Vendor: ${vendor}.)`;
}

/**
 * Strategy A expanded generator. Targets `targetCount` tools, deterministic
 * given the seed.
 *
 * Note: this re-imports DOMAINS by re-declaring the constant. Keeping the
 * authoritative source in `generated.ts` and copying it here would require
 * exporting it, which would break that module's module-internal status. The
 * pragmatic alternative is to pull the templates via require() at runtime.
 * The build script does that — see scripts/eval/build-10k-corpus.ts.
 */
export interface ExpansionConfig {
  domains: DomainTpl[];
  targetCount: number;
  seed?: number;
}

export function generateExpanded(config: ExpansionConfig): FixtureSpec[] {
  const rng = makeRng(config.seed ?? 0xa2c0_10c0);
  const out: FixtureSpec[] = [];

  // Flatten all (domain, template) pairs.
  const allTemplates: Array<{ dom: DomainTpl; tpl: DomainTpl['templates'][number] }> = [];
  for (const dom of config.domains) {
    for (const tpl of dom.templates) {
      allTemplates.push({ dom, tpl });
    }
  }
  const templateCount = allTemplates.length;
  if (templateCount === 0) return out;

  // Per-template variant target (so total lands near targetCount).
  const variantsPerTemplate = Math.ceil(config.targetCount / templateCount);

  let idx = 0;
  for (const { dom, tpl } of allTemplates) {
    for (let v = 0; v < variantsPerTemplate; v++) {
      if (out.length >= config.targetCount) break;

      // Pick combinatorial elements from the augmentation pools using the rng.
      const vertical = VERTICALS[Math.floor(rng() * VERTICALS.length)];
      const geo = GEOS[Math.floor(rng() * GEOS.length)];
      const scenario = SCENARIOS[Math.floor(rng() * SCENARIOS.length)];

      // Vendor name: prefix-suffix combo OR re-use one of the template's real vendors.
      const useRealVendor = v < tpl.vendors.length && rng() < 0.2;
      const vendor = useRealVendor
        ? tpl.vendors[v % tpl.vendors.length]
        : buildName(
            VENDOR_PREFIXES[Math.floor(rng() * VENDOR_PREFIXES.length)],
            VENDOR_SUFFIXES[Math.floor(rng() * VENDOR_SUFFIXES.length)],
            idx,
          );

      const version = VERSION_PATTERNS[idx % VERSION_PATTERNS.length];
      const pat = PASSING_PATTERNS[idx % PASSING_PATTERNS.length];
      const cost = +((rng() * 0.01).toFixed(4)) + 0.0005;
      const latency = Math.round(80 + rng() * 700);
      const cases = pickCases(dom.domain).map((cid, i) => ({
        case_id: cid,
        pass: i < pat.passes,
        latency_ms: Math.round(latency * (0.7 + rng() * 0.4)),
        cost_usd: cost,
        error: i < pat.passes ? undefined : 'edge case missed',
      }));

      out.push({
        name: vendor,
        version,
        author_agent_id: 'demo-tool-author',
        capability_text: buildCapability(tpl.capability, vendor, vertical, geo, scenario),
        input_contract: dom.input_contract,
        output_contract: dom.output_contract,
        endpoint_stub_name: dom.endpoint_stub_name,
        cost_per_call_usd: cost,
        p95_latency_ms: latency,
        reliability_score: pat.rate,
        pass_count: pat.passes,
        total_count: pat.total,
        case_results: cases,
      });
      idx++;
    }
    if (out.length >= config.targetCount) break;
  }
  return out;
}
