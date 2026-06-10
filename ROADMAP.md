# 2chain Roadmap

Updated 2026-06-10. The continuous-improvement loop (dev-framework-rl) is
PAUSED at Keith's direction after shipping the full CI-layer arc; this file
is the queue it resumes from. Working notes live in `.devrl-backlog.md`;
this is the curated view.

## Shipped 2026-06-10 — the "CI for agent tools" arc (E1-E5)

| # | Feature | PR | Merge |
|---|---------|----|-------|
| E1 | Scheduled re-verification engine (the CI core) | #6 | `2b779f5` |
| E3 | Contract drift detection on /push | #7 | `8550c44` |
| E2 | Evidence-blended reliability + circuit recovery | #8 | `7a67b5e` |
| E4 | Tool health surface (API + CLI + dashboard) | #9 | `8bf7f47` |
| E5 | Freshness-aware agent-facing discovery | #10 | `b9ab6be` |

The thesis these close: agents fail silently when tool schemas drift, APIs
change, or outputs violate contracts. The registry now catches rot
proactively (E1), records and gates schema drift (E3), scores on evidence
that flapping tools and hostile callers cannot game (E2), answers "can I
trust this tool right now" in one place (E4), and lets agents themselves
weigh staleness at selection time (E5).

## Next up (in priority order)

### 1. E6 — Close the import-channel drift bypass
Importers (`src/import/*.ts`) and `scripts/seed-fixtures.ts` call
`upsertTool` directly, never `push()` — re-imports at hardcoded versions hit
the UPDATE branch and silently REPLACE contracts, bypassing E3's drift gate
entirely. The last silent-drift channel. Needs its own design: imports are
bulk and unowned, so likely record-only drift events rather than gating.
- Falsifiable: re-importing a catalog tool whose contract changed records a
  drift event; the silent-replace path no longer exists.

### 2. Post-merge polish PR (small, batchable — all review-sourced)
- CLI `health` verb: fall back to `2CHAIN_AGENT_KEY` (caller-permitted
  endpoint; caller-only setups currently get `auth_invalid`).
- Dashboard health panel: pending-refresh flag instead of dropping a
  write-driven refresh while a same-name fetch is in flight (convergent
  finding: E4 ship-readiness + codex).
- Dashboard ranking view + CLI `discover` table: show `final_score` (the
  actual ordering key) the way the MCP shim now does.
- `health.ts` → `streak.ts` refactor (E5 shipped the shared pure helper;
  E4's inline copy should use it).
- Dead dashboard listeners (`violation_logged`, `eval_completed`): the same
  remove-or-emit decision `tool_changed` got.
- `listRankings` Storage read so tests stop reaching the raw db handle.

### 3. Hardening follow-ups (recorded, lower urgency)
- Recovery flip: clear `metadata.broken_at` on circuit recovery + optional
  CAS guard (closes an exotic admin-rebreak stale-watermark path).
- Pino logger injection for services (console.warn drift x4 in
  reverify.ts/push.ts — convention says pino-only in src/).
- `mcp-format.mjs` hardcodes RRF weights/dim/gate in trace copy and cannot
  import TS constants — generate it or pin with a test.
- Equal-timestamp version tie-break at E4's newest-50 cap boundary;
  composite `(tool_id, triggered_at)` index if sweep cadence grows.
- ANSI-escape hygiene for CLI output (pre-existing class, all verbs).
- Gate-vs-write TOCTOU on same-author same-name@version push races
  (pre-existing shape; upsertTool UPDATE branch).
- Annotation-keys allowlist (description/title/$comment/examples) so
  doc-only contract edits stop classifying as breaking.
- Mobile dashboard detail overlay: health panel parity.

## Infrastructure / eval debts
- Golden-corpus reproducibility: the seed produces 238 tools but the graded
  corpus is 434 (seed + 2026-05-23 import set) — only the preserved
  `C:/tmp/v2.db` reproduces a corpus-matched DB. Preserve it or rebuild the
  recipe before it is lost.
- CI does not run the five demo prompts (the golden job is
  typecheck+NDCG-formula only; the full eval needs Ollama). Keith directive
  2026-06-10: "no longer in demo" — rule 8's status in CLAUDE.md deserves
  his revision either way.
- Postgres driver (Phase 2) must implement the Storage methods E1-E5 added
  (listEvalRunsForTool, usageOutcomeCountsForTool,
  outputViolationCountForTool, markCircuitBroken, recordEvalOutcome,
  listToolsByName, insertDriftEvent/listDriftEvents) + a migrations/postgres
  003 twin.

## Owned limitations (deliberate, documented)
- Real catalog imports carry freshness 0 until a reverify sweep scores them
  — unverified means stale, by design (PRD item 14).
- E5's freshness re-sort pool is the returned top-K only; a fresh tool at
  RRF rank K+1 never enters. Widening (fetch K+m, re-sort, trim) only if
  the narrow window proves limiting.
- Freshness guarantee is RANK distance (≥5 RRF ranks is safe), not raw
  similarity margin — RRF compresses cosine gaps.
- Recovery score after circuit-break is the evidence blend, not a clean
  slate; a once-rotted tool re-crosses the 0.80 gate after ~K=4 clean
  sweeps under decayed geometry.
