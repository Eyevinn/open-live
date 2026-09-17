/**
 * Tests for authentication context in the mutating-request audit log (#51).
 *
 * The onResponse audit hook emits a structured `{audit:true, ...}` entry for
 * every mutating /api/v1 call. Before #51 it recorded only method/url/status/ip,
 * so a suspected key-compromise investigation could not tell which credential
 * was used. The entry now carries `authMethod` and (when a key was presented) a
 * MASKED credential — the raw key must never appear in the log.
 *
 * CouchDB, Strom client, and the WS controller are mocked — no real services
 * required. API_KEY is set before importing the server so config.apiKey (read
 * once at module load) picks it up.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;

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
    system = { version: vi.fn().mockResolvedValue({ version: '1.0.0' }), iceServers: vi.fn() };
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

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

/**
 * Builds a server, spies on its logger, performs one injected request, and
 * returns the captured audit log object (or undefined if none was emitted).
 * The audit hook logs through `app.log.info`, so spying on it captures the
 * structured entry without needing a real transport.
 */
async function captureAudit(inject: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
}): Promise<Record<string, unknown> | undefined> {
  const app = await buildServer();
  const infoSpy = vi.spyOn(app.log, 'info');
  await app.inject(inject);
  for (const call of infoSpy.mock.calls) {
    const first = call[0];
    if (first && typeof first === 'object' && (first as Record<string, unknown>)['audit'] === true) {
      return first as Record<string, unknown>;
    }
  }
  return undefined;
}

describe('audit log authentication context (#51)', () => {
  it("records authMethod 'bearer' and a masked credential for Authorization: Bearer requests", async () => {
    const entry = await captureAudit({
      method: 'POST',
      url: '/api/v1/reconnect',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(entry).toBeDefined();
    expect(entry!['authMethod']).toBe('bearer');
    expect(entry!['maskedCred']).toBe('key_***-key');
  });

  it("records authMethod 'none' and no maskedCred when no credential is presented", async () => {
    // A missing key yields 401, but the onResponse audit hook still fires.
    const entry = await captureAudit({ method: 'POST', url: '/api/v1/reconnect' });
    expect(entry).toBeDefined();
    expect(entry!['authMethod']).toBe('none');
    expect(entry).not.toHaveProperty('maskedCred');
  });

  it('never logs the full API key in the audit entry', async () => {
    const entry = await captureAudit({
      method: 'POST',
      url: '/api/v1/reconnect',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(entry).toBeDefined();
    // The raw secret must not appear in any string field of the entry.
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain(TEST_API_KEY);
  });

  it('still records the pre-existing audit fields alongside the auth context', async () => {
    const entry = await captureAudit({
      method: 'POST',
      url: '/api/v1/reconnect',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(entry).toMatchObject({
      audit: true,
      method: 'POST',
      url: '/api/v1/reconnect',
    });
    expect(entry).toHaveProperty('status');
    expect(entry).toHaveProperty('ip');
  });
});
