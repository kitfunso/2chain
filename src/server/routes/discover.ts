import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { discover } from '../../services/discover.js';
import { requireAuth } from '../auth.js';

interface DiscoverQuery {
  q?: string;
  top?: string;
}

export function registerDiscoverRoute(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: DiscoverQuery }>('/discover', async (req, reply) => {
    const ctx = await requireAuth(db, req, reply);
    if (!ctx) return;

    const q = (req.query.q ?? '').trim();
    if (!q) {
      reply.code(400).send({ ok: false, error: { code: 'bad_request', message: 'query parameter ?q= required' } });
      return;
    }
    const top = req.query.top ? Math.max(1, Math.min(20, Number(req.query.top))) : 5;

    try {
      const { results, meta } = await discover(db, q, top);
      reply.code(200).send({ ok: true, results, meta });
    } catch (err) {
      req.log.error(err, 'discover failed');
      reply.code(500).send({ ok: false, error: { code: 'discover_failed', message: (err as Error).message } });
    }
  });
}
