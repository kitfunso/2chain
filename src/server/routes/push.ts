import type { FastifyInstance } from 'fastify';
import type { Storage, Embedder } from '../../types.js';
import { push, type PushInput } from '../../services/push.js';
import { requireAuth } from '../auth.js';

export function registerPushRoute(
  app: FastifyInstance,
  storage: Storage,
  embedder: Embedder,
): void {
  app.post<{ Body: PushInput }>('/push', async (req, reply) => {
    const ctx = await requireAuth(storage, req, reply, ['tool_author', 'admin']);
    if (!ctx) return;

    const b = req.body;
    if (!b || !b.name || !b.version || !b.capability_text || !b.endpoint_stub_name) {
      reply.code(400).send({ ok: false, error: { code: 'bad_request', message: 'missing required fields' } });
      return;
    }
    if (b.output_repair_strategy !== 'fail-fast' && b.output_repair_strategy !== 'llm') {
      reply.code(400).send({ ok: false, error: { code: 'bad_request', message: 'output_repair_strategy must be fail-fast or llm' } });
      return;
    }

    try {
      const result = await push(storage, embedder, ctx.agent_id, b);
      if (!result.ok) {
        const code = result.code === 'name_owned_by_other' ? 403 : 400;
        reply.code(code).send({ ok: false, error: { code: result.code, message: result.message } });
        return;
      }
      reply.code(200).send(result);
    } catch (err) {
      req.log.error(err, 'push failed');
      reply.code(500).send({ ok: false, error: { code: 'push_failed', message: (err as Error).message } });
    }
  });
}
