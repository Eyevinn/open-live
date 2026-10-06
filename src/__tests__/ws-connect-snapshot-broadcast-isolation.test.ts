/**
 * Regression tests for #456: a controller client must be able to tell
 * connect-snapshot frames from live broadcasts that race the snapshot.
 *
 * The socket is subscribed to broadcasts *before* its connect snapshot is built,
 * so a broadcast triggered while the (async) snapshot is still in flight used to
 * arrive interleaved between snapshot frames and indistinguishable from them —
 * e.g. a stale snapshot TALLY could even land *after* a newer live TALLY.
 *
 * The fix holds broadcasts for a snapshotting socket (tally.service
 * beginSnapshot/endSnapshot) and flushes them, in order, immediately before
 * SNAPSHOT_END. So every snapshot frame precedes every in-window broadcast, and
 * every in-window broadcast precedes SNAPSHOT_END.
 *
 * Two layers: a direct unit test of the tally.service buffering primitives, and
 * an integration test over the REAL controller plugin + a live `ws` client that
 * fires a broadcast mid-snapshot (from inside the mocked Strom `flows.get`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

// A hook the mocked Strom calls from inside the connect snapshot's audio-sync
// await, so the test can fire a broadcast while the socket is mid-snapshot.
const hooks = vi.hoisted(() => ({ onFlowsGet: null as null | (() => void) }));

const mockGet = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getOutputsDb: () => ({ get: mockGet, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGuestSessionsDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGuestInvitesDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = {
      // Fire the test hook mid-snapshot, then resolve with a flow that has no
      // mixer block so the rest of the audio-sync path is a no-op.
      get: vi.fn(async () => { hooks.onFlowsGet?.(); return { flow: { id: 'flow-abc', blocks: [] } }; }),
      getBlockProperties: vi.fn().mockResolvedValue({ properties: {} }),
      updateBlockProperties: vi.fn().mockResolvedValue({}),
    };
    mixer = { getState: vi.fn().mockResolvedValue({}) };
  }
  return { ...actual, StromClient: MockStromClient };
});

import { buildServer } from '../server.js';
import { broadcast, beginSnapshot, endSnapshot, subscribe, unsubscribe } from '../services/tally.service.js';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-ws-1',
    _rev: '1-abc',
    type: 'production',
    name: 'WS Test',
    status: 'active',
    sources: [],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('tally.service snapshot buffering (#456)', () => {
  function fakeSocket() {
    return { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;
  }

  it('holds broadcasts for a snapshotting socket and flushes them in order on endSnapshot', () => {
    const live = fakeSocket();
    subscribe('p1', live);
    beginSnapshot(live);

    broadcast('p1', { type: 'A' });
    broadcast('p1', { type: 'B' });
    // Nothing delivered while snapshotting.
    expect((live.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    endSnapshot(live);
    const sent = (live.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[0] as string).type);
    expect(sent).toEqual(['A', 'B']);
    unsubscribe('p1', live);
  });

  it('delivers broadcasts immediately to a socket that is not snapshotting', () => {
    const operator = fakeSocket();
    subscribe('p2', operator);
    broadcast('p2', { type: 'A' });
    expect((operator.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    unsubscribe('p2', operator);
  });

  it('unsubscribe drops the buffer so a socket closing mid-snapshot does not leak or deliver late', () => {
    const closing = fakeSocket();
    subscribe('p3', closing);
    beginSnapshot(closing);
    broadcast('p3', { type: 'A' });
    unsubscribe('p3', closing); // socket closed mid-snapshot
    endSnapshot(closing); // must be a no-op now
    expect((closing.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('WS connect snapshot — in-window broadcast isolation (#456)', () => {
  let app: FastifyInstance;

  async function connectAndCollect(productionId: string, timeoutMs = 500): Promise<Array<Record<string, unknown>>> {
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`);
    const messages: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => {
        try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
      });
      ws.on('error', reject);
      ws.on('open', () => setTimeout(resolve, timeoutMs));
    });
    ws.close();
    return messages;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    hooks.onFlowsGet = null;
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    hooks.onFlowsGet = null;
    await app.close();
  });

  it('delivers a broadcast fired mid-snapshot after every snapshot frame and before SNAPSHOT_END', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      status: 'active',
      stromFlowId: 'flow-abc',
      graphics: [{ id: 'ov-1', name: 'Lower third', active: false }],
    }));

    // When the connect snapshot reaches its Strom audio-sync await, fire a live
    // broadcast. GRAPHIC is a broadcast-only type — the snapshot emits
    // GRAPHIC_STATE, never GRAPHIC — so it is unambiguously the live event.
    hooks.onFlowsGet = () => {
      broadcast('prod-ws-1', { type: 'GRAPHIC', overlayId: 'ov-1', active: true });
    };

    const messages = await connectAndCollect('prod-ws-1');
    const typeAt = (t: string) => messages.findIndex((m) => m.type === t);

    const hello = typeAt('HELLO');
    const tally = typeAt('TALLY');
    const graphicState = typeAt('GRAPHIC_STATE'); // a snapshot frame
    const liveBroadcast = typeAt('GRAPHIC');       // the in-window live broadcast
    const snapshotEnd = typeAt('SNAPSHOT_END');

    // All the delimiters/markers are present.
    expect(hello).toBeGreaterThanOrEqual(0);
    expect(tally).toBeGreaterThanOrEqual(0);
    expect(graphicState).toBeGreaterThanOrEqual(0);
    expect(liveBroadcast).toBeGreaterThanOrEqual(0);
    expect(snapshotEnd).toBeGreaterThanOrEqual(0);

    // The fix: the in-window broadcast is held until after every snapshot frame
    // (including GRAPHIC_STATE, emitted after the Strom await that triggered it)
    // and delivered immediately before SNAPSHOT_END — never interleaved.
    expect(liveBroadcast).toBeGreaterThan(graphicState);
    expect(liveBroadcast).toBeGreaterThan(hello);
    expect(snapshotEnd).toBeGreaterThan(liveBroadcast);

    // SNAPSHOT_END is the last frame of the connect sequence.
    expect(snapshotEnd).toBe(messages.length - 1);

    // Exactly one live GRAPHIC broadcast was delivered (not dropped, not doubled).
    expect(messages.filter((m) => m.type === 'GRAPHIC')).toHaveLength(1);
  });
});
