/**
 * Route tests for SRT relay addresses (`srt+relay://<id>`) on sources and
 * outputs, and `srtRelay` on /api/v1/server-info.
 *
 * - `srt+relay://auto` gets a generated id once; a later `auto` patch keeps it.
 * - Relay addresses take no part in listener-port reservation.
 * - The API carries a `connect` dial-in address built from Strom's relay
 *   public address, never the passphrase.
 *
 * CouchDB, Strom client and the WS controller are mocked.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OutputDoc, SourceDoc } from '../db/types.js';

const mockSourcesGet = vi.fn();
const mockSourcesInsert = vi.fn();
const mockSourcesFind = vi.fn();
const mockOutputsGet = vi.fn();
const mockOutputsInsert = vi.fn();
const mockOutputsFind = vi.fn();
const mockSrtRelay = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }), findTrusted: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockSourcesGet, insert: mockSourcesInsert, find: mockSourcesFind, destroy: vi.fn() }),
  getOutputsDb: () => ({ get: mockOutputsGet, insert: mockOutputsInsert, find: mockOutputsFind, destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn(), iceServers: vi.fn(), srtRelay: mockSrtRelay };
    flows = { get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    mixer = { multiviewEndpoint: vi.fn() };
    ports = { pool: vi.fn(), reservations: { create: vi.fn(), renew: vi.fn(), release: vi.fn(), list: vi.fn(), get: vi.fn(), assign: vi.fn(), unassign: vi.fn() } };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const SECRET = 'supersecretpass';
const RELAY = { configured: true, relay: 'srt-splice:9000', public: 'relay.example.com:9000', error: null };
const ID_RE = /^srt\+relay:\/\/([A-Za-z0-9_-]{22})(\?|$)/;
const originalEnv = { ...process.env };

let app: FastifyInstance;
let resetSrtRelayStatusCache: () => void;
let resetKeyCache: () => void;
let _resetPortReservationState: typeof import('../services/port-reservation.js')._resetPortReservationState;

beforeAll(async () => {
  process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
  delete process.env['NODE_ENV'];
  ({ resetKeyCache } = await import('../lib/srt-passphrase-crypto.js'));
  resetKeyCache();
  ({ resetSrtRelayStatusCache } = await import('../services/srt-relay-status.js'));
  ({ _resetPortReservationState } = await import('../services/port-reservation.js'));
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
  process.env = { ...originalEnv };
  resetKeyCache();
});

beforeEach(() => {
  resetSrtRelayStatusCache();
  // Pending reservation: any listener-port address would be refused with 503,
  // so a 201 for a relay address proves it skipped the port logic entirely.
  _resetPortReservationState({ status: 'pending' });
  mockSrtRelay.mockReset();
  mockSrtRelay.mockResolvedValue(RELAY);
  for (const m of [mockSourcesGet, mockSourcesInsert, mockSourcesFind, mockOutputsGet, mockOutputsInsert, mockOutputsFind]) m.mockReset();
  mockSourcesInsert.mockResolvedValue({ ok: true, rev: '1-new' });
  mockOutputsInsert.mockResolvedValue({ ok: true, rev: '1-new' });
  mockSourcesFind.mockResolvedValue({ docs: [] });
  mockOutputsFind.mockResolvedValue({ docs: [] });
});

function source(address: string, streamType: SourceDoc['streamType'] = 'srt'): SourceDoc {
  return {
    _id: 'src-relay', _rev: '1-abc', type: 'source', name: 'Cam', address, streamType, status: 'inactive',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function output(url: string): OutputDoc {
  return {
    _id: 'output-relay', _rev: '1-abc', type: 'output', name: 'Program', outputType: 'mpegtssrt', url,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('GET /api/v1/server-info — srtRelay', () => {
  it('reports a configured relay and its public address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/server-info' });
    expect(res.statusCode).toBe(200);
    expect(res.json().srtRelay).toEqual({ configured: true, public: 'relay.example.com:9000' });
  });

  it('reports not configured on a Strom without relay support (404)', async () => {
    const { StromClientError } = await import('../lib/strom.js');
    mockSrtRelay.mockRejectedValue(new StromClientError(404, 'Not Found'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/server-info' });
    expect(res.json().srtRelay).toEqual({ configured: false, public: null });
  });
});

describe('sources with a relay address', () => {
  it('POST auto generates an id, stores it with the passphrase encrypted, and binds no port', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      payload: { name: 'Cam', streamType: 'srt', address: `srt+relay://auto?passphrase=${SECRET}&latency=200` },
    });
    expect(res.statusCode).toBe(201);
    const stored = mockSourcesInsert.mock.calls[0]![0] as SourceDoc;
    const id = ID_RE.exec(stored.address)![1]!;
    expect(stored.address).toMatch(/passphrase=encv1:/);
    expect(stored.address).not.toContain(SECRET);
    // No listener-port bookkeeping at all.
    expect(mockSourcesFind).not.toHaveBeenCalled();
    expect(mockOutputsFind).not.toHaveBeenCalled();

    const body = res.json();
    expect(body.address).toBe(`srt+relay://${id}?passphrase=***&latency=200`);
    expect(body.connect).toEqual({
      uri: `srt://relay.example.com:9000?streamid=${id}`,
      host: 'relay.example.com',
      port: 9000,
      mode: 'caller',
      source: 'srt-relay',
      streamid: id,
    });
    expect(res.body).not.toContain(SECRET);
  });

  it('two auto creates get different ids', async () => {
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', streamType: 'srt', address: 'srt+relay://auto' } });
    }
    const [a, b] = mockSourcesInsert.mock.calls.map((c) => ID_RE.exec((c[0] as SourceDoc).address)![1]);
    expect(a).not.toBe(b);
  });

  it('PATCH with auto keeps the stored relay id and takes the new passphrase', async () => {
    mockSourcesGet.mockResolvedValue(source('srt+relay://sticky-id?latency=200'));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/sources/src-relay',
      payload: { address: `srt+relay://auto?passphrase=${SECRET}` },
    });
    expect(res.statusCode).toBe(200);
    const stored = mockSourcesInsert.mock.calls[0]![0] as SourceDoc;
    expect(stored.address).toMatch(/^srt\+relay:\/\/sticky-id\?passphrase=encv1:/);
    expect(res.json().connect.uri).toBe('srt://relay.example.com:9000?streamid=sticky-id');
  });

  it('PATCH from a listener address to auto generates an id without touching ports', async () => {
    mockSourcesGet.mockResolvedValue(source('srt://:47105?mode=listener'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { address: 'srt+relay://auto' } });
    expect(res.statusCode).toBe(200);
    expect((mockSourcesInsert.mock.calls[0]![0] as SourceDoc).address).toMatch(ID_RE);
    expect(mockSourcesFind).not.toHaveBeenCalled();
  });

  it('a rename keeps the relay address as stored', async () => {
    mockSourcesGet.mockResolvedValue(source('srt+relay://sticky-id'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { name: 'Renamed' } });
    expect(res.statusCode).toBe(200);
    expect((mockSourcesInsert.mock.calls[0]![0] as SourceDoc).address).toBe('srt+relay://sticky-id');
  });

  it('rejects mode/streamid on a relay address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      payload: { name: 'Cam', streamType: 'srt', address: 'srt+relay://auto?streamid=x' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it('GET lists connect for relay sources (relay public) and plain SRT sources (Strom host)', async () => {
    mockSourcesFind.mockResolvedValue({ docs: [source('srt+relay://cam1'), { ...source('srt://:47105?mode=listener'), _id: 'src-2' }] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources' });
    const [relay, plain] = res.json();
    expect(relay.connect.uri).toBe('srt://relay.example.com:9000?streamid=cam1');
    expect(plain.connect).toMatchObject({ port: 47105, mode: 'caller' });
    expect(plain.connect.source).not.toBe('srt-relay');
  });

  it('GET reports a null dial-in with a reason when Strom has no relay', async () => {
    mockSrtRelay.mockResolvedValue({ configured: false, relay: null, public: null, error: null });
    mockSourcesGet.mockResolvedValue(source('srt+relay://cam1'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources/src-relay' });
    expect(res.json().connect).toMatchObject({ uri: null, source: 'srt-relay', streamid: 'cam1', reason: 'srt-relay-not-configured' });
  });

  it('listing plain SRT sources never asks Strom about the relay', async () => {
    mockSourcesFind.mockResolvedValue({ docs: [source('srt://:47105?mode=listener')] });
    await app.inject({ method: 'GET', url: '/api/v1/sources' });
    expect(mockSrtRelay).not.toHaveBeenCalled();
  });
});

describe('outputs with a relay address', () => {
  it('POST auto generates an id, encrypts the passphrase, binds no port, and exposes connect', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'Program', outputType: 'efpsrt', url: `srt+relay://auto?passphrase=${SECRET}` },
    });
    expect(res.statusCode).toBe(201);
    const stored = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    const id = ID_RE.exec(stored.url!)![1]!;
    expect(stored.url).toMatch(/passphrase=encv1:/);
    expect(mockSourcesFind).not.toHaveBeenCalled();
    expect(mockOutputsFind).not.toHaveBeenCalled();
    expect(res.json().url).toBe(`srt+relay://${id}?passphrase=***`);
    expect(res.json().connect).toMatchObject({ uri: `srt://relay.example.com:9000?streamid=${id}`, source: 'srt-relay', mode: 'caller' });
    expect(res.body).not.toContain(SECRET);
  });

  it('PATCH with auto keeps the stored relay id', async () => {
    mockOutputsGet.mockResolvedValue(output('srt+relay://out-sticky'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-relay', payload: { url: 'srt+relay://auto?latency=300' } });
    expect(res.statusCode).toBe(200);
    expect((mockOutputsInsert.mock.calls[0]![0] as OutputDoc).url).toBe('srt+relay://out-sticky?latency=300');
    expect(res.json().connect.streamid).toBe('out-sticky');
  });

  it('PATCH with an invalid relay address is a 400', async () => {
    mockOutputsGet.mockResolvedValue(output('srt+relay://out-sticky'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-relay', payload: { url: 'srt+relay://auto?mode=caller' } });
    expect(res.statusCode).toBe(400);
  });

  it('GET reports a null dial-in when the relay public address is unknown', async () => {
    mockSrtRelay.mockResolvedValue({ configured: true, relay: 'srt-splice:9000', public: null, error: null });
    mockOutputsGet.mockResolvedValue(output('srt+relay://out-sticky'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs/output-relay' });
    expect(res.json().connect).toMatchObject({ uri: null, reason: 'srt-relay-public-unknown' });
  });
});
