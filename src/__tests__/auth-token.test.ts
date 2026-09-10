/**
 * Tests for POST /api/v1/auth/token — the server-side SAT-exchange endpoint
 * (issue #204). The endpoint holds the OSC PAT server-side and returns only a
 * short-lived SAT so browser clients (open-live-studio#10) never hold the PAT.
 *
 * Covers:
 *   - 401 without the API key (endpoint is API-key-guarded, NOT exempt)
 *   - 400 on a bad body (Zod .strict() rejects unexpected fields)
 *   - success path with the upstream `servicetoken` exchange mocked, asserting
 *     only the SAT + expiry are returned and the PAT never appears
 *   - 502 when the upstream token service fails
 *
 * The upstream exchange is mocked, so no real network / OSC token service is
 * required. API_KEY and OSC_PAT are set before importing the server so
 * config (read once at module load) picks them up.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const TEST_API_KEY = 'test-secret-key';
const TEST_PAT = 'super-secret-pat-value';
process.env['API_KEY'] = TEST_API_KEY;
process.env['OSC_PAT'] = TEST_PAT;

// ---------------------------------------------------------------------------
// Mock CouchDB (route never touches it, but server startup imports it)
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn() }),
  getGraphicsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

// Avoid WS controller startup side effects
vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the upstream SAT exchange so the test never hits the real token service.
// This stands in for the `servicetoken` call against token.svc.prod.osaas.io.
// ---------------------------------------------------------------------------

const { exchangeMock, TokenExchangeError } = vi.hoisted(() => {
  class TokenExchangeError extends Error {}
  return { exchangeMock: vi.fn(), TokenExchangeError };
});

vi.mock('../lib/osc-token.js', () => ({
  exchangeServiceToken: exchangeMock,
  TokenExchangeError,
  TOKEN_EXCHANGE_URL: 'https://token.svc.prod.osaas.io/servicetoken',
}));

let buildServer: typeof import('../server.js').buildServer;

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

beforeEach(() => {
  exchangeMock.mockReset();
});

describe('POST /api/v1/auth/token (#204)', () => {
  it('rejects the request without an API key', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('rejects a body with unexpected fields (400)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      // serviceId must NOT be caller-supplied — an unexpected field is a 400.
      payload: { serviceId: 'attacker-controlled-service' },
    });
    expect(res.statusCode).toBe(400);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('returns only the SAT + expiry on success, never the PAT', async () => {
    exchangeMock.mockResolvedValue({ token: 'short-lived-sat', expiry: 1_800_000_000 });
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ token: 'short-lived-sat', expiry: 1_800_000_000 });

    // The exchange is scoped to the fixed server-side serviceId, using the
    // server-held PAT — neither comes from the request.
    expect(exchangeMock).toHaveBeenCalledWith(TEST_PAT, 'eyevinn-strom');

    // The PAT must never appear anywhere in the response payload.
    expect(res.body).not.toContain(TEST_PAT);
    expect(body).not.toHaveProperty('pat');
  });

  it('returns 502 when the upstream token service fails', async () => {
    exchangeMock.mockRejectedValue(new TokenExchangeError('token service unreachable'));
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    // Generic message — no upstream internals leaked.
    expect(res.body).not.toContain('unreachable');
  });
});
