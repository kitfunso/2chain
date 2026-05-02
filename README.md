# 2chain

**A tool registry with continuous evals and reliability gating for AI agents.**

Built on MongoDB Atlas Vector Search + Voyage AI embeddings + LangGraph. Every published tool is evaluated automatically; agents discovering tools see only the ones that pass a 0.80 reliability gate. Bad tools are filtered from results, broken tools circuit-break on contract violation. Live re-rank on every push via Atlas change streams.

> MongoDB Agentic Evolution Hackathon, May 2026 — track: **Adaptive Retrieval**.

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

The locked 4-beat narrative is in [DEMO.md](./DEMO.md). One command to dry-run end-to-end:

```bash
npm run dev          # in terminal 1
npm run demo:full    # in terminal 2
```

Open `http://127.0.0.1:3030` for the live dashboard.

| Beat | What happens | Endpoint |
|---|---|---|
| 1 | Caller agent queries the registry, gets a ranked top-N | `GET /discover` |
| 2 | Tool author pushes `pdf-extractor v3.1` with a decimal-comma swap bug; eval runner catches 3/5 → reliability 0.6 | `POST /push` |
| 3 | Caller agent re-queries — v3.1 is filtered, v3.0 still wins. **No agent code changed.** Live re-rank via Atlas change stream. | `GET /discover` |
| 4 | Caller calls `malformed-bot` (passes its own evals but returns prose, not the contracted JSON shape). Contract layer catches the violation and circuit-breaks the tool. | `POST /call` |

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
npm run seed            # seeds 5 fixture tools + 3 agents + pre-computed eval_runs
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
│   ├── tools.ts            5 fixture tool specs (capability_text + cases)
│   ├── cases.ts            15 eval cases across 3 domains
│   └── agents.ts           3 demo agents with sha256-hashed API keys
├── services/
│   ├── discover.ts         $vectorSearch + 0.70 vec-gate + composite re-rank + dedupe
│   ├── push.ts             insert pending → embed → run evals → flip to active
│   ├── call.ts             ajv input/output validation + fail-fast circuit-break
│   ├── evalRunner.ts       Sequential domain-case runner with 5s per-case timeout
│   ├── stubs.ts            In-process tool registry (case_id-keyed responses)
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
| `npm run seed` | Reset to demo-clean state |
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

## What 2chain works for (beyond PDFs)

PDF extraction is the demo because the eval grader is one line: compare numbers within tolerance. The same registry mechanism handles any agent task with multiple competing tools and a JSON contract:

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
- **Submission video**: see SUBMISSION.md (script + shotlist).

---

## Author

Keith So · Principal Researcher and Lead Engineer, KITFUNSO LTD · skfskf27@gmail.com
