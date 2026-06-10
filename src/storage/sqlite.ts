// SqliteStorage — Phase 1 personal-tier driver.
// better-sqlite3 + sqlite-vec + FTS5. Cosine distance, L2-normalized embeddings.
// All writes routed through SqliteWriteQueue; reads use the shared sync handle
// (better-sqlite3 reads are non-blocking in WAL mode).
//
// Step 4 implements everything except runRRF() (Step 6).

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type {
  Storage,
  ToolSpecV2,
  ToolV2,
  ToolStatus,
  ToolKind,
  RrfResult,
  ViolationRow,
  UsageRow,
  EvalRunRow,
  RankingRow,
  DriftEventRow,
  DbStats,
  ChangeEvent,
  AgentRow,
} from '../types.js';
import { DEFAULT_NAMESPACE } from '../types.js';
import { SqliteWriteQueue } from './sqlite-write-queue.js';
import { SqliteChangeHook } from '../live/sqlite-hook.js';

export interface SqliteStorageOpts {
  path: string;                 // ':memory:' for tests, real path for prod
  migrationsDir?: string;       // override (defaults to src/storage/migrations/sqlite)
  readonly?: boolean;           // for read-snapshot consumers
  /** Embedding dim for the vec0 virtual table. Defaults to 768 (nomic).
   *  1024 for mxbai-embed-large parity tests. Locks at first init. */
  embeddingDim?: number;
}

interface ToolRow {
  rowid: number;
  id: string;
  namespace_id: string;
  source_registry_id: string | null;
  name: string;
  version: string;
  author_agent_id: string;
  capability_text: string;
  input_contract: string;
  output_contract: string;
  output_repair_strategy: string;
  endpoint_stub_name: string;
  metadata: string;
  status: string;
  domain: string | null;
  tool_kind: string;
  created_at: string;
  updated_at: string;
}

// FTS5 query sanitizer: strip characters that conflict with the FTS5 query
// grammar, then OR-join remaining tokens. Empty result means "no text arm".
// Defensive: drops anything that could be parsed as a column-filter or
// boolean operator. The user query is untrusted text, not query syntax.
function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  // Wrap each in double-quotes to disable phrase-operator interpretation.
  // FTS5 requires the special "delete" command for content sync (see
  // migration), but at MATCH time double-quoted terms are treated as literal.
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

function rowToTool(r: ToolRow): ToolV2 {
  return {
    id: r.id,
    namespace_id: r.namespace_id,
    source_registry_id: r.source_registry_id,
    name: r.name,
    version: r.version,
    author_agent_id: r.author_agent_id,
    capability_text: r.capability_text,
    input_contract: JSON.parse(r.input_contract) as Record<string, unknown>,
    output_contract: JSON.parse(r.output_contract) as Record<string, unknown>,
    output_repair_strategy: r.output_repair_strategy as ToolV2['output_repair_strategy'],
    endpoint_stub_name: r.endpoint_stub_name,
    metadata: JSON.parse(r.metadata),
    status: r.status as ToolStatus,
    domain: r.domain ?? undefined,
    tool_kind: (r.tool_kind ?? 'tool') as ToolKind,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class SqliteStorage implements Storage {
  private db!: Database.Database;
  private readonly queue: SqliteWriteQueue;
  private readonly hook: SqliteChangeHook;

  constructor(private readonly opts: SqliteStorageOpts) {
    this.queue = new SqliteWriteQueue();
    this.hook = new SqliteChangeHook();
  }

  /** Test-only: synchronously flush the change-hook queue. */
  flushChanges(): void {
    this.hook.flush();
  }

  async init(): Promise<void> {
    if (this.opts.path !== ':memory:') {
      mkdirSync(dirname(this.opts.path), { recursive: true });
    }
    this.db = new Database(this.opts.path, this.opts.readonly ? { readonly: true } : {});
    sqliteVec.load(this.db);
    if (!this.opts.readonly) {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    if (!this.opts.readonly) {
      // Hook must install BEFORE migrations so that triggers created in any
      // future migration which references notify_change() find the function.
      // Triggers themselves are created inside install() — idempotent.
      await this.runMigrations();
      this.hook.install(this.db);
    }
  }

  private async runMigrations(): Promise<void> {
    const migrationsDir =
      this.opts.migrationsDir ?? resolve('src/storage/migrations/sqlite');
    // Bootstrap the tracker table so the first migration can record itself.
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          )`,
      )
      .run();
    const files = ['001_init.sql', '002_tool_kind.sql', '003_drift_events.sql']; // explicit list, in apply order
    for (const file of files) {
      const already = this.db
        .prepare('SELECT 1 FROM _migrations WHERE name = ?')
        .pluck()
        .get(file);
      if (already) continue;
      const path = resolve(migrationsDir, file);
      try {
        statSync(path);
      } catch {
        throw new Error(`migration file missing: ${path}`);
      }
      let sql = readFileSync(path, 'utf-8');
      // Allow overriding the vec0 embedding dim from opts so parity
      // checks against 1024-dim embedders (mxbai-embed-large) can use a
      // separate DB without forking the migration file.
      const dim = this.opts.embeddingDim ?? 768;
      if (dim !== 768) {
        sql = sql.replace(/float\[768\]/g, `float[${dim}]`);
      }
      this.db.transaction(() => {
        this.db.exec(sql);
        // Ensure _migrations exists even if 001 forgot to create it (it does).
        this.db
          .prepare(
            'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')))',
          )
          .run();
        this.db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      })();
    }
  }

  // ----- Tool CRUD ---------------------------------------------------------

  async getToolByNameVersion(
    name: string,
    version: string,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<ToolV2 | null> {
    const row = this.db
      .prepare<[string, string, string], ToolRow>(
        `SELECT rowid, * FROM tools WHERE namespace_id = ? AND name = ? AND version = ?`,
      )
      .get(namespace, name, version);
    return row ? rowToTool(row) : null;
  }

  async upsertTool(
    spec: ToolSpecV2,
    embedding: Float32Array,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<ToolV2> {
    return this.queue.run(() => {
      const now = new Date().toISOString();
      const id = randomUUID();
      const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

      const existing = this.db
        .prepare<[string, string, string], { id: string; rowid: number }>(
          `SELECT id, rowid FROM tools WHERE namespace_id = ? AND name = ? AND version = ?`,
        )
        .get(namespace, spec.name, spec.version);

      const kind: ToolKind = spec.tool_kind ?? 'tool';

      if (existing) {
        this.db
          .prepare(
            `UPDATE tools SET
                capability_text = ?,
                capability_embedding = ?,
                input_contract = ?,
                output_contract = ?,
                output_repair_strategy = ?,
                endpoint_stub_name = ?,
                metadata = ?,
                status = ?,
                domain = ?,
                source_registry_id = ?,
                tool_kind = ?,
                updated_at = ?
              WHERE id = ?`,
          )
          .run(
            spec.capability_text,
            buf,
            JSON.stringify(spec.input_contract),
            JSON.stringify(spec.output_contract),
            spec.output_repair_strategy,
            spec.endpoint_stub_name,
            JSON.stringify(spec.metadata),
            spec.status,
            spec.domain ?? null,
            spec.source_registry_id ?? null,
            kind,
            now,
            existing.id,
          );
        const row = this.db
          .prepare<[string], ToolRow>(`SELECT rowid, * FROM tools WHERE id = ?`)
          .get(existing.id)!;
        return rowToTool(row);
      }

      this.db
        .prepare(
          `INSERT INTO tools (
              id, namespace_id, source_registry_id, name, version,
              author_agent_id, capability_text, capability_embedding,
              input_contract, output_contract, output_repair_strategy,
              endpoint_stub_name, metadata, status, domain, tool_kind,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          namespace,
          spec.source_registry_id ?? null,
          spec.name,
          spec.version,
          spec.author_agent_id,
          spec.capability_text,
          buf,
          JSON.stringify(spec.input_contract),
          JSON.stringify(spec.output_contract),
          spec.output_repair_strategy,
          spec.endpoint_stub_name,
          JSON.stringify(spec.metadata),
          spec.status,
          spec.domain ?? null,
          kind,
          now,
          now,
        );
      const row = this.db
        .prepare<[string], ToolRow>(`SELECT rowid, * FROM tools WHERE id = ?`)
        .get(id)!;
      return rowToTool(row);
    }, 'tools');
  }

  async listToolsByName(
    name: string,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<ToolV2[]> {
    // Prefix of the UNIQUE(namespace_id, name, version) index — exact match,
    // no LIMIT (a tool's version count is small; the 5k listTools scan this
    // replaces was the fail-open hazard).
    const rows = this.db
      .prepare<[string, string], ToolRow>(
        `SELECT rowid, * FROM tools WHERE namespace_id = ? AND name = ? ORDER BY created_at, version`,
      )
      .all(namespace, name);
    return rows.map(rowToTool);
  }

  async setStatus(toolId: string, status: ToolStatus): Promise<void> {
    await this.queue.run(() => {
      this.db
        .prepare(`UPDATE tools SET status = ?, updated_at = ? WHERE id = ?`)
        .run(status, new Date().toISOString(), toolId);
    }, 'tools');
  }

  async updateToolAfterEval(
    toolId: string,
    metadata: ToolSpecV2['metadata'],
    status: ToolStatus,
  ): Promise<void> {
    await this.queue.run(() => {
      this.db
        .prepare(
          `UPDATE tools SET metadata = ?, status = ?, updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(metadata), status, new Date().toISOString(), toolId);
    }, 'tools');
  }

  async recordEvalOutcome(
    toolId: string,
    reliabilityScore: number,
    lastEvalRun: string,
  ): Promise<void> {
    // Atomic JSON patch of ONLY the eval-result fields, inside the serialized
    // write queue. Never touches the status column and never rewrites the
    // rest of metadata, so a re-verification sweep cannot resurrect a
    // concurrently circuit-broken tool (the sweep's read-time status may be
    // minutes stale by write time) nor clobber a concurrent metadata write.
    await this.queue.run(() => {
      this.db
        .prepare(
          `UPDATE tools
           SET metadata = json_set(metadata, '$.reliability_score', ?, '$.last_eval_run', ?),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(reliabilityScore, lastEvalRun, new Date().toISOString(), toolId);
    }, 'tools');
  }

  // ----- Agents ------------------------------------------------------------

  async getAgentByKeyHash(hash: string): Promise<AgentRow | null> {
    const row = this.db
      .prepare<[string], AgentRow>(
        `SELECT id, name, api_key_hash, role, created_at FROM agents WHERE api_key_hash = ?`,
      )
      .get(hash);
    return row ?? null;
  }

  async upsertAgent(agent: AgentRow): Promise<void> {
    await this.queue.run(() => {
      this.db
        .prepare(
          `INSERT INTO agents (id, name, api_key_hash, role, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             api_key_hash = excluded.api_key_hash,
             role = excluded.role`,
        )
        .run(agent.id, agent.name, agent.api_key_hash, agent.role, agent.created_at);
    }, 'agents');
  }

  // ----- Retrieval ---------------------------------------------------------

  async runRRF(opts: {
    queryEmbedding: Float32Array;
    queryText: string;
    topK: number;
    gate: number;
    weights: { vector: number; text: number };
    namespace?: string;
    kind?: ToolKind;
  }): Promise<RrfResult[]> {
    const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    const queryBuf = Buffer.from(
      opts.queryEmbedding.buffer,
      opts.queryEmbedding.byteOffset,
      opts.queryEmbedding.byteLength,
    );
    // FTS5 query: tokenize the user query into terms, OR-join. Matches v1's
    // implicit OR-of-terms behavior and tolerates noisy queries that have
    // some terms not in capability_text.
    const ftsQuery = sanitizeFtsQuery(opts.queryText);

    const kindClause = opts.kind ? ' AND t.tool_kind = ?' : '';

    // ---- Vector arm ----
    const vecParams: Array<Buffer | number | string> = [queryBuf, 50, opts.gate, namespace];
    if (opts.kind) vecParams.push(opts.kind);
    const vecRows = this.db
      .prepare<typeof vecParams, { rowid: number; distance: number }>(
        `SELECT v.rowid AS rowid, v.distance AS distance
         FROM tools_vec v
         JOIN tools t ON t.rowid = v.rowid
         WHERE v.capability_embedding MATCH ?
           AND k = ?
           AND t.status = 'active'
           AND CAST(json_extract(t.metadata, '$.reliability_score') AS REAL) >= ?
           AND t.namespace_id = ?${kindClause}
         ORDER BY v.distance ASC`,
      )
      .all(...vecParams);

    // ---- Text arm ---- (FTS5 with bm25 ASC; lower-is-better)
    let txtRows: Array<{ rowid: number }> = [];
    if (ftsQuery.length > 0) {
      const txtParams: Array<string | number> = [ftsQuery, namespace, opts.gate];
      if (opts.kind) txtParams.push(opts.kind);
      txtParams.push(50);
      txtRows = this.db
        .prepare<typeof txtParams, { rowid: number }>(
          `SELECT f.rowid AS rowid
           FROM tools_fts f
           JOIN tools t ON t.rowid = f.rowid
           WHERE tools_fts MATCH ?
             AND t.namespace_id = ?
             AND t.status = 'active'
             AND CAST(json_extract(t.metadata, '$.reliability_score') AS REAL) >= ?${kindClause}
           ORDER BY bm25(tools_fts) ASC
           LIMIT ?`,
        )
        .all(...txtParams) as Array<{ rowid: number }>;
    }

    // ---- RRF fusion (in JS — far simpler than the equivalent SQL CTE,
    // and the vec/text arrays are already small at this point). ----
    const K_CONSTANT = 60;
    const fused = new Map<number, { score: number; vec_rank?: number; text_rank?: number; vec_distance?: number }>();
    vecRows.forEach((r, idx) => {
      const rank = idx + 1;
      const e = fused.get(r.rowid) ?? { score: 0 };
      e.score += opts.weights.vector / (K_CONSTANT + rank);
      e.vec_rank = rank;
      e.vec_distance = r.distance;
      fused.set(r.rowid, e);
    });
    txtRows.forEach((r, idx) => {
      const rank = idx + 1;
      const e = fused.get(r.rowid) ?? { score: 0 };
      e.score += opts.weights.text / (K_CONSTANT + rank);
      e.text_rank = rank;
      fused.set(r.rowid, e);
    });

    if (fused.size === 0) return [];

    // Top-K by RRF
    const ranked = [...fused.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, opts.topK);

    // Hydrate tool rows
    const placeholders = ranked.map(() => '?').join(',');
    const rowids = ranked.map(([rowid]) => rowid);
    const toolRows = this.db
      .prepare<number[], ToolRow>(
        `SELECT rowid, * FROM tools WHERE rowid IN (${placeholders})`,
      )
      .all(...rowids);
    const byRowid = new Map(toolRows.map((r) => [r.rowid, r]));

    const out: RrfResult[] = [];
    for (const [rowid, info] of ranked) {
      const r = byRowid.get(rowid);
      if (!r) continue;
      const tool = rowToTool(r);
      const vec_score = info.vec_distance !== undefined ? 1.0 - info.vec_distance : 0;
      out.push({
        id: tool.id,
        name: tool.name,
        version: tool.version,
        capability_text: tool.capability_text,
        endpoint_stub_name: tool.endpoint_stub_name,
        metadata: tool.metadata,
        status: tool.status,
        tool_kind: tool.tool_kind,
        rrf_score: info.score,
        vec_score,
        vec_rank: info.vec_rank,
        text_rank: info.text_rank,
      });
    }
    return out;
  }

  // ----- Logging writes ----------------------------------------------------

  async insertViolation(v: ViolationRow): Promise<void> {
    await this.queue.run(() => {
      const id = v.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO violations (
              id, tool_id, tool_name, tool_version, namespace_id, agent_id, call_id,
              attempt, stage, raw_response, schema_errors, repaired, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          v.tool_id,
          v.tool_name,
          v.tool_version,
          v.namespace_id,
          v.agent_id,
          v.call_id,
          v.attempt,
          v.stage,
          v.raw_response === undefined ? null : JSON.stringify(v.raw_response),
          JSON.stringify(v.schema_errors),
          v.repaired ? 1 : 0,
          v.occurred_at,
        );
    }, 'violations');
  }

  async insertUsage(u: UsageRow): Promise<void> {
    await this.queue.run(() => {
      const id = u.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO usage (
              id, tool_id, agent_id, namespace_id, call_id,
              query_capability_text, outcome, latency_ms, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          u.tool_id,
          u.agent_id,
          u.namespace_id,
          u.call_id,
          u.query_capability_text ?? null,
          u.outcome,
          u.latency_ms,
          u.occurred_at,
        );
    }, 'usage');
  }

  async insertEvalRun(e: EvalRunRow): Promise<void> {
    await this.queue.run(() => {
      const id = e.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO eval_runs (
              id, tool_id, tool_name, tool_version, namespace_id,
              triggered_at, triggered_by, cases, pass_count, total_count,
              pass_rate, duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          e.tool_id,
          e.tool_name,
          e.tool_version,
          e.namespace_id,
          e.triggered_at,
          e.triggered_by,
          JSON.stringify(e.cases),
          e.pass_count,
          e.total_count,
          e.pass_rate,
          e.duration_ms,
        );
    }, 'eval_runs');
  }

  async insertRanking(r: RankingRow): Promise<void> {
    await this.queue.run(() => {
      const id = r.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO rankings (
              id, query_capability_text, mode, namespace_id, results, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          r.query_capability_text,
          r.mode,
          r.namespace_id,
          JSON.stringify(r.results),
          r.occurred_at,
        );
    }, 'rankings');
  }

  // ----- Contract drift (E3) -------------------------------------------------

  async insertDriftEvent(e: DriftEventRow): Promise<void> {
    await this.queue.run(() => {
      const id = e.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO drift_events (
              id, namespace_id, tool_name, from_version, to_version,
              direction, classification, changes_json, author_agent_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          e.namespace_id,
          e.tool_name,
          e.from_version,
          e.to_version,
          e.direction,
          e.classification,
          JSON.stringify(e.changes),
          e.author_agent_id,
          e.created_at,
        );
    }, 'drift_events');
  }

  async listDriftEvents(
    toolName: string,
    namespace = DEFAULT_NAMESPACE,
    limit = 100,
  ): Promise<DriftEventRow[]> {
    interface DriftDbRow {
      id: string;
      namespace_id: string;
      tool_name: string;
      from_version: string;
      to_version: string;
      direction: string;
      classification: string;
      changes_json: string;
      author_agent_id: string;
      created_at: string;
    }
    const rows = this.db
      .prepare<[string, string, number], DriftDbRow>(
        `SELECT * FROM drift_events
         WHERE namespace_id = ? AND tool_name = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(namespace, toolName, limit);
    return rows.map((r) => ({
      id: r.id,
      namespace_id: r.namespace_id,
      tool_name: r.tool_name,
      from_version: r.from_version,
      to_version: r.to_version,
      direction: r.direction as DriftEventRow['direction'],
      classification: r.classification as DriftEventRow['classification'],
      changes: JSON.parse(r.changes_json) as DriftEventRow['changes'],
      author_agent_id: r.author_agent_id,
      created_at: r.created_at,
    }));
  }

  // ----- Dashboard reads ---------------------------------------------------

  async listTools(opts: {
    status?: ToolStatus;
    limit?: number;
    namespace?: string;
    kind?: ToolKind;
  }): Promise<ToolV2[]> {
    const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    const limit = opts.limit ?? 1000;
    const clauses: string[] = ['namespace_id = ?'];
    const params: Array<string | number> = [namespace];
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.kind) {
      clauses.push('tool_kind = ?');
      params.push(opts.kind);
    }
    params.push(limit);
    const sql = `SELECT rowid, * FROM tools WHERE ${clauses.join(' AND ')} ORDER BY name LIMIT ?`;
    const rows = this.db.prepare<typeof params, ToolRow>(sql).all(...params);
    return rows.map(rowToTool);
  }

  async listViolations(
    limit: number,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<ViolationRow[]> {
    const rows = this.db
      .prepare<[string, number], any>(
        `SELECT * FROM violations WHERE namespace_id = ? ORDER BY occurred_at DESC LIMIT ?`,
      )
      .all(namespace, limit);
    return rows.map((r) => ({
      id: r.id,
      tool_id: r.tool_id,
      tool_name: r.tool_name,
      tool_version: r.tool_version,
      namespace_id: r.namespace_id,
      agent_id: r.agent_id,
      call_id: r.call_id,
      attempt: r.attempt,
      stage: r.stage as 'input' | 'output',
      raw_response: r.raw_response ? JSON.parse(r.raw_response) : undefined,
      schema_errors: JSON.parse(r.schema_errors),
      repaired: !!r.repaired,
      occurred_at: r.occurred_at,
    }));
  }

  private mapEvalRun(r: any): EvalRunRow {
    return {
      id: r.id,
      tool_id: r.tool_id,
      tool_name: r.tool_name,
      tool_version: r.tool_version,
      namespace_id: r.namespace_id,
      triggered_at: r.triggered_at,
      triggered_by: r.triggered_by as EvalRunRow['triggered_by'],
      cases: JSON.parse(r.cases),
      pass_count: r.pass_count,
      total_count: r.total_count,
      pass_rate: r.pass_rate,
      duration_ms: r.duration_ms,
    };
  }

  async listEvalRuns(
    limit: number,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<EvalRunRow[]> {
    const rows = this.db
      .prepare<[string, number], any>(
        `SELECT * FROM eval_runs WHERE namespace_id = ? ORDER BY triggered_at DESC LIMIT ?`,
      )
      .all(namespace, limit);
    return rows.map((r) => this.mapEvalRun(r));
  }

  // ----- Per-tool evidence reads (E4; signatures shared with parked E2) -----

  async listEvalRunsForTool(
    toolId: string,
    limit: number,
    triggeredBy?: string,
  ): Promise<EvalRunRow[]> {
    // Rides idx_eval_runs_tool for the lookup; sorting the per-tool slice is
    // fine at per-tool scale (composite (tool_id, triggered_at) index noted
    // as a future option, not added speculatively). The optional triggeredBy
    // filter applies BEFORE the limit: recovery's reverify-only window must
    // not be starved by other-trigger rows filling the cap (codex cap round).
    const rows = triggeredBy
      ? this.db
          .prepare<[string, string, number], any>(
            `SELECT * FROM eval_runs WHERE tool_id = ? AND triggered_by = ? ORDER BY triggered_at DESC LIMIT ?`,
          )
          .all(toolId, triggeredBy, limit)
      : this.db
          .prepare<[string, number], any>(
            `SELECT * FROM eval_runs WHERE tool_id = ? ORDER BY triggered_at DESC LIMIT ?`,
          )
          .all(toolId, limit);
    return rows.map((r) => this.mapEvalRun(r));
  }

  async usageOutcomeCountsForTool(
    toolId: string,
    sinceIso: string,
  ): Promise<Record<string, number>> {
    const rows = this.db
      .prepare<[string, string], { outcome: string; n: number }>(
        `SELECT outcome, COUNT(*) AS n FROM usage
         WHERE tool_id = ? AND occurred_at >= ?
         GROUP BY outcome`,
      )
      .all(toolId, sinceIso);
    const out: Record<string, number> = {
      ok: 0,
      circuit_broken: 0,
      gated: 0,
      violation: 0,
      timeout: 0,
    };
    for (const r of rows) out[r.outcome] = r.n;
    return out;
  }

  async usageOutcomeCounts(
    limit: number,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<Record<string, number>> {
    // Look at the most recent N usage rows and count outcomes.
    const rows = this.db
      .prepare<[string, number], { outcome: string; n: number }>(
        `SELECT outcome, COUNT(*) AS n FROM (
            SELECT outcome FROM usage WHERE namespace_id = ? ORDER BY occurred_at DESC LIMIT ?
          ) GROUP BY outcome`,
      )
      .all(namespace, limit);
    const out: Record<string, number> = {
      ok: 0,
      circuit_broken: 0,
      gated: 0,
      violation: 0,
      timeout: 0,
    };
    for (const r of rows) out[r.outcome] = r.n;
    return out;
  }

  async getTrending(
    daysBack: number,
    limit: number,
    namespace = DEFAULT_NAMESPACE,
  ): Promise<Array<{ name: string; version: string; hits: number }>> {
    // Expand each ranking's results JSON array, count distinct (name,version)
    // appearances within the cutoff window, return the top N. SQLite json_each
    // makes this a single query with no app-side parsing.
    const cutoffMs = Date.now() - daysBack * 86400_000;
    const cutoff = new Date(cutoffMs).toISOString();
    return this.db
      .prepare<
        [string, string, number],
        { name: string; version: string; hits: number }
      >(
        `SELECT
            json_extract(je.value, '$.name')    AS name,
            json_extract(je.value, '$.version') AS version,
            COUNT(*)                            AS hits
         FROM rankings, json_each(rankings.results) AS je
         WHERE rankings.namespace_id = ?
           AND rankings.occurred_at  > ?
         GROUP BY name, version
         ORDER BY hits DESC
         LIMIT ?`,
      )
      .all(namespace, cutoff, limit);
  }

  async dbStats(): Promise<DbStats> {
    const versionRow = this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    const vecVersion = this.db.prepare('SELECT vec_version() AS v').get() as { v: string };
    const tools = this.db.prepare('SELECT COUNT(*) AS n FROM tools').get() as { n: number };
    const evalRuns = this.db.prepare('SELECT COUNT(*) AS n FROM eval_runs').get() as { n: number };
    const agents = this.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };
    const violations = this.db.prepare('SELECT COUNT(*) AS n FROM violations').get() as { n: number };
    const usage = this.db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number };
    const rankings = this.db.prepare('SELECT COUNT(*) AS n FROM rankings').get() as { n: number };

    let dataSize = 0;
    if (this.opts.path !== ':memory:') {
      try {
        dataSize = statSync(this.opts.path).size;
      } catch {
        dataSize = 0;
      }
    }

    return {
      driver: 'sqlite',
      version: `${versionRow.v} (sqlite-vec ${vecVersion.v})`,
      database: this.opts.path,
      total_docs: tools.n + evalRuns.n + agents.n + violations.n + usage.n + rankings.n,
      data_size_bytes: dataSize,
      index_size_bytes: 0, // SQLite doesn't break this out per-index
      collection_counts: {
        tools: tools.n,
        eval_runs: evalRuns.n,
        agents: agents.n,
        violations: violations.n,
        usage: usage.n,
        rankings: rankings.n,
      },
      indexes_ready: {
        tools_fts: 'ready',
        tools_vec: 'ready',
      },
    };
  }

  // ----- Live updates ------------------------------------------------------

  watchChanges(onChange: (e: ChangeEvent) => void): void {
    this.hook.addListener(onChange);
  }

  // ----- Lifecycle ---------------------------------------------------------

  async close(): Promise<void> {
    if (this.db && this.db.open) this.db.close();
  }
}
