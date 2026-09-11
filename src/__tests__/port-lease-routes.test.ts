/**
 * Route tests for the SRT port lease: /api/v1/server-info exposes the leased
 * range, /api/v1/sources and /api/v1/outputs reject listener ports outside it or
 * held by another document, and assign one when asked with port 0.
 *
 * CouchDB, Strom client, and the WS controller are mocked — no real services
 * required. The lease state is set directly through the service's test hook.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PortLease } from '../lib/strom.js';
import type { OutputDoc, SourceDoc } from '../db/types.js';

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

const mockSourcesGet = vi.fn();
const mockSourcesInsert = vi.fn();
const mockSourcesFind = vi.fn();
const mockSourcesDestroy = vi.fn();
const mockOutputsGet = vi.fn();
const mockOutputsInsert = vi.fn();
const mockOutputsFind = vi.fn();
const mockOutputsDestroy = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  getSourcesDb: () => ({ get: mockSourcesGet, insert: mockSourcesInsert, find: mockSourcesFind, destroy: mockSourcesDestroy }),
  getOutputsDb: () => ({ get: mockOutputsGet, insert: mockOutputsInsert, find: mockOutputsFind, destroy: mockOutputsDestroy }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Mock WebSocket controller (avoids startup side effects)
// ---------------------------------------------------------------------------

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock StromClient / flow-generator (imported transitively via routes)
// ---------------------------------------------------------------------------

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn(), iceServers: vi.fn() };
    flows = {
      get: vi.fn(),
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    mixer = { multiviewEndpoint: vi.fn() };
    portLeases = { acquire: vi.fn(), renew: vi.fn(), release: vi.fn(), list: vi.fn(), get: vi.fn() };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const LEASE: PortLease = {
  id: 'lease-1',
  client_id: 'open-live-test',
  first_port: 47100,
  last_port: 47119,
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:10:00Z',
};

const EXISTING_SOURCE: SourceDoc = {
  _id: 'src-1',
  _rev: '1-abc',
  type: 'source',
  name: 'Camera 1',
  address: 'srt://:47105?mode=listener',
  streamType: 'srt',
  status: 'inactive',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const EXISTING_OUTPUT: OutputDoc = {
  _id: 'output-1',
  _rev: '1-abc',
  type: 'output',
  name: 'Program',
  outputType: 'mpegtssrt',
  url: 'srt://:47118?mode=listener',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let app: FastifyInstance;
let _resetPortLeaseState: typeof import('../services/port-lease.js')._resetPortLeaseState;

beforeAll(async () => {
  ({ _resetPortLeaseState } = await import('../services/port-lease.js'));
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  mockSourcesGet.mockReset();
  mockSourcesInsert.mockReset();
  mockSourcesInsert.mockResolvedValue({ ok: true, rev: '1-new' });
  mockSourcesGet.mockResolvedValue(EXISTING_SOURCE);
  mockSourcesFind.mockReset();
  mockSourcesFind.mockResolvedValue({ docs: [EXISTING_SOURCE] });
  mockSourcesDestroy.mockReset();
  mockOutputsGet.mockReset();
  mockOutputsInsert.mockReset();
  mockOutputsInsert.mockResolvedValue({ ok: true, rev: '1-new' });
  mockOutputsGet.mockResolvedValue(EXISTING_OUTPUT);
  mockOutputsFind.mockReset();
  mockOutputsFind.mockResolvedValue({ docs: [EXISTING_OUTPUT] });
  mockOutputsDestroy.mockReset();
});

describe('GET /api/v1/server-info', () => {
  it('reports the leased range', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await app.inject({ method: 'GET', url: '/api/v1/server-info' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      stromHost: 'localhost',
      srtPortRange: { first: 47100, last: 47119 },
      srtPortLease: 'leased',
    });
  });

  it.each(['pending', 'unsupported', 'disabled'] as const)('reports %s with a null range', async (status) => {
    _resetPortLeaseState({ status });
    const res = await app.inject({ method: 'GET', url: '/api/v1/server-info' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stromHost: 'localhost', srtPortRange: null, srtPortLease: status });
  });
});

describe('POST /api/v1/sources port lease enforcement', () => {
  const post = (address: string, streamType = 'srt') =>
    app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', address, streamType } });

  it('accepts an in-range listener port', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://:47110?mode=listener');
    expect(res.statusCode).toBe(201);
    expect(mockSourcesInsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an out-of-range listener port with 422 naming the range', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://:9000?mode=listener');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('47100-47119');
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it('applies the same check to efp sources', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://:9000?mode=listener', 'efp');
    expect(res.statusCode).toBe(422);
  });

  it('rejects listener sources with 503 while the lease is pending', async () => {
    _resetPortLeaseState({ status: 'pending' });
    const res = await post('srt://:47110?mode=listener');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'SRT port range not yet allocated from Strom, retry shortly' });
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it('does not check caller-form addresses', async () => {
    _resetPortLeaseState({ status: 'pending' });
    const res = await post('srt://ingest.example.com:9000?mode=caller');
    expect(res.statusCode).toBe(201);
  });

  it.each(['unsupported', 'disabled'] as const)('does not check when the lease is %s', async (status) => {
    _resetPortLeaseState({ status });
    const res = await post('srt://:9000?mode=listener');
    expect(res.statusCode).toBe(201);
  });

  it('still runs the SRT URL validation before the lease check', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://127.0.0.1:47110?mode=caller');
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v1/sources port assignment', () => {
  const post = (address: string) =>
    app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', address, streamType: 'srt' } });

  it('assigns the lowest free port in the range for port 0', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    // 47105 is held by the existing source, 47118 by the existing output.
    const res = await post('srt://:0?mode=listener&latency=200');
    expect(res.statusCode).toBe(201);
    expect(res.json().address).toBe('srt://:47100?mode=listener&latency=200');
  });

  it('skips ports held by other sources and outputs', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    mockSourcesFind.mockResolvedValue({ docs: [
      { ...EXISTING_SOURCE, _id: 's1', address: 'srt://:47100?mode=listener' },
      { ...EXISTING_SOURCE, _id: 's2', address: 'srt://:47101?mode=listener' },
    ] });
    mockOutputsFind.mockResolvedValue({ docs: [{ ...EXISTING_OUTPUT, url: 'srt://:47102?mode=listener' }] });
    const res = await post('srt://:0?mode=listener');
    expect(res.statusCode).toBe(201);
    expect(res.json().address).toBe('srt://:47103?mode=listener');
  });

  it('rejects an explicit port another source holds with 409 naming it', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://:47105?mode=listener');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Camera 1');
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it('rejects an explicit port an output holds even without a lease', async () => {
    _resetPortLeaseState({ status: 'unsupported' });
    const res = await post('srt://:47118?mode=listener');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Program');
  });

  it('answers 409 when the range is full', async () => {
    _resetPortLeaseState({ status: 'leased', lease: { ...LEASE, first_port: 47100, last_port: 47101 } });
    mockSourcesFind.mockResolvedValue({ docs: [
      { ...EXISTING_SOURCE, _id: 's1', address: 'srt://:47100?mode=listener' },
      { ...EXISTING_SOURCE, _id: 's2', address: 'srt://:47101?mode=listener' },
    ] });
    mockOutputsFind.mockResolvedValue({ docs: [] });
    const res = await post('srt://:0?mode=listener');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('No free SRT listener port');
  });

  it('cannot assign without a range and says so', async () => {
    _resetPortLeaseState({ status: 'unsupported' });
    const res = await post('srt://:0?mode=listener');
    expect(res.statusCode).toBe(400);
  });

  it('retries with another port when the assigned one was taken meanwhile', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    mockSourcesFind
      .mockResolvedValueOnce({ docs: [] })                                                        // before the write: all free
      .mockResolvedValueOnce({ docs: [{ ...EXISTING_SOURCE, _id: 'racer', name: 'Racer', address: 'srt://:47100?mode=listener' }] }) // after: someone took 47100
      .mockResolvedValue({ docs: [{ ...EXISTING_SOURCE, _id: 'racer', name: 'Racer', address: 'srt://:47100?mode=listener' }] });
    mockOutputsFind.mockResolvedValue({ docs: [] });
    const res = await post('srt://:0?mode=listener');
    expect(res.statusCode).toBe(201);
    expect(res.json().address).toBe('srt://:47101?mode=listener');
    expect(mockSourcesDestroy).toHaveBeenCalledTimes(1);
    expect(mockSourcesInsert).toHaveBeenCalledTimes(2);
  });
});

describe('PATCH /api/v1/sources/:id port lease enforcement', () => {
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/v1/sources/src-1', payload });

  it('rejects a new out-of-range listener address with 422', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await patch({ address: 'srt://:9000?mode=listener' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('47100-47119');
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it('accepts a new in-range listener address', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await patch({ address: 'srt://:47111?mode=listener' });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe('srt://:47111?mode=listener');
  });

  it('returns 503 for a listener address while the lease is pending', async () => {
    _resetPortLeaseState({ status: 'pending' });
    const res = await patch({ address: 'srt://:47111?mode=listener' });
    expect(res.statusCode).toBe(503);
  });

  it('does not re-check the stored address on a rename', async () => {
    _resetPortLeaseState({ status: 'pending' });
    const res = await patch({ name: 'Camera 1 (renamed)' });
    expect(res.statusCode).toBe(200);
    expect(mockSourcesInsert).toHaveBeenCalledTimes(1);
  });

  it('keeps the current port when patched with port 0', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await patch({ address: 'srt://:0?mode=listener&latency=300' });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe('srt://:47105?mode=listener&latency=300');
  });

  it('rejects a move onto a port another document holds', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await patch({ address: 'srt://:47118?mode=listener' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Program');
  });

  it('re-checks the stored address when the stream type changes to srt', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    mockSourcesGet.mockResolvedValue({ ...EXISTING_SOURCE, streamType: 'efp', address: 'srt://:9000?mode=listener' });
    const res = await patch({ streamType: 'srt' });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /api/v1/outputs port lease enforcement', () => {
  const post = (url: string, outputType = 'mpegtssrt') =>
    app.inject({ method: 'POST', url: '/api/v1/outputs', payload: { name: 'Program', url, outputType } });

  it('accepts an in-range listener port', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://:47119?mode=listener');
    expect(res.statusCode).toBe(201);
    expect(mockOutputsInsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an out-of-range listener port with 422 naming the range', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://:43524?mode=listener');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('47100-47119');
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it('applies the same check to efpsrt outputs', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://:43524?mode=listener', 'efpsrt');
    expect(res.statusCode).toBe(422);
  });

  it('rejects listener outputs with 503 while the lease is pending', async () => {
    _resetPortLeaseState({ status: 'pending' });
    const res = await post('srt://:47119?mode=listener');
    expect(res.statusCode).toBe(503);
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it('does not check caller-form URLs', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://cdn.example.com:9000?mode=caller');
    expect(res.statusCode).toBe(201);
  });

  it('assigns a port for port 0, skipping the ports sources hold', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    mockSourcesFind.mockResolvedValue({ docs: [{ ...EXISTING_SOURCE, address: 'srt://:47100?mode=listener' }] });
    mockOutputsFind.mockResolvedValue({ docs: [] });
    const res = await post('srt://:0?mode=listener');
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toBe('srt://:47101?mode=listener');
  });

  it('rejects an explicit port a source holds with 409', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await post('srt://:47105?mode=listener');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Camera 1');
  });

  it('does not check WHEP outputs', async () => {
    _resetPortLeaseState({ status: 'pending' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/outputs', payload: { name: 'Web', outputType: 'whep' } });
    expect(res.statusCode).toBe(201);
  });
});

describe('PATCH /api/v1/outputs/:id port lease enforcement', () => {
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-1', payload });

  it('rejects a new out-of-range listener URL with 422', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await patch({ url: 'srt://:9000?mode=listener' });
    expect(res.statusCode).toBe(422);
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it('accepts a new in-range listener URL', async () => {
    _resetPortLeaseState({ status: 'leased', lease: LEASE });
    const res = await patch({ url: 'srt://:47110?mode=listener' });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe('srt://:47110?mode=listener');
  });

  it('returns 503 for a listener URL while the lease is pending', async () => {
    _resetPortLeaseState({ status: 'pending' });
    const res = await patch({ url: 'srt://:47110?mode=listener' });
    expect(res.statusCode).toBe(503);
  });

  it('does not re-check the stored URL on a rename', async () => {
    _resetPortLeaseState({ status: 'pending' });
    const res = await patch({ name: 'Program (renamed)' });
    expect(res.statusCode).toBe(200);
    expect(mockOutputsInsert).toHaveBeenCalledTimes(1);
  });
});
