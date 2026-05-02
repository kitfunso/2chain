import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { registerDiscoverRoute } from './routes/discover.js';
import { registerPushRoute } from './routes/push.js';
import { registerCallRoute } from './routes/call.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { startChangeStreams } from './streams.js';
import { prewarmDemoEmbedding, discover as discoverFn, DEMO_AGENT_QUERY } from '../services/discover.js';
import { broadcast } from './sse.js';
// Side-effect: register all stubs in the in-process registry.
import '../services/stubs.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 1_048_576,  // 1MB plenty for tool.json
  });

  const db = await getDb();

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  registerDiscoverRoute(app, db);
  registerPushRoute(app, db);
  registerCallRoute(app, db);
  registerDashboardRoutes(app, db);

  startChangeStreams(db);

  // Pre-warm the demo embed so Beat 1 cold call is sub-100ms.
  prewarmDemoEmbedding()
    .then(() => app.log.info('demo embedding pre-warmed'))
    .catch((e) => app.log.warn({ err: e.message }, 'embedding pre-warm failed (non-fatal)'));

  // Tools change-stream side-effect: when a tool flips status/reliability,
  // re-run the demo discover and broadcast the new ranking. This is what makes
  // Beat 2 → Beat 3 visually pop on the dashboard without any user action.
  db.collection('tools').watch([], { fullDocument: 'updateLookup' }).on('change', async () => {
    try {
      const { results, meta } = await discoverFn(db, DEMO_AGENT_QUERY, 5);
      broadcast('discover_ran', {
        query: DEMO_AGENT_QUERY,
        results: results.map((r) => ({
          name: r.name, version: r.version,
          reliability_score: r.reliability_score,
          vec_score: r.vec_score,
          rank_score: r.rank_score,
        })),
        meta,
        ts: new Date().toISOString(),
        trigger: 'tool_changed',
      });
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 're-rank on tool change failed');
    }
  });

  return app;
}
