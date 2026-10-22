import type { WebSocket } from '@fastify/websocket';
import type { Tally } from '../db/types.js';

// In-memory tally state and subscriber map per production
const tallyState = new Map<string, Tally>();
const subscribers = new Map<string, Set<WebSocket>>();

// Sockets currently receiving their connect-time snapshot (HELLO … SNAPSHOT_END).
// A socket is subscribed to broadcasts *before* its snapshot is built, so live
// broadcasts can race the point-to-point snapshot frames and arrive interleaved
// and indistinguishable from them (#456). While a socket is "snapshotting",
// broadcast() buffers its copies here instead of sending them; endSnapshot()
// flushes the buffer in order right before SNAPSHOT_END, so the client sees the
// full snapshot first, then any broadcasts that landed during it (all with
// seq <= snapshotEnd.seq), then resumes live events with seq > snapshotEnd.seq.
// Buffering (rather than tagging each frame) also means a newer live broadcast
// can never be overwritten by a staler snapshot frame emitted after it.
const snapshotBuffers = new Map<WebSocket, string[]>();

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

// Watch-only sockets receive broadcasts but are not operators: they are left out
// of getSubscriberCount, so they neither show in the controller count nor keep
// a production alive against the idle watchdog.
const watchOnlySockets = new WeakSet<WebSocket>();

export function subscribe(productionId: string, ws: WebSocket, opts: { watchOnly?: boolean } = {}): void {
  if (!subscribers.has(productionId)) {
    subscribers.set(productionId, new Set());
  }
  subscribers.get(productionId)!.add(ws);
  if (opts.watchOnly) watchOnlySockets.add(ws);
}

export function unsubscribe(productionId: string, ws: WebSocket): void {
  subscribers.get(productionId)?.delete(ws);
  // Drop any snapshot buffer so a socket that closes mid-snapshot (before
  // endSnapshot runs) does not leak its queued broadcasts.
  snapshotBuffers.delete(ws);
}

/**
 * Begin buffering broadcasts for a socket while its connect-time snapshot is
 * built (#456). Must be called immediately after `subscribe()` and before any
 * broadcast can be triggered, so no live broadcast slips through unbuffered.
 */
export function beginSnapshot(ws: WebSocket): void {
  snapshotBuffers.set(ws, []);
}

/**
 * Stop buffering for a socket and flush the broadcasts that arrived during its
 * snapshot, in arrival order, right before SNAPSHOT_END. Idempotent and safe to
 * call on a socket that was never buffering or has since closed. Must be the
 * last thing before the SNAPSHOT_END send, with no `await` in between, so a
 * later broadcast cannot land ahead of SNAPSHOT_END.
 */
export function endSnapshot(ws: WebSocket): void {
  const buffered = snapshotBuffers.get(ws);
  snapshotBuffers.delete(ws);
  if (!buffered || ws.readyState !== ws.OPEN) return;
  for (const payload of buffered) ws.send(payload);
}

/** Every socket subscribed to a production, watch-only ones included. */
export function getSockets(productionId: string): WebSocket[] {
  return [...subscribers.get(productionId) ?? []];
}

/** Operator (non-watch-only) sockets for a production. */
export function getOperatorSockets(productionId: string): WebSocket[] {
  return [...subscribers.get(productionId) ?? []].filter((ws) => !watchOnlySockets.has(ws));
}

/** Operator (non-watch-only) connections for a production. */
export function getSubscriberCount(productionId: string): number {
  return getOperatorSockets(productionId).length;
}

export function getWatcherCount(productionId: string): number {
  let count = 0;
  for (const ws of subscribers.get(productionId) ?? []) {
    if (watchOnlySockets.has(ws)) count++;
  }
  return count;
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
    if (ws.readyState !== ws.OPEN) continue;
    // A socket still receiving its connect snapshot buffers the broadcast; it is
    // flushed (in order) by endSnapshot() just before SNAPSHOT_END (#456).
    const buffer = snapshotBuffers.get(ws);
    if (buffer) buffer.push(payload);
    else ws.send(payload);
  }
}
