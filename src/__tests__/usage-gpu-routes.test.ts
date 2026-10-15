/**
 * Route tests for GET /api/v1/usage/gpu (issue #500, schema osc-gpu-usage/v1).
 *
 * Covers the passing path (a closed bucket is produced and readable with a valid
 * bearer token) AND the rejection path (no token → 401), per the team rule that
 * a new rejection branch needs a success-case test. Also covers the `?since`
 * cursor and the 400 on a malformed cursor. CouchDB is mocked.
 *
 * API_KEY + GPU_POOL are set before import so auth is enforced and metering is
 * enabled (config reads env once at module load).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GPU_POOL'] = 'fra-1';
process.env['GPU_CLASS'] = 'shared';

const mockFindTrusted = vi.fn();
const mockIsDbConnected = vi.fn().mockReturnValue(true);

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), findTrusted: mockFindTrusted }),
  getGpuUsageLedgerDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), findTrusted: vi.fn(async () => ({ docs: [] })), destroy: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGraphicsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getConfigsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getRecordingsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGuestInvitesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGuestSessionsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: () => mockIsDbConnected(),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  clearClipStateForProduction: vi.fn(),
}));

let buildServer: typeof import('../server.js').buildServer;
let app: FastifyInstance;

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
  app = await buildServer();
});

describe('GET /api/v1/usage/gpu (#500)', () => {
  it('rejects a request without a bearer token (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/usage/gpu' });
    expect(res.statusCode).toBe(401);
  });

  it('returns closed osc-gpu-usage/v1 buckets with a valid token', async () => {
    // The handler uses the real clock, so anchor the fixture to a hour that is
    // definitely closed (3 hours before the current top-of-hour).
    const HOUR = 3_600_000;
    const closedHourMs = Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR;
    const closedHour = new Date(closedHourMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    mockFindTrusted.mockResolvedValue({
      docs: [
        {
          _id: 'prod-17',
          type: 'production',
          status: 'ended',
          gpuHours: { [closedHour]: 3600 },
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/usage/gpu', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.standard).toBe('osc-gpu-usage/v1');
    expect(body.basis).toBe('allocation');
    expect(typeof body.generatedAt).toBe('string');
    expect(typeof body.settledThrough).toBe('string');
    expect(Array.isArray(body.hours)).toBe(true);
    // The persisted closed hour is readable with its full labels.
    const bucket = body.hours.find((h: { hour: string }) => h.hour === closedHour);
    expect(bucket).toMatchObject({
      tenantId: 'unattributed',
      resource: 'production-prod-17',
      gpuPool: 'fra-1',
      gpuClass: 'shared',
      seconds: 3600,
    });
    // Every emitted bucket is strictly before settledThrough (never the current
    // partial hour).
    const settled = Date.parse(body.settledThrough);
    expect(body.hours.every((h: { hour: string }) => Date.parse(h.hour) < settled)).toBe(true);
  });

  it('400s a malformed since cursor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/usage/gpu?since=not-a-date', headers: AUTH });
    expect(res.statusCode).toBe(400);
  });

  it('503s when the backing store is unreachable (osc-gpu-usage-v1 §2, #503 FIX 3)', async () => {
    // Metering is on (GPU_POOL set) but the DB is unreachable: the endpoint must
    // return 503, NOT a 200 with hours:[] that would hide a transient outage
    // behind genuine-zero semantics. (The server-wide DB-down onRequest guard
    // 503s /api/v1 first; buildGpuUsageResponse's own throw keeps the service and
    // the published standard in agreement and covers the handle-drops-mid-request
    // race — see the unit test in gpu-usage.test.ts.)
    mockIsDbConnected.mockReturnValue(false);
    const res = await app.inject({ method: 'GET', url: '/api/v1/usage/gpu', headers: AUTH });
    mockIsDbConnected.mockReturnValue(true);
    expect(res.statusCode).toBe(503);
    expect(typeof res.json().error).toBe('string');
  });

  it('503s when a usage query fails while the DB is connected (#503 review)', async () => {
    mockIsDbConnected.mockReturnValue(true);
    mockFindTrusted.mockReset();
    mockFindTrusted.mockRejectedValue(new Error('query boom'));
    const res = await app.inject({ method: 'GET', url: '/api/v1/usage/gpu', headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(typeof res.json().error).toBe('string');
  });

  it('still 200s with zero hours on an empty-but-successful query (#503 review)', async () => {
    mockIsDbConnected.mockReturnValue(true);
    mockFindTrusted.mockReset();
    mockFindTrusted.mockResolvedValue({ docs: [] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/usage/gpu', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().hours).toEqual([]);
  });
});
