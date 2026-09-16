/**
 * Idle watchdog — always active.
 *
 * Tracks active productions via event notifications (notifyProductionActivated /
 * notifyProductionDeactivated). On each tick it checks subscriber counts for
 * known active productions — no DB query needed. When the idle timeout expires
 * it fetches the current doc once and deactivates.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { isDbConnected, getDb } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { deactivateStromFlow } from '../lib/flow-generator.js';
import { getSubscriberCount } from './tally.service.js';
import { clearProductionPflState } from './pfl-state.js';
import { clearAudioState, clearPipState, clearFxState } from '../ws/controller.js';
import { broadcast } from './tally.service.js';
import { activationAbortControllers, updateProductionDoc, emitProductionStatus } from '../routes/productions.js';
import { stoppedStatus } from '../lib/production-health.js';
import type { ProductionDoc } from '../db/types.js';

const IDLE_TIMEOUT_MS = config.idleTimeoutSeconds * 1000;
const POLL_INTERVAL_MS = 10 * 1000;    // 10 seconds
// Warning lead time before the idle deadline (issue #290). Clamped so it can
// never exceed the deadline itself (a lead >= timeout would fire at t=0).
const WARNING_LEAD_MS = Math.min(config.idleWarningLeadSeconds, config.idleTimeoutSeconds) * 1000;

/** productionId → timestamp when subscriber count first dropped to 0 */
const idleSince = new Map<string, number>();

/** Production IDs for which an IDLE_WARNING has already been broadcast in the
 *  current idle cycle. Cleared when the timer resets (subscriber joins /
 *  reactivation / deactivation) so the warning fires exactly once per cycle. */
const warned = new Set<string>();

/** Set of production IDs currently known to be active or activating */
const activeProductionIds = new Set<string>();

let watchdogInterval: NodeJS.Timeout | null = null;

export function getIdleSince(productionId: string): number | undefined {
  return idleSince.get(productionId);
}

export function getIdleExpiresAt(idleSinceMs: number): number {
  return idleSinceMs + IDLE_TIMEOUT_MS;
}

export function isWatchdogEnabled(): boolean {
  return watchdogInterval !== null;
}

/** Call when a production transitions to active or activating */
export function notifyProductionActivated(productionId: string): void {
  activeProductionIds.add(productionId);
}

/** Call when a production is deactivated (manually or by the watchdog itself) */
export function notifyProductionDeactivated(productionId: string): void {
  activeProductionIds.delete(productionId);
  idleSince.delete(productionId);
  warned.delete(productionId);
}

/** Call immediately when a subscriber connects — clears the idle timer so the
 *  watchdog cannot deactivate the production while someone is connected. This is
 *  the "activity resets the countdown" path (issue #290): it also cancels any
 *  pending idle warning so a reconnect within the warning window is not left
 *  showing a stale countdown. */
export function notifySubscriberJoin(productionId: string): void {
  idleSince.delete(productionId);
  warned.delete(productionId);
}

async function seedActiveProductions(log: FastifyBaseLogger): Promise<void> {
  if (!isDbConnected()) return;
  try {
    // findTrusted: literal selector written here, no request data (#257)
    const result = await getDb().findTrusted({
      selector: { type: 'production', status: { $in: ['active', 'activating'] } },
      fields: ['_id'],
    });
    const docs = Array.isArray(result?.docs) ? result.docs as { _id: string }[] : [];
    const now = Date.now();
    for (const doc of docs) {
      activeProductionIds.add(doc._id);
      if (getSubscriberCount(doc._id) === 0) {
        idleSince.set(doc._id, now);
      }
    }
    if (docs.length > 0) {
      log.info({ count: docs.length }, '[idle-watchdog] Seeded active productions from DB');
    }
  } catch (err) {
    log.warn({ err }, '[idle-watchdog] Failed to seed active productions — watchdog will learn via events');
  }
}

export function startIdleWatchdog(log: FastifyBaseLogger): void {
  if (watchdogInterval !== null) return;

  log.info(`[idle-watchdog] Idle auto-deactivation enabled (timeout: ${IDLE_TIMEOUT_MS / 1000}s, warning lead: ${WARNING_LEAD_MS / 1000}s, poll: ${POLL_INTERVAL_MS / 1000}s)`);

  void seedActiveProductions(log);

  watchdogInterval = setInterval(() => {
    tick(log).catch((err) => log.error({ err }, '[idle-watchdog] Tick error'));
  }, POLL_INTERVAL_MS);

  // Allow the process to exit even if the interval is still running
  watchdogInterval.unref();
}

/** Exported for tests (issue #290) — runs a single watchdog pass so the
 *  pre-deactivation warning and auto-deactivate logic can be exercised without
 *  the interval timer. */
export async function tick(log: FastifyBaseLogger): Promise<void> {
  if (activeProductionIds.size === 0) return;

  const now = Date.now();

  for (const productionId of activeProductionIds) {
    const count = getSubscriberCount(productionId);

    if (count > 0) {
      idleSince.delete(productionId);
      warned.delete(productionId);
      continue;
    }

    if (!idleSince.has(productionId)) {
      idleSince.set(productionId, now);
      log.debug({ productionId }, '[idle-watchdog] Production became idle — starting timer');
      continue;
    }

    const idleMs = now - idleSince.get(productionId)!;
    const remainingMs = IDLE_TIMEOUT_MS - idleMs;

    // Pre-deactivation warning (issue #290): once the countdown crosses into the
    // warning window (but before the deadline) emit a single IDLE_WARNING to any
    // still-connected controller sockets so a client can surface a countdown.
    // broadcast() is a no-op when there are no subscribers, so this is safe.
    if (remainingMs > 0 && remainingMs <= WARNING_LEAD_MS && !warned.has(productionId)) {
      warned.add(productionId);
      const deadlineAt = idleSince.get(productionId)! + IDLE_TIMEOUT_MS;
      const secondsRemaining = Math.max(0, Math.round(remainingMs / 1000));
      log.info(
        { productionId, secondsRemaining },
        '[idle-watchdog] Emitting pre-deactivation idle warning',
      );
      broadcast(productionId, {
        type: 'IDLE_WARNING',
        secondsRemaining,
        deadline: new Date(deadlineAt).toISOString(),
        reason: 'idle',
      });
    }

    if (idleMs < IDLE_TIMEOUT_MS) continue;

    log.info(
      { productionId, idleSec: Math.round(idleMs / 1000) },
      '[idle-watchdog] Auto-deactivating idle production',
    );

    notifyProductionDeactivated(productionId);

    try {
      await deactivateProduction(productionId, log);
    } catch (err) {
      log.error({ err, productionId }, '[idle-watchdog] Failed to deactivate production — will retry next tick');
      notifyProductionActivated(productionId);
    }
  }
}

/** Exported for tests (issue #255) — exercises the idle-auto-deactivate stop path. */
export async function deactivateProduction(productionId: string, log: FastifyBaseLogger): Promise<void> {
  if (!isDbConnected()) {
    log.warn({ productionId }, '[idle-watchdog] DB not connected — cannot deactivate');
    return;
  }

  // Fetch fresh doc at deactivation time — single targeted read
  const doc = await getDb().get(productionId) as ProductionDoc;

  // Guard: already deactivated by something else between tick and now
  if (doc.status !== 'active' && doc.status !== 'activating') {
    log.debug({ productionId, status: doc.status }, '[idle-watchdog] Production no longer active — skipping');
    return;
  }

  // Cancel any in-progress activation loop
  const abortController = activationAbortControllers.get(doc._id);
  if (abortController) {
    abortController.abort();
    activationAbortControllers.delete(doc._id);
  }

  clearProductionPflState(doc._id);
  clearAudioState(doc._id);
  clearPipState(doc._id);
  clearFxState(doc._id);
  broadcast(doc._id, { type: 'GRP_STATE_RESET' });

  if (doc.stromFlowId) {
    try {
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      await deactivateStromFlow(doc.stromFlowId, strom);
    } catch (err) {
      log.warn({ err, productionId: doc._id }, '[idle-watchdog] Strom flow teardown failed — continuing');
    }
  }

  // Transition rule (spec §1): an `active` production auto-deactivated for idle
  // becomes `ended` (it broadcast and then stopped); one still `activating`
  // becomes `inactive` (it never reached a live broadcast).
  const nextStatus = stoppedStatus(doc.status);
  await updateProductionDoc(doc._id, {
    status: nextStatus,
    endedReason: nextStatus === 'ended' ? 'idle' : undefined,
    autoDeactivated: true,
    stromFlowId: undefined,
    mixerBlockId: undefined,
    audioMixerBlockId: undefined,
    loudnessMainBlockId: undefined,
    sourceOffsetBlockIds: undefined,
    sourceAudioOffsetBlockIds: undefined,
    whepEndpoint: undefined,
    pgmWhepEndpoint: undefined,
    whipEndpoints: undefined,
    srtOutputUri: undefined,
    whepOutputUrls: undefined,
    tally: { pgm: null, pvw: null },
  });
  broadcast(doc._id, { type: 'PRODUCTION_DEACTIVATED' });
  // Emit the typed lifecycle event (spec §3). Flow is torn down, so all assigned
  // outputs derive as down.
  emitProductionStatus({ _id: doc._id, status: nextStatus, stromFlowId: undefined, outputAssignments: doc.outputAssignments });
  log.info({ productionId: doc._id, name: doc.name }, '[idle-watchdog] Production deactivated');
}
