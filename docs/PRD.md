# 2chain v2 (Self-Hosted) — Product Requirements Document

## One-Line Description

A neutral, self-hostable tool registry for AI agents that picks the right specialist tool from many candidates, validates every response on the wire, and quarantines tools that break — runnable on a laptop or behind a corporate firewall, with no managed-cloud dependencies.

## Problem Statement

Today's AI agents are paired with thousands of MCP tools but have no way to tell good from bad, on-topic from generic, or trustworthy from broken at runtime. Existing registries (the official MCP directory, Smithery, LangChain Hub) are dumb lists with keyword search and no quality signal. Heavy AI users spend hours hunting for the right tool; non-technical users give up and blame the model. The 2chain v1 prototype solved this on MongoDB Atlas + Voyage AI, but those dependencies make it impossible to run inside companies with strict data-residency / no-cloud rules and impractical for individual developers who don't want to pay for managed services.

## Target Users

**Personal tier (single-user, laptop-grade):**
- Developers using Claude Code, Cursor, Continue, or any MCP client who want a curated, reliability-graded tool registry running locally
- AI champions inside companies who want to test the architecture before pitching IT
- Hackathon and demo builders who need a self-contained registry that runs on a free instance
- Technical level: comfortable with npm/Docker, not necessarily with cloud or DBA work

**Enterprise tier (multi-user, on-prem or VPC):**
- Internal AI platform teams at regulated companies (banks, healthcare, government) where employee prompts and tool-call data cannot leave the corporate network
- Tool authors inside these companies who publish internal tools alongside vetted public ones (e.g. an internal HR data fetcher next to the public arxiv search)
- Technical level: ops/platform engineers who can run Postgres, K8s, or Docker Compose

Both tiers share one product. The difference is deployment topology, not feature set.

## Core Features (MVP)

1. **Tool registry storage** — name, version, capability text, JSON Schema contracts, reliability score, status, metadata. Backed by Postgres.
2. **Hybrid retrieval** — vector + lexical full-text search fused with Reciprocal Rank Fusion, server-side, in one query. Vector via `pgvector`. Lexical via Postgres `tsvector` + `ts_rank_cd`. Fusion via a single SQL CTE.
3. **Local embedding model** — runs entirely on-device or in-cluster, no API calls. Default: `nomic-embed-text` (768-dim) via Ollama; pluggable to `bge-large-en-v1.5`, `gte-large`, or any HuggingFace model loaded with `transformers.js`.
4. **Reliability gating** — pre-search filter excludes tools below 0.80 reliability. Score is computed from inline eval suite at publish time.
5. **JSON Schema contract enforcement** — every tool call's input and output validated by ajv on the wire. Output violations flip the tool to `circuit_broken` and 503 future calls.
6. **Live registry updates** — Postgres `LISTEN/NOTIFY` drives Server-Sent Events to the dashboard so registry changes propagate without polling.
7. **MCP-native interface** — stdio MCP server exposing `discover_tools` and `call_tool` for Claude Code, Cursor, Continue, etc.
8. **Two deployment modes** — `npm install -g 2chain` for personal (single binary, embedded SQLite + sqlite-vec fallback if no Postgres available); `docker compose up` for enterprise (Postgres 16 + pgvector + the 2chain server).
9. **Existing tool fixtures preserved** — the 14 hand-crafted tools including `sec-edgar-financials` and `arxiv-paper-search` migrate as-is. The 185 generated fixtures port over without changes.
10. **Live dashboard** — single HTML page showing registry, eval runs, violations panel, live call feed. SSE-driven, zero polling.
11. **Continuous re-verification** — the publish-time eval suite re-runs against already-registered tools on demand (`POST /v1/reverify`, `2chain reverify`) or on an opt-in interval (`REVERIFY_INTERVAL_MIN`, default off), so a tool that rots after publish is re-scored and gate-dropped by the registry instead of being discovered live by a user's agent. Catalog entries without an eval suite are skipped, never zeroed.

## What This Product IS NOT

1. **Not a model host.** 2chain does not run language models. It does not generate embeddings as a service to other apps. It does not chat with users. It only picks tools and enforces contracts.
2. **Not a tool execution sandbox.** When a tool calls SEC EDGAR or runs a Python linter, 2chain forwards the request and validates the response. It does not sandbox network egress, it does not isolate filesystems, it does not VM-jail tool authors. Sandboxing is a v0.3 concern.
3. **Not a managed SaaS.** We do not host a multi-tenant cloud version. Hosted-2chain might come later as a separate product; v2 ships only as something users self-deploy.
4. **Not a marketplace with payments.** Tools register and run for free. Revenue capture, billing, subscription tiering, paid-tool discovery — all explicitly out of scope.
5. **Not tied to MongoDB Atlas, Voyage AI, OpenAI, or any cloud-only API.** Everything must run offline, including embeddings. If a deployment can't reach the internet, the registry still works against tools that don't need internet.
6. **Not a replacement for evals frameworks.** 2chain runs its own minimal pass/fail evals at publish time, and re-runs the same suites on re-verification sweeps, to populate the reliability score. Sophisticated eval orchestration (LangSmith, Braintrust, OpenAI Evals) is a separate concern; we offer hooks to plug those in but don't reinvent them.
7. **Not a model router.** 2chain picks tools, not models. Choosing between Claude vs GPT vs Llama for the agent's planning brain is the agent runtime's job, not ours.
8. **Not a logging/observability platform.** We log calls, violations, and reliability changes locally. We don't aim to replace OpenTelemetry, Datadog, or Honeycomb for full agent traces.

## Success Metrics

**Personal tier:**
- Time from `npm install -g 2chain` to first successful `discover_tools` MCP call: under 2 minutes on a fresh laptop.
- Embedding latency for a 199-tool seed on M-series Mac: under 30 seconds.
- Discovery latency (warm): under 50ms p95.
- 100 GitHub stars within 60 days of v2 launch.

**Enterprise tier:**
- Time from `docker compose up` to first successful tool call: under 10 minutes including pgvector index build.
- Discovery latency (warm) with 10,000 tools: under 200ms p95.
- One paying / committed enterprise pilot within 90 days of v2 launch.

**Migration:**
- Existing 199-tool fixture set runs identically on v2 with no capability_text changes.
- All five demo prompts (DCF, arxiv, PR review, security audit, malformed-bot violation) pass end-to-end on the new stack.

## Constraints

- **No managed cloud dependencies.** Every component must run on a single laptop or inside a private VPC. No Atlas, Voyage, OpenAI, Pinecone, Cohere as required dependencies. Optional cloud integrations (e.g. plug-in OpenAI embeddings) are allowed but cannot be the default.
- **TypeScript-first, Node 24+.** Must keep the existing Fastify + ajv + MCP SDK stack to maximize code reuse from v1.
- **Postgres 16 with pgvector is the enterprise reference DB.** SQLite + `sqlite-vec` is the personal-tier fallback. No third option.
- **Single-binary CLI distribution for personal tier.** `npx 2chain` or `npm i -g 2chain` and you're up. No Docker required for individual use.
- **License: MIT or Apache 2.0.** The whole point is enterprise adoption — no AGPL, no SSPL, no source-available licenses that scare procurement.
- **Solo founder timeline: working v2 in 4 weeks, public release in 6.**
- **Preserve the demo narrative.** Same five demo prompts, same on-stage script (with one slide swap to mention "now self-hostable"). Anything that breaks the demo is out of scope.
- **Match v1 quality bar.** No regression on retrieval relevance, no regression on contract enforcement, no regression on dashboard responsiveness. Eval suite from v1 must pass on v2.
