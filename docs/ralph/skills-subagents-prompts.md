# Ralph Loop: Add `tool_kind` discriminator + skills/subagents/prompts importers

You are working in `C:/Users/skf_s/2chain` on the v2 SQLite + sqlite-vec + Ollama
stack (master branch). 2chain currently registers MCP servers and fixture tools.
This loop expands the registry so it can also index three new unit kinds:

- `skill` — Anthropic Claude Code skill (frontmatter + workflow markdown)
- `subagent` — Claude Code subagent (`~/.claude/agents/*.md` shape)
- `prompt` — named, parameterized prompt template

## Completion criterion

Output the literal phrase `<promise>2CHAIN_KINDS_DONE</promise>` only when ALL of:

1. `bun run lint:no-mongodb` exits 0
2. `npm test` is green (no skipped, no .only)
3. `npm run smoke:v2` strict gate passes
4. The new schema column `tool_kind` exists in `tools` (default `'tool'`),
   a migration backfills existing rows, FTS5 + vec0 untouched
5. Three importers exist and each has a `--verify` mode that imports ≥10 real
   entries from disk:
   - `scripts/import-skills.ts` (reads `~/.claude/skills/**/SKILL.md`)
   - `scripts/import-subagents.ts` (reads `~/.claude/agents/*.md` and
     `~/.claude/skills/**/agents/*.md` if any)
   - `scripts/import-prompts.ts` (reads `~/.claude/skills/**/prompts/*.md`
     OR a curated seed list at `src/import/prompts-seed.ts` of ≥10 entries)
6. A new smoke `scripts/smoke/v2-mixed-kind-discover.ts` runs three queries
   ("help me write a grant", "review my code for bugs", "extract tables from a PDF")
   and verifies the top-5 contains at least one `skill` AND one `tool` row
7. `discover` route returns a `tool_kind` field on every result (default `'tool'`)
8. New tests exist:
   - `tests/storage.sqlite.tool-kind.test.ts` (5+ cases)
   - `tests/import.skills.test.ts` (3+ cases)
   - `tests/routes.discover.tool-kind.test.ts` (3+ cases)
9. README has a one-paragraph section "Tool kinds" naming all four kinds
10. Commit history on master shows ≥4 commits since loop start, each with
    a descriptive message (one per importer + one for schema + one for tests)

## How each iteration should work

Read the current state of the repo first. Look at:
- `src/types.ts` — find `ToolSpecV2`, `ToolV2`, `Storage` interface
- `src/storage/sqlite.ts` — schema, migrations, FTS5/vec triggers
- `src/import/mcp-importer.ts` + `mcp-registry.ts` — pattern to mimic
- `scripts/import-mcp-servers.ts` — CLI shape to mimic

Decide what is NOT done yet from the completion criterion. Pick the smallest
slice that moves the needle. Implement it. Run the verification command.
Commit with a clear message. If something is broken, fix the root cause —
do NOT bypass with --no-verify, do NOT skip tests, do NOT mock data.

## Schema migration shape

```sql
ALTER TABLE tools ADD COLUMN tool_kind TEXT NOT NULL DEFAULT 'tool'
  CHECK (tool_kind IN ('tool','skill','subagent','prompt'));
CREATE INDEX IF NOT EXISTS idx_tools_kind ON tools(tool_kind);
```

Use the existing `_migrations` bookkeeping table — append a new migration row,
do not edit history. Keep the existing 768-dim vec table untouched; skills get
embedded via the same Ollama `nomic-embed-text` so retrieval stays uniform.

## TypeScript shape

In `src/types.ts`:

```typescript
export type ToolKind = 'tool' | 'skill' | 'subagent' | 'prompt';

// Add to ToolSpecV2:
tool_kind?: ToolKind; // defaults to 'tool' on insert
```

Threaded through:
- `Storage.upsertTool` — accept and persist `tool_kind`
- `Storage.runRRF` — return `tool_kind` in `RrfResult`
- `Storage.listTools` — accept optional `kind?: ToolKind` filter
- `services/discover.ts` — pass through to `DiscoverResult`
- routes — emit `tool_kind` in JSON

## Importer rules (CLAUDE.md rule 12 still applies)

`skill` and `subagent` units do NOT get a callable stub — they are
discovery-only. Use the existing `catalog-only-stub` from
`src/services/stubs.ts`. Their `endpoint_stub_name` is `catalog-only-stub`.
The `input_contract` and `output_contract` for these can be permissive
(`{ type: 'object' }`).

`prompt` units DO get a callable stub: register a new
`prompt-template-stub` that takes `{ vars: Record<string,string> }` and
returns `{ rendered: string }`. Use a simple `{{var}}` substitution.

## Hard rules (do not violate)

- NEVER touch v1 MongoDB code paths — they live under `src/server/index.ts`
  fallback only when `STORAGE_DRIVER === 'mongodb'`. v2 is the default now.
- NEVER use `--no-verify` on git commits.
- NEVER skip tests by adding `.skip` or `.only` — fix the underlying issue.
- NEVER mock external data — use real MCP servers, real skill files on disk.
  If `~/.claude/skills/` is empty, FAIL the import with a clear message.
- NEVER force push, NEVER touch the remote `master` directly — local commits
  only; pushing is for Keith to do manually after the loop ends.
- Keep changes additive. If you must edit existing files, do not refactor
  unrelated code in the same commit.
- Each commit must be ≤200 lines of diff except the schema migration.

## Pre-flight (run once at iteration 1)

```bash
ollama list | grep -q nomic-embed-text   # required, fail fast otherwise
git status --porcelain                    # must be clean to start
bun run lint:no-mongodb                   # baseline must be green
```

If pre-flight fails, output the failure reason and the literal phrase
`<promise>2CHAIN_KINDS_PREFLIGHT_FAILED</promise>` and stop.

## Verification gate (run before emitting completion)

```bash
bun run lint:no-mongodb && \
npm test && \
npm run smoke:v2 && \
tsx scripts/smoke/v2-mixed-kind-discover.ts
```

All four must exit 0. If any fails, do NOT emit completion — fix the failure
in the next iteration.

## Stop conditions

- If two consecutive iterations make zero file changes, output
  `<promise>2CHAIN_KINDS_STALLED</promise>` and stop.
- If the same test fails three iterations in a row, output the failing test
  name + last error and the literal phrase
  `<promise>2CHAIN_KINDS_BLOCKED</promise>` and stop.
- Cap: 30 iterations. After that, emit a summary of what's done vs missing
  and stop regardless.
