/**
 * Tests for productions routes — dskInput validation (issue #61).
 *
 * CouchDB and WS controller are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../server.js';

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert }),
  getSourcesDb: () => ({ get: mockGet }),
  getOutputsDb: () => ({ get: vi.fn().mockResolvedValue(null) }),
  getGraphicsDb: () => ({ get: vi.fn().mockResolvedValue(null) }),
  getConfigsDb: () => ({ get: vi.fn().mockResolvedValue(null) }),
  isDbConnected: () => true,
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
// Helper: quick production doc lookup
// ---------------------------------------------------------------------------

const prodDoc = (overrides = {}) => ({
  _id: 'prod-test-1',
  type: 'production',
  name: 'Test Production',
  sources: [],
  graphicAssignments: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(prodDoc());
  mockInsert.mockResolvedValue({ ok: true, id: 'prod-test-1', rev: '1-abc' });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/productions/:id/graphics', () => {
  it('accepts valid dskInput format (dsk_in_N)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/graphics',
      payload: { graphicId: 'g-1', dskInput: 'dsk_in_0' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts dsk_in with multi-digit index', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/graphics',
      payload: { graphicId: 'g-2', dskInput: 'dsk_in_42' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects dskInput with colons (would corrupt Strom flow link)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/graphics',
      payload: { graphicId: 'g-3', dskInput: 'dsk_in_0:bad' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects empty dskInput', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/graphics',
      payload: { graphicId: 'g-4', dskInput: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects arbitrarily long dskInput (>20 chars)', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/graphics',
      payload: { graphicId: 'g-5', dskInput: 'dsk_in_0123456789012345' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects dskInput with special characters', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/graphics',
      payload: { graphicId: 'g-6', dskInput: 'dsk_in_<script>' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-dsk_in_ format strings', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/graphics',
      payload: { graphicId: 'g-7', dskInput: 'video_in_0' },
    });
    expect(res.statusCode).toBe(400);
  });
});
