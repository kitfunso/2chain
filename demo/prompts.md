# Live MCP demo prompts (real-world framing)

> Each prompt has a real user persona + real-looking inline data + a clear expected outcome. Designed to demo in 20-30 seconds each.

## Setup (one-time on the laptop)

In Claude Code's MCP config:

```json
{
  "mcpServers": {
    "2chain": {
      "command": "node",
      "args": ["FULL/PATH/TO/2chain/bin/2chain-mcp.mjs"],
      "env": {
        "TWOCHAIN_HOST": "https://your-codespace-3030.app.github.dev",
        "TWOCHAIN_API_KEY": "sk_demo_pdf_agent_8f2c4a"
      }
    }
  }
}
```

Make the Codespaces port 3030 **Public** (PORTS tab → right-click → Port Visibility).

---

## Prompt 1 — Financial analyst building a DCF model

**Persona**: equity research analyst building a discounted cash flow model.

```
I'm building a DCF model for NVIDIA. I need to extract the income-statement
line items from their latest 10-K filing. Here's the relevant page text:

NVIDIA Corporation - Consolidated Statements of Income

Revenue: $60,922
Cost of revenue: $16,621
Gross profit: $44,301
Operating expenses: $11,329
Operating income: $32,972
Net income: $29,760

Use 2chain to find the right financial extraction tool, call it on this text,
and give me a clean structured table I can paste into my model.
```

**What you'll see (≤30s):**
- Claude calls `discover_tools("financial extraction PDF earnings 10-K")`
- Top result: `pdf-extractor v3.0`, reliability 1.0
- Claude calls `call_tool("pdf-extractor", "3.0", { pdf_text: "..." })`
- Returns 6 rows of `{label, value}` with the actual numbers
- **Dashboard lights up:** Live ranking shows pdf-extractor #1, Pipeline Inspector shows the `$rankFusion` JSON, call counter ticks

---

## Prompt 2 — Engineer reviewing a PR before merge

**Persona**: dev about to merge a PR, wants automated review.

```
Before I merge this PR, I want a quick code review. Use 2chain to find a
JavaScript linter and run it on this snippet:

function loadUserData(userId) {
  var cache = {};
  for (var i = 0; i < users.length; i++) {
    eval('cache[users[i].id] = users[i]');
  }
  console.log("loaded", users.length);
  return cache[userId].profile.bar();
}

What does it find?
```

**What you'll see (≤25s):**
- Claude calls `discover_tools("javascript code review lint pr")`
- Top result: `eslint-snitch v7.5` (text rank wins for "lint" + "javascript")
- Claude calls `call_tool` with the code
- Returns ~5 issues: `var`, `eval()`, `console.log`, `.bar()` on possibly null
- **Dashboard:** registry highlights eslint-snitch, call counter ticks

---

## Prompt 3 — Security review before production deploy

**Persona**: backend engineer running pre-deploy security check.

```
I'm about to deploy this Python authentication function to production.
Use 2chain to find a security-focused scanner (not just a generic linter)
and check it for vulnerabilities:

def authenticate(username, password):
    api_key = "sk-prod-7f8a3b9c2d"
    query = f"SELECT * FROM users WHERE name='{username}' AND password='{password}'"
    try:
        result = db.execute(query)
        return result.fetchone()
    except:
        return None

Tell me what's wrong with this code.
```

**What you'll see (≤25s):**
- Claude calls `discover_tools("python security audit OWASP vulnerabilities")`
- Top result: `security-scanner v1.5` (matches "security" in capability_text, beats pylint-pro on relevance)
- Claude calls `call_tool` with the code
- Returns: SQL injection (line 3), hardcoded API key (line 2), bare except (line 7)
- **Dashboard:** security-scanner highlighted in registry, call counter ticks

---

## Prompt 4 — Researcher digesting an arxiv paper

**Persona**: someone catching up on an AI paper, wants the gist.

```
Use 2chain to summarise this paper abstract into a single short paragraph:

We propose Mamba, a new state-space model architecture that achieves
linear-time sequence modelling without attention. Mamba uses a selection
mechanism to filter relevant information through hidden states, scaling
to million-token contexts. On language modelling benchmarks, Mamba-3B
outperforms Transformers of the same size and matches Transformers
twice its size. Throughput is 5x higher than Transformers at inference.
We release the full training pipeline and pre-trained checkpoints.

Find the right summariser in the registry.
```

**What you'll see (≤25s):**
- Claude calls `discover_tools("summarise paper abstract arxiv")`
- Top result: `paper-digest v1.0` (academic-paper specific) or `tldr-bot v2.1`
- Returns a one-paragraph summary mentioning Mamba + state-space + linear-time
- **Dashboard:** summarisation tool highlighted, call counter ticks

---

## Prompt 5 — Accounts payable parsing a supplier invoice

**Persona**: finance ops person processing an invoice into the AP system.

```
I need to enter this UK supplier invoice into our accounts payable system.
Use 2chain to find an invoice-parsing tool and pull out the line items:

INVOICE #2026-0418-INV
Acme Industrial Supplies Ltd
VAT Reg: GB-432-1098-77
Date: 2026-04-15

Subtotal: £12,450
VAT 20%: £2,490
Shipping: £85
Total: £15,025

Give me the structured line items.
```

**What you'll see (≤25s):**
- Claude calls `discover_tools("UK invoice line items VAT")`
- Top result: `invoice-grok v1.2` (matches "UK" + "VAT" + "invoice" + "line item")
- Returns 4 rows
- **Dashboard:** invoice-grok highlighted

---

## Prompt 6 — The contract violation moment (stage punchline)

**Persona**: someone trying a niche tool that turns out to be broken.

```
Use 2chain to call the tool "malformed-bot" version "1.0" — review this
small snippet of code:

const x = 1;
export default x;

I want to see what its output looks like.
```

**What you'll see (≤20s):**
- Claude calls `discover_tools` and may not surface malformed-bot (low semantic match)
- Claude calls `call_tool("malformed-bot", "1.0", { code: "..." })` directly using the version you specified
- 2chain returns **503 circuit_broken** — the tool returned prose, not the JSON contract
- Claude reports: "the tool returned malformed output, 2chain caught it on the wire and circuit-broke it. Falling back to a different reviewer."
- **Dashboard:** malformed-bot pill flips to red `circuit_broken`, violations panel gets a new entry

This is the stage punchline. *"Even if the agent picks the wrong tool, the contract layer protects the user from garbage output."*

---

## Prompt 7 — Adaptive retrieval moment (push then re-discover)

**Persona**: tool author shipping a new version, watching the registry react.

> Run from the Codespaces terminal, not Claude Code:

```bash
npm run demo:beat2
```

Then in Claude Code:

```
Run the same query from earlier — find me a financial extraction tool
and show the top 3 ranked results. Has anything changed?
```

**What you'll see (≤25s):**
- Claude calls `discover_tools("financial extraction PDF earnings")` again
- Top result is **still** pdf-extractor v3.0 — the new v3.1 is filtered (reliability 0.6 < 0.80 gate)
- Claude reports: "v3.0 still wins. A v3.1 was just published but failed 3 of 5 evals so the registry filtered it out."
- **Dashboard:** Pipeline Inspector shows the same `$rankFusion` ran again, registry shows v3.1 with red reliability bar but absent from the live ranking

The point: **the registry re-ranks itself in real time without any agent code change.**

---

## Pre-flight (T-5 before going on stage)

```bash
# In Codespaces:
npm run preflight        # 12/12 green
npm run demo:warmup      # pre-cache the demo embedding

# On laptop, in Claude Code:
# Verify "2chain" appears in MCP servers panel
# Verify port 3030 in Codespaces PORTS tab is "Public"
```

If any prompt above doesn't return the expected tool on the first try, give Claude a hint by being more explicit about what kind of tool you want — the tool descriptions in 2chain are written to match natural-language hints.

---

## Order to run on stage (roughly 3 minutes total)

| Order | Prompt | Beats covered |
|---|---|---|
| 1 | Prompt 1 (NVIDIA DCF) | Beat 1 — discovery |
| 2 | `npm run demo:beat2` (operator side) | Beat 2 — push v3.1 |
| 3 | Prompt 7 (re-discover) | Beat 3 — regression protection |
| 4 | Prompt 6 (malformed-bot) | Beat 4 — circuit-break |

If time permits, do Prompts 2, 3, or 5 as variety. Skip if running over 3 min.
