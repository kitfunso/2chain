import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { addSubscriber } from '../sse.js';
import { DASHBOARD_HTML } from './dashboardHtml.js';

export function registerDashboardRoutes(app: FastifyInstance, db: Db): void {
  // Static dashboard
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(DASHBOARD_HTML);
  });

  // SSE event stream
  app.get('/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    addSubscriber(randomUUID(), reply);
    // hijack the connection so fastify doesn't auto-end it
    return reply;
  });

  // Snapshot endpoint for initial render
  app.get('/state', async (_req, reply) => {
    const tools = await db.collection('tools')
      .find({}, { projection: { capability_embedding: 0 } })
      .sort({ name: 1, version: -1 })
      .toArray();
    const violations = await db.collection('violations').find({})
      .sort({ occurred_at: -1 })
      .limit(20)
      .toArray();
    const evalRuns = await db.collection('eval_runs').find({})
      .sort({ triggered_at: -1 })
      .limit(20)
      .toArray();
    const usageStats = await db.collection('usage').aggregate([
      { $sort: { occurred_at: -1 } },
      { $limit: 50 },
      { $group: { _id: '$outcome', count: { $sum: 1 } } },
    ]).toArray();
    reply.send({ tools, violations, evalRuns, usageStats });
  });

  // MongoDB Atlas stats — collections, indexes, build info. Surfaces Atlas as the substrate.
  app.get('/atlas-stats', async (_req, reply) => {
    try {
      const buildInfo = await db.admin().command({ buildInfo: 1 });
      const isMaster = await db.admin().command({ hello: 1 });
      const dbStats = await db.stats();

      const tools = db.collection('tools');
      const searchIndexes = await tools.listSearchIndexes().toArray().catch(() => []);

      const collectionDocs: Record<string, number> = {};
      for (const name of ['tools', 'eval_runs', 'agents', 'violations', 'usage', 'rankings']) {
        try { collectionDocs[name] = await db.collection(name).estimatedDocumentCount(); }
        catch { collectionDocs[name] = 0; }
      }

      reply.send({
        mongo: {
          version: buildInfo.version,
          modules: buildInfo.modules ?? [],
          replica_set: isMaster.setName ?? null,
          replica_hosts: isMaster.hosts?.length ?? 0,
        },
        db: {
          name: db.databaseName,
          collections: dbStats.collections,
          objects: dbStats.objects,
          dataSize_bytes: dbStats.dataSize,
          indexSize_bytes: dbStats.indexSize,
        },
        collection_doc_counts: collectionDocs,
        search_indexes: searchIndexes.map((i: any) => ({
          name: i.name,
          type: i.type ?? 'search',
          queryable: !!i.queryable,
          status: i.status ?? null,
        })),
      });
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });
}
