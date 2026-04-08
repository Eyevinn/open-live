/**
 * Tests for macros and streaming stats routes.
 *
 * CouchDB is mocked via vi.mock('../db/index.js') — no real database required.
 *
 * ZodError handling: the server error handler checks `instanceof ZodError` and
 * returns HTTP 400. All Zod validation failures are therefore expected to
 * produce 400 responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../server.js';

// ---------------------------------------------------------------------------
// Mock the CouchDB layer
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getTemplatesDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

// Prevent the WebSocket controller from doing anything at startup
vi.mock('../ws/controller.js', () => ({
  default: async () => {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal ProductionDoc fixture that satisfies all route handlers. */
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
// Macros routes
// ---------------------------------------------------------------------------

describe('POST /api/v1/productions/:id/macros', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 201 with a macro whose id starts with "macro-"', async () => {
    const doc = makeProductionDoc();
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ id: 'prod-test-1', rev: '2-def', ok: true });

    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/macros',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slot: 0,
        label: 'Cut to Cam 1',
        color: '#3B82F6',
        actions: [{ type: 'CUT', sourceId: 'src-cam1' }],
      }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; slot: number; label: string; color: string }>();
    expect(body.id).toMatch(/^macro-/);
    expect(body.slot).toBe(0);
    expect(body.label).toBe('Cut to Cam 1');
    expect(body.color).toBe('#3B82F6');
  });

  it('persists the macro in the document passed to insert()', async () => {
    const doc = makeProductionDoc();
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ id: 'prod-test-1', rev: '2-def', ok: true });

    const server = await buildServer();
    await server.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/macros',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slot: 1,
        label: 'Graphic On',
        color: '#10B981',
        actions: [{ type: 'GRAPHIC_ON', overlayId: 'overlay-1', layer: 0, visible: true }],
      }),
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    const insertedDoc = mockInsert.mock.calls[0][0] as { macros: Array<{ slot: number }> };
    expect(insertedDoc.macros).toHaveLength(1);
    expect(insertedDoc.macros[0].slot).toBe(1);
  });

  it('returns 201 for slot=7 (boundary — maximum valid slot)', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    mockInsert.mockResolvedValue({ id: 'prod-test-1', rev: '2-def', ok: true });

    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/macros',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 7, label: 'Last slot', color: '#FFFFFF', actions: [] }),
    });

    expect(res.statusCode).toBe(201);
  });

  it('returns 400 when slot=8 (above maximum of 7)', async () => {
    // getDb().get() should not even be called — parse throws before that
    mockGet.mockResolvedValue(makeProductionDoc());
    mockInsert.mockResolvedValue({ id: 'prod-test-1', rev: '2-def', ok: true });

    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/macros',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 8, label: 'Invalid', color: '#FF0000', actions: [] }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; statusCode: number }>();
    expect(body.statusCode).toBe(400);
    // The database should never have been touched
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 when slot=-1 (below minimum of 0)', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/macros',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: -1, label: 'Invalid', color: '#FF0000', actions: [] }),
    });

    expect(res.statusCode).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns 400 when color format is invalid (not a hex color)', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/macros',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 0, label: 'Test', color: 'red', actions: [] }),
    });

    expect(res.statusCode).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns 400 when label is empty (min length 1)', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/macros',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 0, label: '', color: '#000000', actions: [] }),
    });

    expect(res.statusCode).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/productions/:id/macros
// ---------------------------------------------------------------------------

describe('GET /api/v1/productions/:id/macros', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty array when the production has no macros', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());

    const server = await buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/productions/prod-test-1/macros',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns the macros array from the production document', async () => {
    const macro = {
      id: 'macro-abc-123',
      slot: 2,
      label: 'DSK Toggle',
      color: '#F59E0B',
      actions: [{ type: 'DSK_TOGGLE' }],
    };
    mockGet.mockResolvedValue(makeProductionDoc({ macros: [macro] }));

    const server = await buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/productions/prod-test-1/macros',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<typeof macro[]>();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('macro-abc-123');
    expect(body[0].slot).toBe(2);
  });

  it('returns 404 when production does not exist', async () => {
    mockGet.mockRejectedValue({ statusCode: 404, error: 'not_found' });

    const server = await buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/productions/non-existent/macros',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('Production not found');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/productions/:id/macros/:macroId
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/productions/:id/macros/:macroId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when macroId does not exist in the production', async () => {
    // Production exists but has no macros
    mockGet.mockResolvedValue(makeProductionDoc({ macros: [] }));

    const server = await buildServer();
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/v1/productions/prod-test-1/macros/macro-does-not-exist',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('Macro not found');
  });

  it('returns 404 when production doc has macros but none match the macroId', async () => {
    const doc = makeProductionDoc({
      macros: [{ id: 'macro-other', slot: 0, label: 'Other', color: '#000000', actions: [] }],
    });
    mockGet.mockResolvedValue(doc);

    const server = await buildServer();
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/v1/productions/prod-test-1/macros/macro-unknown',
    });

    expect(res.statusCode).toBe(404);
    // insert must NOT have been called — no document should be mutated
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 204 and removes the macro when it exists', async () => {
    const macroId = 'macro-to-delete';
    const doc = makeProductionDoc({
      macros: [{ id: macroId, slot: 3, label: 'Delete me', color: '#EF4444', actions: [] }],
    });
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ id: 'prod-test-1', rev: '2-def', ok: true });

    const server = await buildServer();
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/v1/productions/prod-test-1/macros/${macroId}`,
    });

    expect(res.statusCode).toBe(204);
    expect(mockInsert).toHaveBeenCalledOnce();
    const saved = mockInsert.mock.calls[0][0] as { macros: unknown[] };
    expect(saved.macros).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/productions/:id/macros/:macroId
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/productions/:id/macros/:macroId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when macroId does not exist', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({ macros: [] }));

    const server = await buildServer();
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/v1/productions/prod-test-1/macros/macro-ghost',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Updated' }),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('Macro not found');
  });

  it('returns 200 with updated macro when patch is valid', async () => {
    const macroId = 'macro-to-patch';
    const original = { id: macroId, slot: 1, label: 'Original', color: '#111111', actions: [] };
    mockGet.mockResolvedValue(makeProductionDoc({ macros: [original] }));
    mockInsert.mockResolvedValue({ id: 'prod-test-1', rev: '2-def', ok: true });

    const server = await buildServer();
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/productions/prod-test-1/macros/${macroId}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Updated Label', color: '#AABBCC' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; label: string; color: string; slot: number }>();
    expect(body.id).toBe(macroId);
    expect(body.label).toBe('Updated Label');
    expect(body.color).toBe('#AABBCC');
    // Unchanged field should be preserved
    expect(body.slot).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/productions/:id/stats/streaming
// ---------------------------------------------------------------------------

describe('GET /api/v1/productions/:id/stats/streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { active: false } when production has no stromFlowId', async () => {
    // Production doc without stromFlowId
    mockGet.mockResolvedValue(makeProductionDoc());

    const server = await buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/productions/prod-test-1/stats/streaming',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('returns { active: false } when stromFlowId is explicitly undefined', async () => {
    const doc = makeProductionDoc({ stromFlowId: undefined });
    mockGet.mockResolvedValue(doc);

    const server = await buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/productions/prod-test-1/stats/streaming',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ active: boolean }>().active).toBe(false);
  });

  it('returns 404 when production does not exist', async () => {
    mockGet.mockRejectedValue({ statusCode: 404, error: 'not_found' });

    const server = await buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/productions/non-existent/stats/streaming',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('Production not found');
  });

  it('returns { active: true, rtpStats: null, webrtcStats: null, error: string } when Strom fetch fails', async () => {
    // Production doc with a stromFlowId triggers Strom API calls
    mockGet.mockResolvedValue(makeProductionDoc({ stromFlowId: 'flow-abc' }));

    const server = await buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/productions/prod-test-1/stats/streaming',
    });

    // Strom is not running in the test environment; the route should handle
    // the fetch error gracefully and return a degraded (non-crash) response.
    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean; rtpStats: unknown; webrtcStats: unknown; error?: string }>();
    expect(body.active).toBe(true);
    expect(body.rtpStats).toBeNull();
    expect(body.webrtcStats).toBeNull();
    expect(typeof body.error).toBe('string');
  });
});
