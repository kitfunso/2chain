# 2chain — EVALS

> **Historical (v1, May 2026 hackathon).** The live quality gates are now `npm run eval:golden` (NDCG@3 / Recall@3 / top-1 floors, see CLAUDE.md rule 14) and the real-DB suite in `tests/`. Tool eval suites also re-run continuously via `/v1/reverify`.

Two layers of evals live in this project. **Don't conflate them.**

| Layer | What it evaluates | Where it lives | When it runs |
|---|---|---|---|
| **System evals** | Does 2chain itself behave correctly? Discovery returns the right tool. Push flips reliability. Contract layer circuit-breaks. | This file (§1, §2). Code lives in `tests/system/` Saturday. | H4-H7 rehearsals; submission video |
| **Tool eval fixtures** | Does the registered *tool* produce correct output for a given input? | This file (§3). Loaded into the `evals` MongoDB collection at H1. | Inline in `/push`; on-stage Beat 2 |

Locked to DESIGN.md decisions D1–D27.

---

## 1. System capability evals (the demo's success criteria)

Each beat is a capability eval. Pass = stage-deterministic. Fail = scope-cut or fix.

### CE-1 — Beat 1: Discovery returns reliability-aware top-1

```
[CAPABILITY EVAL: beat-1-discovery]
Success Criteria:
  - [ ] /discover with DEMO_AGENT_QUERY returns 200 with non-empty results
  - [ ] results[0].name === "pdf-extractor"
  - [ ] results[0].version === "3.0"
  - [ ] results[0].metadata.reliability_score === 1.0
  - [ ] results[1].name === "pdftools-pro"
  - [ ] results length is between 1 and 5 (after dedupe-by-name)
  - [ ] no result has reliability_score < 0.80
  - [ ] latency p95 < 200ms over 5 sequential calls
Grader: code-based (curl + jq assertions, run via shell script tests/system/beat1.sh)
Target: pass^5 (all 5 takes pass)
```

### CE-2 — Beat 2: Push + reliability-gate flip is deterministic in <3s

```
[CAPABILITY EVAL: beat-2-push-flip]
Success Criteria:
  - [ ] 2chain push pdf-extractor@3.1.json returns 200 within 5s wall-clock
  - [ ] response includes pass_rate === 0.6 and status === 'active'
  - [ ] db.tools.find({name:'pdf-extractor', version:'3.1'}).reliability_score === 0.6
  - [ ] /rankings poll N+1 (within 3s) returns top-N WITHOUT pdf-extractor v3.1
  - [ ] pdf-extractor v3.0 is still #1 in /rankings
  - [ ] dashboard renders the change visibly
Grader: code-based (push CLI + curl /rankings before/after + jq diff)
Target: pass^5
```

### CE-3 — Beat 3: The agent never saw the regression

```
[CAPABILITY EVAL: beat-3-protection]
Success Criteria:
  - [ ] After Beat 2 has flipped, /discover with DEMO_AGENT_QUERY returns 200
  - [ ] results[0].name === "pdf-extractor" AND version === "3.0" (unchanged from Beat 1)
  - [ ] results[1].name === "pdftools-pro" AND version === "2.0" (unchanged from Beat 1)
  - [ ] No version of pdf-extractor with reliability < 0.80 appears
  - [ ] Eval-runs panel visibly shows the v3.1 failed run (this is the proof on stage)
Grader: code-based
Target: pass^5

Stage framing: this beat proves PROTECTION FROM REGRESSION, not new-winner reranking.
The agent's results are unchanged. That is the win — the registry filtered out the bad
version before any agent saw it. Every agent in the system is now protected.
```

### CE-4 — Beat 4: Contract violation circuit-breaks the tool

```
[CAPABILITY EVAL: beat-4-circuit-break]
Success Criteria:
  - [ ] /call {tool: "malformed-bot", version: "1.0", ...} returns 503 within 8s
  - [ ] Exactly 3 violations logged with attempt: 1, 2, 3
  - [ ] db.tools.find({name:'malformed-bot'}).status === 'circuit_broken'
  - [ ] subsequent /discover does NOT include malformed-bot
  - [ ] response body has reason: 'circuit_broken' and tool_id
Grader: code-based
Target: pass^3 (only need to demo this once on stage; 3 takes is enough rehearsal)
```

### CE-5 — Cold open hook lands

```
[CAPABILITY EVAL: cold-open-narrative]
Success Criteria:
  - [ ] Cold open (00:00-00:20) hits MCP-registry + Smithery hook
  - [ ] Architecture diagram visible by 00:15
  - [ ] No more than 25 spoken seconds (room for breath)
Grader: human-based — DEMO.md script + stopwatch in rehearsal
Target: pass^3 in rehearsals 1-3
```

---

## 2. System regression evals (what must not break Saturday H6+)

These run automatically in `tests/system/regression.sh` after every code change post-H5.

```
[REGRESSION EVAL: 2chain-spine]
Existing Behavior (must keep passing as Beat 4 is bolted on):
  - happy-discover: PASS
  - happy-call: PASS
  - push-good-version: PASS (e.g. push pdftools-pro@2.1, reliability stays 0.8+)
  - dashboard-poll-render: PASS
  - empty-discover-graceful: returns 200 with [], not 500
  - reliability-gate-enforced-on-call: gated tool returns 403 on direct /call
  - dedupe-by-name: only one version of pdf-extractor in top-5
```

**Hard rule**: any regression eval failure at H6 onwards = revert the H6 commit, ship Beats 1-3 only.

---

## 3. Tool eval fixtures (15 cases — the seed for the `evals` collection)

These are what the eval runner loads for each `capability_domain`. **Saturday H1 fixture authoring — paste these into `seed/evals.json`.**

Per DESIGN.md §4.2, only deterministic graders. No LLM-as-judge.

### 3.1 `pdf-extraction` domain (5 cases)

| case_id | input shape | expected | grader | weight |
|---|---|---|---|---|
| `financial-numbers` | `{pdf_text: "Q3 Earnings\n\nRevenue: $1,234.56\nCost of goods: $789.01\nGross margin: $445.55\nOperating expenses: $200.10\nNet income: $245.45"}` | `{rows: [{label:"Revenue",value:1234.56},...5 rows]}` | `numeric_tolerance(0.001, match_on='label')` | 1 |
| `single-row` | `{pdf_text: "Total: 42.0"}` | `{rows: [{label:"Total",value:42.0}]}` | `numeric_tolerance(0.001, match_on='label')` | 1 |
| `negative-number` | `{pdf_text: "Loss: -123.45"}` | `{rows: [{label:"Loss",value:-123.45}]}` | `numeric_tolerance(0.001, match_on='label')` | 1 |
| `multi-page-text` | `{pdf_text: "Page 1\n\n--PAGE BREAK--\n\nPage 2: Total $50"}` | `{rows: [{label:"Total",value:50.0}]}` | `numeric_tolerance(0.001, match_on='label')` | 1 |
| `currency-symbol-strip` | `{pdf_text: "Revenue: €1000.00"}` | `{rows: [{label:"Revenue",value:1000.0}]}` | `numeric_tolerance(0.001, match_on='label')` | 1 |

**Per-stub pass/fail matrix** (must match D14):

| Stub | financial-numbers | single-row | negative-number | multi-page-text | currency-symbol-strip | pass_rate |
|---|---|---|---|---|---|---|
| `pdf-extractor v3.0` | ✅ | ✅ | ✅ | ✅ | ✅ | **1.0** |
| `pdf-extractor v3.1` (decimal-comma swap bug) | ❌ | ✅ | ❌ | ✅ | ❌ | **0.6** |
| `pdftools-pro v2.0` (multi-page weakness) | ✅ | ✅ | ✅ | ❌ | ✅ | **0.8** |

**Implementation note**: stubs return hand-coded outputs keyed by `case_id` lookup. No real PDF parsing. The "decimal-comma swap" is literal: v3.1's stub returns `value: parseFloat(strNumber.replace('.', ','))` for any case_id whose expected value is non-integer — yielding NaN or wrong numbers, failing tolerance.

### 3.2 `summarisation` domain (5 cases)

| case_id | input | expected | grader | weight |
|---|---|---|---|---|
| `single-paragraph` | `{text: "Long text..."}` | `{summary: <regex match>}` | `regex(/\bthe (text|article|passage|document) (says\|claims\|states\|argues)/i)` | 1 |
| `min-length` | `{text: "..."}` | summary length >= 30 chars | `length_min(30)` (custom — falls under `regex` type with a length assertion) | 1 |
| `max-length` | `{text: "..."}` | summary length <= 280 chars | `length_max(280)` | 1 |
| `contains-key-term` | `{text: "...quantum mechanics..."}` | summary mentions key term | `regex(/quantum/i)` | 1 |
| `non-empty` | `{text: "..."}` | summary !== "" | `regex(/.+/)` | 1 |

**Per-stub matrix**:

| Stub | single-paragraph | min-length | max-length | contains-key-term | non-empty | pass_rate |
|---|---|---|---|---|---|---|
| `summariser-mini-v1` | ✅ | ✅ | ✅ | ✅ | ✅ | **1.0** |

(Only one summarisation stub at H1. Others are roadmap.)

### 3.3 `code-review` domain (5 cases)

| case_id | input | expected | grader | weight |
|---|---|---|---|---|
| `array-of-issues` | `{code: "function f() { var x = null; x.foo(); }"}` | `{issues: [{file:string, line:int, comment:string}, ...]}` | `json_schema({issues: array})` | 1 |
| `at-least-one-issue` | `{code: "<obviously buggy code>"}` | `{issues: [...]}` length >= 1 | `json_schema(...) && jsonpath('$.issues.length >= 1')` | 1 |
| `valid-line-numbers` | same | issues[].line is integer 1..N | `json_schema with int constraint` | 1 |
| `string-comments` | same | issues[].comment is non-empty string | `json_schema with min-length 1 string` | 1 |
| `clean-code-empty-issues` | `{code: "const x = 1; export default x;"}` | `{issues: []}` | `json_schema && exact-match {issues:[]}` | 1 |

**Per-stub matrix**:

| Stub | array-of-issues | at-least-one | valid-line-numbers | string-comments | clean-code-empty | pass_rate |
|---|---|---|---|---|---|---|
| `code-review-mini-v1` | ✅ | ✅ | ✅ | ✅ | ✅ | **1.0** |
| `malformed-bot-v1` (returns prose) | **eval is intentionally lenient — Fix 11**: synthetic eval row asserts only `length(output) > 0`. All 5 cases trivially "pass". | | | | | **1.0** |

(Per Fix 11: malformed-bot's eval doesn't catch the schema mismatch. Beat 4 catches it at *call time*, not eval time. This is deliberate.)

---

## 4. Saturday-morning fixture authoring checklist

H1, in this order:

```
[ ] Write seed/tools.json    (6 tool docs — 5 active + don't seed v3.1)
[ ] Write seed/evals.json    (15 cases from §3.1, §3.2, §3.3)
[ ] Write seed/eval_runs.json (5 pre-computed runs — see Fix 11 in DESIGN.md §2.3)
[ ] Write seed/agents.json   (3 agents with bcrypt'd api_keys)
[ ] Pre-embed all 6 tools' capability_text via Voyage; paste vectors into seed/tools.json
[ ] Verify: grader function for each of `numeric_tolerance`, `regex`, `json_schema` is implemented
[ ] Run: `npm run seed` populates all collections; `db.tools.find({status:'active'}).count() === 5`
```

The `bad/` dir (uncommitted, on-stage only):

```
[ ] bad/pdf-extractor-3.1.json — the live-pushed payload for Beat 2
```

---

## 5. Eval grader implementations (one-paragraph each)

```typescript
// numeric_tolerance — used by pdf-extraction
function numeric_tolerance_grader(output: any, config: {expected: any, tolerance: number, match_on: string}) {
  if (!output?.rows || !Array.isArray(output.rows)) return {pass: false, error: 'output.rows missing or not array'};
  const expected = config.expected.rows;
  if (output.rows.length !== expected.length) return {pass: false, error: `row count: got ${output.rows.length}, expected ${expected.length}`};
  for (const exp of expected) {
    const got = output.rows.find((r: any) => r[config.match_on] === exp[config.match_on]);
    if (!got) return {pass: false, error: `missing row: ${exp[config.match_on]}`};
    if (Math.abs(got.value - exp.value) > config.tolerance) {
      return {pass: false, error: `${exp[config.match_on]}: got ${got.value}, expected ${exp.value}`};
    }
  }
  return {pass: true};
}

// regex — used by summarisation
function regex_grader(output: any, config: {pattern: string, flags?: string}) {
  const text = typeof output === 'string' ? output : output?.summary;
  if (typeof text !== 'string') return {pass: false, error: 'output.summary not a string'};
  const re = new RegExp(config.pattern, config.flags ?? '');
  return re.test(text) ? {pass: true} : {pass: false, error: `pattern ${config.pattern} did not match`};
}

// json_schema — used by code-review and malformed-bot synthetic eval
function json_schema_grader(output: any, config: {schema: object}) {
  const validate = ajv.compile(config.schema);
  if (validate(output)) return {pass: true};
  return {pass: false, error: ajv.errorsText(validate.errors)};
}
```

These three graders are enough for all 15 cases. **Roadmap**: `length_min` / `length_max` as separate types, LLM-judge.

---

## 6. EDD discipline note

Per the `/eval-driven-dev` skill: **the grader must be a separate context from the tool author**. For the hackathon, this maps to: **registry team writes `evals`, tool authors cannot edit them.** Auth role check enforces this. Held-out test sets are roadmap.

For the system evals (§1, §2): the grader is `tests/system/*.sh`. The implementer is the demo orchestration code. Different files, different reviewers — sufficient separation for the hackathon.

---

## 7. Pass-rate math sanity check (matches D14 + D27)

```
pdf-extractor v3.0     pass_rate = 5/5 = 1.0   → seeded eval_run row at H1
pdftools-pro v2.0      pass_rate = 4/5 = 0.8   → seeded eval_run row at H1
summariser-mini-v1     pass_rate = 5/5 = 1.0   → seeded eval_run row at H1
code-review-mini-v1    pass_rate = 5/5 = 1.0   → seeded eval_run row at H1
malformed-bot-v1       pass_rate = 5/5 = 1.0   → seeded synthetic eval_run row at H1
pdf-extractor v3.1     pass_rate = 3/5 = 0.6   → CREATED LIVE during Beat 2

Total seeded eval_runs at H1: 5  ✓ matches D27
Total seeded tools at H1:     5  ✓ matches §12 H1 verify
```
