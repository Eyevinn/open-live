/**
 * Route tests for SRT output passphrase encryption-at-rest and masking (#260).
 *
 * Mirrors what sources already do: the passphrase embedded in an SRT output URL
 * must be encrypted (encv1:...) before it touches CouchDB, and masked as
 * `passphrase=***` in every API response — so GET /api/v1/outputs never returns
 * the cleartext value and CouchDB never stores it when SRT_PASSPHRASE_KEY is set.
 *
 * CouchDB, Strom client, and the WS controller are mocked — no real services
 * required. A deterministic 32-byte key is injected via SRT_PASSPHRASE_KEY.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OutputDoc } from '../db/types.js';
import type { PortLease } from '../lib/strom.js';

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

const mockOutputsGet = vi.fn();
const mockOutputsInsert = vi.fn();
const mockOutputsFind = vi.fn();
const mockOutputsDestroy = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
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
// Test fixtures
// ---------------------------------------------------------------------------

// 32 bytes of 0x01..0x20 — base64 form, same key shape as the crypto unit tests.
const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const SECRET = 'supersecretpass'; // 15 chars — valid SRT length
const originalEnv = { ...process.env };

const LEASE: PortLease = {
  id: 'lease-1',
  client_id: 'open-live-test',
  first_port: 47100,
  last_port: 47119,
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:10:00Z',
};

let app: FastifyInstance;
let _resetPortLeaseState: typeof import('../services/port-lease.js')._resetPortLeaseState;
let resetKeyCache: typeof import('../lib/srt-passphrase-crypto.js').resetKeyCache;
let isEncrypted: typeof import('../lib/srt-passphrase-crypto.js').isEncrypted;
let encryptAddressPassphrase: typeof import('../lib/srt-passphrase-crypto.js').encryptAddressPassphrase;

beforeAll(async () => {
  process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
  delete process.env['NODE_ENV'];
  ({ _resetPortLeaseState } = await import('../services/port-lease.js'));
  ({ resetKeyCache, isEncrypted, encryptAddressPassphrase } = await import('../lib/srt-passphrase-crypto.js'));
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

afterAll(() => {
  process.env = { ...originalEnv };
});

beforeEach(() => {
  process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
  resetKeyCache();
  _resetPortLeaseState({ status: 'leased', lease: LEASE });
  mockOutputsGet.mockReset();
  mockOutputsInsert.mockReset();
  mockOutputsInsert.mockResolvedValue({ ok: true, rev: '1-new' });
  mockOutputsFind.mockReset();
  mockOutputsDestroy.mockReset();
  mockOutputsDestroy.mockResolvedValue({ ok: true });
});

describe('POST /api/v1/outputs — passphrase encryption at rest (#260)', () => {
  it('encrypts the passphrase before persisting and masks it in the response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'Program', outputType: 'mpegtssrt', url: `srt://:47110?mode=listener&passphrase=${SECRET}` },
    });
    expect(res.statusCode).toBe(201);

    // Persisted doc must NOT contain the cleartext passphrase.
    const persisted = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    expect(persisted.url).toContain('passphrase=encv1:');
    expect(persisted.url).not.toContain(SECRET);

    // API response must mask it.
    expect(res.json().url).toBe('srt://:47110?mode=listener&passphrase=***');
    expect(JSON.stringify(res.json())).not.toContain(SECRET);
  });

  it('leaves an output URL without a passphrase unchanged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'Program', outputType: 'mpegtssrt', url: 'srt://:47110?mode=listener' },
    });
    expect(res.statusCode).toBe(201);
    const persisted = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    expect(persisted.url).toBe('srt://:47110?mode=listener');
    expect(res.json().url).toBe('srt://:47110?mode=listener');
  });
});

describe('GET /api/v1/outputs — masks the stored (encrypted) passphrase (#260)', () => {
  it('decrypts then masks so cleartext is never returned', async () => {
    const stored: OutputDoc = {
      _id: 'output-1',
      _rev: '1-abc',
      type: 'output',
      name: 'Program',
      outputType: 'mpegtssrt',
      url: encryptAddressPassphrase(`srt://:47110?mode=listener&passphrase=${SECRET}`),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(isEncrypted(stored.url!.split('passphrase=')[1]!.split('&')[0]!)).toBe(true);
    mockOutputsFind.mockResolvedValue({ docs: [stored] });

    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body[0].url).toBe('srt://:47110?mode=listener&passphrase=***');
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('masks a legacy plaintext passphrase (pre-#260 stored docs)', async () => {
    const stored: OutputDoc = {
      _id: 'output-legacy',
      _rev: '1-abc',
      type: 'output',
      name: 'Old Program',
      outputType: 'mpegtssrt',
      url: `srt://:47110?mode=listener&passphrase=${SECRET}`, // stored plaintext (no key at the time)
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockOutputsFind.mockResolvedValue({ docs: [stored] });

    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].url).toBe('srt://:47110?mode=listener&passphrase=***');
    expect(JSON.stringify(res.json())).not.toContain(SECRET);
  });
});

describe('PATCH /api/v1/outputs/:id — re-encrypts an updated passphrase (#260)', () => {
  it('encrypts a new passphrase on patch and masks it in the response', async () => {
    const existing: OutputDoc = {
      _id: 'output-1',
      _rev: '1-abc',
      type: 'output',
      name: 'Program',
      outputType: 'mpegtssrt',
      url: encryptAddressPassphrase('srt://:47110?mode=listener&passphrase=oldpassphrase'),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockOutputsGet.mockResolvedValue(existing);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/outputs/output-1',
      payload: { url: `srt://:47110?mode=listener&passphrase=${SECRET}` },
    });
    expect(res.statusCode).toBe(200);

    const persisted = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    expect(persisted.url).toContain('passphrase=encv1:');
    expect(persisted.url).not.toContain(SECRET);
    expect(persisted.url).not.toContain('oldpassphrase');

    expect(res.json().url).toBe('srt://:47110?mode=listener&passphrase=***');
    expect(JSON.stringify(res.json())).not.toContain(SECRET);
  });

  it('keeps the stored (encrypted) URL untouched when the patch omits url', async () => {
    const encryptedUrl = encryptAddressPassphrase(`srt://:47110?mode=listener&passphrase=${SECRET}`);
    const existing: OutputDoc = {
      _id: 'output-1',
      _rev: '1-abc',
      type: 'output',
      name: 'Program',
      outputType: 'mpegtssrt',
      url: encryptedUrl,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockOutputsGet.mockResolvedValue(existing);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/outputs/output-1',
      payload: { name: 'Renamed Program' },
    });
    expect(res.statusCode).toBe(200);

    const persisted = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    // Stored value unchanged (no double-wrap, still the same encrypted URL).
    expect(persisted.url).toBe(encryptedUrl);
    expect(res.json().url).toBe('srt://:47110?mode=listener&passphrase=***');
  });
});
