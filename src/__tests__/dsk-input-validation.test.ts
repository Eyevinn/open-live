/**
 * Tests for POST/DELETE /api/v1/productions/:id/graphics `dskInput` validation (issue #61).
 *
 * `dskInput` is forwarded verbatim into a Strom flow link `to` field by
 * flow-generator.ts (`${mixerBlockId}:${assignment.dskInput}`). An unvalidated value
 * containing a `:` or other unexpected characters corrupts the flow topology sent to
 * Strom. It must be validated against the `dsk_in_N` pad naming convention (mirroring
 * `mixerInput`'s `video_in_N` allowlist) so malformed values are rejected with a 400
 * (via the global ZodError handler) rather than injected into the Strom pipeline.
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
    graphicAssignments: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function postGraphic(payload: Record<string, unknown>) {
  const doc = makeProductionDoc();
  mockGet.mockResolvedValue(doc);
  mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });
  const app = await buildServer();
  return app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-test-1/graphics',
    payload,
  });
}

async function deleteGraphic(dskInput: string) {
  const doc = makeProductionDoc({
    graphicAssignments: [{ graphicId: 'gfx-x', dskInput: 'dsk_in_0' }],
  });
  mockGet.mockResolvedValue(doc);
  mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });
  const app = await buildServer();
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/productions/prod-test-1/graphics/${encodeURIComponent(dskInput)}`,
  });
}

describe('POST /api/v1/productions/:id/graphics — dskInput validation (issue #61)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('accepts a well-formed dskInput (dsk_in_0)', async () => {
    const res = await postGraphic({ graphicId: 'gfx-x', dskInput: 'dsk_in_0' });
    expect(res.statusCode).toBe(201);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('accepts a multi-digit dskInput (dsk_in_12)', async () => {
    const res = await postGraphic({ graphicId: 'gfx-x', dskInput: 'dsk_in_12' });
    expect(res.statusCode).toBe(201);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('rejects a dskInput with an injected pad separator (dsk_in_0:injected_pad)', async () => {
    const res = await postGraphic({ graphicId: 'gfx-x', dskInput: 'dsk_in_0:injected_pad' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Validation error');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a dskInput with unexpected characters', async () => {
    const res = await postGraphic({ graphicId: 'gfx-x', dskInput: 'dsk_in_0; drop-block' });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a dskInput that does not match the dsk_in_N convention', async () => {
    const res = await postGraphic({ graphicId: 'gfx-x', dskInput: 'arbitrary_string' });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects an over-long dskInput (max 20 chars)', async () => {
    const res = await postGraphic({ graphicId: 'gfx-x', dskInput: `dsk_in_${'9'.repeat(30)}` });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/productions/:id/graphics/:dskInput — dskInput validation (issue #61)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('removes an assignment for a well-formed dskInput', async () => {
    const res = await deleteGraphic('dsk_in_0');
    expect(res.statusCode).toBe(204);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('rejects a malformed dskInput path param with 400', async () => {
    const res = await deleteGraphic('dsk_in_0:injected_pad');
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Invalid dskInput format');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
