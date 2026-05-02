# Live MCP demo prompts (real-world)

> The test for every prompt: **the user actually needs the tool** — they can't just read the data themselves and answer. Each one demoes in 20-30s.

## Setup (one-time)

In Claude Code, the 2chain MCP server is registered (`claude mcp list` shows `2chain ✓ Connected`). The 2chain API server runs at `http://127.0.0.1:3030`.

By default the MCP server is **verbose**: every `discover_tools` call returns a trace showing the Atlas pipeline used, candidate scores, and the actual `$rankFusion` aggregation JSON. Every `call_tool` shows wall vs server-side latency, contract validation status, and (on failure) raw output + schema errors. Disable with `TWOCHAIN_VERBOSE=false`.

---

## Prompt 1 — Equity analyst, messy 10-K paste, real DCF source

**Why a tool is needed**: the input is raw column-aligned text copy-pasted from a 10-K PDF. Reading it for one row is fine; building a reusable extraction step that works across 1000 filings needs a specialist with a JSON contract.

```
I'm building a DCF model for NVIDIA. Here's a paste from page 47 of their
latest 10-K — the Consolidated Statements of Income. I need it as structured
rows so I can drop them into my spreadsheet model. Use 2chain to find the
right financial-statement extractor and run it.

NVIDIA CORPORATION
CONSOLIDATED STATEMENTS OF INCOME
(In millions)

Revenue: $60,922
Cost of revenue: $16,621
Gross profit: $44,301
Research and development: $8,675
Sales general and administrative: $2,654
Total operating expenses: $11,329
Operating income: $32,972
Other income net: $269
Income before tax: $33,241
Provision for income taxes: $3,481
Net income: $29,760
```

**What you'll see in Claude Code:**
- Verbose trace from `2chain.discover_tools` showing 3-5 candidates with RRF scores and the literal MongoDB pipeline
- Top result: `pdf-extractor v3.0` (financial-statement specialist, rel 1.00)
- Verbose trace from `2chain.call_tool` showing 11 rows extracted, server-side ~30ms, ✓ contract validated
- Claude assembles the table for you

**Dashboard simultaneously**: live ranking flashes, Pipeline Inspector at the bottom shows the `$rankFusion` JSON, call counter ticks `ok`.

---

## Prompt 2 — Engineer with a real bug-prone PR

**Why a tool is needed**: the snippet has 4 distinct anti-patterns. Claude could spot some by eye, but a specialist gives you a structured `{file, line, comment}` array that drops straight into a PR review tool, with reliability you can trust over time.

```
I'm reviewing a PR. This function is supposed to load user data into a cache.
Use 2chain to find a JavaScript linter and have it review this code — give me
back the structured issue list, not your own opinions.

function loadUserCache(userIds) {
  var cache = {};
  for (var i = 0; i < userIds.length; i++) {
    eval('cache[userIds[i]] = fetch("/api/user/" + userIds[i])');
    console.log("queued", userIds[i]);
  }
  return cache[userIds[0]].profile.bar();
}
```

**Top result**: `eslint-snitch v7.5`. Returns issues for `var`, `eval`, `console.log`, possibly-null `.bar()`. Server-side ~10ms.

---

## Prompt 3 — Pre-deploy security review

**Why a tool is needed**: this is dual-use code (looks innocent, has 3 critical security holes). A specialist scanner is auditable + traceable. You want a tool that's been graded for *security* recall specifically, not a generic linter.

```
I'm about to ship this Python authentication code to production. Use 2chain
to find a security-focused scanner — not just a generic linter — and have it
audit this file. I want the structured findings:

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

**Top result**: `security-scanner v1.5` (matches "security" + "OWASP" in its capability_text). Returns: SQL injection (line 3), hardcoded API key (line 2), bare except (line 7). Pylint-pro ranks lower because security has stronger semantic match.

---

## Prompt 4 — Researcher with too-long content (real summarisation need)

**Why a tool is needed**: the source is 3 paragraphs that take 30+ seconds to read. The user wants a 1-sentence TLDR. Specialist summariser delivers consistent length + format.

```
I haven't slept and I have 30 papers to triage. Use 2chain to summarise this
arxiv abstract into a single sentence so I can decide if it's worth a deep
read. Don't summarise it yourself — call the registry tool, that way the
output is consistent across all 30 papers.

We propose Mamba, a new state-space model architecture that achieves linear-time
sequence modelling without attention. Mamba uses a selection mechanism to filter
relevant information through hidden states, scaling to million-token contexts.
On language modelling benchmarks, Mamba-3B outperforms Transformers of the same
size and matches Transformers twice its size. Throughput is 5x higher than
Transformers at inference. We release the full training pipeline and pre-trained
checkpoints. We further evaluate on DNA modelling and audio waveforms, finding
Mamba achieves state-of-the-art on both modalities. The selection mechanism is
implemented via parallel scan, allowing the architecture to remain hardware-friendly
on modern accelerators despite its non-attention design.
```

**Top result**: `paper-digest v1.0` (academic-paper specialist) or `tldr-bot v2.1`. Returns 1 paragraph mentioning Mamba + state-space + linear-time.

---

## Prompt 5 — Accounts-payable workflow on a messy supplier invoice

**Why a tool is needed**: real AP invoices have line items mixed with VAT calc, supplier metadata, dates, references. The tool needs to know AP semantics (subtotal vs total inclusive, VAT line vs item line). It's a different parser from a financial-statement extractor — and 2chain should pick the right one.

```
We received a UK supplier invoice this morning that needs entering into our AP
system. Use 2chain to find the right parser — note this is a SUPPLIER invoice
(we owe them), not a financial filing. Pull out the line items and VAT cleanly.

INVOICE #2026-0418-INV
Acme Industrial Supplies Ltd
VAT Reg: GB-432-1098-77
Date: 2026-04-15
Order ref: PO-7821

Subtotal: £12,450
VAT 20%: £2,490
Shipping: £85
Total: £15,025
```

**Top result**: `invoice-grok v1.2` — the capability_text now explicitly says "supplier invoice", "VAT", "European AP", and explicitly **excludes** SEC filings (so the financial-statement extractor doesn't compete here). pdf-extractor stays out.

---

## Prompt 6 — The contract violation moment (live)

**Why this matters**: a tool that lies at runtime is the worst-case agentic failure. A registry that catches it on the wire and cuts it off, automatically, in real time, is the wow.

```
There's a tool in the registry called "malformed-bot" version "1.0" that's
been getting decent reviews on a code-review benchmark. I want to try it on
this code:

const x = 1;
export default x;

Call it via 2chain.call_tool directly with name "malformed-bot" version "1.0".
Show me what happens.
```

**Top result**: `2chain.call_tool("malformed-bot", "1.0", { code: "..." })` returns **HTTP 503 + `output_contract_violation_circuit_break`**. The verbose trace shows:
- raw output: `"Found 3 issues: missing semicolon, unused variable, deprecated API call."`
- schema_errors: must be object (the contract requires `{issues: array}`)
- *"tool flipped to status=circuit_broken in MongoDB, violation logged, all future agents protected"*

**Dashboard**: malformed-bot pill flips red, violations panel gets a fresh entry, call counter ticks `circuit_broken`.

---

## Prompt 7 — Adaptive retrieval, live

**Why this matters**: the registry self-improves as evals roll in. No agent code changed. New bad versions get filtered automatically.

> First, in the Codespaces / local terminal:

```bash
npm run demo:beat2
```

This pushes `pdf-extractor v3.1` with a decimal-comma swap bug. Eval runner catches 3 of 5 cases, reliability lands at 0.6.

> Then in Claude Code:

```
Run the same NVIDIA 10-K extraction query as before — but tell me explicitly:
which version of pdf-extractor did 2chain pick this time, and why? Did the
v3.1 that was just published show up?
```

**Trace shows**: pdf-extractor **v3.0** still picked, **NOT v3.1**. Reason: v3.1 has reliability 0.6 < 0.80 gate, filtered at $vectorSearch level. Both versions live in the registry (full audit), only one is visible to discovery.

---

## On-stage running order (≤3 min)

| # | Cue | Action |
|---|---|---|
| 0 | Pre-flight | `npm run preflight` → 12/12 green |
| 1 | "An equity analyst building a DCF model..." | Paste **Prompt 1** in Claude Code |
| 2 | "Now what if the tool author publishes a buggy version?" | `npm run demo:beat2` (operator side) |
| 3 | "Watch what happens when the same agent re-runs the query." | Paste **Prompt 7** in Claude Code |
| 4 | "One more layer. Some tools lie at runtime." | Paste **Prompt 6** in Claude Code |
| 5 | Close slide | "Tools that lie get filtered. Tools that work get found." |

If a judge asks about other domains during Q&A, drop **Prompt 3** (security) or **Prompt 5** (AP) live.
