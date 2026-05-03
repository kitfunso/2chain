-- 2chain v2: tool_kind discriminator
-- Adds 'skill' | 'subagent' | 'prompt' as registry-able units alongside 'tool'.
-- Existing rows backfill to 'tool' via the column DEFAULT. FTS5 + vec0 untouched.

ALTER TABLE tools ADD COLUMN tool_kind TEXT NOT NULL DEFAULT 'tool'
  CHECK (tool_kind IN ('tool', 'skill', 'subagent', 'prompt'));

CREATE INDEX IF NOT EXISTS idx_tools_kind ON tools(tool_kind);
