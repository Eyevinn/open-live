/**
 * WHIP live-ingest state reflected on sources (issue #439, interim — parent #437).
 *
 * Covers:
 *  - the in-memory state module's change semantics (set returns "changed"),
 *  - a successful WHIP offer marks the mapped source `connected` and broadcasts
 *    SOURCE_INGEST_STATE to the production's controllers,
 *  - a WHIP teardown (DELETE) marks it `disconnected` and broadcasts,
 *  - the read-only `liveIngest` field appears on a source REST response WITHOUT
 *    overwriting the client-writable `status`,
 *  - the WS connect snapshot replays the current per-source ingest state.
 *
 * CouchDB, Strom auth and Strom itself (`fetch`) are mocked; `broadcast` is
 * captured by mocking the tally service (same approach as the HTML-source-event
 * suite), while the connect-snapshot test uses the REAL controller plugin over a
 * live socket (the snapshot lives in the connect handler, which sends directly
 * to the socket and is unaffected by the broadcast mock).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;

// ---------------------------------------------------------------------------
// Mock CouchDB — a single production with one WHIP source on video_in_0, plus a
// standalone WHIP source doc for the REST-field assertion.
// ---------------------------------------------------------------------------

const productionDocs = new Map<string, Record<string, unknown>>();
const sourceDocs = new Map<string, Record<string, unknown>>();

const getProduction = vi.fn(async (id: string) => {
  const doc = productionDocs.get(id);
  if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
  return doc;
});
const getSource = vi.fn(async (id: string) => {
  const doc = sourceDocs.get(id);
  if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
  return doc;
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: getProduction, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }), findTrusted: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: getSource, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGatewaysDb: () => ({ get: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

// Mock StromClient so the connect handler's audio-sync branch never makes a
// real network call (runs after the snapshot sends, so it does not affect it).
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = {
      get: vi.fn().mockResolvedValue({ flow: { id: 'flow-abc', blocks: [] } }),
      getBlockProperties: vi.fn().mockResolvedValue({ properties: {} }),
      updateBlockProperties: vi.fn().mockResolvedValue({}),
    };
    mixer = { getState: vi.fn().mockResolvedValue({}) };
  }
  return { ...actual, StromClient: MockStromClient };
});

// Capture broadcasts (overriding only broadcast; real subscribe/unsubscribe so
// the live-socket snapshot test still works).
const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: (_id: string, message: unknown) => {
      broadcasts.push(message as Record<string, unknown>);
    },
  };
});

import { buildServer } from '../server.js';
import {
  setWhipIngestState,
  getWhipIngestState,
  clearWhipIngestState,
} from '../services/whip-ingest-state.js';

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-ingest-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Ingest Test',
    status: 'active',
    stromFlowId: 'flow-abc',
    sources: [{ sourceId: 'src-whip-0', mixerInput: 'video_in_0' }],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSourceDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'src-whip-0',
    type: 'source',
    name: 'Guest Cam',
    address: 'whip://ignored',
    streamType: 'whip',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let app: FastifyInstance;
let fetchCounter = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  clearWhipIngestState();
  broadcasts.length = 0;
  fetchCounter = 0;
  productionDocs.clear();
  sourceDocs.clear();
  productionDocs.set('prod-ingest-1', makeProductionDoc());
  sourceDocs.set('src-whip-0', makeSourceDoc());
  app = await buildServer();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      fetchCounter += 1;
      return {
        ok: true,
        status: 201,
        text: async () => 'v=0 mock-answer-sdp',
        headers: { get: (name: string) => (name === 'Location' ? `/session/sess-${fetchCounter}` : null) },
      };
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

function ingestBroadcasts() {
  return broadcasts.filter((m) => m.type === 'SOURCE_INGEST_STATE');
}

// ---------------------------------------------------------------------------
// State module
// ---------------------------------------------------------------------------

describe('whip-ingest-state module', () => {
  it('reports a change on first observation and on a transition, but not on a repeat', () => {
    expect(setWhipIngestState('src-x', 'connected')).toBe(true); // first observation
    expect(setWhipIngestState('src-x', 'connected')).toBe(false); // same state
    expect(setWhipIngestState('src-x', 'disconnected')).toBe(true); // transition
    expect(getWhipIngestState('src-x')?.state).toBe('disconnected');
    expect(typeof getWhipIngestState('src-x')?.changedAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// WHIP offer / teardown → state + broadcast
// ---------------------------------------------------------------------------

describe('WHIP offer marks the mapped source connected', () => {
  it('sets connected and broadcasts SOURCE_INGEST_STATE on a successful offer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-ingest-1/whip/video_in_0',
      headers: { ...AUTH, 'content-type': 'application/sdp' },
      payload: 'v=0',
    });
    expect(res.statusCode).toBe(201);
    expect(getWhipIngestState('src-whip-0')?.state).toBe('connected');

    const evts = ingestBroadcasts();
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ sourceId: 'src-whip-0', state: 'connected' });
    expect(typeof evts[0]!.changedAt).toBe('string');
  });
});

describe('WHIP teardown marks the mapped source disconnected', () => {
  it('sets disconnected and broadcasts SOURCE_INGEST_STATE on DELETE', async () => {
    // Pre-connected, so the DELETE is a real transition.
    setWhipIngestState('src-whip-0', 'connected');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/productions/prod-ingest-1/whip/video_in_0',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(getWhipIngestState('src-whip-0')?.state).toBe('disconnected');

    const evts = ingestBroadcasts();
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ sourceId: 'src-whip-0', state: 'disconnected' });
  });
});

// ---------------------------------------------------------------------------
// Read-only REST field — must not overwrite `status`
// ---------------------------------------------------------------------------

describe('read-only liveIngest field on source responses', () => {
  it('exposes liveIngest without touching the client-writable status field', async () => {
    setWhipIngestState('src-whip-0', 'connected');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sources/src-whip-0',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // status is the stored client-writable value, unchanged by live ingest.
    expect(body.status).toBe('active');
    expect(body.liveIngest).toMatchObject({ state: 'connected' });
    expect(typeof (body.liveIngest as Record<string, unknown>).changedAt).toBe('string');
  });

  it('omits liveIngest entirely when no ingest has been observed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sources/src-whip-0',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.status).toBe('active');
    expect(body.liveIngest).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WS connect snapshot — replays current ingest states
// ---------------------------------------------------------------------------

describe('WS connect snapshot includes SOURCE_INGEST_STATE', () => {
  async function connectAndCollect(productionId: string, timeoutMs = 400): Promise<Array<Record<string, unknown>>> {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`, [
      'openlive.bearer',
      `openlive.bearer.${TEST_API_KEY}`,
    ]);
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

  it('replays the current per-source ingest state on connect', async () => {
    setWhipIngestState('src-whip-0', 'connected');
    const messages = await connectAndCollect('prod-ingest-1');
    const snap = messages.find((m) => m.type === 'SOURCE_INGEST_STATE');
    expect(snap).toBeDefined();
    expect(snap!.sourceId).toBe('src-whip-0');
    expect(snap!.state).toBe('connected');
    expect(typeof snap!.changedAt).toBe('string');
  });
});
