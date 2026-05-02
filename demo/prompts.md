# Live MCP demo prompts

> These are the prompts to paste into Claude Code (or any MCP-compatible agent) once the 2chain MCP server is configured. Each one triggers a real `/discover` → `/call` round-trip against MongoDB Atlas. Watch the dashboard light up.

## Setup (one-time on the laptop)

In Claude Code's MCP configuration (or `claude_desktop_config.json`), add:

```json
{
  "mcpServers": {
    "2chain": {
      "command": "node",
      "args": ["C:/path/to/2chain/bin/2chain-mcp.mjs"],
      "env": {
        "TWOCHAIN_HOST": "https://cautious-giggle-p99j6r5vv4pfvpq-3030.app.github.dev",
        "TWOCHAIN_API_KEY": "sk_demo_pdf_agent_8f2c4a"
      }
    }
  }
}
```

Replace `TWOCHAIN_HOST` with your Codespaces forwarded URL. Restart Claude Code so the MCP server loads. You should see `2chain` listed in the MCP servers panel.

---

## Demo prompts (paste verbatim)

### Prompt 1 — PDF financial extraction (the locked Beat 1)

```
Extract the line items from this PDF text:

Q3 Earnings

Revenue: $1,234.56
Cost of goods: $789.01
Gross margin: $445.55
Operating expenses: $200.10
Net income: $245.45

Use 2chain to discover the right tool, then call it. Show me the resulting rows.
```

**What should happen:**
- Claude calls `discover_tools("extract financial figures from PDF")` → top result `pdf-extractor v3.0`
- Claude calls `call_tool("pdf-extractor", "3.0", { pdf_text: "..." })` → returns `{rows: [5 rows]}`
- Dashboard: live ranking flashes, call counter ticks `ok`

---

### Prompt 2 — JavaScript code review

```
I have this JS code, can you review it for bugs and style issues?

function process(items) {
  var total = 0;
  for (var i = 0; i < items.length; i++) {
    eval('total += ' + items[i].value);
    console.log(total);
  }
  return total;
}

Find the right reviewer in 2chain.
```

**What should happen:**
- discover → `eslint-snitch v7.5` (text rank wins for "lint" / "review js")
- call → returns issues array (var, eval, console.log)
- Dashboard: registry highlights eslint-snitch, call counter ticks

---

### Prompt 3 — Python security scan

```
Scan this Python code for security issues:

def login(username, password):
    query = f"SELECT * FROM users WHERE name='{username}' AND pw='{password}'"
    api_key = "sk-1234567890"
    try:
        result = db.execute(query)
    except:
        pass
    return result

Use 2chain — find a tool specialised in security, not just a generic linter.
```

**What should happen:**
- discover → `security-scanner v1.5` (matches "security" + "OWASP" in capability_text)
- call → returns SQL injection, hardcoded secret, bare except issues
- Dashboard updates

---

### Prompt 4 — Article summarisation

```
Summarise this article in one paragraph using 2chain:

Quantum mechanics is the branch of physics that deals with phenomena at atomic and subatomic scales. Unlike classical mechanics, where particles have definite positions and velocities, quantum systems exist in superpositions of states described by wave functions. The Heisenberg uncertainty principle establishes a fundamental limit on the precision with which conjugate variables — like position and momentum — can be simultaneously known. The interpretation of these results has been debated since the 1920s, with the Copenhagen interpretation, many-worlds, and pilot wave theories all attempting to explain measurement collapse.
```

**What should happen:**
- discover → `tldr-bot v2.1` or `summariser-mini v1.0` (semantic match for summarisation)
- call → returns one-paragraph summary
- Dashboard updates

---

### Prompt 5 — UK invoice parsing

```
I have a UK supplier invoice — pull the line items and totals using 2chain.

INVOICE #INV-7821
Acme Widgets Ltd
Date: 2026-04-15

Item: Industrial widget x 50 @ £12.50 = £625.00
Item: Premium fastener x 200 @ £0.85 = £170.00
Item: Delivery charge: £35.00
Subtotal: £830.00
VAT 20%: £166.00
Total: £996.00
```

**What should happen:**
- discover → `invoice-grok v1.2` (matches "UK invoice" / "VAT" / "line items")
- call → returns label-value rows
- Dashboard: invoice-grok flashes in registry

---

### Prompt 6 — The contract violation moment (Beat 4 in MCP form)

```
Use 2chain to find a code review bot called "malformed-bot" and have it review this code:

const x = 1; export default x;

I want to see what its output looks like.
```

**What should happen:**
- discover → maybe doesn't find it (only top 5 by relevance) — Claude may need to discover by name explicitly
- call_tool("malformed-bot", "1.0", { code: "..." }) → **503 circuit_broken** (returns prose, not JSON)
- Claude reports: "the tool was malformed, 2chain caught it and circuit-broke"
- Dashboard: malformed-bot status pill turns red; violations panel gets a new entry

This is the **on-stage punchline**: even if the agent picks the wrong tool, 2chain protects the user from garbage output.

---

### Prompt 7 — Adaptive retrieval, on stage

```
Find me a tool to extract tables from a PDF. Then publish a new version of pdf-extractor with version "3.1" — capability text "Extract tables from PDF financial reports v3.1 with fixes" — and rerun the discovery. Why does the new version not show up at the top?
```

**What should happen:**
- discover → pdf-extractor v3.0 #1
- (Claude will need the push API — point at the bin/2chain CLI: "use 2chain push")
- After push, discover again → v3.0 still #1, v3.1 absent (eval gate)
- Claude explains the reliability gate

This one is more advanced — let it ride only if Claude takes to it.

---

## Pre-flight check (T-5 before going on stage)

Run this in a Codespaces terminal to confirm the MCP server can talk to the API:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/2chain-mcp.mjs
```

Should print a JSON envelope listing `discover_tools` and `call_tool`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Claude Code says "MCP server failed to start" | Check the path in the JSON config is absolute and uses forward slashes on Windows |
| MCP server logs `connect ECONNREFUSED` | `TWOCHAIN_HOST` is wrong — paste the full Codespaces forwarded URL |
| `discover_tools` returns nothing | Codespaces port 3030 visibility is "Private" — set to "Public" in the PORTS tab |
| Tool returns 401 | `TWOCHAIN_API_KEY` env var doesn't match a seeded agent — use `sk_demo_pdf_agent_8f2c4a` |
| Tool returns 403 reliability_gate | Working as intended — that tool is below the 0.80 gate. Pick a different one. |
