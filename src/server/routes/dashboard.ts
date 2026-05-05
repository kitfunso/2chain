import type { FastifyInstance } from 'fastify';
import type { Storage } from '../../types.js';
import { randomUUID } from 'node:crypto';
import { addSubscriber } from '../sse.js';
import { DASHBOARD_HTML } from './dashboardHtml.js';

export function registerDashboardRoutes(app: FastifyInstance, storage: Storage): void {
  app.get('/', async (_req, reply) => {
    // CSP layer: blocks remote script loads, eval, base-uri hijack, framing.
    // Does NOT defang inline-script XSS — 'unsafe-inline' permits any injected
    // <script>. The actual XSS defense is escapeHtml() on every interpolation.
    // CSP is defense-in-depth, not the primary control. To strengthen later,
    // move to a per-response nonce ('nonce-...') and drop 'unsafe-inline'.
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

  // Snapshot endpoint for initial render
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
    // Trending aggregates over a 7-day window from rankings; safe to cache for
    // a minute. Browsers + Fly's edge will dedupe repeated dashboard hits.
    reply.header('cache-control', 'public, max-age=60');
    const trending = await storage.getTrending(days, limit);
    if (trending.length === 0) {
      reply.send({ window_days: days, results: [] });
      return;
    }
    // Hydrate with full tool metadata so the dashboard can render rows
    // without a second round-trip.
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
