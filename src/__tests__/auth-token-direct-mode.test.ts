/**
 * Tests for POST /api/v1/auth/token in STROM_AUTH_MODE=direct (issue #329).
 *
 * STROM_AUTH_MODE only controls how *this backend* talks to Strom directly —
 * it says nothing about what OSC service the Studio's own SAT is scoped to.
 * #324/#322 short-circuited this endpoint to a 503 whenever
 * STROM_AUTH_MODE=direct, reasoning that funnel-provisioned tenants have no
 * eyevinn-strom subscription. True, but irrelevant after #328: the exchange
 * is scoped to config.oscSatServiceId, which now defaults to
 * eyevinn-open-live — a service every funnel-provisioned tenant *is*
 * entitled to. The #324 short-circuit made that fix unreachable and left the
 * Studio's eyevinn-open-live.sat cookie (see open-live-studio's sat.ts) never
 * set, so it could never pass the OSC reverse-proxy wall on a funnel
 * instance. This suite guards that STROM_AUTH_MODE=direct does NOT bypass
 * the exchange.
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

describe('POST /api/v1/auth/token — STROM_AUTH_MODE=direct (#329)', () => {
  it('still attempts the SAT exchange, scoped to eyevinn-open-live', async () => {
    exchangeMock.mockResolvedValue({ token: 'short-lived-sat', expiry: 1_800_000_000 });
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: 'short-lived-sat', expiry: 1_800_000_000 });
    // STROM_AUTH_MODE=direct must NOT change the exchange scope or skip it.
    expect(exchangeMock).toHaveBeenCalledWith(TEST_PAT, 'eyevinn-open-live');
    // The PAT must never leak into the response.
    expect(res.body).not.toContain(TEST_PAT);
  });

  it('surfaces a 502, not a silent 503, when the exchange fails', async () => {
    exchangeMock.mockRejectedValue(new TokenExchangeError('User not entitled to access service'));
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(502);
    expect(exchangeMock).toHaveBeenCalledWith(TEST_PAT, 'eyevinn-open-live');
    expect(res.body).not.toContain(TEST_PAT);
  });
});
