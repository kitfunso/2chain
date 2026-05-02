import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { registerDiscoverRoute } from './routes/discover.js';
import { registerPushRoute } from './routes/push.js';
import { registerCallRoute } from './routes/call.js';
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

  return app;
}
