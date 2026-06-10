// E4 health surface routes. Two views over the SAME service + projection:
//
//   GET /v1/tools/:name/health  — authenticated (every role: callers are
//                                 exactly who needs to know whether to
//                                 trust a tool before calling it).
//   GET /health-view/:name      — dashboard-scoped, UNAUTHENTICATED, same
//                                 trust boundary as /, /state, /events
//                                 (read-only, bounded). Exists because the
//                                 dashboard ships no API key; the /v1 route
//                                 stays authenticated for programmatic
//                                 callers.
//
// Both payloads carry PROJECTED drift fields only — changes_json never
// leaves the service layer (see src/services/health.ts).

import type { FastifyInstance } from 'fastify';
import type { Storage } from '../../types.js';
import { toolHealth } from '../../services/health.js';
import { requireAuth } from '../auth.js';

interface HealthParams {
  name: string;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  storage: Storage,
): void {
  // :name is a path param — Fastify handles decoding; the service treats it
  // as exact-match data (parameterized SQL only, no LIKE).
  app.get<{ Params: HealthParams }>(
    '/v1/tools/:name/health',
    async (req, reply) => {
      const ctx = await requireAuth(storage, req, reply, [
        'caller',
        'tool_author',
        'admin',
      ]);
      if (!ctx) return;

      const report = await toolHealth(storage, req.params.name);
      if (!report) {
        reply.code(404).send({
          ok: false,
          error: {
            code: 'tool_not_found',
            message: `no tool named '${req.params.name}'`,
          },
        });
        return;
      }
      reply.send({ ok: true, ...report });
    },
  );

  app.get<{ Params: HealthParams }>('/health-view/:name', async (req, reply) => {
    const report = await toolHealth(storage, req.params.name);
    if (!report) {
      reply.code(404).send({
        ok: false,
        error: {
          code: 'tool_not_found',
          message: `no tool named '${req.params.name}'`,
        },
      });
      return;
    }
    reply.send({ ok: true, ...report });
  });
}
