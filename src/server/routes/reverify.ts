import type { FastifyInstance } from 'fastify';
import type { Storage } from '../../types.js';
import { reverifyTools, SweepInFlightError } from '../../services/reverify.js';
import { requireAuth } from '../auth.js';

interface ReverifyBody {
  tool_name?: string;
  tool_version?: string;
}

const reverifyBodySchema = {
  type: 'object',
  additionalProperties: true, // MCP clients add metadata fields (documented v1 incident)
  properties: {
    tool_name: { type: 'string', minLength: 1 },
    tool_version: { type: 'string', minLength: 1 },
  },
} as const;

export function registerReverifyRoute(app: FastifyInstance, storage: Storage): void {
  app.post<{ Body: ReverifyBody }>('/v1/reverify', { schema: { body: reverifyBodySchema } }, async (req, reply) => {
    // A tool_author may re-score other authors' tools via the filtered path —
    // suites are deterministic so that is benign; the unfiltered fleet sweep
    // (long request, re-scores every author) stays admin-only.
    const isFiltered = Boolean(req.body?.tool_name);
    const ctx = await requireAuth(
      storage,
      req,
      reply,
      isFiltered ? ['tool_author', 'admin'] : ['admin'],
    );
    if (!ctx) return;

    if (req.body?.tool_version !== undefined && !isFiltered) {
      reply.code(400).send({
        ok: false,
        error: { code: 'bad_request', message: 'tool_version requires tool_name' },
      });
      return;
    }

    try {
      const summary = await reverifyTools(storage, {
        toolName: req.body?.tool_name,
        toolVersion: req.body?.tool_version,
      });
      reply.code(200).send({ ok: true, ...summary });
    } catch (err) {
      if (err instanceof SweepInFlightError) {
        reply.code(409).send({
          ok: false,
          error: { code: err.code, message: err.message },
        });
        return;
      }
      req.log.error(err, 'reverify failed');
      reply.code(500).send({
        ok: false,
        error: { code: 'reverify_failed', message: (err as Error).message },
      });
    }
  });
}
