-- 2chain v2 SQLite schema
-- Single migration that creates all tables, FTS5 + vec0 virtual tables, and sync triggers.
-- Applied via storage.init() on first connect; idempotent guarded by _migrations table.
--
-- Conventions:
--   - All "real" tables include namespace_id (default 'default') for v0.4 multi-tenant.
--   - JSON columns stored as TEXT (SQLite has no jsonb); use json_extract() for path access.
--   - Timestamps stored as TEXT in ISO-8601 form (sortable, JSON-friendly).
--   - vec0 declared with distance_metric=cosine; embeddings MUST be L2-normalized.
--
-- Pragmas live in init() before this script runs:
--   PRAGMA journal_mode = WAL;
--   PRAGMA busy_timeout = 5000;
--   PRAGMA foreign_keys = ON;

-- Migration tracker
CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Tools registry (the heart of the system)
CREATE TABLE IF NOT EXISTS tools (
  id                      TEXT    PRIMARY KEY,
  namespace_id            TEXT    NOT NULL DEFAULT 'default',
  source_registry_id      TEXT,                                    -- NULL = local registry
  name                    TEXT    NOT NULL,
  version                 TEXT    NOT NULL,
  author_agent_id         TEXT    NOT NULL,
  capability_text         TEXT    NOT NULL,
  capability_embedding    BLOB    NOT NULL,                        -- mirrored into tools_vec
  input_contract          TEXT    NOT NULL,                        -- JSON Schema as TEXT
  output_contract         TEXT    NOT NULL,
  output_repair_strategy  TEXT    NOT NULL DEFAULT 'fail-fast',
  endpoint_stub_name      TEXT    NOT NULL,
  metadata                TEXT    NOT NULL DEFAULT '{}',           -- JSON: cost, p95, reliability_score
  status                  TEXT    NOT NULL DEFAULT 'pending',      -- pending|active|circuit_broken
  domain                  TEXT,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (namespace_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_tools_status      ON tools(status);
CREATE INDEX IF NOT EXISTS idx_tools_namespace   ON tools(namespace_id);
CREATE INDEX IF NOT EXISTS idx_tools_reliability ON tools(json_extract(metadata, '$.reliability_score'));
CREATE INDEX IF NOT EXISTS idx_tools_domain      ON tools(domain);

-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL,                                       -- caller|tool_author|admin
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Eval runs (one per /push)
CREATE TABLE IF NOT EXISTS eval_runs (
  id             TEXT PRIMARY KEY,
  tool_id        TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  tool_version   TEXT NOT NULL,
  namespace_id   TEXT NOT NULL DEFAULT 'default',
  triggered_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  triggered_by   TEXT NOT NULL,                                     -- push|manual|scheduled|reverify
  cases          TEXT NOT NULL,                                     -- JSON array of case results
  pass_count     INTEGER NOT NULL,
  total_count    INTEGER NOT NULL,
  pass_rate      REAL NOT NULL,
  duration_ms    INTEGER NOT NULL,
  FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_tool      ON eval_runs(tool_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_namespace ON eval_runs(namespace_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_time      ON eval_runs(triggered_at DESC);

-- Usage log (one per /call)
CREATE TABLE IF NOT EXISTS usage (
  id                     TEXT PRIMARY KEY,
  tool_id                TEXT NOT NULL,
  agent_id               TEXT NOT NULL,
  namespace_id           TEXT NOT NULL DEFAULT 'default',
  call_id                TEXT NOT NULL,
  query_capability_text  TEXT,
  outcome                TEXT NOT NULL,                              -- ok|circuit_broken|violation|timeout|gated
  latency_ms             INTEGER NOT NULL,
  occurred_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_tool      ON usage(tool_id);
CREATE INDEX IF NOT EXISTS idx_usage_namespace ON usage(namespace_id);
CREATE INDEX IF NOT EXISTS idx_usage_time      ON usage(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_outcome   ON usage(outcome);

-- Contract violations (the trust layer's audit trail)
CREATE TABLE IF NOT EXISTS violations (
  id             TEXT PRIMARY KEY,
  tool_id        TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  tool_version   TEXT NOT NULL,
  namespace_id   TEXT NOT NULL DEFAULT 'default',
  agent_id       TEXT NOT NULL,
  call_id        TEXT NOT NULL,
  attempt        INTEGER NOT NULL,
  stage          TEXT NOT NULL,                                       -- input|output
  raw_response   TEXT,
  schema_errors  TEXT NOT NULL,                                       -- JSON array
  repaired       INTEGER NOT NULL DEFAULT 0,                          -- 0|1
  occurred_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_violations_tool      ON violations(tool_id);
CREATE INDEX IF NOT EXISTS idx_violations_namespace ON violations(namespace_id);
CREATE INDEX IF NOT EXISTS idx_violations_time      ON violations(occurred_at DESC);

-- Rankings (append-only log of /discover results for the dashboard)
CREATE TABLE IF NOT EXISTS rankings (
  id                     TEXT PRIMARY KEY,
  query_capability_text  TEXT NOT NULL,
  mode                   TEXT NOT NULL,                              -- vector|hybrid
  namespace_id           TEXT NOT NULL DEFAULT 'default',
  results                TEXT NOT NULL,                              -- JSON top-K snapshot
  occurred_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_rankings_time      ON rankings(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_rankings_namespace ON rankings(namespace_id);

-- =========================================================================
-- FTS5 virtual table mirrors capability_text. Triggers below keep it synced.
-- =========================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(
  capability_text,
  content='tools',
  content_rowid='rowid'
);

-- =========================================================================
-- sqlite-vec virtual table for vector ANN.
-- distance_metric=cosine pairs with L2-normalized 768-dim embeddings.
-- =========================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS tools_vec USING vec0(
  capability_embedding float[768] distance_metric=cosine
);

-- =========================================================================
-- Sync triggers — keep tools_fts and tools_vec aligned with tools.
--
-- vec0 quirk: virtual rows don't update in place. UPDATE on the base table
-- requires DELETE + INSERT inside the trigger to refresh the vec0 row.
-- See: https://github.com/asg017/sqlite-vec/issues/100
-- =========================================================================

-- FTS5 external-content tables require the special 'delete' command for
-- stale-content removal (DELETE FROM ... WHERE rowid only removes the
-- docsize entry, not the indexed terms). See:
-- https://www.sqlite.org/fts5.html#external_content_tables
CREATE TRIGGER IF NOT EXISTS tools_ai_fts AFTER INSERT ON tools BEGIN
  INSERT INTO tools_fts(rowid, capability_text)
  VALUES (new.rowid, new.capability_text);
END;

CREATE TRIGGER IF NOT EXISTS tools_ai_vec AFTER INSERT ON tools BEGIN
  INSERT INTO tools_vec(rowid, capability_embedding)
  VALUES (new.rowid, new.capability_embedding);
END;

CREATE TRIGGER IF NOT EXISTS tools_ad_fts AFTER DELETE ON tools BEGIN
  INSERT INTO tools_fts(tools_fts, rowid, capability_text)
  VALUES ('delete', old.rowid, old.capability_text);
END;

CREATE TRIGGER IF NOT EXISTS tools_ad_vec AFTER DELETE ON tools BEGIN
  DELETE FROM tools_vec WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS tools_au_fts AFTER UPDATE OF capability_text ON tools BEGIN
  INSERT INTO tools_fts(tools_fts, rowid, capability_text)
  VALUES ('delete', old.rowid, old.capability_text);
  INSERT INTO tools_fts(rowid, capability_text)
  VALUES (new.rowid, new.capability_text);
END;

CREATE TRIGGER IF NOT EXISTS tools_au_vec AFTER UPDATE OF capability_embedding ON tools BEGIN
  DELETE FROM tools_vec WHERE rowid = old.rowid;
  INSERT INTO tools_vec(rowid, capability_embedding)
  VALUES (new.rowid, new.capability_embedding);
END;

-- Mark this migration as applied. SqliteStorage.init() inserts here.
-- INSERT INTO _migrations(name) VALUES ('001_init');  -- handled by app code
