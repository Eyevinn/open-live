/**
 * Tests for the CORS default-origin behaviour.
 *
 * Regression guard for #54: when CORS_ORIGIN is unset the server must NOT fall
 * back to a permissive wildcard (Access-Control-Allow-Origin: *), which would
 * leave any deployment omitting the var fully open to cross-origin reads.
 *
 * CouchDB, Strom client, and the WS controller are mocked — no real services
 * required. CORS_ORIGIN is deleted before importing the server so config.corsOrigin
 * (read once at module load) reflects the unset state.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

delete process.env['CORS_ORIGIN'];

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn() }),
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
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let buildServer: typeof import('../server.js').buildServer;
let config: typeof import('../config.js').config;

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  ({ buildServer } = await import('../server.js'));
});

describe('CORS default origin (#54)', () => {
  it('does not default CORS_ORIGIN to a wildcard', () => {
    expect(config.corsOrigin).toBeUndefined();
  });

  it('does not send a wildcard Access-Control-Allow-Origin when CORS_ORIGIN is unset', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
