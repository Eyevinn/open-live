import type { WebSocket } from '@fastify/websocket';
import type { Tally } from '../db/types.js';

// In-memory tally state and subscriber map per production
const tallyState = new Map<string, Tally>();
const subscribers = new Map<string, Set<WebSocket>>();

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
  const stamped =
    message !== null && typeof message === 'object' && !Array.isArray(message)
      ? { ts: new Date().toISOString(), ...(message as Record<string, unknown>) }
      : message;
  const payload = JSON.stringify(stamped);
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}
