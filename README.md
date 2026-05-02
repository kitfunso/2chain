# 2chain

**A tool registry with continuous evals and reliability gating for AI agents.**

Built on MongoDB Atlas Vector Search + Atlas Search + `$rankFusion` + change streams + Voyage AI embeddings. Agents type a natural-language task; 2chain picks the right tool from 199 candidates, calls it, and validates the response on the wire. Bad tools are filtered from results before they're ever returned, broken tools circuit-break on contract violation, and the dashboard re-ranks live via Atlas change streams.

> MongoDB Agentic Evolution Hackathon, May 2026 — track: **Adaptive Retrieval**.

🎬 **60-second demo video**: [youtu.be/puINYgtQXdM](https://youtu.be/puINYgtQXdM)

📖 **3-min stage script**: [demo/SCRIPT.md](./demo/SCRIPT.md) · **demo prompts**: [demo/prompts.md](./demo/prompts.md)

---

## Why MongoDB Atlas

Every layer of 2chain is an Atlas primitive. Nothing custom-built that Atlas does better.

| Layer | Atlas primitive | Role |
|---|---|---|
| **Semantic match** | Atlas Vector Search (1024-dim cosine, Voyage `voyage-3`) | Finds tools whose capability *means* the same thing as the user's query |
| **Lexical match** | Atlas Search (`lucene.english` BM25) | Catches concrete keyword hits the embedding misses |
| **Hybrid fusion** | **`$rankFusion`** (new Atlas operator) | Reciprocal rank fusion of both pipelines in a single server-side aggregation. No client merge, no two-DB juggle |
| **Reliability gate** | Filtered `$vectorSearch` | `metadata.reliability_score >= 0.80` enforced *inside* the index — bad tools never even score |
| **Live dashboard** | Change streams (`tools.watch()`, `usage.watch()`, `violations.watch()`) | SSE-driven UI with zero polling |
| **Audit trail** | Standard collections | `usage`, `violations`, `eval_runs`, `rankings` — every action observable |

The whole hybrid retrieval + reliability gate is **six lines of aggregation pipeline**. That's only possible because `$rankFusion` ships in Atlas.

---

## What it does

```
┌──────────────────┐                                            ┌──────────────┐
│  caller agent    │ ── "Extract tables from PDF" ─────────►   │  /discover   │
└──────────────────┘                                            └──────┬───────┘
                                                                       │
              ┌────────────────────────────────────────────────────────┤
              │ Atlas Vector Search    + 0.80 reliability gate         │
              │ Voyage embeddings 1024d  + 0.70 vec-score gate         │
              │ composite = 0.4·vec + 0.6·reliability                  │
              │ dedupe by tool name (latest version wins)              │
              └────────────────────────────────────────────────────────┘
                                                                       │
                         ┌───────────────────────────────────────┐     │
   tool author ──────►   │  /push   embed + run inline evals     │  ◄──┘ ranked top-N
                         │          status='active' + rel score  │      visible to agent
                         └───────────────────────────────────────┘
                                                                       │
                         ┌───────────────────────────────────────┐     │
   caller agent ────►    │  /call   input contract + stub +      │  ◄──┘
                         │          output contract + circuit-   │
                         │          break on violation           │
                         └───────────────────────────────────────┘
```

**Three trust layers**:
1. **Discovery filter** — pre-search, only `status='active'` tools with `reliability ≥ 0.80` are even considered.
2. **Relevance gate** — post-search, vector similarity must be ≥ 0.70 (drops semantic noise).
3. **Contract enforcement** — at call time, input + output schemas are validated; tools that lie circuit-break.

**Two retrieval modes**:
- **Vector** (`/discover?mode=vector`, default) — `$vectorSearch` + composite re-rank (`0.4·vec + 0.6·reliability`). Best for natural-language queries.
- **Hybrid** (`/discover?mode=hybrid`) — Atlas `$rankFusion` of `$vectorSearch` (Voyage embeddings) + `$search` (Atlas Search text). Reciprocal rank fusion with `0.7 vector / 0.3 text` weights. Best for queries that mix semantic intent with concrete keywords ("lint javascript", "extract financial tables from PDF"). Pure adaptive retrieval — different rank arms agree on the trustworthy answer.

---

## Demo

199 tools live in the registry. Headline demo prompts run via Claude Code over MCP:

| # | User prompt to Claude Code | Tool 2chain picks | What happens |
|---|---|---|---|
| **1** | *"Build a DCF for NVIDIA, pull the income statement"* | `sec-edgar-financials@1.0` | **Real fetch** from `data.sec.gov` XBRL API. Live numbers, source URL, schema-validated |
| **2** | *"Lit review on Mamba state-space models, fetch top 3 papers"* | `arxiv-paper-search@1.0` | **Real fetch** from `export.arxiv.org`. Live papers, abstracts, PDF URLs |
| **3** | *"Lint this JS for our CI dashboard, structured findings"* | `eslint-snitch@7.5` | Returns the `{issues: [...]}` contract every time |
| **4** | *"Audit this Python auth function, OWASP-graded"* | `security-scanner@1.5` | Wins over `pylint-pro` because reliability is graded on security, not style |
| **5** | *"Try malformed-bot v1.0 directly"* | `malformed-bot@1.0` | Returns prose instead of JSON → ajv catches it on the wire → tool flips to `circuit_broken` in MongoDB → change stream fires → dashboard ticks red. **Every future agent is now protected.** |

One command to dry-run end-to-end without an agent:

```bash
npm run dev          # in terminal 1
npm run demo:full    # in terminal 2
```

Open `http://127.0.0.1:3030` for the live dashboard. Between recording takes, `npm run reset:state` clears violations and unbreaks circuit-broken tools without re-seeding.

Full prompt set with expected dashboard reactions: [demo/prompts.md](./demo/prompts.md). Stage script: [demo/SCRIPT.md](./demo/SCRIPT.md). Original 4-beat dry-run narrative (pdf-extractor v3.1 reliability drop): [DEMO.md](./DEMO.md).

Measured latencies (real Atlas M10, eu-west-2):

| Operation | Latency |
|---|---|
| `/discover` (warm — query embed pre-cached) | 30ms |
| `/discover` (cold — Voyage call) | 320ms |
| `/push` (embed + 5 evals + status flip) | ~340ms |
| `/call` happy path | ~40ms |
| `/call` triggering circuit-break | ~80ms |

---

## Setup

Prerequisites: Node 20+, an Atlas cluster (M10+ for change streams), a Voyage AI API key.

```bash
git clone https://github.com/kitfunso/2chain.git
cd 2chain
npm install

# Create .env
cat > .env <<'EOF'
MONGODB_URI=mongodb+srv://USER:PASS@cluster.xxx.mongodb.net/?appName=Cluster0
MONGODB_DB=twochain
VOYAGE_API_KEY=pa-xxxxxxxxxxxxxxxx
EOF

npm run smoke:setup     # creates collections, indexes, vector index (1024d cosine)
npm run setup:text      # creates Atlas Search text index (for hybrid mode)
npm run seed            # seeds 199 tools (14 hand-crafted + 185 generated) + 3 agents + eval_runs
npm run dev             # http://127.0.0.1:3030
```

The vector index takes ~45s to become queryable on first creation; the setup script polls until it's ready.

### Atlas requirements

The vector index is created with these filter paths declared up-front (filter paths can't be added post-build):

- `status` (string)
- `metadata.reliability_score` (number)
- `metadata.cost_per_call_usd` (number)
- `metadata.p95_latency_ms` (number)

Change streams require a replica set (M10+ on Atlas). The seed will work on M0, but the dashboard's live re-rank will not — fall back to polling.

---

## Project layout

```
src/
├── types.ts                Shared TypeScript types + locked constants
├── db/client.ts            Singleton MongoClient
├── embeddings/voyage.ts    Voyage v3 fetch wrapper (1024d)
├── fixtures/
│   ├── tools.ts            14 hand-crafted tool specs (incl. sec-edgar-financials, arxiv-paper-search)
│   ├── generated.ts        185 generated specs across pdf-extract, code, summarisation, lint domains
│   ├── cases.ts            15 eval cases across 3 domains
│   └── agents.ts           3 demo agents with sha256-hashed API keys
├── services/
│   ├── discover.ts         $vectorSearch + 0.70 vec-gate + composite re-rank + dedupe
│   ├── discoverHybrid.ts   $rankFusion (vector 0.7 + text 0.3) + heuristic / Cohere re-rank
│   ├── push.ts             insert pending → embed → run evals → flip to active
│   ├── call.ts             ajv input/output validation + fail-fast circuit-break
│   ├── evalRunner.ts       Sequential domain-case runner with 5s per-case timeout
│   ├── stubs.ts            In-process tool registry (case_id-keyed responses + real-fetch wrappers)
│   ├── secEdgar.ts         Real SEC EDGAR XBRL client (CIK lookup, concept fallback chain)
│   ├── arxivSearch.ts      Real arxiv.org Atom feed client
│   └── graders.ts          numeric_tolerance, regex, length, json_schema_array_field
└── server/
    ├── index.ts            buildServer() + change-stream subscriptions
    ├── auth.ts             x-api-key middleware (sha256 hashed lookup)
    ├── sse.ts              SSE broadcast manager
    ├── streams.ts          MongoDB change-stream watchers
    └── routes/
        ├── discover.ts     GET /discover
        ├── push.ts         POST /push
        ├── call.ts         POST /call
        └── dashboard.ts    GET / (HTML), /events (SSE), /state (snapshot)

bin/2chain.mjs              CLI: 2chain push|discover|call
demo/                       Locked tool-spec JSON for Beat 2
scripts/                    Smoke tests + seed + demo:full orchestrator
```

---

## NPM scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the API server on `127.0.0.1:3030` |
| `npm run seed` | Full re-seed: 199 tools, embeddings, agents, eval_runs (~1m25s, hits Voyage) |
| `npm run reset:state` | Fast reset between recording takes: clears violations/usage/rankings, un-breaks circuit-broken tools (no re-embed) |
| `npm run demo:full` | Orchestrated 4-beat dry run with timing labels |
| `npm run demo:beat1`..`4` | Run individual beats |
| `npm run smoke:all` | Run every smoke test in sequence |
| `npm run typecheck` | `tsc --noEmit` |

Per-component smoke tests live under `npm run smoke:*`. All tests use the real Atlas, no mocks (per CLAUDE.md / DESIGN.md).

---

## How the trust layers stack

### 1. Reliability gate (pre-search filter)

```js
$vectorSearch: {
  ...,
  filter: {
    status: { $eq: 'active' },
    'metadata.reliability_score': { $gte: 0.80 },  // hard gate
  }
}
```

Tools below 0.80 are *invisible* to discovery. The /push flow calculates reliability as the eval pass-rate; tools that ship buggy versions get filtered automatically without any agent-side change.

### 2. Relevance gate (post-search filter, D33)

```js
{ $match: { vec_score: { $gte: 0.70 } } }
```

Voyage-3's similarity floor for AI-tool descriptions is ~0.55-0.65 regardless of topic. Without this gate, off-topic tools at high reliability outrank lower-reliability on-topic tools. Standard semantic-search hygiene.

### 3. Contract enforcement (call-time)

Every `/call` validates input + output against the tool's JSON Schema (ajv). On output failure with `output_repair_strategy: 'fail-fast'`, the tool flips to `circuit_broken` immediately and subsequent calls 503 without re-invoking the stub.

---

## Architecture decisions

The full 34-decision log lives in [DESIGN.md](./DESIGN.md). The most consequential:

- **D9** — Pushed tools insert with `status='pending'`, `reliability=0`. Eval runner is the only writer that flips the status. Closes the eval race window.
- **D14** — 5 binary cases per domain → pass-rates quantised to multiples of 0.2. Demo math is deterministic at the 0.6/0.8/1.0 boundaries.
- **D33** — Post-search `vec_score >= 0.70` relevance gate (added at H1 after Voyage-3 baseline tested empirically — see lessons below).
- **D34** — `/push` always ends in `status='active'`. Reliability filtering is done by the discovery gate. Circuit-break is reserved for `/call` contract violations only.

---

## Lessons (added during the build)

> Voyage-3 cosine similarity for AI-tool descriptions floors at ~0.55-0.65 regardless of how topic-separated the descriptions are. The original DESIGN predicted 0.20-0.30 for off-topic; reality is ~0.6. Fixing this with text tuning is fragile. **D33 (post-search vec gate at 0.70) is the right move.** Industry-standard semantic search has this anyway.

> The `/push` flow's status-flip rule had a contradiction in the DESIGN.md sequence diagram (suggested circuit-break at low pass-rate) vs the §3.4 state table and EVALS Beat 2 (status stays active, reliability does the gating). **D34 resolves: push always ends `active`. Circuit-break is `/call`-only.** This matches the demo's narrative: bad versions are *filtered*, not banished — a fixed v3.2 can pass evals later and reclaim the top slot without admin intervention.

---

## Live agent demo (MCP)

2chain ships an MCP server so Claude Code (and any MCP-compatible agent) can use the registry natively. Configure it in your MCP client:

```json
{
  "mcpServers": {
    "2chain": {
      "command": "node",
      "args": ["/path/to/2chain/bin/2chain-mcp.mjs"],
      "env": {
        "TWOCHAIN_HOST": "https://your-codespace-3030.app.github.dev",
        "TWOCHAIN_API_KEY": "sk_demo_pdf_agent_8f2c4a"
      }
    }
  }
}
```

The MCP server exposes two tools:

- **`discover_tools(query, mode?, top?)`** — search the registry, get a ranked list with reliability scores. Returns only tools that pass the 0.80 reliability gate.
- **`call_tool(tool_name, tool_version, input)`** — invoke a tool. Input/output schemas are enforced; bad responses circuit-break the tool automatically.

After configuring the MCP server, prompts like *"extract the line items from this PDF text"* or *"lint this JavaScript for bugs"* trigger Claude to call `discover_tools`, pick the right tool, then call it via `call_tool` — all visible on the dashboard's live call feed in real time.

See [demo/prompts.md](./demo/prompts.md) for 7 ready-to-paste demo prompts covering financial extraction, code review, security scanning, summarisation, invoice parsing, contract violations, and live re-ranking.

## What 2chain works for (beyond the demo prompts)

The headline demo shows two real-fetch tools (SEC EDGAR financials, arxiv paper search) plus three contract-enforced specialists (linter, security scanner, malformed-bot). The same registry mechanism handles any agent task with multiple competing tools and a JSON contract:

| Domain | Multiple tools because... | Eval style |
|---|---|---|
| Audio transcription (Whisper, Deepgram, AssemblyAI) | Accuracy varies per accent, jargon, multi-speaker | WER vs reference |
| Text-to-SQL (Vanna, sqlcoder, Claude, GPT) | Quality varies per schema complexity, dialect | Run vs fixture DB, compare result rows |
| OCR / document understanding (Textract, Document AI) | Per-document-type reliability varies wildly | Field-by-field exact match |
| Code review (already in fixtures) | Different rule sets, different langs, different specialities | Synthetic buggy code, pass/fail per rule |
| Translation (DeepL, Google, Azure) | Reliability per language pair + domain | BLEU vs reference |
| Image generation (DALL-E, SD, Flux) | Style fidelity, brand safety vary | LLM-as-judge with rubric |

The discovery + reliability gate + contract layers stay identical. Only the eval grader changes per domain.

## Roadmap (v0.2)

- **Atlas auto-embedding** — drop the Voyage env var; Atlas Vector Search now generates embeddings on insert.
- **LLM-driven repair branch** — for tools with `output_repair_strategy: 'llm'`, attempt up to 3 schema-guided repairs before circuit-break.
- **Consumer chat UI** — non-technical user types "convert this PDF"; the orchestrator agent calls `/discover` then `/call`. The registry stays the moat; the chat is the wrapper.
- **Signed manifests + sandbox execution** — preventing malicious tools from poisoning the network beyond the contract layer.

---

## Compliance

- **Theme**: Adaptive Retrieval — results reorder as evals roll in; the system gets smarter without any agent code changing.
- **Atlas Sandbox**: required by hackathon (M10 dedicated, eu-west-2 London).
- **Public repo**: yes, this one.
- **Live demo**: see [DEMO.md](./DEMO.md) for the locked 3-min stage script.
- **Submission video**: [youtu.be/puINYgtQXdM](https://youtu.be/puINYgtQXdM) (60s) · script + shotlist in [SUBMISSION.md](./SUBMISSION.md).

---

## Author

Keith So · Principal Researcher and Lead Engineer, KITFUNSO LTD · skfskf27@gmail.com
