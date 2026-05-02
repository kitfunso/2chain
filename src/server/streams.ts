import type { Db } from 'mongodb';
import { broadcast } from './sse.js';

export function startChangeStreams(db: Db): void {
  // tools — flips status/reliability_score, new tool inserts
  const toolsStream = db.collection('tools').watch([], { fullDocument: 'updateLookup' });
  toolsStream.on('change', (event) => {
    const fd = (event as any).fullDocument;
    if (!fd) return;
    broadcast('tool_changed', {
      operation: event.operationType,
      tool: {
        name: fd.name,
        version: fd.version,
        status: fd.status,
        reliability_score: fd.metadata?.reliability_score ?? 0,
        updated_at: fd.updated_at ?? fd.created_at,
      },
    });
  });
  toolsStream.on('error', (err) => console.error('tools change-stream error:', err.message));

  // violations — append-only, broadcast on insert
  const violationsStream = db.collection('violations').watch([{ $match: { operationType: 'insert' } }]);
  violationsStream.on('change', (event) => {
    const fd = (event as any).fullDocument;
    if (!fd) return;
    broadcast('violation_added', {
      tool_name: fd.tool_name,
      tool_version: fd.tool_version,
      stage: fd.stage,
      schema_errors: fd.schema_errors,
      occurred_at: fd.occurred_at,
    });
  });
  violationsStream.on('error', (err) => console.error('violations change-stream error:', err.message));

  // usage — broadcast on insert (for live call feed)
  const usageStream = db.collection('usage').watch([{ $match: { operationType: 'insert' } }]);
  usageStream.on('change', (event) => {
    const fd = (event as any).fullDocument;
    if (!fd) return;
    broadcast('call_logged', {
      outcome: fd.outcome,
      latency_ms: fd.latency_ms,
      occurred_at: fd.occurred_at,
    });
  });
  usageStream.on('error', (err) => console.error('usage change-stream error:', err.message));

  // eval_runs — new push runs
  const evalStream = db.collection('eval_runs').watch([{ $match: { operationType: 'insert' } }]);
  evalStream.on('change', (event) => {
    const fd = (event as any).fullDocument;
    if (!fd) return;
    broadcast('eval_run_added', {
      tool_name: fd.tool_name,
      tool_version: fd.tool_version,
      pass_count: fd.pass_count,
      total_count: fd.total_count,
      pass_rate: fd.pass_rate,
      cases: fd.cases,
      triggered_by: fd.triggered_by,
      duration_ms: fd.duration_ms,
    });
  });
  evalStream.on('error', (err) => console.error('eval_runs change-stream error:', err.message));

  console.log('change streams started: tools, violations, usage, eval_runs');
}
