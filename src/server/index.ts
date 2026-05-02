import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { registerDiscoverRoute } from './routes/discover.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
  });

  const db = await getDb();

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  registerDiscoverRoute(app, db);

  return app;
}
