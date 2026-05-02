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
}
