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
const mockSourcesDestroy = vi.fn();
const mockOutputsDestroy = vi.fn();
const mockSrtRelay = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }), findTrusted: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockSourcesGet, insert: mockSourcesInsert, find: mockSourcesFind, destroy: mockSourcesDestroy }),
  getOutputsDb: () => ({ get: mockOutputsGet, insert: mockOutputsInsert, find: mockOutputsFind, destroy: mockOutputsDestroy }),
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
  for (const m of [mockSourcesGet, mockSourcesInsert, mockSourcesFind, mockSourcesDestroy, mockOutputsGet, mockOutputsInsert, mockOutputsFind, mockOutputsDestroy]) m.mockReset();
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
    expect(res.json().srtRelay).toEqual({ configured: true, public: 'relay.example.com:9000', state: 'ok' });
  });

  it('reports not configured on a Strom without relay support (404)', async () => {
    const { StromClientError } = await import('../lib/strom.js');
    mockSrtRelay.mockRejectedValue(new StromClientError(404, 'Not Found'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/server-info' });
    expect(res.json().srtRelay).toEqual({ configured: false, public: null, state: 'ok' });
  });

  it('reports Strom unreachable as such, not as "not configured"', async () => {
    const { StromClientError } = await import('../lib/strom.js');
    mockSrtRelay.mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/server-info' });
    expect(res.json().srtRelay).toEqual({ configured: false, public: null, state: 'unreachable' });
  });

  it('serves the cached answer without waiting on a slow Strom', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/server-info' });
    mockSrtRelay.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60_000); // the cached answer is stale now
      const res = await app.inject({ method: 'GET', url: '/api/v1/server-info' });
      expect(res.json().srtRelay).toEqual({ configured: true, public: 'relay.example.com:9000', state: 'ok' });
    } finally {
      vi.useRealTimers();
    }
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
    // No listener-port bookkeeping: the reservation is pending, which would
    // refuse any listener address with 503.

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
    mockSourcesGet.mockResolvedValue(source('srt+relay://sticky-id-0123456789?latency=200'));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/sources/src-relay',
      payload: { address: `srt+relay://auto?passphrase=${SECRET}` },
    });
    expect(res.statusCode).toBe(200);
    const stored = mockSourcesInsert.mock.calls[0]![0] as SourceDoc;
    expect(stored.address).toMatch(/^srt\+relay:\/\/sticky-id-0123456789\?passphrase=encv1:/);
    expect(res.json().connect.uri).toBe('srt://relay.example.com:9000?streamid=sticky-id-0123456789');
  });

  it('PATCH from a listener address to auto generates an id without touching ports', async () => {
    mockSourcesGet.mockResolvedValue(source('srt://:47105?mode=listener'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { address: 'srt+relay://auto' } });
    expect(res.statusCode).toBe(200);
    expect((mockSourcesInsert.mock.calls[0]![0] as SourceDoc).address).toMatch(ID_RE);
  });

  it('a rename keeps the relay address as stored', async () => {
    mockSourcesGet.mockResolvedValue(source('srt+relay://sticky-id-0123456789'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { name: 'Renamed' } });
    expect(res.statusCode).toBe(200);
    expect((mockSourcesInsert.mock.calls[0]![0] as SourceDoc).address).toBe('srt+relay://sticky-id-0123456789');
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
    expect(res.json().url).toBe(`srt+relay://${id}?passphrase=***`);
    expect(res.json().connect).toMatchObject({ uri: `srt://relay.example.com:9000?streamid=${id}`, source: 'srt-relay', mode: 'caller' });
    expect(res.body).not.toContain(SECRET);
  });

  it('PATCH with auto keeps the stored relay id', async () => {
    mockOutputsGet.mockResolvedValue(output('srt+relay://out-sticky-0123456789'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-relay', payload: { url: 'srt+relay://auto?latency=300' } });
    expect(res.statusCode).toBe(200);
    expect((mockOutputsInsert.mock.calls[0]![0] as OutputDoc).url).toBe('srt+relay://out-sticky-0123456789?latency=300');
    expect(res.json().connect.streamid).toBe('out-sticky-0123456789');
  });

  it('PATCH with an invalid relay address is a 400', async () => {
    mockOutputsGet.mockResolvedValue(output('srt+relay://out-sticky-0123456789'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-relay', payload: { url: 'srt+relay://auto?mode=caller' } });
    expect(res.statusCode).toBe(400);
  });

  it('GET reports a null dial-in when the relay public address is unknown', async () => {
    mockSrtRelay.mockResolvedValue({ configured: true, relay: 'srt-splice:9000', public: null, error: null });
    mockOutputsGet.mockResolvedValue(output('srt+relay://out-sticky-0123456789'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs/output-relay' });
    expect(res.json().connect).toMatchObject({ uri: null, reason: 'srt-relay-public-unknown' });
  });
});

describe('relay id uniqueness and explicit ids', () => {
  const LONG = 'explicit-id-0123456789';

  it('accepts an explicit id of 16+ characters as given', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', streamType: 'srt', address: `srt+relay://${LONG}` } });
    expect(res.statusCode).toBe(201);
    expect((mockSourcesInsert.mock.calls[0]![0] as SourceDoc).address).toBe(`srt+relay://${LONG}`);
  });

  it('refuses a short explicit id with 400, saying it is guessable', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/outputs', payload: { name: 'Out', outputType: 'mpegtssrt', url: 'srt+relay://cam1' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/16–64 characters/);
    expect(res.body).toMatch(/guesses the id/);
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it('POST source: 409 when an output already holds the id (shared namespace)', async () => {
    mockOutputsFind.mockResolvedValue({ docs: [{ ...output(`srt+relay://${LONG}`), name: 'Program' }] });
    const res = await app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', streamType: 'srt', address: `srt+relay://${LONG}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SRT relay id is already used by output "Program"; every source and output needs its own relay id');
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it('POST output: 409 when a source already holds the id', async () => {
    mockSourcesFind.mockResolvedValue({ docs: [source(`srt+relay://${LONG}?passphrase=encv1:AAAA`)] });
    const res = await app.inject({ method: 'POST', url: '/api/v1/outputs', payload: { name: 'Out', outputType: 'efpsrt', url: `srt+relay://${LONG}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already used by source "Cam"/);
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it('PATCH source: 409 when another doc holds the new id; its own id does not count', async () => {
    mockSourcesGet.mockResolvedValue(source(`srt+relay://${LONG}`));
    mockSourcesFind.mockResolvedValue({ docs: [source(`srt+relay://${LONG}`)] });
    mockOutputsFind.mockResolvedValue({ docs: [output('srt+relay://taken-by-output-0123')] });
    const own = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { address: 'srt+relay://auto?latency=200' } });
    expect(own.statusCode).toBe(200);
    const taken = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { address: 'srt+relay://taken-by-output-0123' } });
    expect(taken.statusCode).toBe(409);
    expect(mockSourcesInsert).toHaveBeenCalledTimes(1);
  });

  it('PATCH output: 409 when a source holds the new id', async () => {
    mockOutputsGet.mockResolvedValue(output('srt+relay://out-sticky-0123456789'));
    mockSourcesFind.mockResolvedValue({ docs: [source(`srt+relay://${LONG}`)] });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-relay', payload: { url: `srt+relay://${LONG}` } });
    expect(res.statusCode).toBe(409);
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it('post-write re-check: an explicit id taken meanwhile is undone and refused', async () => {
    const rival = { ...output(`srt+relay://${LONG}`), _id: 'output-rival', name: 'Rival' };
    mockOutputsFind.mockResolvedValueOnce({ docs: [] }).mockResolvedValue({ docs: [rival] });
    const res = await app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', streamType: 'srt', address: `srt+relay://${LONG}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/output "Rival"/);
    expect(mockSourcesDestroy).toHaveBeenCalledTimes(1);
  });

  it('post-write re-check: an auto id taken meanwhile is regenerated', async () => {
    // The rival "takes" whatever id the first attempt wrote.
    let firstId: string | undefined;
    mockOutputsInsert.mockImplementation(async (doc: OutputDoc) => {
      firstId ??= ID_RE.exec(doc.url!)![1];
      return { ok: true, rev: '1-new' };
    });
    mockSourcesFind.mockImplementation(async () => ({
      docs: firstId && mockOutputsInsert.mock.calls.length === 1 ? [source(`srt+relay://${firstId}`)] : [],
    }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/outputs', payload: { name: 'Out', outputType: 'mpegtssrt', url: 'srt+relay://auto' } });
    expect(res.statusCode).toBe(201);
    expect(mockOutputsDestroy).toHaveBeenCalledTimes(1);
    expect(mockOutputsInsert).toHaveBeenCalledTimes(2);
    const secondId = ID_RE.exec((mockOutputsInsert.mock.calls[1]![0] as OutputDoc).url!)![1];
    expect(secondId).not.toBe(firstId);
  });
});

describe('PATCH re-checks a relay address whenever the effective address is one', () => {
  const LONG = 'explicit-id-0123456789';

  it('a stream-type-only patch (whip -> srt) still resolves `auto`', async () => {
    mockSourcesGet.mockResolvedValue(source('srt+relay://auto', 'whip'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { streamType: 'srt' } });
    expect(res.statusCode).toBe(200);
    const stored = (mockSourcesInsert.mock.calls[0]![0] as SourceDoc).address;
    expect(stored).toMatch(ID_RE);
    expect(stored).not.toBe('srt+relay://auto');
  });

  it('a stream-type-only patch (whip -> srt) still refuses an id another document holds', async () => {
    mockSourcesGet.mockResolvedValue(source(`srt+relay://${LONG}`, 'whip'));
    mockOutputsFind.mockResolvedValue({ docs: [output(`srt+relay://${LONG}`)] });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { streamType: 'srt' } });
    expect(res.statusCode).toBe(409);
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it('source: an id taken between the check and the write is undone and refused', async () => {
    const original = source('srt+relay://sticky-id-0123456789');
    mockSourcesGet.mockResolvedValue(original);
    const rival = { ...output(`srt+relay://${LONG}`), _id: 'output-rival', name: 'Rival' };
    mockOutputsFind.mockResolvedValueOnce({ docs: [] }).mockResolvedValue({ docs: [rival] });
    mockSourcesInsert.mockResolvedValueOnce({ ok: true, rev: '2-new' }).mockResolvedValue({ ok: true, rev: '3-undo' });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { address: `srt+relay://${LONG}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/output "Rival"/);
    expect(mockSourcesInsert).toHaveBeenCalledTimes(2);
    // The undo writes the document back as it was, on top of our revision.
    expect(mockSourcesInsert.mock.calls[1]![0]).toEqual({ ...original, _rev: '2-new' });
  });

  it('output: an id taken between the check and the write is undone and refused', async () => {
    const original = output('srt+relay://out-sticky-0123456789');
    mockOutputsGet.mockResolvedValue(original);
    const rival = { ...source(`srt+relay://${LONG}`), _id: 'src-rival', name: 'Rival' };
    mockSourcesFind.mockResolvedValueOnce({ docs: [] }).mockResolvedValue({ docs: [rival] });
    mockOutputsInsert.mockResolvedValueOnce({ ok: true, rev: '2-new' }).mockResolvedValue({ ok: true, rev: '3-undo' });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-relay', payload: { url: `srt+relay://${LONG}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/source "Rival"/);
    expect(mockOutputsInsert).toHaveBeenCalledTimes(2);
    expect(mockOutputsInsert.mock.calls[1]![0]).toEqual({ ...original, _rev: '2-new' });
  });
});

describe('relay addresses when Strom has no relay', () => {
  const NONE = { configured: false, relay: null, public: null, error: null };

  it('POST source and output: 422 when Strom positively reports no relay', async () => {
    mockSrtRelay.mockResolvedValue(NONE);
    const src = await app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', streamType: 'srt', address: 'srt+relay://auto' } });
    expect(src.statusCode).toBe(422);
    expect(src.json().error).toMatch(/no SRT relay configured/);
    const out = await app.inject({ method: 'POST', url: '/api/v1/outputs', payload: { name: 'Out', outputType: 'mpegtssrt', url: 'srt+relay://auto' } });
    expect(out.statusCode).toBe(422);
    expect(mockSourcesInsert).not.toHaveBeenCalled();
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it('PATCH to a relay address: 422 when Strom positively reports no relay; a rename still works', async () => {
    mockSrtRelay.mockResolvedValue(NONE);
    mockSourcesGet.mockResolvedValue(source('srt+relay://sticky-id-0123456789'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { address: 'srt+relay://auto' } });
    expect(res.statusCode).toBe(422);
    const rename = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { name: 'Renamed' } });
    expect(rename.statusCode).toBe(200);
    mockOutputsGet.mockResolvedValue(output('srt://:47100?mode=listener'));
    const out = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-relay', payload: { url: 'srt+relay://auto' } });
    expect(out.statusCode).toBe(422);
  });

  it('accepted while Strom is unreachable, with the reason on connect', async () => {
    const { StromClientError } = await import('../lib/strom.js');
    mockSrtRelay.mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    const res = await app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', streamType: 'srt', address: 'srt+relay://auto' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().connect).toMatchObject({ uri: null, source: 'srt-relay', reason: 'srt-relay-unreachable' });
  });
});

describe('save-time SRT address check (GStreamer reads keys and modes exactly)', () => {
  it('POST source refuses a key in the wrong case with 400, naming the right spelling', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/sources',
      payload: { name: 'Cam', streamType: 'srt', address: 'srt://cdn.example.com:9000?Mode=caller' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("use 'mode'");
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it('PATCH source refuses a sent address with a mode in the wrong case', async () => {
    mockSourcesGet.mockResolvedValue(source('srt://cdn.example.com:9000?mode=caller'));
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/sources/src-relay',
      payload: { address: 'srt://cdn.example.com:9000?mode=Caller' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("use 'caller'");
  });

  it('PATCH source without an address does not re-check a stored one', async () => {
    mockSourcesGet.mockResolvedValue(source('srt://cdn.example.com:9000?Mode=Caller'));
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/sources/src-relay', payload: { name: 'Renamed' } });
    expect(res.statusCode).toBe(200);
  });

  it('POST output refuses a relay address with a misspelt passphrase key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outputs',
      payload: { name: 'Program', outputType: 'mpegtssrt', url: `srt+relay://auto?PassPhrase=${SECRET}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("use 'passphrase'");
    expect(res.body).not.toContain(SECRET);
  });

  it('PATCH output refuses a sent URL with a key given twice; a rename keeps the stored one', async () => {
    mockOutputsGet.mockResolvedValue(output('srt://cdn.example.com:9000?mode=caller&mode=caller'));
    const bad = await app.inject({
      method: 'PATCH', url: '/api/v1/outputs/output-relay',
      payload: { url: 'srt://cdn.example.com:9000?mode=caller&mode=caller' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("'mode' is given more than once");
    const rename = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-relay', payload: { name: 'Renamed' } });
    expect(rename.statusCode).toBe(200);
  });
});

describe("relay passphrase with ! * ' ( ) ~ (as encodeURIComponent sends it)", () => {
  it('POST output stores it and never returns it', async () => {
    const pass = encodeURIComponent("my!secret(2024)~*'");
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outputs',
      payload: { name: 'Program', outputType: 'mpegtssrt', url: `srt+relay://auto?passphrase=${pass}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('secret');
  });
});
