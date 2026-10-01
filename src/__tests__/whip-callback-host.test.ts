/**
 * Security tests for WHIP callback URL host resolution (#50).
 *
 * When PUBLIC_BASE_URL is not set, the activation endpoint previously built the
 * WHIP callback URL directly from the raw X-Forwarded-Proto / X-Forwarded-Host
 * request headers, bypassing Fastify's trustProxy mechanism. A client could
 * inject `X-Forwarded-Host: attacker.com` to persist `http://attacker.com` as
 * the WHIP callback URL in CouchDB, redirecting WHIP clients to an
 * attacker-controlled endpoint.
 *
 * These tests assert that an untrusted / injected host is NOT persisted and NOT
 * returned — the request is rejected (400) or falls back to the configured URL.
 *
 * CouchDB, Strom client, and flow-generator are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { buildServer } from '../server.js';
import { resolvePublicBaseUrl, UntrustedHostError } from '../routes/productions.js';

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind }),
  getSourcesDb: () => ({ get: mockGet }),
  getOutputsDb: () => ({ get: mockGet }),
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

const mockActivateStromFlow = vi.fn();
const mockDeactivateStromFlow = vi.fn();

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn(), iceServers: vi.fn() };
    flows = {
      get: vi.fn().mockResolvedValue({ flow: { id: 'flow-abc', running: false } }),
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    mixer = { multiviewEndpoint: vi.fn() };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-test-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
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

// ---------------------------------------------------------------------------
// Unit tests: resolvePublicBaseUrl helper
// ---------------------------------------------------------------------------

describe('resolvePublicBaseUrl', () => {
  it('prefers PUBLIC_BASE_URL and ignores the request host entirely', () => {
    const url = resolvePublicBaseUrl(
      { protocol: 'http', host: 'attacker.com' },
      { publicBaseUrl: 'https://live.example.com', trustedHosts: [] },
    );
    expect(url).toBe('https://live.example.com');
  });

  it('allows a loopback host when no PUBLIC_BASE_URL / allow-list is set', () => {
    const url = resolvePublicBaseUrl(
      { protocol: 'http', host: 'localhost' },
      { publicBaseUrl: undefined, trustedHosts: [] },
    );
    expect(url).toBe('http://localhost');
  });

  // Regression test for #397: `req.host` (unlike `req.hostname` under Fastify 5)
  // retains the port, so a loopback request on a non-default port must keep it
  // in the resolved base URL instead of silently dropping it.
  it('preserves the port from a loopback host on a non-default port', () => {
    const url = resolvePublicBaseUrl(
      { protocol: 'http', host: 'localhost:3100' },
      { publicBaseUrl: undefined, trustedHosts: [] },
    );
    expect(url).toBe('http://localhost:3100');
  });

  it('rejects an injected non-loopback host when no allow-list is configured', () => {
    expect(() =>
      resolvePublicBaseUrl(
        { protocol: 'http', host: 'attacker.com' },
        { publicBaseUrl: undefined, trustedHosts: [] },
      ),
    ).toThrow(UntrustedHostError);
  });

  it('allows a host that is on the TRUSTED_HOSTS allow-list', () => {
    const url = resolvePublicBaseUrl(
      { protocol: 'https', host: 'live.example.com' },
      { publicBaseUrl: undefined, trustedHosts: ['live.example.com'] },
    );
    expect(url).toBe('https://live.example.com');
  });

  it('rejects a host that is NOT on the TRUSTED_HOSTS allow-list', () => {
    expect(() =>
      resolvePublicBaseUrl(
        { protocol: 'http', host: 'attacker.com' },
        { publicBaseUrl: undefined, trustedHosts: ['live.example.com'] },
      ),
    ).toThrow(UntrustedHostError);
  });
});

// ---------------------------------------------------------------------------
// Regression test for #397: real Fastify request, Host header with a port.
//
// The unit tests above call resolvePublicBaseUrl() with hand-built `{ host }`
// objects, which exercise the function's own logic but not Fastify 5's actual
// `req.host` getter behaviour. The bug fixed by #397 was specifically that the
// previous implementation read `req.hostname`, which Fastify 5 strips the port
// from, so a hand-built object using the right property name would never have
// caught it. This spins up a real `trustProxy`-enabled Fastify instance (same
// as server.ts) and sends a real request with `Host: localhost:3100`, so the
// port is carried through Fastify's own header parsing rather than injected
// directly into a plain object.
// ---------------------------------------------------------------------------

describe('resolvePublicBaseUrl — real Fastify request with a port (#397)', () => {
  it('keeps the port from a real Host header instead of dropping it', async () => {
    const app = Fastify({ trustProxy: true });
    app.get('/probe', async (req) => ({
      base: resolvePublicBaseUrl(req, { publicBaseUrl: undefined, trustedHosts: [] }),
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { host: 'localhost:3100' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ base: 'http://localhost:3100' });
  });

  it('still returns the default-port host unchanged (no spurious port added)', async () => {
    const app = Fastify({ trustProxy: true });
    app.get('/probe', async (req) => ({
      base: resolvePublicBaseUrl(req, { publicBaseUrl: undefined, trustedHosts: [] }),
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { host: 'localhost' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ base: 'http://localhost' });
  });
});

// ---------------------------------------------------------------------------
// Integration test: POST /activate with a spoofed X-Forwarded-Host
// ---------------------------------------------------------------------------

describe('POST /api/v1/productions/:id/activate — X-Forwarded-Host injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
    delete process.env['PUBLIC_BASE_URL'];
    delete process.env['TRUSTED_HOSTS'];
  });

  it('does not persist attacker.com and rejects the injected host with 400', async () => {
    const doc = makeProductionDoc();
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });
    mockActivateStromFlow.mockResolvedValue({
      flowId: 'flow-abc',
      sourceOffsetBlockIds: {},
      sourceAudioOffsetBlockIds: {},
      whepOutputEntries: [],
    });

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
      headers: {
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'attacker.com',
      },
    });

    // The injected host must be rejected, not accepted as an 'activating' response.
    expect(res.statusCode).toBe(400);

    // No WHIP callback URL containing attacker.com may have been written to CouchDB,
    // and the production must not have been transitioned to 'activating'.
    const wroteAttackerHost = mockInsert.mock.calls.some((call) =>
      JSON.stringify(call[0]).includes('attacker.com'),
    );
    expect(wroteAttackerHost).toBe(false);
    const wroteActivating = mockInsert.mock.calls.some(
      (call) => (call[0] as { status?: string }).status === 'activating',
    );
    expect(wroteActivating).toBe(false);
  });

  it('still activates normally (200) for a legitimate loopback request', async () => {
    // No spoofed headers: Fastify inject resolves req.host to a loopback
    // host, which the resolver accepts. This proves the fix does not break the
    // legitimate local/dev activation path.
    const doc = makeProductionDoc();
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });
    mockActivateStromFlow.mockResolvedValue({
      flowId: 'flow-abc',
      sourceOffsetBlockIds: {},
      sourceAudioOffsetBlockIds: {},
      whepOutputEntries: [],
    });

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('activating');

    // The legitimate path must never smuggle an attacker host in either.
    const wroteAttackerHost = mockInsert.mock.calls.some((call) =>
      JSON.stringify(call[0]).includes('attacker.com'),
    );
    expect(wroteAttackerHost).toBe(false);
  });
});
