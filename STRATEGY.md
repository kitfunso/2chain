# 2chain

**npm + TypeScript + CI for agent tools.**

A discovery + contracts + continuous-eval layer for the agent-tool ecosystem. Agents register tools by capability, contracts enforce typed I/O at runtime, and an eval harness continuously re-ranks tools as new versions get pushed. The development lifecycle layer for the next generation of agent tools.

---

## Status

- **Event**: MongoDB Agentic Evolution Hackathon
- **Date**: Saturday, May 2, 2026, 9am – 9pm
- **Venue**: CodeNode, 10 South Place, London EC2M 7EB
- **Theme**: Adaptive Retrieval (per official rules — agentic retrieval that "modifies query approaches, alters chunking, reorders results based on input" and "improves over time")
- **Repo**: not initialised yet — `git init` happens Saturday 9am, no earlier
- **Team size**: up to 4 (TBC)

---

## Why 2chain

The Claude-Code/Codex/OpenSWE bar isn't "good app." It's "missing primitive in the agent stack that becomes substrate for everyone else." 2chain is one of those primitives.

Three primitives stacked into one product:

1. **Discovery layer** — tools register with semantic capability descriptions. Agents query `"I need to extract tables from PDFs"` and 2chain returns ranked candidates via vector search over MongoDB Atlas. *The npm part.*
2. **Contract layer** — every tool declares typed input/output contracts. Runtime enforces them. Schema violations trigger an LLM-repair retry, escalation, or circuit-break. *The TypeScript part.*
3. **CI layer** — every tool change triggers an eval suite. Regression scores publish back to the registry. Rankings update via polling. *The GitHub Actions part.*

### Pitch line

> "Tools are how agents touch reality. Today every team builds tools badly, in isolation, with no contracts, no evals, and no discovery. 2chain is the development lifecycle for agent tools — discovery, contracts, and continuous evaluation, on one substrate."

### Why this wins

- **Q&A defensibility from personal expertise**: Keith has built full slash-command pipelines for Claude Code on his own projects. Judges' hardest questions ("how do you handle versioning, deprecation, malicious tools, capability discovery") are ones he's lived. Q&A is where finalists become winners.
- **Build feasibility**: vector search over capability embeddings is a well-trodden MongoDB pattern. No novel primitives to invent in 6.5 hours.
- **Demo determinism**: the regression-detection moment is scriptable and reliable. No live audio, no shadow execution gymnastics.
- **Theme fit**: the Adaptive Retrieval brief asks for "an agentic retrieval system that actively fetches... modifying query approaches, altering chunking, reordering results based on input" and "improves over time and performs reasoning across various documents and sources." 2chain is exactly that — vector retrieval over a tool registry, reordered by reliability scores that update on every push.

---

## Quick Start (post-hackathon — coming soon)

The hackathon ships a working demo and the architecture below. The npm packages roll out post-event.

**For tool authors** (publish a tool, get evaluated, get ranked):

```bash
npm install -g @2chain/cli
2chain init                          # writes ./.2chain/key in cwd
2chain new-tool my-pdf-tool          # scaffolds my-pdf-tool.json with default contracts
# edit my-pdf-tool.json — capability_text, input/output schema, endpoint
2chain validate my-pdf-tool.json     # local schema sanity check
2chain push my-pdf-tool.json         # registers + runs evals + writes reliability
```

**For agent authors** (let your agent discover and call tools):

```typescript
import { TwoChainClient } from "@2chain/client";

const client = new TwoChainClient({ apiKey: process.env.TWOCHAIN_KEY });

// Discovery — vector search + reliability gate + composite ranking
const candidates = await client.discover("extract tables from PDFs", {
  topN: 5,
  minReliability: 0.8     // override per-call
});

// Call — typed contract validation + LLM repair on output violation
const result = await client.call(candidates[0], {
  pdf_text: "Revenue: $1,234.56\nCost: $789.01"
});

console.log(result.rows);
```

**For agent runtimes** (subscribe to ranking changes):

```typescript
client.onRankingChange((evt) => {
  console.log(`tool ${evt.tool_name}@${evt.tool_version} reliability ${evt.score}`);
});
```

> Today these surfaces are fronted by direct HTTP against `/discover`, `/call`, `/push`. The npm packages are roadmap: `@2chain/cli` (the push CLI), `@2chain/client` (the agent SDK).

---

## The 3-minute demo (rehearse to 2:45)

### Cold open (00:00–00:20)
> "Last month Anthropic shipped the official MCP registry. It tells you what exists. Smithery hosts 7,300 servers. They count how often each gets called. Neither tells you whether a tool actually *works* — today, on the input you're about to give it. So we built one that does."

Architecture diagram on screen. Three pillars: Discovery, Contracts, CI.

### Beat 1 — Discovery works (00:20–00:50)
On-stage agent receives: *"Extract tables from this financial report PDF."*

Agent queries 2chain. Vector search returns ranked candidates: `pdf-extractor-v3` (reliability 100%, p95 latency 1.2s, $0.003/call), `pdftools-pro` (80%, 2.1s, $0.001), three others below.

Agent picks #1. Calls it. Tables extracted cleanly. Ranking ticker visible.

### Beat 2 — Bad version pushed, CI triggers (00:50–01:45)
Live: a teammate runs `2chain push pdf-extractor@3.1.json` — a "bad" version. Hidden bug: misformats numbers in financial tables.

The push CLI directly invokes the eval runner (no change-stream dependency). Runner executes 5 pre-curated deterministic eval cases against the new version (the failing-numbers case is one of them, run live; the other 4 are pre-cached). Reliability drops from 100% to 60% (3/5 cases pass). The hard reliability gate excludes any tool with `reliability < 0.80` from top-N, so v3.1 is filtered out entirely.

Dashboard polls `/rankings` every 2s and renders the flip on screen.

### Beat 3 — The agent never saw the regression (01:45–02:15)
Same agent, fresh task, identical query. Vector search returns the same top-N as Beat 1 — except the bad version is filtered out. The agent never sees v3.1. The registry caught the regression in seconds, and every other agent in the room is now protected automatically. That's the spine.

### Beat 4 — Contract enforcement (02:15–02:45)
Different agent calls a tool that returns malformed JSON. Contract layer catches it on the wire. **LLM-repair retry**: a small LLM call rewrites the response against the output schema. Second attempt: still fails. Third attempt: still fails. Circuit-break (scope: `tool_name@version` globally, manual override available). Audit log to MongoDB. Agent gracefully degrades to alternative tool.

### Close (02:45–03:00)
Close slide (full-bleed black, three lines): "2chain / Tools that lie get filtered. / Tools that work get found." Roadmap details (monetisation, multi-tenant private registries, capability composition, governance for malicious tools) live in this README, not on a slide. Tagline spoken aloud:
> "Tools are how agents touch reality, and right now, nobody knows which ones lie. Discovery. Contracts. Evals. We're 2chain."

---

## Architecture

### Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | Familiar; clean Atlas SDK |
| Agent runtime | LangGraph | First-class MongoDB Checkpointer integration |
| Database | MongoDB Atlas (M0 + Vector Search) | Required by hackathon rules; converged docs + vectors |
| Embeddings | Voyage AI `voyage-3` (1024-dim) | MongoDB's blessed embedding partner. **Pre-embedded only — never on the live demo path.** |
| LLM inference | Fireworks AI + Anthropic | Sponsor partners; Fireworks credits in prize pool |
| Observability | LangSmith | Sponsor partner; checkpointer integrates natively |
| Cloud | AWS | Required for finalist eligibility |
| Frontend | Next.js or simple React | Whatever ships fastest |

### Why not Atlas Streams / change-stream-driven eval

The Atlas Sandbox tier is unknown pre-event (revealed only when the email link is opened). M0 has restricted change-stream filtering, 100 ops/sec, 0.5 GB storage. M10+ removes those caps and makes Atlas Streams reliable. The default plan **does not depend on streams** — polling is correct under M0 and merely conservative under M10+:

- Eval triggers run **inline in the push CLI** (push pipeline calls eval runner directly).
- Ranking updates propagate via **2-second polling from the dashboard and from agents**, not push.
- This is boring, deterministic, and survives flaky Wi-Fi.

If Streams turns out to be available and stable on the day, we can swap polling for subscriptions in 15 min — but the demo never blocks on it.

### MongoDB collections

```
2chain (database)
├── tools                  // tool registry, one doc per version
├── capabilities           // capability embeddings + metadata
├── contracts              // input/output schemas per tool
├── evals                  // eval test cases per capability domain (5 per domain max)
├── eval_runs              // time-series of eval results
├── rankings               // computed rankings per capability query (cache)
├── violations             // contract violation log (append-only)
├── usage                  // tool-call telemetry
└── agents                 // registered agent identities (api_key, owner)
```

### Tool definition schema

```typescript
interface Tool {
  _id: ObjectId;
  name: string;                    // "pdf-extractor"
  version: string;                 // "3.1.2"
  author_agent_id: string;         // FK → agents._id
  capability_text: string;         // human description, embedded
  capability_embedding: number[];  // voyage-3 vector, 1024 dim — pre-computed
  input_contract: JSONSchema;
  output_contract: JSONSchema;
  output_repair_strategy: 'llm' | 'fail-fast';
  endpoint_stub_name: string;      // key into in-process stub registry
  metadata: {
    cost_per_call_usd: number;
    p95_latency_ms: number;
    reliability_score: number;     // 0..1, written by eval runner
    last_eval_run: Date;
  };
  status: 'pending' | 'active' | 'deprecated' | 'circuit_broken';
  created_at: Date;
}
```

### Tool hosting (stubs only — declared up front)

For the hackathon, tool endpoints are **stub functions hosted in the same Node service**, not real Lambdas or external HTTPS endpoints. Each "tool" is an in-process function with a registered name. The plan does not pretend to ship real hosted tools in 6.5 hours; the hosting story is part of the roadmap.

### Auth & agent identity

- Each `agents` doc has an `api_key` (random 32-byte hex).
- Pushing a tool: caller passes `X-2chain-Key` header; only the agent matching `author_agent_id` can push new versions of an existing tool.
- Calling a tool: any registered agent with a valid key.
- Editing eval cases: restricted to the registry admin agent (one for the demo).
- For the demo, three pre-seeded agents share keys hard-coded in fixtures. Real auth is roadmap.

### Vector search index

Atlas Vector Search index `tools_capability_idx` on `tools.capability_embedding` (1024-dim, cosine). **Build this Saturday Hour 1**, with a readiness check (`db.tools.aggregate([{$vectorSearch: ...}]).itcount()` returning >0) before declaring Hour 2 done.

Hybrid search: `$vectorSearch` + numerical filter `reliability_score >= 0.80` (hard gate — see ranking).

### Ranking algorithm (rebalanced)

```
score = vector_similarity * 0.4
      + reliability_score * 0.6

HARD GATE: any tool with reliability_score < 0.80 is excluded from the top-N
           result set entirely (applied at the $vectorSearch filter stage).
```

Cost and latency are stored on tools and shown to agents but excluded from the composite score for the demo (see DESIGN.md D24). Bringing them back as opt-in per-call weights is roadmap.

**Why these weights matter**: the original `0.5/0.3/0.1/0.1` only moves the score by `0.075` when reliability drops 25 points — vector similarity alone could keep the bad tool ranked #1 on stage. The hard gate makes Beat 2 deterministic: any tool that crosses below 0.80 disappears from the list.

Default weights configurable per-agent for "I want cheapest" vs "I want most reliable."

### Eval harness flow (no change streams)

1. Tool author runs `2chain push <tool.json>` (CLI).
2. Push CLI writes the new tool doc, then **directly invokes the eval runner** (in-process or via HTTP to runner service).
3. Runner loads the **5 pre-curated eval cases** for that capability domain (PDF extraction, summarisation, etc).
4. Runs cases in parallel.
5. Computes pass/fail, latency, cost.
6. Writes `eval_runs` document.
7. Recomputes `reliability_score`, updates `tools` doc.
8. Dashboard and agents pick up the change on next 2s poll.

For the demo, **3-4 of the 5 eval cases are pre-computed** (cached in `eval_runs` to avoid live LLM cost) — only the deterministic "financial-numbers" case runs live, taking ~2s.

### Eval test case design

- Cases are written by the registry team, not tool authors. Tool authors cannot edit `evals` collection.
- Each case is `{input: ..., expected_output: ..., grader: function}`. Grader is a deterministic function (regex match, JSON-schema check, numeric tolerance) — no LLM-as-judge for this hackathon.
- Tool-author gaming is acknowledged in roadmap (held-out test sets, secret cases) but not solved in 6.5 hours.

### Contract enforcement runtime

Sits between agent and tool endpoint. On every call:
1. Validate input against `input_contract` (zod or ajv). Hard fail on bad input — no retry.
2. Forward to tool endpoint.
3. Validate response against `output_contract`.
4. **On output violation** → log to `violations`. Then:
   - If `tool.output_repair_strategy === "llm"` (the default for LLM-backed tools): call a small LLM with the schema + the malformed response, ask for a corrective rewrite, validate again. Up to 3 attempts.
   - If `tool.output_repair_strategy === "fail-fast"` (deterministic tools): no retry, immediate violation.
5. After 3 failed attempts (or 1 fail-fast failure) → **circuit-break the tool**. Scope: `(tool_name, version)` globally. Status flips to `circuit_broken`. Manual override via admin endpoint.
6. Caller gets a structured violation; agent retries discovery for a new tool.

---

## Prizes (FYI — what we're playing for)

| Place | Cash | Credits + extras |
|---|---|---|
| 🥇 1st | £7.5k | 1-mo Founder House residency, $3k LangSmith, $5k Fireworks, $3k Emergent, 3-mo ElevenLabs Pro/person, NVIDIA Jetson Orin Nano, NVIDIA RTX 5080 |
| 🥈 2nd | £4.5k | $2k LangSmith, $3k Fireworks, $2k Emergent |
| 🥉 3rd | £3k | $1k LangSmith, $2k Fireworks, $1k Emergent |
| 🏆 Best Use of ElevenLabs (separate async track) | — | 6-mo Scale tier ($1980/person) |

**Three-round process** (all required for prize eligibility):
1. **May 2 first-round judging** (5:15-6:45pm) — 3-min live demo + 1-2 min Q&A
2. **May 7 community vote** at MongoDB.local London — visitors vote for favourite. Top 3 advance.
3. **May 7 mainstage** — 3 min presentation + 2 min Q&A. 1st/2nd/3rd selected.

**At least one team member must attend MongoDB.local on May 7** to be eligible for finals/prizes.

---

## Hackathon rules — critical compliance

### Hard rules (per the participant guide)
- **Theme**: must build in one of three — Prolonged Coordination, Multi-Agent Collaboration, **Adaptive Retrieval** ← 2chain.
- **Atlas Sandbox is functionally mandatory**: project + cluster must be created through the email link. Projects not built in the sandbox are ineligible for finals or prizes.
- **Atlas as core component** for finals (per participant guide). The earlier resource-guide line "MUST build on Atlas & AWS" is contradicted by the participant guide which only requires Atlas. **Treat AWS-deployable as a stretch, not blocking.**
- **Open source**: repo must be public.
- **Team size**: max 4. Solo allowed.
- **New work only — built entirely during the event**: anything pre-existing must be a disclosed dependency, not part of the demoed contribution. Failure to clearly distinguish = immediate disqualification.
- **At least one team member must attend MongoDB.local London on May 7** to be eligible for finals + prizes (3-round process: round 1 May 2 first-round judging; round 2 May 7 community vote; round 3 May 7 mainstage).
- **Live demo, not a presentation**: judges look at what was built. No slide decks beyond architecture + close.
- **Submission**: 1-min demo video + public repo URL + accessible demo link, all team members on submission page.

### Banned project archetypes (do not build)
AI mental health advisor, basic RAG, Streamlit apps, image analyzers, AI for education chatbots, AI job screeners, AI nutrition coaches, personality analyzers, AI medical advice.

### Judging weights (round 1 — May 2)
- **Live Demo**: 45%
- **Creativity & Originality**: 35%
- **Impact Potential**: 20%

Round 2 (community vote May 7) and Round 3 (mainstage May 7) use equal weights across the same three categories.

### 2chain compliance check
- Adaptive Retrieval theme ✓
- Atlas Sandbox (mandatory for finalists) ✓
- Atlas Vector Search as core component ✓
- AWS-deployable (stretch, not blocking) — defer to finalist round
- Public repo from Saturday `git init` ✓
- Not a banned archetype ✓
- 1-min submission video + public repo + 1+ team member at MongoDB.local May 7 (TBC) ✓

---

## Pre-Saturday prep (this week)

### Definitely safe — do all of this

**Planning docs** (this file plus):
- `DESIGN.md`: schemas, queries, agent topology, eval harness flow
- `DEMO.md`: word-for-word 3-minute script with timestamps and fallbacks
- Architecture diagram (Excalidraw)
- Pitch deck for Q&A reference

**Environment setup**:
- MongoDB Atlas Sandbox: open the email link Saturday morning, accept the project invite, allowlist CodeNode WiFi (or `0.0.0.0/0`). Log the cluster tier — it determines D2 (polling vs change streams).
- AWS account ready
- API keys: Anthropic, Voyage AI, Fireworks AI, LangSmith — all tested with `curl`
- `.env.example` written

**Demo fixture *specs* (text descriptions only, NOT committable JSON files)**:
- The 5 seed tool definitions, described in DESIGN.md and EVALS.md as schemas + capability_text drafts. Actual JSON files are authored Saturday H1, in the new repo.
- The 5 eval cases per capability domain, described in EVALS.md §3 as input/grader/expected tables. Actual JSON files Saturday H1.
- The "bad tool" payload, described in EVALS.md §3.1 + DESIGN.md §6.1 as the v3.1 stub behavior. Actual JSON Saturday H1, in `bad/`.
- The agent prompts, described in DEMO.md §3 as a literal string (`DEMO_AGENT_QUERY`). Actual env file Saturday H1.
- 3 agent identities + key generation procedure, described in DESIGN.md §7. Keys generated Saturday H1.

**Voyage embeddings — Saturday H1, not earlier**: run all seed tool `capability_text` through Voyage during H1 in the new repo. Verify the produced cosine similarities match the target bands in DESIGN.md §3.4. **Voyage is never called during the live demo.**

**Compliance hard rule**: nothing executable, no JSON files, no embedded vectors, no env files, no shell scripts, no `expect` traces, no API key files exist in the `2chain` repo before `git init` Saturday at 9am.

**Reading**:
- MongoDB "Build AI Agents with MongoDB" tutorial
- LangChain + MongoDB partnership docs
- Atlas Vector Search filtering docs
- Skim MCP registry, Smithery, Anthropic's tool directory for differentiation language

**Demo assets**:
- Cold-open slide
- Architecture diagram
- Close slide (full-bleed black with the "Tools that lie / Tools that work" tagline)
- **Pre-recorded fallback demo video** in case live fails

### Grey zone — proceed with care

A "hello world" connectivity check that proves: LangGraph + MongoDB Checkpointer + Voyage AI + Atlas Vector Search all stand up. Throw it away Saturday morning.

Reusable libraries from elsewhere can be `npm install`'d as a dependency. Disclose in README.

### Hard no — do not write before Saturday

- Any code in the actual `2chain` repo
- Tool registration logic
- Vector capability search implementation
- Eval harness implementation
- Ranking algorithm implementation
- Contract enforcement runtime
- Agent that performs the demo task
- Demo orchestration code
- The MongoDB index creation scripts (write Saturday — 10 min)
- Any frontend/UI code

The repo gets a fresh `git init` Saturday 9am. Zero commits before that.

---

## Saturday hour-by-hour (rebalanced)

| Hour | Time | Goal |
|---|---|---|
| 0 | 9:00 | Doors open. Eat. Confirm team. `git init`. Wire up Atlas + AWS + LangSmith. |
| — | 10:00 | Welcome kick-off (per official schedule) |
| 1 | 10:00 | **Hour 1**: scaffold project; create MongoDB schemas + vector index; **start vector index build** (longest async dependency); register seed tools with **pre-computed embeddings** |
| 2 | 11:00 | **Hour 2**: vector capability search + ranking query end-to-end; **vector index readiness check** |
| 3 | 12:00 | **Hour 3**: agent discovery client (LangGraph node) + push CLI scaffold + inline eval runner |
| 4 | 13:00 | Lunch + **Hour 4**: eval runner glue; reliability_score writeback; ranking dashboard polling |
| 5 | 14:00 | **Hour 5**: end-to-end discovery + push + rerank flow rehearsable (NO contract layer yet) |
| 5.5 | 14:30 | **Decision point**: contract layer ships only if H5 demo flow is rehearsing cleanly |
| 6 | 15:00 | **Hour 6**: contract enforcement runtime (LLM-repair retry, circuit-break) — OR — polish + film fallback if cut |
| 6.5 | 15:30 | **Hour 6.5**: end-to-end rehearsal #1 |
| 7 | 16:00 | Bug fixes from rehearsal; **rehearsal #2** |
| 7.5 | 16:30 | **rehearsal #3** — film fallback video on this run |
| 8 | 17:00 | **Submissions due**. Submit. |
| 8.25 | 17:15 | First-round judging starts |
| 9 | 18:00 | Dinner |
| 10 | 19:00 | Top 6 demos; closing remarks |

**Key shift from prior plan**: Beat 4 (contracts) is now a Hour-6 stretch goal gated on a working H5. Beats 1-3 (the spine: discovery, push, rerank) ship by H5 or we scope-cut hard. Vector index build starts at H1 because it's the longest async dependency.

---

## Demo orchestration — what to pre-build (Saturday morning, in repo)

- One agent persona: `demo-pdf-agent` (LangGraph). Second agent (`demo-coder-agent`) is **stretch only** for Beat 4.
- A "tool author" CLI: `2chain push <tool.json>` — used live on stage to push the bad version. **The CLI synchronously triggers the eval runner.**
- A live-updating ranking dashboard (simple React, **2s polling** against `/rankings`).
- A contract violation viewer (only if contract layer ships).

---

## Risk register

| Risk | Mitigation |
|---|---|
| Live demo glitches during the 3-minute slot | Pre-recorded fallback video; rehearse 3x before submission |
| Atlas Vector Search index slow to build | Build during Hour 1, readiness check at Hour 2 — leaves 4hr buffer |
| Voyage AI rate limits or latency | Pre-embed all seed tools and demo queries Saturday morning. Voyage out of live path. |
| Atlas Streams unavailable on M0 | Plan does not depend on Streams. Polling everywhere. |
| Eval harness too slow on stage | 3-4 of 5 eval cases pre-computed; live demo only runs 1 deterministic case (~2s) |
| Bad-tool push doesn't actually flip ranking on stage | **Hard reliability gate (< 0.80 excluded)** + reliability weight bumped to 0.6. Tested in rehearsal. |
| Tool endpoint hosting fails | Stubs in-process; declared up front; not a real-hosting story |
| Contract retry loop looks fake (deterministic tool fails 3x identically) | LLM-repair is the default retry strategy; deterministic-tool branch is fail-fast in 1 attempt |
| External API outage (Voyage / Fireworks / Anthropic) | Voyage pre-embedded; Fireworks/Anthropic only used in Beat 4's LLM-repair (cut Beat 4 if either is down) |
| Bad Wi-Fi at venue | M0 cluster on cellular hotspot fallback |
| Judge asks "isn't this MCP registry?" | "MCP registry is a directory; 2chain adds evals, contracts, and continuous ranking. Different layer of the stack." |
| Judge asks "isn't this Smithery?" | "Smithery hosts MCP servers. We're the development lifecycle: discovery + contracts + CI. Compatible with Smithery as a hosting layer." |
| Judge asks "why MongoDB instead of Postgres + cron?" | Vector search + JSON-flexible contracts + change-stream future option in one converged store. Postgres needs pgvector + a separate orchestrator + a separate trigger system. |
| Judge asks "can tool authors game the evals?" | Yes, in principle. Held-out cases + secret graders are roadmap. Today's defence: registry team owns `evals`, tool authors can't edit them. |
| Judge asks "who trusts the scores?" | Eval cases are deterministic, public, and versioned. Reliability is reproducible — anyone can re-run. |
| Judge asks "what if evals disagree with production usage?" | `usage` collection logs real call outcomes. Roadmap: blend usage-derived reliability with eval-derived reliability. |
| Judge asks "how do agents know rankings are fresh?" | Rankings doc has `computed_at`. Agents poll every 2s during demo. Production: webhook subscriptions or change streams when stable. |
| Team has 6.5hr budget exceeded | Cut contract beat first (priority 1 below). |

### Scope cuts in priority order if time runs short
1. **Drop contract beat (Beat 4)** — saves 60 min. Discovery + CI rerank is the spine.
2. **Drop second agent** — saves 30 min. Single agent through Beats 1–3.
3. **Drop live UI updates, use static ranking display** — saves 30 min.
4. **Hard-code one eval case instead of running 5** — saves 30 min.

The minimum viable demo is: agent queries → ranked tools returned → bad tool pushed → reliability drops → hard gate excludes it → next query returns different tool. Everything else is bonus.

---

## Q&A cheat sheet (rehearse the answers)

| Question | Answer |
|---|---|
| How is this different from the official MCP registry? | The MCP registry (`registry.modelcontextprotocol.io`, launched preview 2026) is a metadata catalog — it tells you a server exists. 2chain runs evals, enforces typed contracts, and re-ranks by reliability. It tells you whether a tool *works*. |
| Isn't this just Smithery? | Smithery hosts MCP servers and counts calls. We're orthogonal — the eval + contract + ranking layer. Smithery is a hosting backend we could plug into. |
| Are you compatible with Smithery / the official MCP registry? | Yes. 2chain consumes their metadata, layers contracts + evals + ranking on top. Tool authors can publish into the registry and 2chain. |
| How is this different from LangSmith Evals? | LangSmith evaluates the agent's *trajectory* across a trace. 2chain evaluates the *tool itself*, in isolation, and re-ranks it in a registry. Different unit of evaluation, different consumer (the agent runtime, not the human dev tuning prompts). |
| Why MongoDB instead of Postgres + cron? | Atlas converges vector search, JSON-flexible contracts, and change streams in one store. Postgres needs pgvector + a separate orchestrator + a separate stream system. |
| Can tool authors game the evals? | Yes, in principle. Held-out test sets and secret graders are roadmap. Today: registry team owns `evals`, tool authors can't edit them. |
| Who trusts the scores? | Eval cases are deterministic, public, versioned. Reliability is reproducible — anyone can re-run. |
| What if evals disagree with real production usage? | `usage` collection logs every call. Roadmap blends usage-reliability with eval-reliability. We chose eval-only today for demo determinism. |
| How do agents know rankings are fresh? | `rankings` docs have `computed_at`. Agents poll every 2s. Webhooks/streams are the production path. |
| What stops a malicious tool from poisoning the network? | Author identity is checked on push. Circuit-breaker globally disables a tool that fails contracts. Roadmap: signed manifests, sandbox execution. |
| What's the business model? | Free for OSS tools. Paid tiers for private registries, premium evals, monetised tool listings. Out of scope today. |
| Why TypeScript? | Aligns with the agent-tool-author audience (most MCP/LangGraph work is TS). Atlas SDK is mature. |

---

## Open questions to resolve this week

- Team composition (solo vs 2-4)?
- Pitch the bad-tool live-push as "competitor sabotage" or "honest mistake"? (Honest mistake is more sympathetic.)
- Submission video script (1 min) — separate from live demo
- Branding: just "2chain" wordmark, or a logo? Time-cheap design wins.

---

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| pre-Sat | Adaptive Retrieval theme | Cleaner fit — the rules' "reordering results based on input" + "improves over time" is 2chain's literal mechanic |
| pre-Sat | TypeScript over Python | Cleaner Atlas SDK; matches MCP/LangGraph community |
| pre-Sat | LangGraph over crewAI / autogen | MongoDB Checkpointer integration |
| pre-Sat | Voyage AI over OpenAI embeddings | MongoDB partnership signal |
| pre-Sat | Net-new repo, fresh git init Saturday | Disqualification risk if reused |
| pre-Sat | Polling, not Atlas Streams | M0 reliability; 2s polling is good enough; simpler to demo |
| pre-Sat | Hard reliability gate (< 0.80 excluded) | Makes Beat 2 ranking-flip deterministic |
| pre-Sat | Reliability weight 0.6 (was 0.3) | 0.075 score swing was too small to flip top-1 |
| pre-Sat | Eval = 5 cases per domain, mostly pre-computed | Stage determinism > scale theatre |
| pre-Sat | Tool endpoints are in-process stubs | Real hosting in 6.5h is unrealistic; stated up front |
| pre-Sat | LLM-repair retry default; fail-fast for deterministic tools | Avoids the "retry the same broken thing 3 times" theatre |
| pre-Sat | Circuit-break scope: `(tool_name, version)` globally | Simplest defensible scope |
| pre-Sat | Beat 4 (contracts) is H6 stretch goal, not core path | Discovery + rerank is the spine |
| pre-Sat | Frame as "npm + TS + CI for agent tools" | Codex-suggested framing — clearest mental model |

---

## Useful references

### Hackathon
- Participant guide (Notion): https://mongodb-hackathons.notion.site/MongoDB-Agentic-Evolution-Hackathon-350bf2cba6d5803992b0dfe0f0b7e018
- Submission portal: https://cerebralvalley.ai/e/mongo-db-london-hackathon/hackathon/submit
- Discord: https://discord.gg/GnBNJpXk5 (mandatory infrastructure — sponsor questions, official updates, team formation)
- Venue WiFi: SSID `CodeNode`, password `EnterSpace`
- Getting to CodeNode: Moorgate or Liverpool Street tube (both <5 min walk). Santander Cycles dock at Moorgate.

### Our infrastructure
- **MongoDB Atlas Sandbox** (mandatory, per hackathon rules): the project + cluster MUST be created through the sandbox link sent by email. Don't use a personal Atlas org.
  - Cluster connection string lives in `.env` (never commit)
  - Vector index name: `tools_capability_idx` (1024 dim, cosine, on `tools.capability_embedding`)
  - IP allowlist: add CodeNode WiFi Saturday morning via the sandbox dashboard (or `0.0.0.0/0` for the day, then locked down post-event)
  - **Tier unknown until the email link is opened** — could be M0 (constrained) or M10+ (change streams viable). H1 first task: open the link, log the tier, decide D2 (polling vs streams) accordingly.

### Documentation
- MongoDB Build AI Agents: https://www.mongodb.com/docs/atlas/atlas-vector-search/ai-agents/
- LangChain + MongoDB partnership: https://www.langchain.com/blog/announcing-the-langchain-mongodb-partnership-the-ai-agent-stack-that-runs-on-the-database-you-already-trust
- Atlas Vector Search overview: https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/
- Voyage AI embeddings: https://docs.voyageai.com/
- Fireworks AI inference: https://docs.fireworks.ai/

---

## Mantras

- **Demo first, build to demo.** Every line of code serves the 3-minute narrative.
- **Net-new repo, fresh `git init` Saturday.** No exceptions.
- **Discovery + rerank is the spine.** Contracts are bonus. Cut contracts before anything else.
- **Polling beats streams.** Boring, deterministic, survives bad Wi-Fi.
- **Voyage out of the live path.** Pre-embed everything.
- **Hard reliability gate makes the demo deterministic.** Tested in rehearsal.
- **Stubs are honest.** Real hosting is roadmap, said out loud.
- **The Q&A is half the score.** Cheat sheet rehearsed.
- **MongoDB is not a backend, it's the showcase.** Every architectural choice should make Atlas look good.
