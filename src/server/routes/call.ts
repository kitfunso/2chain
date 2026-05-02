import type { FastifyInstance } from 'fastify';
import type { Storage } from '../../types.js';
import { call, type CallInput } from '../../services/call.js';
import { requireAuth } from '../auth.js';
import { broadcast } from '../sse.js';

export function registerCallRoute(app: FastifyInstance, storage: Storage): void {
  app.post<{ Body: CallInput }>('/call', async (req, reply) => {
    const ctx = await requireAuth(storage, req, reply);
    if (!ctx) return;

    const b = req.body;
    if (!b || !b.tool_name || !b.tool_version || typeof b.input !== 'object' || b.input === null) {
      reply.code(400).send({ ok: false, error: { code: 'bad_request', message: 'tool_name, tool_version, input required' } });
      return;
    }

    const bypass = req.headers['x-2chain-bypass-gate'] === 'true';

    try {
      const r = await call(storage, ctx.agent_id, ctx.role, b, bypass);
      broadcast('tool_invoked', {
        tool_name: b.tool_name,
        tool_version: b.tool_version,
        outcome: r.ok ? 'ok' : (r.error?.code ?? 'error'),
        latency_ms: r.ok ? r.latency_ms : undefined,
        ts: new Date().toISOString(),
      });
      if (r.ok) {
        reply.code(200).send(r);
      } else {
        reply.code(r.status).send({ ok: false, error: r.error });
      }
    } catch (err) {
      req.log.error(err, 'call failed');
      reply.code(500).send({ ok: false, error: { code: 'call_failed', message: (err as Error).message } });
    }
  });
}
