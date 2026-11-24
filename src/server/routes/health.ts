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
