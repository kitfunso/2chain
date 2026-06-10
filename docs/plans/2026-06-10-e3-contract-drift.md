# Episode E3 — Contract drift detection on /push

**Status:** Implemented on `feat/e3-contract-drift` (plan-eng reviewed, 83 after a fail round). Baseline 161/161 green; 179/179 with this episode's 18 tests.

**Goal:** When an author pushes a NEW VERSION of an existing tool, stop accepting contract changes silently. Schema drift — the thesis's headline failure mode — was invisible until an agent's call broke. Same-version re-pushes are already rejected (`duplicate_version`) and cross-author pushes to an owned name are rejected (`name_owned_by_other`), so drift is exactly: new version vs the latest prior version of the same name, same author.

**Non-negotiables enforced:** real SQLite tests (no mocks); the differ is a pure module (no storage/driver/embedder imports); migration is forward-only and idempotent; the demo arc is locked by a regression test (rule 8).

---

## 1. `src/services/contractDiff.ts` — pure, dependency-free differ

`diffContracts(prev, next, direction)` → `{ classification, changes[] }`

- `classification ∈ identical | compatible | breaking` (worst change wins)
- `changes[]`: `{ path, kind, breaking, detail }` — path is the exact pointer-ish path (`properties.user.properties.email`).

Direction-aware rules (the asymmetry is the point — callers SEND inputs, consumers RECEIVE outputs). **This table is the single normative spec:**

| Change | input | output |
|---|---|---|
| property added (optional) | compatible | compatible |
| property added (required) | **breaking** (old payloads lack it) | compatible (always present now) |
| property removed | **breaking** if the NEW schema's effective `additionalProperties` is `false` (old payloads carrying the property are rejected by the NEW schema), else compatible | **breaking** (consumers may read it) |
| property retyped (`type` changed) | **breaking** | **breaking** |
| enum narrowed | **breaking** (old values rejected) | compatible (consumers handle all old values) |
| enum widened | compatible | **breaking** (consumer meets unknown value) |
| required added on existing prop | **breaking** | compatible |
| required removed | compatible | **breaking** (field may now be absent) |
| `additionalProperties` true→false | **breaking** | compatible |
| `additionalProperties` false→true | compatible | **breaking** (unknown fields can reach consumer) |
| any change inside UNMODELED constructs (`oneOf`/`anyOf`/`allOf`/`not`/`pattern`/`format`/`min*`/`max*`/`items` tuple forms…) | **breaking** (`unknown-construct-changed`) | **breaking** |

Modeled constructs: `type`, `properties`, `required`, `enum`, `additionalProperties`, single-schema `items` (recurse). Everything else is compared by canonical-JSON equality per subtree; changed ⇒ conservative `breaking`. Effective `additionalProperties`: absent = `true` (the MCP-client default, see CLAUDE.md Common Mistakes); schema-form AP is treated as restrictive (conservative) and AP shape changes involving it classify as `unknown-construct-changed`.

Combo analysis: prior-AP:`false` → new-AP:`true` + property removed = compatible on input — correct, since any payload valid under the old strict schema (which could not carry extra props) remains valid under the new permissive schema even with the property gone (it becomes an allowed additional property). No fail-open path exists: every cell that loosens validation on input is genuinely non-breaking for existing payloads.

Depth guard: the differ carries its OWN `MAX_DIFF_DEPTH = 16` defensive cap (conservative `breaking` with kind `depth-exceeded` if hit). CLAUDE.md rule 11 bounds only contracts that entered via push's `validateContract`; PRIOR contracts created by seed/import scripts call `upsertTool` directly and bypass the bounds, so the differ cannot inherit the bound by assumption.

## 2. Version ordering + the breaking gate

`compareVersions(a, b)`: split on `.`, numeric prefixes compare numerically (1.9 < 1.10), non-numeric remainders compare as strings, missing segments = 0. `majorOf(v)`: leading integer of the first segment; `null` if non-numeric.

- Latest prior = max by `compareVersions` over same-name rows fetched by the NEW storage query `listToolsByName(name, namespace)` (indexed exact-match on the `UNIQUE(namespace_id, name, version)` prefix, no list cap). Push's old `listTools({limit: 5_000})` scan was the find-before-cap family: beyond 5k tools the prior lookup would silently miss versions and the drift check would FAIL OPEN. The ownership-conflict check had the same latent defect; both now use `listToolsByName` (the 5k scan is gone — strictly fewer rows read).
- Gate: if overall classification (worst of input-diff, output-diff) is `breaking`, require `majorOf(new) > majorOf(prior)`. Otherwise reject with `code: 'breaking_contract_requires_major_bump'`; the message names the first 3 breaking paths + count, and the error carries the full diff in `details`. The push route serializes `error.details` when present (the /call route's existing precedent).
- `majorOf` null on either side AND breaking ⇒ reject with the same code; the message explains the version is unordered (fail-loud, never fail-open).
- Compatible/identical ⇒ no gate (any new unique version is fine).

## 3. Persistence — `003_drift_events.sql`

`SqliteStorage.runMigrations` applies a HARDCODED list, not a directory scan — `003_drift_events.sql` is appended to that array.

Table: `drift_events(id TEXT PK, namespace_id, tool_name, from_version, to_version, direction CHECK in input|output, classification CHECK in compatible|breaking, changes_json, author_agent_id, created_at)` + index on `(namespace_id, tool_name)`. Ids are app-generated uuids (`randomUUID`), matching every 001_init table.

Storage interface: `insertDriftEvent(row)`, `listDriftEvents(toolName, namespace?, limit?)` (read side is minimal; the operator surface is E4's), `listToolsByName(name, namespace?)`. One event per direction with a non-identical classification; `identical` writes nothing.

## 4. push.ts hook (signature UNCHANGED — zero caller churn)

After the ownership check, BEFORE embed (fail fast, no wasted embed cost):

1. `prior` = max-by-`compareVersions` over `listToolsByName` rows — none ⇒ skip (first version).
2. `diffContracts(prior.input_contract, body.input_contract, 'input')`, same for output.
3. Breaking + no major bump ⇒ return the new PushError.
4. AFTER `upsertTool` succeeds, persist drift events — FAIL-SOFT: the tool is already registered, so `insertDriftEvent` failure logs (`console.warn`) and the push still succeeds. Never a 500 on a post-commit side effect. Locked by a test (failure injected on the new write path over real SQLite).
5. `PushResult` gains optional `drift?: { from_version, input, output }`; the CLI (`bin/2chain.mjs push`) prints a one-line drift summary when present.

Rejected-but-attempted breaking pushes deliberately do NOT write events (the table records what the registry ACCEPTED; auditing rejected attempts is a different concern — conscious cut).

## 5. Demo-impact audit (rule 8)

Source-verified demo break under the unpatched gate: demo Beat 2 pushes `demo/pdf-extractor-3.1.json` (same author as the seed), whose INPUT contract had `additionalProperties: false` while the seeded `pdf-extractor@3.0` has `true` — input-breaking with no major bump (3.0 → 3.1) ⇒ the gate would have rejected Beat 2.

Fix shipped in this episode:
- `demo/pdf-extractor-3.1.json`: the single INPUT-level `additionalProperties` flipped to `true` (the demo's story is 3.1-as-less-reliable, not contract strictness). The output contracts of seed 3.0 and demo 3.1 were already identical and stay untouched.
- Regression test replays the seeded 3.0 + demo 3.1 pair through `push()` against real SQLite asserting `ok: true` and identical/identical with zero drift events — the demo arc is locked against future gate tightening.

## 6. Tests (18, real SQLite `:memory:`, no mocks)

Differ matrix over every rule-table cell in both directions, including the pinned subtle cells (removed-input + new-AP false ⇒ breaking; removed-input + new-AP true ⇒ compatible; removed-input + new-AP absent ⇒ compatible; combo prior-AP false → new-AP true + removed ⇒ compatible); items recursion path; `compareVersions`/`majorOf`; 12 push-level gate tests (retype minor reject / major accept + event, optional add, required add, enums both directions, AP restriction, output removal, identical ⇒ no events, first version, pattern change, 1.9-vs-1.10 prior ordering, unparseable version fail-loud); demo regression; fail-soft event write.

## Out of scope (named cuts)

- Drift read API/CLI/dashboard (E4 health surface).
- Drift checks at reverify time (E1+E3 integration, later).
- Events for REJECTED pushes (see §4).
- Semver pre-release/build-metadata semantics (loose numeric segments only).
- **Import-channel bypass:** every importer (`src/import/*.ts`) and `scripts/seed-fixtures.ts` call `storage.upsertTool` directly — they never pass through `push()`, so re-imports at hardcoded version '1.0' hit upsertTool's UPDATE branch and silently REPLACE contracts. The headline "silent drift" channel survives E3 via imports. Named cut: gating imports is a follow-up episode (imports are bulk + unowned). E3 closes the AUTHOR-push channel.
