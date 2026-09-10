/**
 * Tests for server-side event timestamps on controller broadcasts (issue #169).
 *
 * The `broadcast()` helper stamps every outbound event with a server-side `ts`
 * (ISO 8601 UTC) taken at handle time, so consumers no longer fold WebSocket /
 * scheduling latency into their own measurements. The field is added centrally
 * so all message types (TALLY, PIP_STATE, ON_AIR, ...) inherit it consistently.
 * Shape matches the automation-control-contract spec envelope.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { WebSocket } from '@fastify/websocket';
import { broadcast, subscribe, unsubscribe } from '../services/tally.service.js';

/** Minimal fake WebSocket that records everything sent to it. */
class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(payload: string): void {
    this.sent.push(payload);
  }
}

const PRODUCTION_ID = 'prod-ts-test';

function makeSub(): { ws: FakeWs; last: () => Record<string, unknown> } {
  const ws = new FakeWs();
  subscribe(PRODUCTION_ID, ws as unknown as WebSocket);
  return {
    ws,
    last: () => JSON.parse(ws.sent[ws.sent.length - 1]) as Record<string, unknown>,
  };
}

describe('broadcast() server-side timestamp (#169)', () => {
  let sub: ReturnType<typeof makeSub>;

  beforeEach(() => {
    sub = makeSub();
  });

  it('adds a well-formed ISO-8601 ts to TALLY broadcasts', () => {
    const before = Date.now();
    broadcast(PRODUCTION_ID, { type: 'TALLY', pgm: 'cam-1', pvw: 'cam-2' });
    const after = Date.now();

    const msg = sub.last();
    expect(msg.type).toBe('TALLY');
    // existing fields preserved (additive / backward-compatible)
    expect(msg.pgm).toBe('cam-1');
    expect(msg.pvw).toBe('cam-2');

    expect(typeof msg.ts).toBe('string');
    // round-trips as a valid date and is in ISO-8601 UTC form
    const parsed = new Date(msg.ts as string);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(msg.ts).toBe(parsed.toISOString());
    // stamped at handle time, within the broadcast window
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before);
    expect(parsed.getTime()).toBeLessThanOrEqual(after);

    unsubscribe(PRODUCTION_ID, sub.ws as unknown as WebSocket);
  });

  it('stamps every message type consistently (PIP_STATE, ON_AIR)', () => {
    broadcast(PRODUCTION_ID, { type: 'PIP_STATE', pgmPip: null, pvwPip: null, pips: [] });
    expect(typeof sub.last().ts).toBe('string');

    broadcast(PRODUCTION_ID, { type: 'ON_AIR', value: true });
    const onAir = sub.last();
    expect(onAir.value).toBe(true);
    expect(typeof onAir.ts).toBe('string');

    unsubscribe(PRODUCTION_ID, sub.ws as unknown as WebSocket);
  });

  it('does not overwrite a caller-provided ts', () => {
    const explicit = '2020-01-01T00:00:00.000Z';
    broadcast(PRODUCTION_ID, { type: 'TALLY', ts: explicit, pgm: null, pvw: null });
    expect(sub.last().ts).toBe(explicit);

    unsubscribe(PRODUCTION_ID, sub.ws as unknown as WebSocket);
  });
});
