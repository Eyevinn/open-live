import { config } from './config.js';
import { startIdleWatchdog } from './services/idle-watchdog.js';
import { connectDb, getDb, isDbConnected } from './db/index.js';
import { cleanLegacyFixtures } from './db/seed.js';
import { buildServer } from './server.js';
import { StromClient } from './lib/strom.js';
import { getStromToken } from './lib/strom-token.js';
import type { ProductionDoc } from './db/types.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Startup reconciliation: cross-reference each production's stored stromFlowId
 * against the live Strom flow list so the DB reflects reality after a restart.
 *
 * - Productions with a stromFlowId still present in Strom → mark active
 * - Productions with a stromFlowId that no longer exists in Strom → mark inactive
 * - Productions stuck in 'activating' (no live flow) → mark inactive
 *
 * If Strom is unreachable, productions are left as-is (we can't know the truth).
 */
async function reconcileProductionStatuses(
  log: FastifyBaseLogger,
): Promise<void> {
  if (!isDbConnected()) {
    log.debug('[reconcile] Database not connected — skipping');
    return;
  }
  const db = getDb();

  let liveFlows: import('./lib/strom.js').Flow[];
  let liveFlowIds: Set<string>;
  try {
    const stromToken = await getStromToken(config.stromToken);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
    ({ flows: liveFlows } = await strom.flows.list());
    liveFlowIds = new Set(liveFlows.map((f) => f.id));
    log.debug({ count: liveFlowIds.size }, '[reconcile] Fetched Strom flows');
  } catch (err) {
    log.warn({ err }, '[reconcile] Could not reach Strom — skipping');
    return;
  }

  // Build a map from production ID → flow ID using the description tag every
  // Open Live flow carries: properties.description = "prod:PROD_ID".
  // This catches flows whose ID was never written back to the production doc.
  const flowByProdId = new Map<string, string>();
  for (const flow of liveFlows) {
    const desc = (flow.properties as { description?: string } | undefined)?.description ?? '';
    const match = /^prod:(.+)$/.exec(desc);
    if (match) flowByProdId.set(match[1], flow.id);
  }

  let result: Awaited<ReturnType<typeof db.find>>;
  try {
    result = await db.find({ selector: { type: 'production' } });
  } catch (err) {
    log.warn({ err }, '[reconcile] CouchDB unreachable — skipping');
    return;
  }
  for (const doc of result.docs as ProductionDoc[]) {
    // A flow is alive if the stored stromFlowId exists in Strom, OR if a flow
    // tagged with this production's ID is present (covers the case where the
    // stromFlowId write failed after the flow was created).
    const liveFlowId = (doc.stromFlowId && liveFlowIds.has(doc.stromFlowId))
      ? doc.stromFlowId
      : (flowByProdId.get(doc._id) ?? null);

    if (liveFlowId && (doc.status !== 'active' || doc.stromFlowId !== liveFlowId)) {
      try {
        await db.insert({ ...doc, stromFlowId: liveFlowId, status: 'active', updatedAt: new Date().toISOString() } as ProductionDoc);
        log.info({ productionId: doc._id, stromFlowId: liveFlowId }, '[reconcile] Restored production to active');
      } catch (err) {
        log.error({ err, productionId: doc._id }, '[reconcile] Failed to restore production to active');
      }
    } else if (!liveFlowId && (doc.status === 'active' || doc.status === 'activating')) {
      try {
        await db.insert({ ...doc, status: 'inactive', stromFlowId: undefined, updatedAt: new Date().toISOString() } as ProductionDoc);
        log.info({ productionId: doc._id }, '[reconcile] Reset stale production to inactive');
      } catch (err) {
        log.error({ err, productionId: doc._id }, '[reconcile] Failed to reset production to inactive');
      }
    }
  }
}

async function main() {
  // API_KEY is required in production. Without it every route is unauthenticated,
  // allowing any client that can reach port 3000 to create, modify, and delete
  // productions. Omitting API_KEY is intentional only when running behind OSC's
  // reverse-proxy auth wall or another trusted auth layer.
  if (!config.apiKey) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'API_KEY must be set in production deployments. ' +
        'Without it all API routes are unauthenticated. ' +
        'Set API_KEY to a strong random secret, or set NODE_ENV to a value ' +
        'other than "production" if this deployment intentionally relies on ' +
        'an external auth layer (e.g. the OSC reverse proxy).'
      );
    } else {
      console.warn(
        '[security] API_KEY is not set — all /api/v1 routes are unauthenticated. ' +
        'Set API_KEY before deploying to production.'
      );
    }
  }

  // PUBLIC_BASE_URL is required in production to prevent X-Forwarded-Host injection.
  // Without it, the activation endpoint derives the public WHIP URL from the raw
  // X-Forwarded-Host header, which an attacker can forge to redirect camera streams
  // to an attacker-controlled server (CVE category: host-header injection).
  if (!config.publicBaseUrl) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'PUBLIC_BASE_URL must be set in production deployments. ' +
        'Without it the activation endpoint derives WHIP endpoint URLs from the ' +
        'X-Forwarded-Host request header, enabling host-header injection attacks.'
      );
    } else {
      console.warn(
        '[security] PUBLIC_BASE_URL is not set. WHIP endpoint URLs will be derived ' +
        'from request headers (X-Forwarded-Host / Host). Set PUBLIC_BASE_URL to the ' +
        'externally reachable URL of this service before deploying to production.'
      );
    }
  }

  const app = await buildServer();

  try {
    await connectDb();
    app.log.info('[db] Connected to CouchDB');
    await cleanLegacyFixtures();
    await reconcileProductionStatuses(app.log);
  } catch (err: any) {
    app.log.error('[db] Failed to connect to CouchDB — continuing without database (status: %s)', err?.statusCode ?? err?.message ?? 'unknown');
  }

  startIdleWatchdog(app.log);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

const shutdown = (err: unknown, origin: string): void => {
  console.error({ err, origin }, 'Fatal error — shutting down');
  // Force-exit if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000).unref();
  process.exit(1);
};

process.on('uncaughtException', (err, origin) => shutdown(err, origin));
process.on('unhandledRejection', (reason) => shutdown(reason, 'unhandledRejection'));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
