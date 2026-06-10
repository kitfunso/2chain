# E2 — Evidence-driven reliability lifecycle (decay + recovery)

Branch `feat/e2-reliability-lifecycle` off master 8550c44 (E1 + E3 merged,
baseline 197/197).

## Problem

`reliability_score` was the latest pass_rate — a point sample. A tool that
fails every other sweep scored 1.0 the moment one run passed; a tool with
months of clean history scored 0.0 after one bad run. And `circuit_broken`
was a dead end: D34 made `call.ts` the only flip site and recovery was
explicitly deferred to E2 (reverify already ran + recorded evals for
circuit-broken tools but passed status through untouched).

## Design

### 1. `src/services/scoreLifecycle.ts` — pure scoring module

No storage/driver imports; all inputs passed in, `now` injected. Exports
`blendReliability(evalHistory, usage, now)` and
`evaluateRecovery(recentReverifyRuns, gate)` plus the tuning constants
(named exports, deliberately not env-configurable).

**Blend** = 0.8 × eval leg + 0.2 × usage leg:

- **Eval leg**: exponential recency decay, `w_i = 0.5^(age_days_i / 7)`,
  `eval_score = Σ(w_i · pass_rate_i) / Σ(w_i)`. History spans ALL
  `triggered_by` values (push/manual/reverify); only recovery filters to
  reverify-triggered runs. Negative ages (clock skew) clamp to 0.
- **Usage leg** (caller-fault never counts against the tool):
  `usage_score = ok / (ok + output_violations + timeout)`. The `usage`
  table's `violation` outcome conflates input-stage with output-stage and
  has no stage column, so `output_violations` is counted from the
  `violations` table `WHERE stage='output'` over a 7-day window.
  Input-stage violations appear NOWHERE — malformed-input spam cannot drag
  a healthy tool below the gate. `circuit_broken`/`gated` usage outcomes
  are EXCLUDED (consequences of scoring, not evidence). Stub-side timeouts
  (CALL_TIMEOUT_MS) are tool-fault evidence.
- **Fallbacks**: no usage evidence ⇒ eval leg weight 1.0; no eval history ⇒
  usage-only; both empty ⇒ 0.
- Float discipline: no byte-identity assumptions anywhere; test assertions
  are epsilon-based (the push JSON.stringify and reverify json_set write
  paths round-trip differently at the last ulp).

**Recovery** (`evaluateRecovery`): true iff ≥ 3 reverify-triggered runs
exist, the 3 most recent all have `pass_rate >= gate`, and the oldest and
newest of those 3 are ≥ 60 minutes apart (back-to-back sweeps of a
deterministic suite carry the evidence of one — spacing forces evidence
across time). Recovery is evaluated ONLY during unfiltered sweeps; the
tool_author filtered path can refresh scores but never flips status.

### 2. Write points (rule 7 intact)

`metadata.reliability_score` stays the materialized truth the SQL gate
reads. Push is unchanged (day-1 score = publish pass_rate; a new version is
a new tool_id ⇒ fresh evidence line). The reverify sweep is THE recompute
point: after inserting the run, it fetches history + usage evidence and
writes the blend via `recordEvalOutcome`. `/call` never recomputes
(latency-critical; usage evidence enters at sweep cadence).

### 3. Recovery — the documented D34 amendment

In the unfiltered sweep, after recording a circuit-broken tool's run: if
`evaluateRecovery(history, RELIABILITY_GATE)` → `setStatus(tool.id,
'active')`, reported in the new summary field `recovered: string[]`.
Direction-bound: reverify may flip `circuit_broken → active` ONLY — never
the reverse, never touches `pending`. `call.ts` remains the only flip TO
`circuit_broken`. Documented at five sites: call.ts D34 comment, reverify.ts
header, routes/reverify.ts authz comment, ARCHITECTURE service-boundaries
row, PRD item 11.

### 4. Storage additions

- `listEvalRunsForTool(toolId, limit)` — newest first; rides
  `idx_eval_runs_tool` (composite index noted as future option only).
- `usageOutcomeCountsForTool(toolId, sinceIso)` — windowed per-tool counts
  from `usage` (`occurred_at`).
- `outputViolationCountForTool(toolId, sinceIso)` — from `violations`
  `WHERE stage = 'output'`.

No Postgres twin: no postgres driver exists; Phase 2 implements the
interface (same status as the E1/E3 methods).

### 4b. Summary semantics under the blend

`passed`/`failed` stay RAW-RUN facts (this sweep's suite pass_rate vs the
gate). `gate_dropped` becomes a BLEND crossing (previous materialized score
≥ gate AND new blend < gate). `recovered` is new. A run can be `passed` yet
`gate_dropped`, or `failed` without `gate_dropped` — both tested.

### 4c. prompt-kind dead end (fixed at root)

`call.ts`'s `kind_not_callable` check covered 'skill' and 'subagent' but
not 'prompt', so a prompt-kind entry could reach the stub, circuit-break,
and then be skipped forever by reverify's catalog-kind partition — a dead
end recovery can never reach. 'prompt' joins the check; the E1-era test
asserting prompts pass the gate is reversed.

### 4d. Breaking changes (all updated in this episode)

- `tests/reverify.test.ts` test 2: E1's restore acceptance (snap back to
  1.0, immediate re-discovery) is REVERSED into evidence semantics — see
  the K = 4 note below.
- `tests/reverify.test.ts` test 8: Object.is byte-identity is impossible
  under the blend; rewritten to POLICY parity (same lenient grading, raw
  run pass_rate equal within epsilon).
- CANONICAL errored shape: `Array<{tool: string /* name@version */, error:
  string}>`. `bin/2chain.mjs` prints `tool (error)` and mentions the
  `recovered` list when present (the CLI is the summary's one external
  consumer).

### 5. E1 carry-in debts shipped here

Direct tests for eaa0501 behaviors (CLI strict-args rejection via spawning
the real bin, `isSweepInFlight` suppression flag, single post-sweep rerank
via the route's `afterSweep` seam); errored diagnostics; the
insertEvalRun→recordEvalOutcome orphan-window NOTE updated — the blend
READS the eval_runs series, so an orphan row influences the next computed
score by design (window now self-consistent, no tx needed).

### 6. Tests

`tests/score-lifecycle.test.ts` (pure table tests + integration, real
SQLite, no mocks) + rewrites in `tests/reverify.test.ts` and
`tests/services.call.kind-gate.test.ts`. Recovery tests construct REAL
state change (stub re-point + restore via raw SQL, E1 precedent) and inject
`triggered_at` spacing via raw SQL — never by sleeping. All float
assertions epsilon-based.

## K = 4 (measured, geometry-pinned)

The documented "once-rotted tool re-crosses the gate after K = 4 clean
post-restore sweeps" holds — but K depends on the history geometry. With
idealized same-day near-equal weights, 3 cleans give (1+0+1+1+1)/5 = 0.8,
which sits exactly ON the inclusive `>= 0.80` gate (a knife edge; in
time-forward execution the failure decays slightly more than the cleans and
lands a hair ABOVE the gate). Test 2 therefore pins a margin-safe decayed
geometry via raw-SQL backdating — publish run 28d old (weight 0.0625),
failure 1d old (weight ≈0.9057), cleans fresh:

    blend(k) = (0.0625 + k) / (0.0625 + 0.90572 + k)
    k=3 → ≈0.7718 < 0.80      k=4 → ≈0.8177 ≥ 0.80      ⇒ K = 4

## Out of scope (named cuts)

- Per-call blend recompute (usage evidence enters at sweep cadence).
- Tunable weights/half-life via env (constants in scoreLifecycle.ts).
- Postgres twin (no postgres driver exists — Phase 2).
- Cross-version history inheritance (new version = fresh evidence line).
