import type { FastifyInstance } from 'fastify';
import type { Storage, Embedder, ToolKind } from '../../types.js';
import { discover, DEMO_AGENT_QUERY } from '../../services/discover.js';
import { requireAuth } from '../auth.js';
import { broadcast } from '../sse.js';
import { DEFAULT_NAMESPACE } from '../../types.js';

interface DiscoverQuery {
  q?: string;
  top?: string;
  mode?: 'vector' | 'hybrid';
  kind?: string;
}

const VALID_KINDS: ReadonlySet<ToolKind> = new Set(['tool', 'skill', 'subagent', 'prompt']);

export function registerDiscoverRoute(
  app: FastifyInstance,
  storage: Storage,
  embedder: Embedder,
): void {
  app.get<{ Querystring: DiscoverQuery }>('/discover', async (req, reply) => {
    const ctx = await requireAuth(storage, req, reply);
    if (!ctx) return;

    const q = (req.query.q ?? '').trim();
    if (!q) {
      reply.code(400).send({ ok: false, error: { code: 'bad_request', message: 'query parameter ?q= required' } });
      return;
    }
    const top = req.query.top ? Math.max(1, Math.min(20, Number(req.query.top))) : 5;
    // Mode is accepted for v1 wire-compat but v2 always runs hybrid (RRF).
    const mode = req.query.mode === 'vector' ? 'vector' : 'hybrid';

    let kind: ToolKind | undefined;
    if (req.query.kind) {
      if (!VALID_KINDS.has(req.query.kind as ToolKind)) {
        reply.code(400).send({
          ok: false,
          error: {
            code: 'bad_request',
            message: `kind must be one of tool|skill|subagent|prompt, got "${req.query.kind}"`,
          },
        });
        return;
      }
      kind = req.query.kind as ToolKind;
    }

    try {
      const { results, meta } = await discover(storage, embedder, q, top, DEFAULT_NAMESPACE, kind);

      broadcast('discover_ran', {
        query: q,
        results: results.map((r) => ({
          name: r.name, version: r.version,
          reliability_score: r.reliability_score,
          vec_score: r.vec_score,
          rank_score: r.rank_score,
          rrf_score: r.rrf_score,
        })),
        meta,
        ts: new Date().toISOString(),
      });

      reply.code(200).send({ ok: true, mode, results, meta });
    } catch (err) {
      req.log.error(err, 'discover failed');
      reply.code(500).send({ ok: false, error: { code: 'discover_failed', message: (err as Error).message } });
    }
  });
}

export { DEMO_AGENT_QUERY };
