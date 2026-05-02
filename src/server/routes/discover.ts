import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { discover, DEMO_AGENT_QUERY } from '../../services/discover.js';
import { discoverHybrid } from '../../services/discoverHybrid.js';
import { requireAuth } from '../auth.js';
import { broadcast } from '../sse.js';

interface DiscoverQuery {
  q?: string;
  top?: string;
  mode?: 'vector' | 'hybrid';
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
    const mode = req.query.mode === 'hybrid' ? 'hybrid' : 'vector';

    try {
      const { results, meta } = mode === 'hybrid'
        ? await discoverHybrid(db, q, top)
        : await discover(db, q, top);

      // Broadcast for the dashboard panels.
      // For the demo query: live ranking. For ALL queries: pipeline inspector if hybrid.
      if (q === DEMO_AGENT_QUERY) {
        broadcast('discover_ran', {
          query: q,
          results: results.map((r) => ({
            name: r.name, version: r.version,
            reliability_score: r.reliability_score,
            vec_score: r.vec_score,
            rank_score: r.rank_score,
          })),
          meta,
          ts: new Date().toISOString(),
        });
      }
      const pipelineJson = (meta as unknown as { pipeline_json?: string }).pipeline_json;
      if (mode === 'hybrid' && pipelineJson) {
        broadcast('pipeline_ran', {
          query: q,
          pipeline_json: pipelineJson,
          search_ms: meta.search_ms,
          ts: new Date().toISOString(),
        });
      }

      reply.code(200).send({ ok: true, mode, results, meta });
    } catch (err) {
      req.log.error(err, 'discover failed');
      reply.code(500).send({ ok: false, error: { code: 'discover_failed', message: (err as Error).message } });
    }
  });
}
