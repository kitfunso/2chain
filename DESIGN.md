# 2chain — DESIGN

Technical design doc for Saturday's build. README is the *what* and the *narrative*; this is the *how*. Every choice here exists because it makes the 3-minute demo deterministic on M0 + flaky venue WiFi in 6.5 hours.

---

## Status

- **Source of truth**: this file. README cites it for narrative context only.
- **Locked decisions** are in `## Decisions` at the end. Anything not in that list is open to question Saturday morning.
- **Last updated**: 2026-05-01 (pre-event)

---

## 0. Glossary (so on-stage speech matches the schema)

| Term in pitch | Term in code | What it actually is |
|---|---|---|
| "tool" | `tools` doc | A versioned function declaration with a typed contract and an endpoint URL |
| "capability" | `capability_text` + `capability_embedding` | Free-text description of what the tool does, embedded with `voyage-3` |
| "reliability" | `metadata.reliability_score` | Pass-rate over the latest eval run, in `[0, 1]` |
| "ranking" | `rankings` doc | Cached top-N result for a given query embedding + filter |
| "circuit-broken" | `tools.status === 'circuit_broken'` | Tool dropped from discovery; manual unset only |
| "push" | `2chain push <tool.json>` | CLI command: writes new tool version, triggers inline eval |
| "repair strategy" | `output_repair_strategy: 'llm' \| 'fail-fast'` | How `/call` reacts to an output-contract violation: try LLM rewrite (3x) or circuit-break immediately |
| "pending" | `tools.status === 'pending'` | Tool just inserted, eval not yet completed. Excluded from `/discover` until eval flips status to `'active'` or `'circuit_broken'` |

---

## 1. System architecture

### 1.1 Components

```
┌─────────────────────────┐    ┌──────────────────────────┐
│  Agent (LangGraph)      │    │  Tool author (CLI)       │
│  - demo-pdf-agent       │    │  - 2chain push <json>    │
└──────────┬──────────────┘    └────────────┬─────────────┘
           │ HTTP                            │ HTTP
           ▼                                 ▼
┌──────────────────────────────────────────────────────────┐
│  2chain API service (Node, single process Saturday)      │
│                                                          │
│  ┌───────────┐  ┌────────────┐  ┌──────────────────┐    │
│  │ /discover │  │ /push      │  │ /call (proxy)    │    │
│  │ vec query │  │ inline eval│  │ contract enforce │    │
│  └─────┬─────┘  └──────┬─────┘  └─────────┬────────┘    │
│        │               │                  │             │
│  ┌─────┴───────────────┴──────────────────┴────┐        │
│  │  MongoDB Atlas (M0 + Vector Search)         │        │
│  │  collections: tools, evals, eval_runs,      │        │
│  │    contracts, violations, usage, rankings,  │        │
│  │    agents                                   │        │
│  └─────────────────────────────────────────────┘        │
│                                                          │
│  ┌────────────────────┐  ┌────────────────────┐         │
│  │ Tool stub registry │  │ Eval runner (sync) │         │
│  │ in-process funcs   │  │ runs N cases,      │         │
│  │ name -> impl       │  │ writes eval_runs   │         │
│  └────────────────────┘  └────────────────────┘         │
└──────────────────────────────────────────────────────────┘
                                 ▲ poll /rankings @ 2s
                                 │
                ┌────────────────┴───────────────┐
                │  Ranking dashboard (React)     │
                │  - one screen on demo display  │
                └────────────────────────────────┘
```

### 1.2 What each component owns

| Component | Owns | Does not own |
|---|---|---|
| Agent (LangGraph) | Conversation state, tool selection from `/discover` results, calling `/call` with auth header | Ranking math, eval logic, contract validation |
| Tool author CLI (`2chain push`) | Reading local `tool.json`, calling `/push` | Doing the eval (server-side) |
| API service `/discover` | Query embedding (cached), `$vectorSearch` with hard filter, returning ranked top-N | Eval execution, contract enforcement |
| API service `/push` | Writing tool doc, invoking eval runner synchronously, updating `reliability_score`, invalidating ranking cache | LLM repair (that lives in `/call`) |
| API service `/call` | Input validation, forward to tool stub, output validation, LLM-repair retry, circuit-break, log violation, log usage | Discovery |
| Eval runner | Loading the 5 cases for a capability domain, running graders, computing pass-rate | Vector index, ranking |
| Tool stub registry | Returning the in-process function for a `(name, version)` key | Hosting, networking |
| Dashboard | Polling `/rankings`, rendering current top-N + reliability bar | Anything else |

### 1.3 Response envelope (D3 — uniform across all endpoints)

Every JSON response from `/discover`, `/call`, `/push`, `/rankings`, `/eval_runs`, `/admin/*` uses this shape:

```typescript
// Success
{
  ok: true,
  data: <endpoint-specific payload>
}

// Error
{
  ok: false,
  error: {
    code: string,         // machine-readable, e.g. 'reliability_gate' | 'circuit_broken' | 'auth' | 'not_found' | 'eval_timeout' | 'contract_violation'
    message: string,      // human-readable
    details?: any         // optional structured info (schema_errors, attempt_count, etc.)
  }
}
```

HTTP status codes still convey the broad class (200 / 4xx / 5xx). The envelope adds the *machine-discriminable error code* so SDK clients can branch cleanly without parsing prose.

**Example — `/call` returns 403 with reliability gate violation:**
```json
{
  "ok": false,
  "error": {
    "code": "reliability_gate",
    "message": "Tool reliability_score (0.6) below gate (0.8)",
    "details": { "tool_name": "pdf-extractor", "version": "3.1", "score": 0.6, "gate": 0.8 }
  }
}
```

**Implementation note**: a single `respond(res, code, payload)` helper enforces the envelope. Five lines.

### 1.4 Why not change-streams / Atlas Streams

The Atlas Sandbox is provided by the hackathon (email link, mandatory per rules). **Tier is unknown pre-event** — could be M0 (constrained: 100 ops/sec, 0.5GB, restricted change streams, unreliable Atlas Stream Processing) or M10+ (change streams + Stream Processing reliable). The default plan does not depend on streams; polling at 2s is correct on M0 and merely conservative on M10+. **At H1, open the sandbox link, log the cluster tier, and decide D2 then**: stay on polling (default, safe), or swap to change-stream subscriptions (15 min job, more impressive sub-second flip). Demo never blocks on either choice.

---

## 2. Data model

All collections live in database `2chain`. All `_id` are MongoDB ObjectIds unless stated.

### 2.1 `tools`

```typescript
interface Tool {
  _id: ObjectId;
  name: string;                    // "pdf-extractor"
  version: string;                 // semver "3.1.2"
  author_agent_id: string;         // FK → agents._id
  capability_text: string;         // human description, embedded
  capability_embedding: number[];  // voyage-3 vector, 1024 dim, pre-computed
  input_contract: JSONSchema;      // full draft-2020-12 schema object
  output_contract: JSONSchema;
  output_repair_strategy: 'llm' | 'fail-fast';
  endpoint_stub_name: string;      // key into in-process stub registry
  metadata: {
    cost_per_call_usd: number;     // declared by author, not measured
    p95_latency_ms: number;        // declared by author
    reliability_score: number;     // 0..1, written by eval runner
    last_eval_run: Date;
    last_eval_run_id: ObjectId;    // FK → eval_runs._id
  };
  status: 'pending' | 'active' | 'deprecated' | 'circuit_broken';
  created_at: Date;
}
```

**Insert invariant** (A1 fix — closes the eval race window): every new tool doc is inserted with `status: 'pending'` and `metadata.reliability_score: 0`. The eval runner is the only writer that flips `status` to `'active'` (eval passed `>=` `CIRCUIT_BREAK_THRESHOLD`) or `'circuit_broken'` (below threshold). Discovery filters `status === 'active'`, so pending tools are invisible until evaluation completes.

**Indexes**:
- `{name: 1, version: 1}` unique
- `{name: 1, "metadata.reliability_score": -1}` for "latest version of X"
- `tools_capability_idx` Atlas Vector Search index (see 3.1)

### 2.2 `evals`

```typescript
interface EvalCase {
  _id: ObjectId;
  capability_domain: string;       // "pdf-extraction" | "summarisation" | "code-review"
  case_id: string;                 // "financial-numbers" — stable, referenced in code
  input: any;                      // shape matches the domain's input_contract
  expected_output_grader: {
    type: 'json_schema' | 'regex' | 'numeric_tolerance' | 'exact';
    config: any;                   // grader-specific config (schema obj, regex string, etc.)
  };
  weight: number;                  // for weighted pass-rate (default 1)
  is_secret: boolean;              // false for hackathon; future: held-out
  created_at: Date;
}
```

**5 cases per capability_domain max for the hackathon.** Three domains pre-seeded: `pdf-extraction`, `summarisation`, `code-review`. So 15 `evals` rows total in the seed.

**Pre-computed `eval_runs` row count (Fix 11)**: not 4, not 6. **Five.** One row per tool that ships at H1 with `status: 'active'`:

| Tool seeded at H1 | Pre-computed `eval_runs` row | reliability_score |
|---|---|---|
| `pdf-extractor v3.0` | yes (5/5 pass) | 1.0 |
| `pdftools-pro v2.0` | yes (4/5 pass) | 0.8 |
| `summariser-mini-v1` | yes (5/5 pass) | 1.0 |
| `code-review-mini-v1` | yes (5/5 pass) | 1.0 |
| `malformed-bot-v1` | yes (synthetic — see note below) | 1.0 |
| `pdf-extractor v3.1` | NOT seeded; gets created live during Beat 2 | n/a until pushed |

`malformed-bot-v1`'s pre-computed eval row is synthetic: it asserts that the stub returns a string of length > 0, which it always does. The eval doesn't catch the schema mismatch — that's deliberate, because Beat 4 is about *contract violation at call time*, not eval time. This is documented in §6 and stays out of the Q&A unless asked.

### 2.3 `eval_runs`

```typescript
interface EvalRun {
  _id: ObjectId;
  tool_id: ObjectId;               // FK → tools._id
  tool_name: string;               // denormalised for cheap query
  tool_version: string;
  triggered_at: Date;
  triggered_by: 'push' | 'manual' | 'scheduled';
  cases: Array<{
    case_id: string;
    pass: boolean;
    error?: string;                // grader's diagnostic on fail
    latency_ms: number;
    cost_usd: number;
  }>;
  pass_count: number;
  total_count: number;
  pass_rate: number;               // pass_count / total_count
  duration_ms: number;
}
```

**Indexes**: `{tool_id: 1, triggered_at: -1}` for "latest run for this tool".

### 2.4 `violations`

```typescript
interface Violation {
  _id: ObjectId;
  tool_id: ObjectId;
  tool_name: string;
  tool_version: string;
  agent_id: string;                // FK → agents._id (the caller)
  call_id: string;                 // correlation ID across retry chain
  attempt: number;                 // 1, 2, 3
  stage: 'input' | 'output';
  raw_response?: any;              // null for input violations
  schema_errors: Array<{path: string; message: string}>;
  repaired: boolean;               // true if LLM-repair fixed it on a later attempt
  occurred_at: Date;
}
```

Append-only. Surfaced in the contract violation viewer (Beat 4).

### 2.5 `usage`

```typescript
interface Usage {
  _id: ObjectId;
  tool_id: ObjectId;
  agent_id: string;
  call_id: string;
  query_capability_text?: string;  // null if direct call (not via /discover)
  outcome: 'ok' | 'circuit_broken' | 'violation' | 'timeout';
  latency_ms: number;
  occurred_at: Date;
}
```

For roadmap: blend usage-derived reliability with eval-derived reliability.

### 2.6 `rankings`

Cache only. Recomputed on every `/discover` call when stale. Saturday: simplest path is **don't cache, recompute on each query**. Promote to cache only if perf is a problem (it won't be at demo scale).

```typescript
interface RankingCacheEntry {
  _id: ObjectId;
  query_capability_text: string;   // the cache key (or its hash)
  query_embedding_hash: string;
  top_n: Array<{tool_id: ObjectId; score: number; reliability: number}>;
  computed_at: Date;
  ttl_seconds: number;             // 60 default
}
```

### 2.7 `agents`

```typescript
interface Agent {
  _id: string;                     // human-readable id, e.g. "demo-pdf-agent"
  name: string;
  api_key_hash: string;            // bcrypt of the raw key
  role: 'caller' | 'tool_author' | 'admin';
  created_at: Date;
}
```

3 pre-seeded agents for the demo:
- `demo-pdf-agent` (caller)
- `demo-coder-agent` (caller, stretch beat 4 only)
- `demo-tool-author` (tool_author + admin, used by the on-stage push)

Raw keys live in `.env` and Saturday-morning fixtures only.

---

## 3. Atlas Vector Search

### 3.1 Index definition

`tools_capability_idx` on `tools` collection:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "capability_embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "metadata.reliability_score"
    },
    {
      "type": "filter",
      "path": "status"
    },
    {
      "type": "filter",
      "path": "metadata.cost_per_call_usd"
    },
    {
      "type": "filter",
      "path": "metadata.p95_latency_ms"
    }
  ]
}
```

**Critical gotcha**: filter paths must be declared at index-creation time. You cannot add `cost_per_call_usd` as a filter post-build. List all four explicitly when creating the index Saturday H1.

Created via:

```typescript
await db.collection('tools').createSearchIndex({
  name: 'tools_capability_idx',
  type: 'vectorSearch',
  definition: { fields: [...] }
});
```

### 3.2 Readiness check

After creation, poll `db.tools.aggregate([{$listSearchIndexes: {}}])` until `queryable: true`. Or call a cheap `$vectorSearch` and check it returns a cursor without "index not ready" error. **Block H2 work until this passes.**

### 3.3 Discovery query (the `/discover` endpoint)

Pseudocode:

```typescript
async function discover(query: string, agentId: string, top: number = 5) {
  const queryEmbedding = await getQueryEmbedding(query);  // pre-cached if possible
  const results = await db.collection('tools').aggregate([
    {
      $vectorSearch: {
        index: 'tools_capability_idx',
        path: 'capability_embedding',
        queryVector: queryEmbedding,
        numCandidates: 50,
        limit: top * 6,                      // over-fetch (multiple versions per tool) then group + re-rank
        filter: {
          'status': { $eq: 'active' },
          'metadata.reliability_score': { $gte: 0.80 }   // HARD GATE
        }
      }
    },
    {
      $project: {
        name: 1, version: 1, capability_text: 1,
        endpoint_stub_name: 1,
        metadata: 1,
        vec_score: { $meta: 'vectorSearchScore' }
      }
    },
    // D33 (locked at H1): vec_score relevance gate. Voyage-3's similarity floor for
    // AI-tool-vs-AI-tool descriptions is ~0.55-0.65 regardless of topic separation.
    // Without this gate, off-topic tools at rel=1.0 (composite ~0.84) outrank
    // on-topic tools at rel=0.8 (composite ~0.81). Standard semantic-search hygiene.
    { $match: { vec_score: { $gte: 0.70 } } },
    {
      $addFields: {
        rank_score: {                                             // Fix 7: latency dropped from ranking
          $add: [                                                 // for demo determinism. Latency is
            { $multiply: [ '$vec_score', 0.4 ] },                 // displayed but not scored.
            { $multiply: [ '$metadata.reliability_score', 0.6 ] }
          ]
        }
      }
    },
    // A4: dedupe by tool name — the highest-scoring version per name wins.
    // Without this, an old + new version of the same tool can both appear in results.
    { $sort: { rank_score: -1 } },
    {
      $group: {
        _id: '$name',
        best: { $first: '$$ROOT' }
      }
    },
    { $replaceRoot: { newRoot: '$best' } },
    { $sort: { rank_score: -1 } },
    { $limit: top }
  ]).toArray();
  return results;
}
```

**Why over-fetch then re-rank**: `$vectorSearch`'s `limit` is greedy on similarity only. We re-sort by the composite score afterwards. With `numCandidates: 50` and a hard filter, M0 returns this in <100ms.

**Pre-cache query embeddings**: the demo asks "Extract tables from this financial report PDF" verbatim. Pre-embed Saturday morning. Voyage never called live.

### 3.4 Hard reliability gate — why it matters for Beat 2

Original ranking weights `0.5/0.3/0.1/0.1`: a 25-point reliability drop only moves total score by `0.075`. Vector similarity dominates and the bad tool stays #1 on stage.

New: weight `0.6` + hard filter `>= 0.80`. The bad tool (60% after the eval run) gets *excluded by the filter*, not just outranked. **Deterministic flip.** Confirmed by the math (A2 fix: 5 binary cases quantise pass-rate to multiples of 0.2, so we use round numbers throughout the demo):

**Seeded vector_score targets** (Fix 7 — ordering must be provable, not vibes-based). Saturday H1, immediately after capability_text is finalised, embed each tool through Voyage and verify the produced cosine similarities to the demo query land in these target bands. If they don't, adjust capability_text wording during H1 and re-embed. Targets:

| Tool | reliability | vec_score (target) | composite = 0.4·vec + 0.6·rel |
|---|---|---|---|
| `pdf-extractor v3.0` | 1.0 | 0.95 | **0.98** ← #1 |
| `pdftools-pro v2.0` | 0.8 | 0.92 | **0.85** ← #2 |
| `pdf-extractor v3.1` (after push) | 0.6 | 0.95 | 0.74 ← **excluded by 0.80 gate** |
| `summariser-mini-v1` | 1.0 | 0.30 | (different domain — irrelevant for this query) |
| `code-review-mini-v1` | 1.0 | 0.20 | (different domain — irrelevant for this query) |
| `malformed-bot-v1` | 1.0 | 0.20 | (different domain — irrelevant for this query) |

**Worst-case tolerance**: even if Voyage embedding produces ±0.05 jitter on the vec_scores at runtime, v3.0's composite (0.98 − 0.02 = 0.96) still beats pdftools-pro's worst case (0.85 + 0.02 = 0.87). Determinism holds across realistic embedding noise.

The on-stage flip:
- Before push: `pdf-extractor v3.0` (1.0/0.95) → composite 0.98 → #1; `pdftools-pro v2.0` (0.8/0.92) → composite 0.85 → #2
- After push: `pdf-extractor v3.1` (0.6/0.95) → **fails the 0.80 filter** → absent from results
- Dedupe by name (A4) keeps only one version of `pdf-extractor` in results — `v3.0` stays #1, `pdftools-pro v2.0` stays #2

**If the seeded vec_scores don't materialise** during Saturday H1 (Voyage gives different similarity than expected), the rank_score formula still works — just the ordering may need a small reliability tweak to compensate. Verify in H2.

Tested by precomputed dry-run in DEMO.md.

**Stage-language discipline (Fix 1)**: a tool that drops below the reliability gate (`< 0.80`) is **"reliability-gated"**, NOT "circuit-broken." Circuit-broken is reserved for Beat 4 (contract violations cause status flip to `'circuit_broken'`). Beat 2's v3.1 stays `status: 'active'` but is excluded from `/discover` results by the filter. The two are different states with different recovery paths:

| State | Trigger | DB field | Recovery |
|---|---|---|---|
| Reliability-gated | Eval pass-rate < 0.80 | `status: 'active'`, `reliability_score < 0.80` | Push a new version that passes evals |
| Circuit-broken | 3 contract violations on /call | `status: 'circuit_broken'` | Manual `/admin/uncircuit` |

DEMO.md script must say "filtered out by the reliability gate" for Beat 2 and "circuit-broken" only for Beat 4.

---

## 4. Eval harness

### 4.1 Push → eval flow (synchronous, no streams)

```
2chain push pdf-extractor@3.1.json
        │
        ▼
POST /push
  - validate tool.json schema (JSON Schema for the tool doc itself)
  - check api_key role == tool_author
  - check name+version not already exists
  - if name exists: must match author_agent_id (no impersonation)
        │
        ▼
db.tools.insertOne({                              ← A1: status='pending', score=0
  ...,
  status: 'pending',
  metadata: { reliability_score: 0, ... }
})
        │
        ▼
EvalRunner.run(tool)        ← INLINE, blocks the push response
  Wrapped in: Promise.race([eval, totalTimeout(EVAL_TOTAL_TIMEOUT_MS)])
  - load 5 cases for capability_domain
  - for each case:
      - run stub call wrapped in Promise.race([stub, timeout(EVAL_CASE_TIMEOUT_MS)])
      - timed-out cases auto-fail the grader with error="case_timeout"
      - apply grader → pass/fail
      - record latency, cost
  - compute pass_rate
  - db.eval_runs.insertOne({...})
  - db.tools.updateOne({_id}, {$set: {
        'metadata.reliability_score': pass_rate,
        'metadata.last_eval_run': new Date(),
        'metadata.last_eval_run_id': run._id,
        'status': 'active'                    ← D34 (locked at H3): push always flips to 'active'.
                                              ← Reliability filtering is done by /discover's 0.80 gate.
                                              ← Circuit-break is reserved for /call contract violations only.
                                              ← (Earlier draft incorrectly tied this to CIRCUIT_BREAK_THRESHOLD;
                                              ← contradicts §3.4 table and EVALS Beat 2.)
    }})
  If totalTimeout fires:
  - db.tools.updateOne({_id}, {$set: {status: 'circuit_broken'}})
  - return 504 with { eval_timeout: true }
        │
        ▼
return 200 { tool_id, eval_run_id, pass_rate, status }
```

**Latency budget** (A3): per-case timeout `EVAL_CASE_TIMEOUT_MS = 5000`, total `/push` deadline `EVAL_TOTAL_TIMEOUT_MS = 15000`. 5 cases × ~400ms each = ~2s for the live one. **Cache 4 of 5 cases** by storing precomputed eval_run rows for the bad tool's known input — push only re-runs the financial-numbers case live, well under the 5s per-case budget.

### 4.2 Grader types (deterministic only — no LLM-as-judge for hackathon)

| Grader | Use case | Pass condition |
|---|---|---|
| `json_schema` | Tool returns structured data | Output validates against given JSON Schema |
| `regex` | Tool returns text with a known pattern | Regex matches |
| `numeric_tolerance` | Numeric extraction (financial tables!) | All numbers match expected within `±tolerance` |
| `exact` | Deterministic transformations | Output equals expected string |

The "financial-numbers" case for pdf-extraction uses `numeric_tolerance` with tolerance `0.001`. The bug in v3.1 misformats numbers (e.g. `1,234.56` → `1234,56` via decimal-comma swap). Fails the grader. Pass-rate drops.

### 4.3 Worked sample — `financial-numbers` case (the live one in Beat 2)

This is the only eval case that runs live during the demo. Everything else about it is pre-computed.

```json
{
  "_id": "ObjectId(...)",
  "capability_domain": "pdf-extraction",
  "case_id": "financial-numbers",
  "input": {
    "pdf_text": "Q3 Earnings\n\nRevenue: $1,234.56\nCost of goods: $789.01\nGross margin: $445.55\nOperating expenses: $200.10\nNet income: $245.45"
  },
  "expected_output_grader": {
    "type": "numeric_tolerance",
    "config": {
      "expected": {
        "rows": [
          { "label": "Revenue",            "value": 1234.56 },
          { "label": "Cost of goods",      "value": 789.01  },
          { "label": "Gross margin",       "value": 445.55  },
          { "label": "Operating expenses", "value": 200.10  },
          { "label": "Net income",         "value": 245.45  }
        ]
      },
      "tolerance": 0.001,
      "match_on": "label"
    }
  },
  "weight": 1,
  "is_secret": false
}
```

**Stub behavior**:
- `pdf-extractor-v3` returns the rows correctly. Grader: pass.
- `pdf-extractor-v3.1` returns rows with the decimal-comma swap bug, e.g. `value: 1234`+ a corrupt parse on `,56`. Grader sees `1234 vs 1234.56` → fails tolerance check. **Pass: false** for this case. Combined with 2/4 of the other (pre-cached) cases failing for v3.1, total pass-rate `= 3/5 = 0.6`, which falls below the `0.80` reliability gate.

### 4.4 Test case design (acknowledged weakness)

Tool authors *could* optimise for visible cases. For the hackathon:
- Authors cannot edit `evals` collection (auth role check).
- Cases are public, in-repo, versioned. Seeing them helps everyone equally.
- Held-out / secret cases are roadmap.
- LLM-judge for fuzzy outputs (summarisation) is roadmap. For now: regex + structural checks only.

---

## 5. Contract enforcement runtime (`/call`)

### 5.1 State machine

```
Caller
  │  POST /call { tool_name, version, input, agent_id, api_key }
  ▼
[VALIDATE_INPUT]
  - check api_key against agents
  - load tool
  - check status == 'active'                                ← rejects 'pending' + 'circuit_broken'
  - check reliability_score >= RELIABILITY_GATE             ← Fix 2: closes the direct-call loophole
      - exception: header X-2chain-Bypass-Gate: true allowed if agent.role === 'admin'
      - on fail (and no admin bypass) → 403 with { reason: 'reliability_gate', score, gate }, log usage(outcome='gated')
  - validate input against input_contract (ajv)
  - on fail → 400 + log violation, NO retry, return
  ▼
[FORWARD]
  - call stub(tool.endpoint_stub_name, input)
  - measure latency
  - on stub throw → log usage(outcome=timeout), return 502
  ▼
[VALIDATE_OUTPUT]
  - validate response against output_contract
  - on pass → log usage(outcome=ok), return 200 { result }
  - on fail → goto [REPAIR] if strategy=='llm', else [CIRCUIT_BREAK]
  ▼
[REPAIR]                        (v0.2 — NOT IMPLEMENTED SATURDAY; all live demo tools use 'fail-fast')
                                (only if output_repair_strategy === 'llm')
  attempt = 1
  while attempt <= 3:
    - log violation(attempt, raw_response, schema_errors)
    - call repairLLM(output_contract, raw_response, schema_errors)
    - parse repair output:                                  ← Fix 3: explicit JSON parse path
        try {
          parsed = JSON.parse(repairedText)
        } catch (e) {
          log violation(attempt, raw_response=repairedText, error='repair_invalid_json')
          attempt++; continue                              ← counts as a failed attempt
        }
        if (parsed.repair_failed === true) {
          attempt++; continue                              ← LLM admitted defeat
        }
    - validate parsed against output_contract
    - if pass: log violation(repaired=true), log usage(outcome=ok), return 200
    - attempt++
  ▼
[CIRCUIT_BREAK]
  - db.tools.updateOne({_id}, {$set: {status: 'circuit_broken'}})
  - log usage(outcome=circuit_broken)
  - return 503 + diagnostic for caller
```

For `output_repair_strategy === 'fail-fast'` (deterministic tools), one attempt then straight to `[CIRCUIT_BREAK]`.

**Saturday scope (B-pivot, locked at H0)**: all 5 fixture tools and the on-stage `malformed-bot` are seeded with `output_repair_strategy: 'fail-fast'`. The `[REPAIR]` branch above stays in the spec as v0.2. No LLM client is wired today, no Anthropic/OpenAI dependency in the live demo. DEMO.md Beat 4 already runs fail-fast → circuit-break (lines 143, 200, 212).

### 5.2 LLM repair prompt template (v0.2 reference)

```
The tool {name}@{version} returned a response that does not match
its declared output schema.

Expected schema:
{output_contract}

Tool returned:
{raw_response}

Schema errors:
{schema_errors}

Return ONLY a JSON object that matches the schema. No prose. No
explanation. If the original response cannot be repaired without
fabricating data, return: {"repair_failed": true}.
```

Repair calls go to **Anthropic Haiku** (fast, cheap). Timeout 5s. If `repair_failed: true` is returned, treat as another fail and proceed.

### 5.3 Circuit breaker scope

`(tool_name, tool_version)` globally — not per-agent, not per-contract-field. Simplest defensible scope. Manual override:

```
POST /admin/uncircuit { tool_id }   (admin role required)
```

---

## 6. Tool stub registry

For the hackathon, "tool endpoints" are in-process functions registered by name, **not external HTTPS endpoints**. This is the honest stub story we name in the README.

```typescript
type StubFn = (input: any) => Promise<any>;
const stubs: Record<string, StubFn> = {};

function registerStub(name: string, fn: StubFn) {
  stubs[name] = fn;
}

async function callStub(name: string, input: any): Promise<any> {
  const fn = stubs[name];
  if (!fn) throw new Error(`No stub registered: ${name}`);
  return fn(input);
}
```

Seeded stubs (with target reliability scores from precomputed eval_run rows — A2 round numbers):

| Stub | Domain | Behavior | Target reliability |
|---|---|---|---|
| `pdf-extractor-v3` | pdf-extraction | Returns rows with correct numeric parsing | **1.0** (passes 5/5) |
| `pdf-extractor-v3.1` | pdf-extraction | Same as v3 but decimal-comma swap on numbers; passes 2 non-numeric edge cases live, fails 3 numeric cases | **0.6** (passes 3/5 — below the 0.80 gate) |
| `pdftools-pro-v2` | pdf-extraction | Slightly slower, well-formed; deliberately fails 1 case (e.g. multi-page) | **0.8** (passes 4/5) |
| `summariser-mini-v1` | summarisation | Returns 1-paragraph summary, regex-graded | **1.0** |
| `code-review-mini-v1` | code-review | Returns array of `{file, line, comment}` | **1.0** |
| `malformed-bot-v1` | code-review | **Beat 4 victim** — returns prose instead of JSON. Registered with `output_repair_strategy: 'fail-fast'` so the contract layer circuit-breaks deterministically on the first violation, in 1 attempt. Reliability `1.0` because the eval suite only checks output existence; violation only appears at call time. | **1.0** (eval doesn't catch it) |

Demo never calls a real LLM through these (except the LLM-repair retry in `/call`).

### 6.1 `malformed-bot-v1` worked sample (the Beat 4 violation)

```typescript
// Output contract (declared by the tool author):
const codeReviewSchema = {
  type: 'object',
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'comment'],
        properties: {
          file:    { type: 'string' },
          line:    { type: 'integer' },
          comment: { type: 'string' }
        }
      }
    }
  }
};

// Stub behavior (deterministic):
async function malformedBotV1(input: any) {
  return "Sure! Here's my code review: file auth.ts on line 42 has a bug — the token check returns undefined when the session expires. Also, billing.ts:118 might race-condition on retry. Hope this helps!";
}
```

The output is prose, not JSON. Output-contract validation fails immediately (`expected object, got string`). Because `malformed-bot-v1` is registered with `output_repair_strategy: 'fail-fast'`, no LLM repair runs — the tool circuit-breaks on the first violation. **Beat 4 is deterministic without depending on Anthropic Haiku's behaviour at all.** A separate roadmap demo can show the LLM-repair retry path on a tool that *can* be repaired.

### 6.2 Push CLI output spec (D1 — what the audience sees on stage during Beat 2)

The push CLI prints to stdout in real time as the eval runs. **This is the screen during Beat 2 — design accordingly.**

```
$ 2chain push bad/pdf-extractor-3.1.json
→ pushing pdf-extractor@3.1 to https://localhost:4000
→ auth ok (demo-tool-author)
→ inserted with status=pending, reliability_score=0
→ running 5 eval cases against pdf-extractor@3.1...
  ✗ financial-numbers       (0.82s) — numeric mismatch on "Revenue": got 1234, expected 1234.56
  ✓ single-row              (0.41s)
  ✗ negative-number         (0.39s) — numeric mismatch on "Loss": got NaN, expected -123.45
  ✓ multi-page-text         (0.44s)
  ✗ currency-symbol-strip   (0.40s) — numeric mismatch on "Revenue": got NaN, expected 1000.0
→ pass_rate: 3/5 = 0.6
→ status: active (above circuit-break threshold of 0.5)
→ visibility: ⚠ filtered from /discover (below reliability gate of 0.8)
✓ done in 2.61s

Tool ID: 6634a8f9c2d1e4b8f0a1b2c3
Eval Run ID: 6634a8fac2d1e4b8f0a1b2c4
```

**Failure mode outputs** (negative-path tests in §12 H4 verify):

```
$ 2chain push bad/pdf-extractor-3.1.json     # bad api_key
✗ unauthorized: check .2chain/key  (HTTP 401)

$ 2chain push bad/pdf-extractor-3.1.json     # name+version exists
✗ pdf-extractor@3.1 already registered  (HTTP 409)
  Hint: bump the version in the json file or use `2chain push --force` (admin only)

$ 2chain push bad/pdf-extractor-3.1.json     # author_agent_id mismatch
✗ forbidden: only the original author can push new versions of `pdf-extractor`  (HTTP 403)

$ 2chain push bad/pdf-extractor-3.1.json     # eval timeout
✗ eval exceeded EVAL_TOTAL_TIMEOUT_MS=15000  (HTTP 504)
  Tool was inserted but flipped to circuit_broken. Inspect with `2chain logs pdf-extractor`.
```

**Implementation note**: stdout uses `chalk` (or equivalent) for colour. ✓ green, ✗ red, ⚠ yellow. The pass/fail per-case lines stream as the eval runner completes each one — don't batch. ~30 min of polish in H4.

---

## 7. Auth & agent identity

### 7.1 Push protection

```
2chain push tool.json
  → reads .2chain/key (api_key)
  → POST /push { tool_doc } with header X-2chain-Key: <key>
  → server: bcrypt.compare(key, agent.api_key_hash)
  → server: agent.role must be 'tool_author' OR 'admin'
  → server: if name already exists, agent._id must equal existing tool.author_agent_id
```

### 7.2 Call protection

Any agent role can call `/call`. Agent identity is logged in `usage` and `violations`.

### 7.3 Admin ops (eval edits, uncircuit, deprecate)

Restricted to `role === 'admin'`. Only `demo-tool-author` has admin in the demo.

### 7.4 What we do NOT do (and say so on stage)

- No signed manifests
- No sandbox execution
- No rate limiting per agent
- No key rotation

All roadmap. Disclosed in the README's Q&A cheat sheet.

---

## 8. Dashboard (the visible UI)

Single React page. Two panels:

1. **Top-N rankings** for the demo's canonical query (`DEMO_AGENT_QUERY`, the literal env value — no trailing punctuation). Polls `GET /rankings?q=<encoded>` every 2s. Renders tool name + version + reliability bar (red < 0.80, green ≥ 0.80) + score. **(Fix 6)** Empty result set renders as: `"No tools meet the reliability bar for this capability — N candidates excluded by gate (lowest reliability X.XX)."` — explicit, not silent. The `/rankings` endpoint must include `excluded_count` and `excluded_min_reliability` in the response when results are empty.
2. **Recent eval_runs** (last 10). Polls `GET /eval_runs?limit=10` every 2s. Each row: tool, version, pass rate, duration.

Optional third panel for Beat 4: **Recent violations** (last 5).

No charts. No animations. No filtering. Built in 30 minutes Saturday H6.

---

## 9. Configuration surface (`.env`)

```
MONGODB_URI=mongodb+srv://user:pass@cluster.xxx.mongodb.net/2chain
MONGODB_DB=2chain

# A7: connection pool + transient retry for M0 throttling
MONGO_MAX_POOL_SIZE=5
MONGO_RETRY_ATTEMPTS=3
MONGO_RETRY_BASE_MS=250            # exponential backoff base; doubles each attempt

VOYAGE_API_KEY=...                 # only used pre-event for embedding
ANTHROPIC_API_KEY=...              # only used by repairLLM in /call

PORT=4000
NODE_ENV=development           # Fix 8: keep dev stack traces visible during the hackathon

CIRCUIT_BREAK_THRESHOLD=0.50       # below this pass_rate, auto circuit-break on push
RELIABILITY_GATE=0.80              # the hard filter in /discover
RANKING_TOP_N=5
DASHBOARD_POLL_MS=2000
DISCOVER_QUERY_CACHE_TTL=300       # seconds; demo query is pre-cached anyway

# A3: eval timeouts
EVAL_CASE_TIMEOUT_MS=5000          # per-case timeout; case auto-fails on timeout
EVAL_TOTAL_TIMEOUT_MS=15000        # total /push deadline; if hit, tool flips to circuit_broken

# A6: demo agent literal query (hard-coded, never LLM-rewritten).
# IMPORTANT (Fix 8): this string MUST exactly match the pre-cached embedding key
# Saturday morning. Trailing punctuation and capitalisation are part of the key.
# Pre-cache step: pre-embed THIS exact string and store under
# embeddings_cache[hash(DEMO_AGENT_QUERY)].
DEMO_AGENT_QUERY="Extract tables from this financial report PDF"

# Repair LLM
REPAIR_LLM_MODEL=claude-haiku-4-5-20251001
REPAIR_LLM_TIMEOUT_MS=5000

DEMO_FAULT_INJECTION=false         # when true, force pdf-extractor-v3.1 to fail more
```

**MongoDB client init** (A7):
```typescript
const client = new MongoClient(MONGODB_URI, {
  maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE || '5'),
  retryWrites: true,
  retryReads: true,
});
// Wrap every db operation in a retry helper:
async function withRetry<T>(op: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await op(); }
    catch (e: any) {
      const transient = e.code === 16500 || e.code === 8000 || e.codeName === 'ShutdownInProgress';
      if (!transient || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 250 * Math.pow(2, i)));
    }
  }
  throw new Error('unreachable');
}
```

### 9.1 Validation libraries (C1 — pin them)

- **`ajv`** (`^8.x`): JSONSchema validation in `/call` (input + output contracts) and in eval graders of type `json_schema`. Compiled validators cached per (tool_name, version, direction).
- **`zod`** (`^4.x`): LangGraph state schemas (`StateSchema`). Do not use `zod` for tool I/O — keep schema authoring in plain JSONSchema so tool authors don't need to learn zod.

These two libraries don't fight each other; they live in different lanes (state vs wire).

---

## 10. Error budget per dependency

| Dependency | Failure mode | Mitigation | Cost if it fails on stage |
|---|---|---|---|
| MongoDB Atlas Sandbox (tier TBD until H1 email link) | Connection drop, throttle, index not ready, ops-per-sec cap if M0 | Connection retry with backoff, readiness check at H2, hotspot fallback. **First H1 action**: open sandbox email + record tier in `.env` so subsequent decisions (polling vs streams) are tier-aware. | Demo dies. Fall back to recorded video. |
| Atlas Vector Search index | Slow build, "index not ready" error | Build at H1, readiness check, fail H2 if not ready and triage | Lose ~1h, demo still possible if cached embeddings + manual top-N |
| Voyage AI | Rate limit, latency, outage | **Out of live path.** Pre-embed Saturday morning. | Zero impact — never called live |
| Anthropic Haiku (repair) | Timeout, rate limit | Used only in Beat 4. If down, Beat 4 cuts to "fail-fast" branch — circuit-break in 1 attempt, still a clean demo | Beat 4 looks slightly less magical. Spine intact. |
| Fireworks AI | Not used in demo path | n/a | n/a |
| LangSmith | Observability only | If down, lose tracing visibility, demo proceeds | Zero stage impact |
| AWS | Hosting infra (if deployed) | Can run locally on Saturday — AWS is only required for *finalist* eligibility | Zero stage impact |
| Venue WiFi | Unreliable | Cellular hotspot fallback. Demo is mostly localhost-to-Atlas anyway. | Demo proceeds on hotspot |
| Demo agent (LangGraph) bug | Bug in agent logic | Pre-recorded fallback video | Lose live demo, recover with video |

**Hard rule**: if any external API is down at H7, cut Beat 4 (contract enforcement) entirely and demo Beats 1-3 only.

---

## 11. Sequence diagrams

### 11.1 Beat 1 — Discovery + first call

```
Agent             /discover         /call            stub
  │                  │                │                │
  │── query ──────► │                │                │
  │                  │── $vecSearch  │                │
  │                  │── filter+rank │                │
  │ ◄── top-5 ──────│                │                │
  │                                  │                │
  │── call(top1) ─────────────────► │                │
  │                                  │── input valid │
  │                                  │── stub call ─►│
  │                                  │ ◄── result ──│
  │                                  │── output v.   │
  │                                  │── log usage  │
  │ ◄── result ─────────────────────│                │
```

### 11.2 Beat 2 — Bad push + rerank

```
ToolAuthor       /push          EvalRunner        DB
  │               │                  │              │
  │── push v3.1 ►│                  │              │
  │               │── auth check    │              │
  │               │── insert tool ─────────────────►
  │               │── run evals ───►│              │
  │               │                  │── load cases◄│
  │               │                  │── exec stub │
  │               │                  │── grade     │
  │               │                  │── insert run──►
  │               │                  │── update tool──►  (reliability=0.6, status='active')
  │               │ ◄── pass_rate ──│              │
  │ ◄── 200 ──────│                  │              │

Dashboard (in parallel, polling every 2s)
  │── GET /rankings ──────────────────────────────► /discover
  │                                                  │── $vecSearch
  │                                                  │── filter (>=0.80) excludes v3.1
  │ ◄── new top-N (v3.1 gone) ─────────────────────│
```

### 11.3 Beat 4 — Contract violation + circuit break

```
Agent          /call          stub(malformed-bot)    repairLLM
  │              │                  │                    │
  │── call ────►│                  │                    │
  │              │── input valid    │                    │
  │              │── stub call ───►│                    │
  │              │ ◄── prose       │                    │
  │              │── output FAIL    │                    │
  │              │── log violation │                    │
  │              │── repair (1) ──────────────────────►│
  │              │ ◄── still bad ─────────────────────│
  │              │── repair (2) ──────────────────────►│
  │              │ ◄── still bad ─────────────────────│
  │              │── repair (3) ──────────────────────►│
  │              │ ◄── still bad ─────────────────────│
  │              │── circuit-break tool                 │
  │              │── log usage(circuit_broken)          │
  │ ◄── 503 ────│                                       │
  │── /discover (new query) ────► [tool now filtered out by status != 'active']
  │ ◄── different tool ──────────│
```

---

## 12. Hour-by-hour build plan (engineer-side)

| Hour | Build | Verify |
|---|---|---|
| H1 | **Step 0 (do FIRST, blocks everything)**: open the Atlas Sandbox email link, accept the project invite, allowlist `0.0.0.0/0` (lock down post-event), record the cluster tier in `.env` as `ATLAS_TIER=`, also redeem the $50 LangSmith credits at https://chat.langchain.com/. **Step 1**: connect to MongoDB, create `tools` collection, **call `db.tools.createSearchIndex(...)`**. Start polling `$listSearchIndexes` for `queryable: true`. **Step 2 (in parallel while index builds)**: `git init`, scaffold Node project, retry helper + pool=5, create remaining collections, register seed tools with pre-computed embeddings (run Voyage embedding NOW, post-init), write 5 pre-computed eval_run rows. | Index status `queryable: true` BEFORE H2 starts. `db.tools.find({status:'active'}).count() === 5`. `db.eval_runs.find({}).count() === 5`. `curl /health` returns 200. `.env` includes `ATLAS_TIER` value. |
| H2 | `/discover` endpoint with `$vectorSearch` + composite ranking + `$group` dedupe-by-name | `curl /discover?q="Extract tables..."` returns top-5; `[0].name === 'pdf-extractor'` and `[0].metadata.reliability_score === 1.0`; latency < 200ms locally. **Negative test**: `curl /discover?q="something nobody offers"` returns `[]` with status 200, not 500. |
| H3 | LangGraph agent that hits `/discover` then `/call`. Tool stub registry with 6 stubs. `/call` happy path (no contracts yet). Demo agent has `DEMO_AGENT_QUERY` hard-coded as the first node. | `curl /call -d '{tool_name:"pdf-extractor", version:"3.0", input:<sample>}'` returns the 5 expected rows. |
| H4 | `/push` endpoint with synchronous EvalRunner (case + total timeouts). Dashboard polling (2s). | `2chain push pdf-extractor@3.1.json` flips dashboard within 3s; v3.1 disappears from `/rankings`. **Negative tests**: (a) push with bad api_key → 401 + violation logged; (b) re-push same `name+version` → 409; (c) push with author_agent_id mismatch → 403. |
| H5 | **Demo spine working without contracts.** Rehearse Beats 1-3. | Three full takes of Beats 1-3 in <2:15 |
| H5.5 | **Decision point.** If H5 demo is rehearsing cleanly, build contracts. If not, freeze and polish. | Go/no-go on Beat 4 |
| H6 (if go) | Contract enforcement in `/call`. LLM repair. Circuit break. | Beat 4 demoable end-to-end. **Negative test**: `curl /call -d '{tool_name:"malformed-bot", version:"1.0", ...}'` triggers 3 repair failures → tool flips to `circuit_broken` → next `/call` returns 503; subsequent `/discover` excludes it. |
| H6 (if no-go) | Polish dashboard, film fallback video, write submission text. | Dashboard looks clean |
| H6.5 | Full rehearsal #1 | Hits 2:45 mark |
| H7 | Bug fixes. Rehearsal #2. | Cleaner takes |
| H7.5 | Rehearsal #3. **Film the fallback video on this take.** | Have a backup recording |
| H8 | Submit. | Submission accepted by portal |

---

## 13. Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| D1 | Single Node service, in-process stubs | 6.5h budget; real hosting is roadmap |
| D2 | No change streams; polling everywhere (2s) | M0 reliability; deterministic on stage |
| D3 | Vector ranking weights `0.4/0.6/0/0.05` + hard reliability gate `>= 0.80` | Makes Beat 2 ranking flip deterministic |
| D4 | Eval = 5 cases per domain, 4/5 pre-computed | Stage determinism > scale theatre |
| D5 | LLM-repair retry default; fail-fast for deterministic tools | Avoid "retry the same broken thing 3x" theatre |
| D6 | Circuit break scope: `(tool_name, version)` globally | Simplest defensible scope |
| D7 | API keys + bcrypt hash, role-based access on push/admin | Demo-grade auth; signed manifests are roadmap |
| D8 | Beat 4 (contracts) is H6 stretch, gated on H5 demo readiness | Discovery + rerank is the spine |
| D9 | Anthropic Haiku for repair LLM | Fast, cheap, sponsor-aligned |
| D10 | Voyage AI never called live; pre-embed everything Saturday morning | Rate-limit and latency risk |
| D11 | Single dashboard page, two panels, no animations | Build in 30 min, doesn't fight the demo |
| D12 | TypeScript + LangGraph + `@langchain/langgraph-checkpoint-mongodb` | Confirmed via context7; matches MCP/agent author audience |
| D13 | All new `tools` docs inserted with `status: 'pending'`, `reliability_score: 0`. Eval runner is the only writer that flips status to `'active'` or `'circuit_broken'`. (A1) | Closes the race window between insert and eval completion |
| D14 | Reliability scores quantised to multiples of 0.2 (5 binary cases). Demo numbers: v3.0 = 1.0, pdftools-pro = 0.8, v3.1 = 0.6. (A2) | What the math actually produces — no fabricated 96%/71% |
| D15 | Per-case timeout `EVAL_CASE_TIMEOUT_MS=5000`, total `/push` deadline `EVAL_TOTAL_TIMEOUT_MS=15000`. (A3) | Prevents a hung stub from freezing the on-stage push |
| D16 | `/discover` aggregation includes `$group: { _id: '$name', best: { $first: '$$ROOT' } }` — one row per tool name. (A4) | Dashboard ranking ticker shows one entry per tool, not one per version |
| D17 | Demo agent's `/discover` query is the literal `DEMO_AGENT_QUERY` env string, hard-coded in the first LangGraph node. No LLM rewrite. (A6) | Pre-cached embedding stays warm; Voyage never called live |
| D18 | MongoDB client `maxPoolSize: 5` + transient-error retry helper (3 attempts, exponential backoff). (A7) | M0 throttle resilience |
| D19 | `ajv` for JSONSchema I/O contract validation; `zod` for LangGraph state schemas only. (C1) | One library per lane, no overlap |
| D20 | Stage language: tools below 0.80 are "reliability-gated" (active + filtered). Tools that fail 3 contract checks are "circuit-broken" (status flip). DEMO.md mirrors this. (Fix 1) | Two distinct states need two distinct words |
| D21 | `/call` enforces `reliability_score >= RELIABILITY_GATE` with admin bypass header. (Fix 2) | Closes the direct-call-by-name loophole on a gated tool |
| D22 | Repair LLM output is wrapped in `JSON.parse` try/catch; parse failures count as a failed attempt (3 strikes total). (Fix 3) | Prevents 500 errors on malformed repair text |
| D23 | Empty `/discover` results render an explicit "N candidates excluded by gate" message in the dashboard. (Fix 6) | Silence on stage looks like a bug |
| D24 | Latency dropped from ranking math (weight 0.0). Composite = `0.4·vec_score + 0.6·reliability`. Seeded vec_scores documented in §3.4 with proven ordering tolerance. (Fix 7) | Latency at original weight could swap top-1 by accident |
| D25 | `NODE_ENV=development` for the demo; `DEMO_AGENT_QUERY` cache key has no trailing punctuation. (Fix 8) | Stack traces visible; cache hits guaranteed |
| D26 | H1 starts with `createSearchIndex` (longest async dep), then scaffolds in parallel while polling `queryable`. (Fix 9) | Atlas index alone can consume the hour if blocking |
| D27 | 5 pre-computed `eval_runs` rows seeded at H1 (one per active tool). v3.1 is created live during Beat 2. (Fix 11) | Removes inconsistency between stubs count and eval rows count |
| D28 | Push CLI streams per-case ✓/✗ output to stdout in real time, with chalk colour and concrete error reasons. (DX-D1) | This output IS the screen during Beat 2 — design the CLI for the audience |
| D29 | README ships a "Quick Start" block showing `@2chain/cli` and `@2chain/client` import surfaces. Marked "post-hackathon — coming soon." (DX-D2) | Answers the "show me the npm package" judge question without lying |
| D30 | All HTTP endpoints return `{ok, data}` or `{ok, error: {code, message, details}}` envelopes. Five-line `respond()` helper. (DX-D3) | Machine-discriminable error codes; no prose-parsing |
| D31 | Beat 3 narrative is **protection from regression**, not new-winner reranking. Stage script + README + EVALS CE-3 all aligned on this. (Codex E) | The system filters; it does not rerank. The story must match. |
| D32 | Hard rule: nothing executable lives in the `2chain` repo before Saturday 9am `git init`. Specs only. Voyage embeddings, fixture JSON, env files, expect scripts all author Saturday H1. (Codex D) | Hackathon rule: demo must show only what was built during the event |

---

## 14. Open questions (to resolve this week or during build)

- **Q1**: Tool-author key distribution for the on-stage push — hard-code in fixtures or generate on the day? *(Lean: hard-code in fixtures, simpler.)*
- **Q2**: Single-node deploy or actually push to AWS? *(Lean: localhost during demo, AWS deploy during judging if time. Finalist round is the AWS-required moment.)*
- **Q3**: Submission video script (1 min) — separate from live demo. Re-use the 3-min cold open? *(Lean: tighter cut of the 3-min video.)*
- **Q4**: Branding. Just "2chain" wordmark? *(Lean: yes, time-cheap.)*
- **Q5**: If two MongoDB collections genuinely thrash on M0 ops/sec, which collection do we drop? *(Lean: drop `usage` writes for the demo, keep eval_runs and violations.)*

---

## 15. Out of scope (explicit)

These are *not* shipping Saturday and the README's roadmap reflects that:

- Multi-tenant private registries
- Real tool-endpoint hosting (Lambda / external HTTPS)
- LLM-as-judge graders
- Held-out / secret eval cases
- Tool-author monetisation
- Capability composition (chained tools)
- Signed manifests / sandbox execution
- Rate limiting per agent
- Key rotation
- Webhook-based ranking propagation
- LangSmith trace integration beyond the trivial setup
- **ElevenLabs voice integration**: the hackathon offers a side prize for "Best Project Built with ElevenLabs" ($1980/team member, 6 months Scale tier). 2chain has no voice in its narrative. Adding voice at H6 would be scope creep against the spine. The obvious play if voice were in scope: agent reads the discovered tool name aloud before calling. ~30 min of work, but not worth the H6 risk. Skip.
- Other partner toolkits available but unused: Emergent, Factory, LiveKit, NVIDIA NemoClaw, Replit. None map to the discovery + contracts + evals story.
- **Re-eval on `/admin/uncircuit`**: manual uncircuit currently flips `status` back to `'active'` without forcing a fresh eval. A tool can be quarantined-then-resurrected without proving the underlying issue is fixed. **Roadmap**: uncircuit triggers a fresh inline eval before flip.
- **Concurrent same-name push protection**: two simultaneous pushes of *different versions* of the same tool both flip `'active'` independently. Dashboard ordering can briefly look confusing during the race window. **Roadmap**: per-name pessimistic lock around `/push`.

If a judge asks about any of these, the answer is: "Roadmap. The hackathon scope was deliberately the four core beats."
