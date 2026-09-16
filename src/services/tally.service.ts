import type { WebSocket } from '@fastify/websocket';
import type { Tally } from '../db/types.js';

// In-memory tally state and subscriber map per production
const tallyState = new Map<string, Tally>();
const subscribers = new Map<string, Set<WebSocket>>();

/**
 * Per-production monotonically increasing sequence counter (#169).
 * Incremented by `nextSeq()` before every outbound state event.
 * Resets only on server restart — reconnect resync relies on the
 * connect-time snapshot (HELLO … SNAPSHOT_END), not seq replay.
 * Documented in the automation-control-contract spec.
 */
const seqByProduction = new Map<string, number>();

/**
 * Returns the next sequence number for a production and increments the counter.
 * Initialises at 1 on first call. Thread-safe within a single Node.js event loop.
 */
export function nextSeq(productionId: string): number {
  const current = seqByProduction.get(productionId) ?? 0;
  const next = current + 1;
  seqByProduction.set(productionId, next);
  return next;
}

/**
 * Returns the current (last-emitted) sequence number for a production without
 * incrementing it. Returns 0 if no events have been emitted yet.
 * Used by SNAPSHOT_END to echo the seq of the last snapshot frame.
 */
export function currentSeq(productionId: string): number {
  return seqByProduction.get(productionId) ?? 0;
}

export function getTally(productionId: string): Tally {
  return tallyState.get(productionId) ?? { pgm: null, pvw: null };
}

export function setTally(productionId: string, tally: Tally): void {
  tallyState.set(productionId, tally);
}

export function subscribe(productionId: string, ws: WebSocket): void {
  if (!subscribers.has(productionId)) {
    subscribers.set(productionId, new Set());
  }
  subscribers.get(productionId)!.add(ws);
}

export function unsubscribe(productionId: string, ws: WebSocket): void {
  subscribers.get(productionId)?.delete(ws);
}

export function getSubscriberCount(productionId: string): number {
  return subscribers.get(productionId)?.size ?? 0;
}

export function broadcast(productionId: string, message: unknown): void {
  const subs = subscribers.get(productionId);
  if (!subs) return;
  // Stamp every outbound event with a server-side timestamp taken at handle
  // time, so consumers do not fold WebSocket/scheduling latency into their own
  // measurements (issue #169). Added centrally here so all message types get it
  // consistently and future events inherit it. Additive/backward-compatible; an
  // explicit `ts` on the message (if ever provided) is preserved. Shape matches
  // the automation-control-contract spec envelope (`ts: '<ISO 8601 UTC>'`).
  //
  // Also stamp a per-production monotonic `seq` number (issue #169 / spec §2).
  // Allows reconnecting automation clients to order events and detect gaps.
  // `seq` advances before the send so the value is consistent even if multiple
  // subscribers receive the same payload object reference.
  const isObj = message !== null && typeof message === 'object' && !Array.isArray(message);
  const seq = nextSeq(productionId);
  const stamped = isObj
    ? { seq, ts: new Date().toISOString(), ...(message as Record<string, unknown>) }
    : message;
  const payload = JSON.stringify(stamped);
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}
