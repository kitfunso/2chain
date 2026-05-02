import type { FastifyInstance } from 'fastify';
import type { Storage } from '../../types.js';
import { randomUUID } from 'node:crypto';
import { addSubscriber } from '../sse.js';
import { DASHBOARD_HTML } from './dashboardHtml.js';

export function registerDashboardRoutes(app: FastifyInstance, storage: Storage): void {
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(DASHBOARD_HTML);
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

  // Snapshot endpoint for initial render
  app.get('/state', async (_req, reply) => {
    const tools = await storage.listTools({ limit: 1000 });
    const violations = await storage.listViolations(20);
    const evalRuns = await storage.listEvalRuns(20);
    const usageCounts = await storage.usageOutcomeCounts(50);
    const usageStats = Object.entries(usageCounts).map(([outcome, count]) => ({
      _id: outcome,
      count,
    }));
    reply.send({ tools, violations, evalRuns, usageStats });
  });

  // v1 endpoint name kept for dashboard wire-compat. Reports the current
  // storage driver + collection counts; "Atlas" is a misnomer in v2 but
  // changing it would break the dashboard HTML which is shipped as a string.
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
