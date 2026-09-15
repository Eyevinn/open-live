import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getDb, isDbConnected } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { stoppedStatus } from '../lib/production-health.js';
import type { ProductionDoc } from '../db/types.js';

/**
 * Startup reconciliation: cross-reference each production's stored stromFlowId
 * against the live Strom flow list so the DB reflects reality after a restart.
 *
 * - Productions with a stromFlowId still present in Strom → mark active
 * - Productions that were 'active' whose flow is gone → mark 'ended' (#255)
 * - Productions stuck in 'activating' (no live flow) → mark inactive
 *
 * If Strom is unreachable, productions are left as-is (we can't know the truth).
 *
 * Extracted from main.ts so it can be unit-tested without triggering the
 * server-entry side effects of importing main.ts (issue #255).
 */
export async function reconcileProductionStatuses(
  log: FastifyBaseLogger,
): Promise<void> {
  if (!isDbConnected()) {
    log.debug('[reconcile] Database not connected — skipping');
    return;
  }
  const db = getDb();

  let liveFlows: import('../lib/strom.js').Flow[];
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
      // Transition rule (spec §1): a doc that was `active` whose Strom flow has
      // disappeared broadcast and then stopped abnormally — it becomes `ended`
      // (endedReason: 'flow-lost'). A doc still `activating` never reached a live
      // broadcast, so it resets to `inactive`.
      const nextStatus = stoppedStatus(doc.status);
      try {
        await db.insert({
          ...doc,
          status: nextStatus,
          ...(nextStatus === 'ended' ? { endedReason: 'flow-lost' as const } : {}),
          stromFlowId: undefined,
          updatedAt: new Date().toISOString(),
        } as ProductionDoc);
        log.info({ productionId: doc._id, status: nextStatus }, '[reconcile] Reset stale production');
      } catch (err) {
        log.error({ err, productionId: doc._id }, '[reconcile] Failed to reset stale production');
      }
    }
  }
}
