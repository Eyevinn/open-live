/**
 * Tests for POST /api/v1/auth/token in STROM_AUTH_MODE=direct (issue #322).
 *
 * Funnel-provisioned / self-hosted deployments wire the shared dev Strom via
 * STROM_AUTH_MODE=direct. Such tenants have no eyevinn-strom subscription, so an
 * OSC SAT exchange for that scope can only ever 403 "not entitled". The endpoint
 * must NOT attempt the exchange in this mode: it degrades to 503, which the
 * Studio treats as "no auth" (sends requests without an Authorization header,
 * relying on the same-origin/proxy session). The PAT is never returned.
 *
 * config reads env once at module load, so STROM_AUTH_MODE is set here BEFORE
 * importing the server — this file is intentionally separate from the osc-mode
 * suite in auth-token.test.ts.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const TEST_API_KEY = 'test-secret-key';
const TEST_PAT = 'super-secret-pat-value';
process.env['API_KEY'] = TEST_API_KEY;
process.env['OSC_PAT'] = TEST_PAT;
process.env['STROM_AUTH_MODE'] = 'direct';

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn() }),
  getGraphicsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
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

describe('POST /api/v1/auth/token — STROM_AUTH_MODE=direct (#322)', () => {
  it('degrades to 503 without attempting the doomed SAT exchange', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(503);
    // The whole point: no eyevinn-strom exchange is attempted in direct mode.
    expect(exchangeMock).not.toHaveBeenCalled();
    // The PAT must never leak into the response, even on the degrade path.
    expect(res.body).not.toContain(TEST_PAT);
  });
});
