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

export function broadcast(productionId: string, message: unknown): void {
  const subs = subscribers.get(productionId);
  if (!subs) return;
  const payload = JSON.stringify(message);
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}
