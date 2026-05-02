import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createStorage } from '../storage/index.js';
import { createEmbedder } from '../embeddings/index.js';
import { registerDiscoverRoute } from './routes/discover.js';
import { registerPushRoute } from './routes/push.js';
import { registerCallRoute } from './routes/call.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { discover, prewarmDiscover, DEMO_AGENT_QUERY } from '../services/discover.js';
import { broadcast } from './sse.js';
import type { Storage, Embedder } from '../types.js';
// Side-effect: register all stubs in the in-process registry.
import '../services/stubs.js';

declare module 'fastify' {
  interface FastifyInstance {
    storage: Storage;
    embedder: Embedder;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 1_048_576,
  });

  const storage = await createStorage();
  await storage.init();
  const embedder = await createEmbedder();

  app.decorate('storage', storage);
  app.decorate('embedder', embedder);

  app.get('/health', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    storage: (await storage.dbStats()).driver,
    embedder: embedder.name(),
  }));

  registerDiscoverRoute(app, storage, embedder);
  registerPushRoute(app, storage, embedder);
  registerCallRoute(app, storage);
  registerDashboardRoutes(app, storage);

  // Pre-warm prewarm queries so demo cold-call is sub-100ms.
  prewarmDiscover(embedder)
    .then(() => app.log.info({ count: 17 }, 'embedder prewarm complete'))
    .catch((e) => app.log.warn({ err: (e as Error).message }, 'embedder prewarm failed (non-fatal)'));

  // v1's MongoDB change-stream re-rank, expressed against the Storage interface.
  // Fires on any change event the storage driver reports; we filter for tool
  // mutations and rebroadcast a fresh ranking. Step 9 wires SqliteStorage's
  // updateHook to actually fire these; for now this is a no-op subscription.
  storage.watchChanges(async (event) => {
    if (event.table !== 'tools') return;
    try {
      const { results, meta } = await discover(storage, embedder, DEMO_AGENT_QUERY, 5);
      broadcast('discover_ran', {
        query: DEMO_AGENT_QUERY,
        results: results.map((r) => ({
          name: r.name, version: r.version,
          reliability_score: r.reliability_score,
          vec_score: r.vec_score,
          rank_score: r.rank_score,
          rrf_score: r.rrf_score,
        })),
        meta,
        ts: new Date().toISOString(),
        trigger: event.type,
      });
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 're-rank on tool change failed');
    }
  });

  app.addHook('onClose', async () => {
    await storage.close();
  });

  return app;
}
