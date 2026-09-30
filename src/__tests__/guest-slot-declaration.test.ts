/**
 * Tests for declaring a guest slot on a production (issue #381 item 1).
 *
 * A guest slot is a source assignment carrying a `returnFeed` (program-minus by
 * default), declared before air via `POST /api/v1/productions/:id/sources` and
 * built into the flow as a per-guest return bus at activation. This test covers
 * that the assign-source route persists `returnFeed` when present (⇒ guest slot)
 * and omits it for an ordinary assignment, and that `lowLatency` is normalised to
 * false (v1 builds only the synced/picture-switch return).
 *
 * CouchDB and the WS controller are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProductionDoc } from '../db/types.js';
import { buildServer } from '../server.js';

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

async function postSource(payload: Record<string, unknown>) {
  const doc = makeProductionDoc();
  mockGet.mockResolvedValue(doc);
  mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });
  const app = await buildServer();
  return app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-test-1/sources',
    payload,
  });
}

/** The ProductionDoc written by the last insert. */
function lastInsertedDoc(): ProductionDoc {
  return mockInsert.mock.calls.at(-1)![0] as ProductionDoc;
}

describe('POST /api/v1/productions/:id/sources — guest slot declaration (#381)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('declares a guest slot: persists returnFeed on the assignment', async () => {
    const res = await postSource({
      sourceId: 'Whip',
      mixerInput: 'video_in_0',
      returnFeed: { synced: 'program-minus' },
    });
    expect(res.statusCode).toBe(201);
    const slot = lastInsertedDoc().sources.find((s) => s.mixerInput === 'video_in_0');
    expect(slot?.returnFeed).toEqual({ synced: 'program-minus', lowLatency: false });
  });

  it('defaults the slot return mode to program-minus', async () => {
    const res = await postSource({
      sourceId: 'Whip',
      mixerInput: 'video_in_1',
      returnFeed: {},
    });
    expect(res.statusCode).toBe(201);
    const slot = lastInsertedDoc().sources.find((s) => s.mixerInput === 'video_in_1');
    expect(slot?.returnFeed?.synced).toBe('program-minus');
  });

  it('an ordinary source assignment (no returnFeed) is not a guest slot', async () => {
    const res = await postSource({ sourceId: 'src-cam', mixerInput: 'video_in_2' });
    expect(res.statusCode).toBe(201);
    const assignment = lastInsertedDoc().sources.find((s) => s.mixerInput === 'video_in_2');
    expect(assignment?.returnFeed).toBeUndefined();
  });

  it('rejects a v1-unsupported low-latency return (lowLatency: true)', async () => {
    const res = await postSource({
      sourceId: 'Whip',
      mixerInput: 'video_in_3',
      returnFeed: { synced: 'program-minus', lowLatency: true },
    });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
