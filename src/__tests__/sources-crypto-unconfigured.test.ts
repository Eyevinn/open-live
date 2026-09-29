/**
 * Regression test for issue #349 — credential storage with NO encryption key
 * configured in production.
 *
 * The crypto modules fail closed (ADR-003 Decision 4): with neither HTML_AUTH_KEY
 * nor SRT_PASSPHRASE_KEY set in production they refuse to store a secret in
 * plaintext. Before #349 that surfaced as a generic 500 ("An internal error
 * occurred"), indistinguishable from a real bug. These tests assert the route now
 * returns a clear, non-500 config error (503) whose message names the missing env
 * var — for BOTH crypto paths (HTML header credentials and SRT passphrases) — end
 * to end through the global error handler.
 *
 * CouchDB, Strom and the WS controller are mocked — no live services required.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SourceDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
// The point of this suite: production, with NO encryption key of either kind.
process.env['NODE_ENV'] = 'production';
delete process.env['HTML_AUTH_KEY'];
delete process.env['SRT_PASSPHRASE_KEY'];
// PUBLIC_BASE_URL is required for buildServer() to run cleanly in production.
process.env['PUBLIC_BASE_URL'] = 'https://openlive.example.com';

const CANARY = 'Bearer CANARY-9f83b1e0-DO-NOT-LEAK';

// ---- Mock CouchDB ----
const sourcesStore = new Map<string, SourceDoc>();

const sourcesDb = {
  get: vi.fn(async (id: string) => {
    const doc = sourcesStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: SourceDoc) => {
    sourcesStore.set(doc._id, { ...doc, _rev: '2-x' });
    return { ok: true, id: doc._id, rev: '2-x' };
  }),
  destroy: vi.fn(async (id: string) => {
    sourcesStore.delete(id);
    return { ok: true };
  }),
  find: vi.fn(async () => ({ docs: Array.from(sourcesStore.values()) })),
  findTrusted: vi.fn(async () => ({ docs: [] })),
};

const prodDb = {
  get: vi.fn(),
  insert: vi.fn(),
  find: vi.fn(),
  findTrusted: vi.fn(async () => ({ docs: [] })),
};

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getSourcesDb: () => sourcesDb,
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
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
    flows = { get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    mixer = { multiviewEndpoint: vi.fn() };
    portLeases = { acquire: vi.fn(), renew: vi.fn(), release: vi.fn(), list: vi.fn(), get: vi.fn() };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../services/port-lease.js', () => ({
  getPortLease: () => ({ start: 9000, end: 9100 }),
}));

vi.mock('../services/listener-ports.js', () => ({
  usedListenerPorts: vi.fn().mockResolvedValue([]),
  clashesAfterWrite: vi.fn().mockReturnValue(undefined),
  listenerPortRequest: vi.fn().mockReturnValue(9000),
  resolveListenerAddress: vi.fn((address: string) => ({ ok: true, address, port: 9000 })),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  sourcesStore.clear();
});

/** Create a plain (no-auth) HTML source — no crypto involved, so this succeeds. */
async function createHtmlSource(): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/sources', headers: AUTH,
    payload: { name: 'dashboard', address: 'https://dashboard.example.com/', streamType: 'html' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe('#349 — credential storage with no encryption key configured (production)', () => {
  it('PATCH storing an HTML header credential returns a clear 503, not a 500', async () => {
    const id = await createHtmlSource();
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/sources/${id}`, headers: AUTH,
      payload: { auth: { mode: 'header', header: { name: 'Authorization', value: CANARY } } },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.statusCode).toBe(503);
    // Clear, non-generic message that names the missing env var...
    expect(body.error).not.toBe('An internal error occurred');
    expect(body.error).toMatch(/not configured/);
    expect(body.error).toMatch(/HTML_AUTH_KEY/);
    // ...and the secret is never leaked, nor stored (fail closed).
    expect(JSON.stringify(body)).not.toContain('CANARY');
    expect(sourcesStore.get(id)!.authHeaderValueEnc).toBeUndefined();
  });

  it('POST /auth/rotate storing an HTML header credential returns a clear 503, not a 500', async () => {
    const id = await createHtmlSource();
    // Give it a header-mode auth shell first (name only, no value → no crypto).
    await app.inject({
      method: 'PATCH', url: `/api/v1/sources/${id}`, headers: AUTH,
      payload: { auth: { mode: 'header', header: { name: 'Authorization' } } },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sources/${id}/auth/rotate`, headers: AUTH,
      payload: { value: CANARY },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/HTML_AUTH_KEY/);
    expect(JSON.stringify(res.json())).not.toContain('CANARY');
  });

  it('POST creating an SRT source with a passphrase returns a clear 503, not a 500', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/sources', headers: AUTH,
      payload: { name: 'cam', address: 'srt://cam.example.com:9000?passphrase=topsecretpassphrase&latency=200', streamType: 'srt' },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.statusCode).toBe(503);
    expect(body.error).not.toBe('An internal error occurred');
    expect(body.error).toMatch(/not configured/);
    expect(body.error).toMatch(/SRT_PASSPHRASE_KEY/);
    expect(JSON.stringify(body)).not.toContain('topsecretpassphrase');
  });
});
