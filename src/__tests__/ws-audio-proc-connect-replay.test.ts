/**
 * Issue #527 (OL-25) acceptance #6: a client that connects after processing
 * changes were made receives the current non-default AUDIO_PROC_STATE for every
 * set stage without sending anything.
 *
 * Drives the REAL controller plugin over a live socket (the connect handler
 * lives in the plugin, not handleMessage), like
 * `ws-production-status-snapshot.test.ts`. CouchDB, Strom and the meter relay
 * are mocked.
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

vi.mock('../services/meter-relay.js', () => ({
  startMeterRelay: vi.fn(),
  stopMeterRelay: vi.fn(),
  reconcileMeterRelay: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = {
      get: vi.fn().mockResolvedValue({
        flow: { id: 'flow-abc', blocks: [{ id: 'mixer-1', block_definition_id: 'builtin.mixer', properties: { num_channels: 2 } }] },
      }),
      getBlockProperties: vi.fn().mockResolvedValue({ properties: {}, rejected: {} }),
      updateBlockProperties: vi.fn().mockResolvedValue({ properties: {}, rejected: {} }),
    };
    mixer = { getState: vi.fn().mockResolvedValue({}) };
  }
  return { ...actual, StromClient: MockStromClient };
});

import { buildServer } from '../server.js';

let app: FastifyInstance;

async function connectAndCollect(productionId: string, timeoutMs = 500): Promise<Array<Record<string, unknown>>> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`);
  const messages: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ } });
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

describe('WS connect replay — AUDIO_PROC_STATE (#527, acceptance #6)', () => {
  it('replays every stored processing stage, completed with defaults', async () => {
    mockGet.mockResolvedValue({
      _id: 'prod-proc-replay',
      _rev: '1-abc',
      type: 'production',
      name: 'Proc Replay',
      status: 'active',
      stromFlowId: 'flow-abc',
      audioMixerBlockId: 'mixer-1',
      sources: [],
      pipeline: { stromConfig: null, status: 'running' },
      graphics: [],
      macros: [],
      tally: { pgm: null, pvw: null },
      audioProcessing: {
        ch1: { comp: { enabled: true, threshold: -24 } },
        main: { limiter: { enabled: true, threshold: -6 } },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const messages = await connectAndCollect('prod-proc-replay');
    const proc = messages.filter((m) => m.type === 'AUDIO_PROC_STATE');

    const ch1Comp = proc.find((m) => m.elementId === 'ch1' && m.stage === 'comp');
    expect(ch1Comp).toBeDefined();
    // default-completed: ratio 4 etc. present alongside the set threshold
    expect(ch1Comp!.params).toMatchObject({ enabled: true, threshold: -24, ratio: 4, makeup: 0 });

    const mainLimiter = proc.find((m) => m.elementId === 'main' && m.stage === 'limiter');
    expect(mainLimiter).toBeDefined();
    expect(mainLimiter!.params).toEqual({ enabled: true, threshold: -6 });
  });

  it('replays nothing for a production that never set any processing', async () => {
    mockGet.mockResolvedValue({
      _id: 'prod-proc-none',
      _rev: '1-abc',
      type: 'production',
      name: 'No Proc',
      status: 'active',
      stromFlowId: 'flow-abc',
      audioMixerBlockId: 'mixer-1',
      sources: [],
      pipeline: { stromConfig: null, status: 'running' },
      graphics: [],
      macros: [],
      tally: { pgm: null, pvw: null },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const messages = await connectAndCollect('prod-proc-none');
    expect(messages.filter((m) => m.type === 'AUDIO_PROC_STATE')).toHaveLength(0);
  });
});
