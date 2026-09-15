/**
 * Tests the WS connect snapshot for the production lifecycle event (issue #255,
 * spec §3): a client attaching to /ws/productions/:id/controller receives one
 * PRODUCTION_STATUS with the current status + per-output health, so a
 * single-source downstream consumer learns the state immediately without a REST
 * round-trip.
 *
 * Uses the REAL controller plugin against a listening Fastify server with a live
 * `ws` client — the connect handler lives in the plugin, not handleMessage, so
 * it can only be exercised over an actual socket. CouchDB and Strom are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const mockGet = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getOutputsDb: () => ({ get: mockGet, find: vi.fn().mockResolvedValue({ docs: [] }) }),
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

// Mock StromClient so the connect handler's audio-sync branch (reached when the
// doc has a stromFlowId) never makes a real network call. It runs after the
// PRODUCTION_STATUS snapshot is sent, so it does not affect these assertions.
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

import { buildServer } from '../server.js';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-ws-1',
    _rev: '1-abc',
    type: 'production',
    name: 'WS Test',
    status: 'inactive',
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await app.close();
});

describe('WS connect snapshot — PRODUCTION_STATUS (spec §3)', () => {
  it('emits PRODUCTION_STATUS with ended status + down outputs for a stopped production', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      status: 'ended',
      outputAssignments: [{ outputId: 'out-1' }, { outputId: 'out-2' }],
    }));

    const messages = await connectAndCollect('prod-ws-1');
    const evt = messages.find((m) => m.type === 'PRODUCTION_STATUS');

    expect(evt).toBeDefined();
    expect(evt!.productionId).toBe('prod-ws-1');
    expect(evt!.status).toBe('ended');
    expect(typeof evt!.ts).toBe('string');
    expect(evt!.outputs).toEqual([
      { id: 'out-1', status: 'down' },
      { id: 'out-2', status: 'down' },
    ]);
  });

  it('emits healthy outputs for an active production with a live flow', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      status: 'active',
      stromFlowId: 'flow-abc',
      // no mixerBlockId → connect handler skips the audio-sync Strom calls
      outputAssignments: [{ outputId: 'out-1' }],
    }));

    const messages = await connectAndCollect('prod-ws-1');
    const evt = messages.find((m) => m.type === 'PRODUCTION_STATUS');

    expect(evt).toBeDefined();
    expect(evt!.status).toBe('active');
    expect(evt!.outputs).toEqual([{ id: 'out-1', status: 'healthy' }]);
  });
});
