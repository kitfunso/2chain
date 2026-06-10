import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createStorage } from '../storage/index.js';
import { createEmbedder } from '../embeddings/index.js';
import { registerDiscoverRoute } from './routes/discover.js';
import { registerPushRoute } from './routes/push.js';
import { registerCallRoute } from './routes/call.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerReverifyRoute } from './routes/reverify.js';
import { discover, prewarmDiscover, DEMO_AGENT_QUERY, PREWARM_QUERIES } from '../services/discover.js';
import { isSweepInFlight, reverifyTools } from '../services/reverify.js';
import { broadcast } from './sse.js';
import type { Storage, Embedder } from '../types.js';
// Side-effect: register all stubs in the in-process registry.
import '../services/stubs.js';
import { registerAllMcpServers } from '../import/mcp-importer.js';

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

  // Wire the MCP runtime bridge so curated `endpoint_stub_name=mcp-bridge`
  // catalog rows are callable even after a cold restart (no manual import
  // required). The catalog-vs-runtime split was a real bug: scrapers wrote
  // mcp-bridge specs but only `npm run import:mcp` ever called
  // registerMcpServer, so /call returned "unknown server" until that ran.
  const bridgeReg = registerAllMcpServers();
  app.log.info({ servers: bridgeReg.registered }, 'mcp runtime bridge registered');

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
  // Assigned after rerankAndBroadcast is defined below; both sweep trigger
  // paths (route + interval) call it once per completed unfiltered sweep.
  let postSweepRerank: () => Promise<void> = async () => {};
  registerReverifyRoute(app, storage, () => postSweepRerank());

  // Opt-in continuous re-verification. REVERIFY_INTERVAL_MIN unset = OFF so
  // fly.io / laptop deployments opt in deliberately (no surprise CPU).
  // Cap: setInterval delays above 2^31-1 ms overflow and Node clamps the
  // interval to 1ms — an absurd REVERIFY_INTERVAL_MIN would hot-loop the
  // sweep back-to-back. ~24 days is the largest safe interval.
  const REVERIFY_INTERVAL_MAX_MIN = 35_000;
  const reverifyIntervalMin = Number(process.env.REVERIFY_INTERVAL_MIN);
  if (
    Number.isFinite(reverifyIntervalMin) &&
    reverifyIntervalMin > 0 &&
    reverifyIntervalMin <= REVERIFY_INTERVAL_MAX_MIN
  ) {
    // In-flight guard: a slow sweep must never overlap the next tick.
    let reverifyInFlight = false;
    const reverifyTimer = setInterval(() => {
      if (reverifyInFlight) {
        app.log.warn('reverify sweep still in flight; skipping this tick');
        return;
      }
      reverifyInFlight = true;
      reverifyTools(storage)
        .then(async (summary) => {
          app.log.info(summary, 'scheduled reverify sweep complete');
          // One coalesced rerank for the whole sweep (per-event reranks are
          // suppressed while the sweep is in flight).
          await postSweepRerank();
        })
        .catch((e) => app.log.error({ err: (e as Error).message }, 'scheduled reverify sweep failed'))
        .finally(() => { reverifyInFlight = false; });
    }, reverifyIntervalMin * 60_000);
    reverifyTimer.unref();
    app.log.info({ interval_min: reverifyIntervalMin }, 'reverify interval enabled');
    app.addHook('onClose', async () => clearInterval(reverifyTimer));
  } else if (process.env.REVERIFY_INTERVAL_MIN !== undefined) {
    // Set-but-unusable (NaN from a typo like '60m', zero/negative, or above
    // the setInterval-safe cap): the operator believes continuous
    // re-verification is on — say loudly that it is not.
    app.log.warn(
      { raw: process.env.REVERIFY_INTERVAL_MIN, max_min: REVERIFY_INTERVAL_MAX_MIN },
      'REVERIFY_INTERVAL_MIN is set but not a usable interval; reverify interval DISABLED',
    );
  }

  // Pre-warm prewarm queries so demo cold-call is sub-100ms.
  prewarmDiscover(embedder)
    .then(() => app.log.info({ count: 17 }, 'embedder prewarm complete'))
    .catch((e) => app.log.warn({ err: (e as Error).message }, 'embedder prewarm failed (non-fatal)'));

  // Seed the rankings table by firing each prewarm query through real /discover
  // so the /trending endpoint has data on day one. Cold-only: gate on count===0
  // not <length, so a crash mid-seed doesn't double-count on next boot. The
  // seed runs once per database lifetime — re-seed by deleting from rankings.
  (async () => {
    try {
      const stats = await storage.dbStats();
      const rankingCount = stats.collection_counts.rankings ?? 0;
      if (rankingCount === 0) {
        app.log.info({ queries: PREWARM_QUERIES.length }, 'seeding trending via real /discover (cold start)');
        for (const q of PREWARM_QUERIES) {
          try { await discover(storage, embedder, q, 10); } catch { /* tolerate per-query failures */ }
        }
        const after = await storage.dbStats();
        app.log.info({ rankings: after.collection_counts.rankings }, 'trending seed complete');
      }
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 'trending seed failed (non-fatal)');
    }
  })();

  // v1's MongoDB change-stream re-rank, expressed against the Storage interface.
  // Fires on any change event the storage driver reports; we filter for tool
  // mutations and rebroadcast a fresh ranking. Step 9 wires SqliteStorage's
  // updateHook to actually fire these; for now this is a no-op subscription.
  const rerankAndBroadcast = async (trigger: string): Promise<void> => {
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
        trigger,
      });
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 're-rank on tool change failed');
    }
  };

  postSweepRerank = () => rerankAndBroadcast('reverify-sweep');

  // Sweep coalescing (codex P2): an unfiltered reverify sweep writes the
  // tools table once per verified tool; reranking on each write would spawn
  // a discover per tool on top of the eval work. Per-event reranks are
  // suppressed while a sweep is in flight; the sweep's trigger paths (route
  // + interval) fire exactly ONE rerank after the sweep completes.
  storage.watchChanges(async (event) => {
    if (event.table !== 'tools') return;
    if (isSweepInFlight()) return;
    await rerankAndBroadcast(event.type);
  });

  app.addHook('onClose', async () => {
    await storage.close();
  });

  return app;
}
