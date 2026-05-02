# Live MCP demo prompts (honest framing)

> The point of 2chain isn't extraction itself. It's:
> 1. **Contract enforcement** — output is guaranteed to conform to a JSON Schema, ajv-validated at the wire. No hallucinated fields, no markdown wrapping, no inconsistent label spelling between runs.
> 2. **Specialist routing** — picks the RIGHT tool from 197 candidates for THIS document type (10-K vs invoice vs receipt vs codebase).
> 3. **Reliability gating** — only tools that pass a 0.80 reliability gate are even considered.
> 4. **Audit trail** — every call logs to MongoDB. Every push runs evals. Every contract violation circuit-breaks the tool.
>
> This is what your AI agent gets that it doesn't have today. Not "can it extract?" — "can you trust 50,000 extractions across 50,000 documents to all return the same shape, with provenance?"

## Setup (one-time)

Claude Code MCP panel shows `2chain · ✔ connected`. Server runs at `http://127.0.0.1:3030`. Dashboard at the same URL in a browser tab.

Verbose mode is on by default — every `discover_tools` returns the Atlas pipeline + per-candidate scores; every `call_tool` returns wall vs server-side latency + contract validation status.

---

## Prompt 1 — Equity research, batch processing 10-Ks

**Why a tool is needed**: Volume + consistency. Doing this once is easy. Doing 50 in a row with the same JSON shape, validated against a schema, with audit trail — that's what 2chain solves. The model alone might output `{Revenue: 60922}` one time and `{revenue_usd: 60922}` the next.

```
I'm modelling NVIDIA for our DCF database. We're rebuilding 50 large-cap
income statements this week — they all need to land in the same JSON shape
so my spreadsheet model can ingest them. Don't do the extraction yourself
(I need consistency across all 50, not your best guess) — use 2chain to
find a financial-statement-specialist tool with a schema contract, and run
it on this first one. Here's the raw paste from page 47 of NVIDIA's 10-K:

NVIDIA Corp, Form 10-K, fiscal year ended January 28, 2024 (page 47):

Total revenues for fiscal 2024 increased to $60,922 million, up 126% over the
prior year. Cost of revenue: $16,621 million, yielding gross profit of $44,301
million (72.7% gross margin). Operating expense breakdown: Research and
development: $8,675 million; Sales general and administrative: $2,654 million.
Total operating expenses: $11,329 million. Operating income: $32,972 million.
Other income net: $269 million. Income before tax: $33,241 million. Provision
for income taxes: $3,481 million. Net income: $29,760 million.

Page 47 of 234.
```

**What you'll see (≤30s):**
- Verbose `discover_tools` trace shows ~5 candidates with RRF scores; pdf-extractor v3.0 wins with reliability 1.00
- The literal `$rankFusion` MongoDB pipeline is in the trace
- `call_tool` returns `{rows: [...]}` validated against the schema, server-side ~30ms
- Dashboard: pdf-extractor row flashes, Pipeline Inspector shows the aggregation, call counter ticks `ok`

**On stage line**: *"The point isn't that 2chain extracted this — Claude could have. The point is the next 49 will return the same shape, validated, with reliability tracked."*

---

## Prompt 2 — Engineer reviewing a PR, needs structured findings (not opinion)

**Why a tool is needed**: Code review by Claude is great, but it produces prose. To put findings in a CI dashboard or auto-comment on a PR, you need structured `{file, line, comment}` records. A specialist enforces that contract.

```
I'm reviewing a PR. Don't review the code yourself — I need the findings as
structured JSON to drop into our CI dashboard, not your prose. Use 2chain to
find a JS linter and have it review:

function loadUserCache(userIds) {
  var cache = {};
  for (var i = 0; i < userIds.length; i++) {
    eval('cache[userIds[i]] = fetch("/api/user/" + userIds[i])');
    console.log("queued", userIds[i]);
  }
  return cache[userIds[0]].profile.bar();
}
```

**Top result**: `eslint-snitch v7.5`. Returns `{issues: [...]}` validated at the wire.

---

## Prompt 3 — Pre-deploy security audit (specialist, not a generic linter)

**Why a tool is needed**: A specialist scanner has been graded specifically on security recall. A generic linter probably catches `var` and `console.log` but might miss the SQL injection. The reliability score is what tells you which tool to trust for *this* class of problem.

```
I'm shipping this Python authentication function. Don't audit it yourself —
I need an output from a tool that's been graded specifically for OWASP
recall, not your prose. Use 2chain to find a security specialist:

def authenticate(username, password):
    api_key = "sk-prod-7f8a3b9c2d-real-key"
    query = f"SELECT * FROM users WHERE name='{username}' AND password='{password}'"
    try:
        result = db.execute(query)
        return result.fetchone()
    except:
        log.warn("auth failed")
        return None
```

**Top result**: `security-scanner v1.5` (beats pylint-pro because reliability profile is OWASP-specific).

---

## Prompt 4 — Researcher needing consistent format across 30 papers

**Why a tool is needed**: Volume + format consistency. Reading one paper is fine; reading 30 with the same length and structure is what a specialist guarantees.

```
I have 30 papers to triage today. Use 2chain to summarise this one — I want
the output coming from the same tool you'll use on the other 29, so my
notes are consistent. Don't summarise it yourself.

We propose Mamba, a new state-space model architecture that achieves linear-time
sequence modelling without attention. Mamba uses a selection mechanism to filter
relevant information through hidden states, scaling to million-token contexts.
On language modelling benchmarks, Mamba-3B outperforms Transformers of the same
size and matches Transformers twice its size. Throughput is 5x higher than
Transformers at inference. We release the full training pipeline and pre-trained
checkpoints. We further evaluate on DNA modelling and audio waveforms, finding
Mamba achieves state-of-the-art on both modalities.
```

**Top result**: `paper-digest v1.0` or `tldr-bot v2.1`.

---

## Prompt 5 — Accounts payable, schema-validated invoice intake

**Why a tool is needed**: AP system requires exact field shapes. Different parsers exist for SEC filings vs supplier invoices — wrong tool = wrong data in your accounting system. The reliability gate is what stops "good for filings, bad for invoices" from making it into your AP pipeline.

```
This UK supplier invoice arrived this morning — it needs entering in our AP
system, which expects a strict JSON shape. Use 2chain to find a SUPPLIER
INVOICE parser (NOT a financial-filing extractor — different document type).

INVOICE #2026-0418-INV
Acme Industrial Supplies Ltd
VAT Reg: GB-432-1098-77
Date: 2026-04-15

Subtotal: £12,450
VAT 20%: £2,490
Shipping: £85
Total: £15,025
```

**Top result**: `invoice-grok v1.2`.

---

## Prompt 6 — The contract violation moment (the wow)

**Why this matters**: this is the one that's hard for Claude to do alone. A tool can pass evals (its outputs are non-empty, "look reasonable") but still violate the contract at runtime. 2chain catches this on the wire and the registry self-quarantines.

```
There's a code-review tool in the registry called malformed-bot version 1.0.
It's been getting decent reviews. Try it on this code via 2chain:

const x = 1;
export default x;

Use 2chain.call_tool directly — name "malformed-bot", version "1.0".
Show me what happens.
```

**Result**: `2chain.call_tool` returns **HTTP 503 + output_contract_violation_circuit_break**. Verbose trace shows:
- raw output: `"Found 3 issues: missing semicolon, unused variable..."`
- schema_errors: must be object (the contract requires `{issues: array}`)
- *"tool flipped to status=circuit_broken in MongoDB, violation logged, all future agents protected"*

**Dashboard**: malformed-bot pill turns red, violations panel gets a fresh entry, call counter ticks `circuit_broken`.

---

## Prompt 7 — Adaptive retrieval (push v3.1, watch the gate)

> Operator side first:

```bash
npm run demo:beat2
```

This pushes `pdf-extractor v3.1` with a decimal-comma swap bug. Eval runner catches 3/5 cases → reliability 0.6.

> Then in Claude Code:

```
Run the same NVIDIA 10-K extraction as before. Tell me which version of
pdf-extractor 2chain picked, and whether the v3.1 that was just published
showed up at all.
```

**Trace shows**: pdf-extractor v3.0 still picked, NOT v3.1. Reason: v3.1 reliability 0.6 < 0.80 gate, filtered at the index level. Both versions live in the registry — full audit, only one visible to discovery.

---

## On-stage running order (≈3 min)

| # | Cue | Action |
|---|---|---|
| 0 | Pre-flight | `npm run preflight` → 12/12 green |
| 1 | "An equity analyst rebuilding 50 income statements..." | Paste **Prompt 1** in Claude Code |
| 2 | "What if a tool author publishes a buggy version?" | `npm run demo:beat2` (operator side) |
| 3 | "Watch the same query re-run." | Paste **Prompt 7** in Claude Code |
| 4 | "One more layer. Some tools lie at runtime." | Paste **Prompt 6** in Claude Code |
| 5 | Close slide | "Tools that lie get filtered. Tools that work get found." |

Q&A spares: Prompt 2 (PR review) or Prompt 3 (security audit) — drop live if a judge asks "another domain".
