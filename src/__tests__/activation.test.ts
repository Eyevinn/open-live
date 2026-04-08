/**
 * Tests for async activation state machine and ICE servers route.
 *
 * CouchDB, Strom client, and flow-generator are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../server.js';

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind }),
  getSourcesDb: () => ({ get: mockGet }),
  getTemplatesDb: () => ({ get: mockGet }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

// ---------------------------------------------------------------------------
// Mock WebSocket controller (avoids startup side effects)
// ---------------------------------------------------------------------------

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
}));

// ---------------------------------------------------------------------------
// Mock flow-generator
// ---------------------------------------------------------------------------

const mockActivateStromFlow = vi.fn();
const mockDeactivateStromFlow = vi.fn();

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

// ---------------------------------------------------------------------------
// Mock StromClient
// ---------------------------------------------------------------------------

const mockStromFlowsGet = vi.fn();
const mockStromMixerMultiviewEndpoint = vi.fn();
const mockStromSystemIceServers = vi.fn();
const mockStromSystemVersion = vi.fn();

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = {
      version: mockStromSystemVersion,
      iceServers: mockStromSystemIceServers,
    };
    flows = {
      get: mockStromFlowsGet,
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    mixer = {
      multiviewEndpoint: mockStromMixerMultiviewEndpoint,
    };
  }
  return {
    ...actual,
    StromClient: MockStromClient,
  };
});

// Mock strom-token
vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Tests: POST /api/v1/productions/:id/activate
// ---------------------------------------------------------------------------

describe('POST /api/v1/productions/:id/activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('returns 200 with status "activating" immediately', async () => {
    const doc = makeProductionDoc({ templateId: 'tmpl-1' });
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });
    // The async polling loop will call activateStromFlow — we just let it
    // resolve slowly so it doesn't interfere with this test
    mockActivateStromFlow.mockResolvedValue('flow-abc');
    mockStromFlowsGet.mockResolvedValue({ flow: { id: 'flow-abc', state: 'idle' } });

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('activating');
    expect(body.id).toBe('prod-test-1');
  });

  it('returns 409 if production is already active', async () => {
    const doc = makeProductionDoc({ status: 'active' });
    mockGet.mockResolvedValue(doc);

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("already 'active'");
  });

  it('returns 409 if production is already activating', async () => {
    const doc = makeProductionDoc({ status: 'activating' });
    mockGet.mockResolvedValue(doc);

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("already 'activating'");
  });

  it('returns 500 if CouchDB write fails', async () => {
    const doc = makeProductionDoc();
    mockGet.mockResolvedValue(doc);
    mockInsert.mockRejectedValue(new Error('CouchDB connection error'));

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/v1/productions/:id/deactivate
// ---------------------------------------------------------------------------

describe('POST /api/v1/productions/:id/deactivate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('clears whepEndpoint, stromFlowId, and mixerBlockId on deactivate', async () => {
    const doc = makeProductionDoc({
      status: 'active',
      stromFlowId: 'flow-abc',
      mixerBlockId: 'mixer-1',
      whepEndpoint: 'https://strom.example.com/whep/flow-abc/mixer-1',
    });
    mockGet.mockResolvedValue(doc);
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockInsert.mockResolvedValue({ rev: '3-cde', ok: true, id: doc._id });

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/deactivate',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('inactive');

    // Verify the doc written to CouchDB cleared the fields
    const insertedDoc = mockInsert.mock.calls[0][0];
    expect(insertedDoc.whepEndpoint).toBeUndefined();
    expect(insertedDoc.stromFlowId).toBeUndefined();
    expect(insertedDoc.mixerBlockId).toBeUndefined();
  });

  it('returns 200 even if production has no stromFlowId', async () => {
    const doc = makeProductionDoc({ status: 'inactive' });
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/deactivate',
    });

    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/v1/ice-servers
// ---------------------------------------------------------------------------

describe('GET /api/v1/ice-servers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('returns 200 with iceServers array from Strom', async () => {
    mockStromSystemIceServers.mockResolvedValue({
      ice_servers: [
        { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass' },
        { urls: ['stun:stun.example.com:3478'] },
      ],
    });

    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ice-servers',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.iceServers).toHaveLength(2);
    expect(body.iceServers[0].urls).toContain('turn:turn.example.com:3478');
    expect(body.iceServers[0].username).toBe('user');
    expect(body.iceServers[0].credential).toBe('pass');
  });

  it('returns 502 if Strom is unreachable', async () => {
    mockStromSystemIceServers.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ice-servers',
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.statusCode).toBe(502);
  });

  it('returns 502 if Strom returns a StromClientError', async () => {
    const { StromClientError } = await import('../lib/strom.js');
    mockStromSystemIceServers.mockRejectedValue(new StromClientError(503, 'Service unavailable'));

    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ice-servers',
    });

    expect(res.statusCode).toBe(502);
  });
});
