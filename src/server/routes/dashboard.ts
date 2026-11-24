import type { FastifyInstance } from 'fastify';
import type { Storage } from '../../types.js';
import { randomUUID } from 'node:crypto';
import { addSubscriber } from '../sse.js';
import { DASHBOARD_HTML } from './dashboardHtml.js';

export function registerDashboardRoutes(app: FastifyInstance, storage: Storage): void {
  app.get('/', async (_req, reply) => {
    reply
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
      )
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .type('text/html')
      .send(DASHBOARD_HTML);
  });

  app.get('/events', async (_req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    addSubscriber(randomUUID(), reply);
    return reply;
  });

  app.get('/state', async (_req, reply) => {
    const tools = await storage.listTools({ limit: 5000 });
    const violations = await storage.listViolations(20);
    const evalRuns = await storage.listEvalRuns(20);
    const usageCounts = await storage.usageOutcomeCounts(50);
    const usageStats = Object.entries(usageCounts).map(([outcome, count]) => ({
      _id: outcome,
      count,
    }));
    reply.send({ tools, violations, evalRuns, usageStats });
  });

  app.get('/trending', async (req, reply) => {
    const q = (req.query as Record<string, string>) ?? {};
    const days = Math.max(1, Math.min(90, Number(q.days ?? 7)));
    const limit = Math.max(1, Math.min(100, Number(q.limit ?? 20)));
    reply.header('cache-control', 'public, max-age=60');
    const trending = await storage.getTrending(days, limit);
    if (trending.length === 0) {
      reply.send({ window_days: days, results: [] });
      return;
    }
    const all = await storage.listTools({ limit: 5000 });
    const idx = new Map(all.map((t) => [t.name + '@' + t.version, t]));
    const results = trending
      .map((t) => {
        const tool = idx.get(t.name + '@' + t.version);
        return tool ? { ...tool, hits: t.hits } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    reply.send({ window_days: days, results });
  });

  app.get('/atlas-stats', async (_req, reply) => {
    try {
      const stats = await storage.dbStats();
      reply.send({
        mongo: {
          version: stats.version,
          modules: [stats.driver],
          replica_set: null,
          replica_hosts: 0,
        },
        db: {
          name: stats.database,
          collections: Object.keys(stats.collection_counts).length,
          objects: stats.total_docs,
          dataSize_bytes: stats.data_size_bytes,
          indexSize_bytes: stats.index_size_bytes,
        },
        collection_doc_counts: stats.collection_counts,
        search_indexes: Object.entries(stats.indexes_ready).map(([name, status]) => ({
          name,
          type: name.endsWith('_vec') ? 'vectorSearch' : 'search',
          queryable: status === 'ready',
          status,
        })),
      });
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });
}
