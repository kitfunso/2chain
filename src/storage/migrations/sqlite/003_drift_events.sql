-- 2chain v2: contract drift events (E3)
-- One row per accepted /push per non-identical diff direction. Records what
-- the registry ACCEPTED; rejected breaking pushes write nothing (named cut,
-- see docs/plans/2026-06-10-e3-contract-drift.md). Forward-only, idempotent.

CREATE TABLE IF NOT EXISTS drift_events (
  id TEXT PRIMARY KEY,  -- app-generated uuid, matching every 001_init table
  namespace_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('input','output')),
  classification TEXT NOT NULL CHECK (classification IN ('compatible','breaking')),
  changes_json TEXT NOT NULL,
  author_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_tool ON drift_events(namespace_id, tool_name);
