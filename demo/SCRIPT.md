# 2chain · stage script (~3:15)

Running order: **#1 SEC fetch → #2 arxiv fetch → #5 contract violation**.
Dashboard open on the projector. Claude Code window beside it.

---

## OPEN — origin story · ~60s

> Part of my job is helping colleagues use AI better. Most of them don't know what tools, hooks, or MCP servers are. They just want to extract some data, update a file, or get a clean answer out of an email. When the answer comes back wrong, they blame the AI and stop using it.

> Heavy AI users like me spend hours hunting for the right tool to wire around the model. Most people will never do that. That gap, between someone who knows the tooling layer exists and someone who doesn't, is the real reason corporate AI adoption is still small. The model isn't the problem. The harness around it is. AI is brilliant at retrieving and reasoning over information, but only when the right specialist tools are plugged in.

> 2chain closes that gap. The user types what they want, the registry picks the right tool, the answer comes back correct. They never see the tooling layer, and they don't have to. Let me show you how.

---

## BEAT 1 — DCF prompt · ~45s

**Paste:**
```
I'm building a DCF model for NVIDIA. Use 2chain to pull the latest year's
income statement from NVIDIA's 10-K. I need it as JSON for my model.
```

**While it runs:**
> Equity analyst. Building a DCF for NVIDIA. Doesn't know the latest revenue. Neither does Claude — training cutoff. So Claude calls `2chain.discover_tools` with the user's natural-language prompt.

**Live ranking panel updates:**
> 199 tools, vector search and BM25 fused with reciprocal rank fusion in a single Atlas aggregation, then re-ranked. **`sec-edgar-financials`** wins.

**Registry row flashes, JSON returns:**
> The tool just hit SEC EDGAR's XBRL API live. Real fetch. **$216 billion revenue**, fiscal year ending January 2026. Schema-validated at the wire. Source URL stamped. Nobody knew that number until 2chain found the tool that did.

---

## BEAT 2 — arxiv prompt · ~40s

**Paste:**
```
I'm doing a literature review on Mamba state-space models. Use 2chain to
fetch the latest papers on this topic from arxiv. I need top 3 with title,
authors, and abstract.
```

**While it runs:**
> Same architecture, different domain. Researcher doing a literature review. Watch the ranking change.

**Live ranking shows arxiv-paper-search winning:**
> Different specialist now — **`arxiv-paper-search`**. Hits export.arxiv.org, parses the Atom feed, three real papers come back with titles, authors, abstracts, PDF URLs.

**Pause:**
> The registry doesn't care if the tool is finance or research. Tool authors publish capability text. Embeddings plus text search plus re-ranker do the routing. This is what **adaptive retrieval** actually means for AI agents.

---

## BEAT 5 — contract violation · ~45s

**Paste:**
```
There's a code-review tool called malformed-bot version 1.0. Try it on
this code via 2chain:

const x = 1;
export default x;

Use 2chain.call_tool directly — name "malformed-bot", version "1.0".
Show me what happens.
```

**While it runs:**
> Now the part you can't do in vector search alone. There's a tool called `malformed-bot` in the registry. It **passed its evals** — outputs *look* reasonable. But at runtime...

**503 on screen, dashboard ticks `circuit_broken`:**
> ...it returned prose instead of the contracted `{issues: [...]}` JSON. ajv caught it on the wire. 2chain just flipped the tool's status to **`circuit_broken`** in MongoDB. Every other agent in the system — every future call — is now protected.

**Drive it home:**
> Evals catch lies at publish time. Contracts catch lies at **every single call**.

---

## CLOSE — 10s

> Tools that lie get filtered. Tools that work get found. Atlas plus agents, end to end. Thanks.

---

## Cheat sheet

- If a beat lags: dashboard tells the story — point at it, say *"watch what happens"*.
- If MCP hiccups: have `npm run demo:beat1` ready in a terminal as fallback.
- Total runtime: ~3:15 with the origin-story open. Trim the open to one paragraph if you need ~2:30.
- Q&A spares: prompt #3 (PR linter), #4 (security scanner).
- Stack: Node 24, Fastify, MongoDB Atlas M10 (eu-west-2), Voyage `voyage-3` 1024-dim, $rankFusion, ajv contract validation, change streams → SSE dashboard.
