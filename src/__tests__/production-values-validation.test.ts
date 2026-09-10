/**
 * Tests for PATCH /api/v1/productions/:id `values` validation (issue #88).
 *
 * Several production `values` are forwarded verbatim to Strom block properties by
 * flow-generator.ts (pgm_resolution, pgm_framerate, multiview_*, clock → clock_type).
 * These must be validated against format-specific allowlists so malformed values are
 * rejected with a 400 (via the global ZodError handler) rather than injected into
 * Strom flow properties.
 *
 * CouchDB and the WS controller are mocked — no real services required.
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
  getOutputsDb: () => ({ get: mockGet }),
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

async function patchValues(values: Record<string, unknown>) {
  const doc = makeProductionDoc();
  mockGet.mockResolvedValue(doc);
  mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });
  const app = await buildServer();
  return app.inject({
    method: 'PATCH',
    url: '/api/v1/productions/prod-test-1',
    payload: { values },
  });
}

describe('PATCH /api/v1/productions/:id — values validation (issue #88)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('rejects a malformed pgm_resolution with 400', async () => {
    const res = await patchValues({ pgm_resolution: '1280x720; drop-block' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Validation error');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a malformed pgm_framerate with 400', async () => {
    const res = await patchValues({ pgm_framerate: 'evil' });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a clock value outside the fixed allowlist with 400', async () => {
    const res = await patchValues({ clock: 'malicious_clock' });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('accepts valid forwarded values (resolution, framerate, clock)', async () => {
    const res = await patchValues({
      pgm_resolution: '1920x1080',
      pgm_framerate: '30000/1001',
      multiview_resolution: '1280x720',
      multiview_framerate: '25',
      clock: 'ntp',
    });
    expect(res.statusCode).toBe(200);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('accepts an empty clock (treated as "use template default")', async () => {
    const res = await patchValues({ clock: '' });
    expect(res.statusCode).toBe(200);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('leaves unrelated keys (numbers, booleans, labels) untouched', async () => {
    const res = await patchValues({ bitrate: 6000, ebu_main: true, some_label: 'Camera 1' });
    expect(res.statusCode).toBe(200);
    expect(mockInsert).toHaveBeenCalledOnce();
  });
});
