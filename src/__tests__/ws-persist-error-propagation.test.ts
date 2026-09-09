/**
 * Regression tests for issue #203 — "persistMixerMutation swallows non-conflict
 * errors that used to propagate, after #175".
 *
 * #175 routed mixer writes through persistMixerMutation, whose catch block
 * consulted isConflictError only to decide whether to retry. After the retry
 * loop fell through, EVERY error — 409 conflicts AND non-conflict errors (500s,
 * socket resets, not_found from db.get) — was logged at warn and swallowed.
 * Before #175 non-conflict errors propagated to the socket handler's catch-all.
 *
 * Fix: re-check the error class after the loop. Exhausted 409s stay swallowed
 * (the accepted decision); non-conflict errors are re-thrown so they propagate
 * out of handleMessage exactly as before #175.
 *
 * These tests drive a real inbound CUT through handleMessage (the harness from
 * ws-macro-pip.test.ts) and assert on whether the returned promise rejects.
 * CouchDB is mocked via vi.mock('../db/index.js').
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Mock the CouchDB layer. mockGet always succeeds; mockInsert is the seam we
// drive to reject with either a 409 conflict or a non-conflict error.
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockInsert = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

// Keep the real tally state machine but drop broadcasts on the floor.
vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: () => {},
  };
});

// ---------------------------------------------------------------------------
// A throwaway Strom the real StromClient can talk to, so the CUT reaches
// persistMixerMutation without the transition call itself failing.
// ---------------------------------------------------------------------------

const stromServer: Server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
});

await new Promise<void>((resolve) => {
  stromServer.listen(0, '127.0.0.1', () => resolve());
});
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;

afterAll(() => {
  stromServer.close();
});

const { handleMessage, clearPipState } = await import('../ws/controller.js');
const { setTally } = await import('../services/tally.service.js');

const PROD = 'prod-203';

function makeProductionDoc() {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Err Prop Test',
    status: 'active',
    stromFlowId: 'flow-1',
    mixerBlockId: 'mixer-1',
    sources: [
      { sourceId: 'cam1', mixerInput: 'video_in_0' },
      { sourceId: 'cam2', mixerInput: 'video_in_1' },
    ],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: 'video_in_0', pvw: 'video_in_1' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;

function conflictError(): Error & { statusCode: number } {
  const err = new Error('Document update conflict') as Error & { statusCode: number };
  err.statusCode = 409;
  return err;
}

function serverError(): Error & { statusCode: number } {
  const err = new Error('Internal Server Error') as Error & { statusCode: number };
  err.statusCode = 500;
  return err;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearPipState(PROD);
  setTally(PROD, { pgm: 'video_in_0', pvw: 'video_in_1' });
  mockGet.mockReset();
  mockGet.mockResolvedValue(makeProductionDoc());
  mockInsert.mockReset();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('persistMixerMutation error propagation (issue #203)', () => {
  it('propagates a non-conflict error (500) out of handleMessage', async () => {
    mockInsert.mockRejectedValue(serverError());

    await expect(
      handleMessage(PROD, ws, JSON.stringify({ type: 'CUT', mixerInput: 'video_in_1' }), {}),
    ).rejects.toThrow('Internal Server Error');

    // Retries are conflict-only, so a non-conflict error fails on the first attempt.
    expect(mockInsert).toHaveBeenCalledTimes(1);
    // A non-conflict error must not be swallowed at warn.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('swallows an exhausted 409 conflict (the accepted decision) without throwing', async () => {
    mockInsert.mockRejectedValue(conflictError());

    await expect(
      handleMessage(PROD, ws, JSON.stringify({ type: 'CUT', mixerInput: 'video_in_1' }), {}),
    ).resolves.toBeUndefined();

    // MAX_DB_WRITE_RETRIES === 3: the write is attempted the full budget.
    expect(mockInsert).toHaveBeenCalledTimes(3);
    // The exhausted conflict is deliberately logged at warn and swallowed.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist mixer mutation'),
      expect.objectContaining({ productionId: PROD, action: 'CUT' }),
      expect.anything(),
    );
  });
});
