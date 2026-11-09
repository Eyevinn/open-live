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
import { recordingStateMessage } from '../lib/input-recording.js';
import { getSubscriberCount } from './tally.service.js';
import { clearProductionPflState } from './pfl-state.js';
import { clearAudioState, clearPipState, clearFxState, clearClipStateForProduction } from '../ws/controller.js';
import { forceStopMeterRelay } from './meter-relay.js';
import { stopLiveRecordingUpload } from './live-recording-upload.js';
import { forceStopClipRelay } from './clip-relay.js';
import { broadcast } from './tally.service.js';
import {
  activationAbortControllers,
  emitProductionStatus,
  uploadRecordingBeforeTeardown,
  teardownIntercomForProduction,
  writeDeactivatedDoc,
} from '../routes/productions.js';
import { sweepGuestsOnProductionEnd } from './guest-sweep.js';
import type { ProductionDoc, RecordingUploadSummary } from '../db/types.js';

// Idle deadline is config-driven (issue #290, env IDLE_TIMEOUT_SEC, default 300s
// = the previous hardcoded 5-minute constant). Read via getIdleTimeoutMs() so a
// test or deployment override is honored without changing runtime defaults.
const POLL_INTERVAL_MS = 10 * 1000;    // 10 seconds

function getIdleTimeoutMs(): number {
  return config.idleTimeoutSec * 1000;
}

/**
 * Warning lead time in ms, clamped so it can never exceed the deadline itself
 * (a lead >= deadline would mean "warn immediately on going idle", which we
 * still permit but never a negative threshold).
 */
function getIdleWarningLeadMs(): number {
  return Math.min(config.idleWarningLeadSec, config.idleTimeoutSec) * 1000;
}

/** productionId → timestamp when subscriber count first dropped to 0 */
const idleSince = new Map<string, number>();

/** productionId → true once an IDLE_WARNING has been emitted this idle cycle.
 *  Prevents re-emitting the warning on every tick; cleared when the timer resets
 *  (subscriber joins, keep-alive) or the production deactivates. */
const idleWarned = new Map<string, boolean>();

/** Set of production IDs currently known to be active or activating */
const activeProductionIds = new Set<string>();

let watchdogInterval: NodeJS.Timeout | null = null;

export function getIdleSince(productionId: string): number | undefined {
  return idleSince.get(productionId);
}

export function getIdleExpiresAt(idleSinceMs: number): number {
  return idleSinceMs + getIdleTimeoutMs();
}

/**
 * Reset a production's idle timer and cancel any pending idle warning (issue
 * #290). Called on an explicit client keep-alive/activity (inbound KEEP_ALIVE
 * on the controller WS). When a warning had already been emitted this idle
 * cycle, broadcast an IDLE_WARNING_CLEARED so connected clients dismiss the
 * countdown. Idempotent — a keep-alive with no pending warning just clears the
 * timer silently.
 */
export function resetIdleTimer(productionId: string): void {
  idleSince.delete(productionId);
  if (idleWarned.get(productionId)) {
    idleWarned.delete(productionId);
    broadcast(productionId, { type: 'IDLE_WARNING_CLEARED', productionId });
  } else {
    idleWarned.delete(productionId);
  }
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
  idleWarned.delete(productionId);
}

/** Call immediately when a subscriber connects — clears the idle timer so the
 *  watchdog cannot deactivate the production while someone is connected. A
 *  connect is itself activity, so any pending warning is cleared too (#290). */
export function notifySubscriberJoin(productionId: string): void {
  resetIdleTimer(productionId);
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

  log.info(`[idle-watchdog] Idle auto-deactivation enabled (timeout: ${getIdleTimeoutMs() / 1000}s, warningLead: ${getIdleWarningLeadMs() / 1000}s, poll: ${POLL_INTERVAL_MS / 1000}s)`);

  void seedActiveProductions(log);

  watchdogInterval = setInterval(() => {
    tick(log).catch((err) => log.error({ err }, '[idle-watchdog] Tick error'));
  }, POLL_INTERVAL_MS);

  // Allow the process to exit even if the interval is still running
  watchdogInterval.unref();
}

/** Stop the watchdog poll loop. Idempotent; exported for graceful shutdown and
 *  for tests that need a fresh interval per fake-timer context (issue #290). */
export function stopIdleWatchdog(): void {
  if (watchdogInterval !== null) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (activeProductionIds.size === 0) return;

  const now = Date.now();
  const timeoutMs = getIdleTimeoutMs();
  const warningLeadMs = getIdleWarningLeadMs();

  for (const productionId of activeProductionIds) {
    const count = getSubscriberCount(productionId);

    if (count > 0) {
      // Activity: reset the timer and cancel any pending warning (#290).
      resetIdleTimer(productionId);
      continue;
    }

    if (!idleSince.has(productionId)) {
      idleSince.set(productionId, now);
      log.debug({ productionId }, '[idle-watchdog] Production became idle — starting timer');
      continue;
    }

    const idleMs = now - idleSince.get(productionId)!;
    const deadlineMs = idleSince.get(productionId)! + timeoutMs;
    const remainingMs = deadlineMs - now;

    // Emit a single pre-deactivation warning once the timer crosses the warning
    // threshold (T-minus the lead time), before the deadline fires (#290).
    if (idleMs < timeoutMs) {
      if (remainingMs <= warningLeadMs && !idleWarned.get(productionId)) {
        idleWarned.set(productionId, true);
        const remainingSec = Math.max(0, Math.round(remainingMs / 1000));
        log.info(
          { productionId, remainingSec },
          '[idle-watchdog] Emitting idle pre-deactivation warning',
        );
        broadcast(productionId, {
          type: 'IDLE_WARNING',
          productionId,
          remainingSec,
          deadlineMs,
        });
      }
      continue;
    }

    log.info(
      { productionId, idleSec: Math.round(idleMs / 1000) },
      '[idle-watchdog] Auto-deactivating idle production',
    );

    notifyProductionDeactivated(productionId);

    try {
      await deactivateProduction(productionId, log);
    } catch (err) {
      // `idleSince` was cleared above, so the production is tracked again with a
      // fresh idle period: it is retried once it has been idle for another full
      // timeout, not on the next tick.
      log.error({ err, productionId }, '[idle-watchdog] Failed to deactivate production — will retry after a fresh idle period');
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
  // Stop any clip completion-poll timers and wipe the in-memory clip-state
  // registry — live-only clip state must not survive the stop (#278, #625).
  // A cued clip's cue point is not in this registry and is kept (#336, #307).
  clearClipStateForProduction(doc._id);
  // Force-stop both relays regardless of refCount — same stale-relay hazard as
  // the explicit deactivate path (issue #416): controller sockets survive the
  // idle auto-deactivate, so the relays must be torn down here too or a connect
  // after reactivation ref-counts into a relay bound to the old flow.
  forceStopMeterRelay(doc._id, doc.stromFlowId);
  forceStopClipRelay(doc._id, doc.stromFlowId);
  broadcast(doc._id, { type: 'GRP_STATE_RESET' });
  // Stop the live recording part upload with the flow (issue #556), and wait
  // for a running pass so the sweep below never races it.
  const liveSession = await stopLiveRecordingUpload(doc._id);
  let lastRecordingUpload: RecordingUploadSummary | undefined;

  if (doc.stromFlowId) {
    try {
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      // Upload the recording before the flow is torn down, same as the explicit
      // deactivate (issue #596). No doc write may precede it (#366 _rev guard).
      lastRecordingUpload = await uploadRecordingBeforeTeardown(doc, strom, stromToken, log, liveSession);
      await deactivateStromFlow(doc.stromFlowId, strom);
    } catch (err) {
      log.warn({ err, productionId: doc._id }, '[idle-watchdog] Strom flow teardown failed — continuing');
    }
  }

  // End the talkback sessions and delete the Open Intercom grouping, same as
  // the explicit deactivate (issue #625). Never throws; a repointed or cleared
  // connection skips the teardown with a log (#617).
  await teardownIntercomForProduction(doc, log);

  // Revoke guest invites and end live guest sessions (issue #414); best-effort.
  await sweepGuestsOnProductionEnd(doc._id, log);

  // The same doc write as the explicit deactivate (issue #625): every
  // live-session field is cleared (including the intercom grouping, clip-player
  // blocks and return buses), shared-GPU usage is settled (#500), and the
  // transition rule (spec §1) applies — `active` becomes `ended` with
  // endedReason 'idle', `activating` becomes `inactive`. A revision conflict
  // never drops a flow or grouping this run did not tear down: a grouping
  // created meanwhile (a guest join) is torn down and the write retried in this
  // run; a new activation is left alone (see writeIdleDeactivatedDoc).
  const stored = await writeIdleDeactivatedDoc(doc, log, lastRecordingUpload);
  if (!stored) return;
  // Nothing records any more (OL-32, spec §2.8), before PRODUCTION_DEACTIVATED.
  broadcast(doc._id, recordingStateMessage(undefined));
  broadcast(doc._id, { type: 'PRODUCTION_DEACTIVATED' });
  // Emit the typed lifecycle event (spec §3). Flow is torn down, so all assigned
  // outputs derive as down.
  emitProductionStatus(stored);
  log.info({ productionId: doc._id, name: doc.name }, '[idle-watchdog] Production deactivated');
}

/** CouchDB answers a stale `_rev` with 409. */
function isConflict(err: unknown): boolean {
  return err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409;
}

/** Bound on the grouping-race retries below; each one is a fresh teardown + write. */
const MAX_GROUPING_RACE_RETRIES = 3;

/**
 * The idle stop's doc write. `writeDeactivatedDoc` rethrows a revision conflict
 * whenever the stored doc names a flow or grouping this run did not tear down.
 * The idle path cannot leave that to a later tick: `tick()` has already dropped
 * the idle timer, so the production would stay half-stopped (flow deleted, doc
 * still `active`) for at least another full idle timeout (#625 review). So the
 * two conflicts are resolved here:
 *  - Grouping only (same status, same `stromFlowId`, a new or different
 *    intercom grouping, e.g. a guest joined during the teardown): tear down the
 *    new grouping and retry the write, bounded, so the production ends in this
 *    run.
 *  - New activation (status `active`/`activating` with a different
 *    `stromFlowId`): nothing is torn down and nothing is written. The
 *    production is tracked as active again with a fresh idle period. Returns
 *    undefined.
 * Any other conflict rethrows.
 */
async function writeIdleDeactivatedDoc(
  doc: ProductionDoc,
  log: FastifyBaseLogger,
  lastRecordingUpload: RecordingUploadSummary | undefined,
): Promise<ProductionDoc | undefined> {
  let base = doc;
  for (let attempt = 0; ; attempt++) {
    try {
      const { doc: stored } = await writeDeactivatedDoc(base, log, lastRecordingUpload, 'idle');
      return stored;
    } catch (err) {
      if (!isConflict(err)) throw err;
      const current = await getDb().get(doc._id) as ProductionDoc;
      if (current.status === base.status && current.stromFlowId === base.stromFlowId) {
        if (attempt >= MAX_GROUPING_RACE_RETRIES - 1) throw err;
        const groupingChanged =
          current.intercomProductionId !== base.intercomProductionId ||
          current.intercomManagerOrigin !== base.intercomManagerOrigin;
        if (groupingChanged) {
          log.info(
            { productionId: doc._id, intercomProductionId: current.intercomProductionId },
            '[idle-watchdog] Intercom grouping created during the idle stop — tearing it down too',
          );
          await teardownIntercomForProduction(current, log);
        }
        base = current;
        continue;
      }
      if ((current.status === 'active' || current.status === 'activating') && current.stromFlowId !== doc.stromFlowId) {
        log.info(
          { productionId: doc._id, stromFlowId: current.stromFlowId, status: current.status },
          '[idle-watchdog] Production was re-activated during the idle stop — leaving the new activation alone',
        );
        notifyProductionActivated(doc._id);
        return undefined;
      }
      throw err;
    }
  }
}
