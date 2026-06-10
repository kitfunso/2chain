# Episode E4 — Tool health surface

**Status:** Implemented on `feat/e4-health-surface` (plan-eng reviewed, 80; all critic findings folded in). Baseline 197/197 green; 210/210 with this episode's 13 tests.

**Goal:** "Can I trust this tool right now?" takes four manual queries today (tools row, eval_runs history, drift_events, usage counts). One read-only surface answers it for the operator-facing CI dashboard, the API, and the CLI; agents get theirs in E5.

**Non-negotiables enforced:** READ-ONLY feature — no writes, no status flips, no score recompute (lifecycle logic lives in E2, not here); real SQLite tests (no mocks); the service imports nothing from storage drivers (interface types only); parameterized SQL; `escapeHtml()` on every dashboard interpolation.

---

## 1. `src/services/health.ts` — read-only aggregator

`toolHealth(storage, name, namespace?) → HealthReport | null`

```
HealthReport {
  name: string;
  versions: Array<{
    version: string;
    status: ToolStatus;
    tool_kind: ToolKind;
    reliability_score: number;
    last_eval_run: string | null;     // newest eval_runs.triggered_at
    verification_streak: number;      // consecutive most-recent reverify-triggered
                                      // runs with pass_rate >= RELIABILITY_GATE,
                                      // counted until the first sub-gate run
                                      // (0 if none / none clean). Window:
                                      // listEvalRunsForTool(id, 20, 'reverify')
                                      // — max observable streak is 20 by design.
                                      // Interleaved push/manual runs are FILTERED
                                      // OUT (skipped), never streak-breaking (tested).
    score_history: Array<{ at; pass_rate; triggered_by }>;  // newest-first, BOUNDED 20
    usage: Record<string, number>;    // outcome counts, 7-day window
  }>;
  // ROOT-level (E3 stores drift by tool_name, not tool_id — one list per
  // report, never per version). PROJECTED fields ONLY: changes_json is
  // EXCLUDED (it carries contract internals; the unauthenticated dashboard
  // view must never ship it — locked by the security test).
  drift_events: Array<{ from_version; to_version; direction; classification; created_at }>;  // BOUNDED 10, newest-first
}
```

- Versions enumerated via `listToolsByName` (E3, indexed, no cap).
- Unknown name ⇒ null ⇒ route 404 (`tool_not_found`).
- ALL lists bounded (history 20 / drift 10 / usage windowed 7d): an unbounded
  history endpoint on a hot name is a DoS vector (rule 11 spirit).

## 2. Storage additions — E2-collision-aware

E2 (parked, unmerged PR #8) already defines on its branch
`listEvalRunsForTool(toolId, limit, triggeredBy?)` and
`usageOutcomeCountsForTool(toolId, sinceIso)`. E4 adds the SAME methods with
**byte-identical signatures, doc comments, SQL, and the same extracted
`mapEvalRun` helper** so whichever merges second resolves trivially — both
sides add the same hunk. Identical-intent duplicates between the branches are
EXPECTED, not drift.

- `listEvalRunsForTool` — DESC, rides `idx_eval_runs_tool`, optional
  `triggeredBy` filter applies BEFORE the limit (the reverify-only streak
  window must not be starved by other-trigger rows filling the cap).
- `usageOutcomeCountsForTool` — windowed per-tool outcome counts.
- (`listDriftEvents` already on master from E3.)
- Merge-resolver note: only the section-header comments differ from E2's text
  (E2's reference `src/services/scoreLifecycle.ts`, which does not exist on
  master until E2 merges). Method bodies are verbatim; if the headers
  conflict, either wording wins.

## 3. Routes — `src/server/routes/health.ts`

- `GET /v1/tools/:name/health` — `requireAuth(['caller','tool_author','admin'])`:
  read-only, every authenticated role may ask (callers are exactly who needs
  to know whether to trust a tool). 404 standard envelope on unknown name.
- `GET /health-view/:name` — dashboard-scoped, UNAUTHENTICATED, same service,
  same projection. The dashboard today hits `/state` unauthenticated; `/`,
  `/state`, `/events` are unauthenticated by design — same trust boundary,
  read-only, bounded. The `/v1` route stays authenticated for programmatic
  callers.
- `:name` is a path param — Fastify handles decoding; the service treats it
  as exact-match data (parameterized SQL only, no LIKE).
- Both registered from `buildServer` next to the dashboard routes.

## 4. CLI — `2chain health <name>`

Table of versions (status, score, streak, last verified), drift list, one
aggregated 7-day usage line. Mirrors the reverify verb's formatting
conventions. Strict args: exactly one positional, anything else dies before
any fetch.

## 5. Dashboard panel + SSE (no polling)

- Clicking a tool row renders the health detail view from a fetch of
  `/health-view/:name`; refreshes on the SSE events that ACTUALLY exist on
  master: `discover_ran` (fires on every tools-table write via watchChanges →
  rerankAndBroadcast — covers pushes and reverify score writes) and
  `tool_invoked` (covers usage-count changes, filtered to the inspected name).
- The dead v1 `tool_changed` listener was REMOVED (the server never broadcasts
  that event).
- `escapeHtml()` wraps EVERY health-payload interpolation. The renderer lives
  between `// ---- health panel (E4)` source markers and a test statically
  asserts the wrapping over that region (payload-enum comparisons also go
  through `escapeHtml(...)` so no bare payload-field access exists in the
  region — escaping an enum is a no-op).
- Stale-response guard: only the newest in-flight health fetch may render.

## 6. Tests — `tests/health.test.ts` (13, real SQLite, StubEmbedder precedent)

1. Healthy multi-version tool: both versions present, scores, last_eval_run.
2. Streak: 3 clean reverify ⇒ 3; interleaved failing manual run filtered not
   breaking; clean-fail-clean ⇒ 1; push-only ⇒ 0.
3. score_history bounded at 20 (insert 25, get 20 newest-first).
4. drift_events at root, real compatible push writes a real E3 event,
   bounded 10, projected keys only, no per-version drift list.
5. Usage window: 8-day-old rows excluded.
6. Unknown name ⇒ service null ⇒ both routes 404 standard envelope.
7. Route auth: caller 200; missing key 401.
8. Dashboard view route: payload byte-identical to /v1, unauthenticated.
9. CLI strict args via `spawnSync(process.execPath, [bin, 'health'])` and
   `[..., 'health', 'a', 'b']` (E2 cli-spawn precedent; no server needed —
   render data path is proven by the route tests).
10. Catalog kind (importer path: upsertTool + applyKindEval): streak 0 +
    score_history exactly the one triggered_by='manual' rubric run.
11. Circuit-broken tool shows status + score (the "do not trust" answer).
12. escapeHtml static assertion over the marked renderer source region, with
    tautology guards (region non-empty, contains renderHealth, ≥10 wrapped
    sites found).
13. Security: NO 'changes' / 'changes_json' key on any drift event in BOTH
    routes' payloads; contract internals never serialize.

## Out of scope (named cuts)

- E2 blend/recovered/broken_at fields in the report (enrich AFTER E2 merges —
  the report shape gains fields additively).
- Agent-facing freshness in discover results (E5's whole point).
- Historical score CHART rendering (the panel lists; charting is cosmetic
  follow-up).
- Health for namespaces beyond default (multi-tenant surface comes with the
  Postgres tier).
- `PostgresStorage` parity for the two new methods lands with the Postgres
  driver work (sqlite.ts is the only driver implementing the v2 Storage
  interface on master today).
